/*! 画室（studio）：后端适配层。一套归一化请求，五种后端各自翻译。
 *
 *   comfy     本机 ComfyUI 直连（任意工作流：SDXL / Flux / Qwen / MOSS / MiniMax；也可按模型现拼）
 *   sdwebui   A1111 / Forge / SD.Next（换底模就能跑任意本地 checkpoint）
 *   openai    任何 OpenAI 兼容的 /v1/images（官方、中转站、硅基流动……）
 *   gemini    Google 原生 generateContent（gemini-2.5-flash-image 等）
 *   dashscope 通义万相（异步任务接口）
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { BackendCfg, StudioConfig } from './config.ts';
import { ComfyClient, sleep } from './comfy.ts';
import { canvasToApi, isCanvas } from './canvas.ts';
import { buildMossEditWorkflow, buildWorkflow } from './graph.ts';
import { inventory } from './models.ts';
import {
  describeSlots,
  fillWorkflow,
  inferMapping,
  loadCachedMapping,
  readWorkflowFile,
  saveCachedMapping,
  WorkflowError,
} from './comfy-workflow.ts';
import type { BackendCaps, GenFile, GenRequest, GenResult } from './types.ts';
import {
  b64,
  decodeB64,
  describeFailure,
  httpJson,
  joinUrl,
  parseSize,
  safeName,
  snapSize,
  stamp,
  stripDataUri,
} from './util.ts';

export type ProviderContext = {
  backend: BackendCfg;
  cfg: StudioConfig;
  outDir: string;
  workflowsDir: string;
  mappingsDir: string;
  /** ComfyUI 自己的画布工作流目录（界面里「另存为」的那些） */
  canvasDir?: string;
  /** ComfyUI 的 models 目录，用来读本地模型清单 */
  modelsDir?: string;
  signal?: AbortSignal;
};

export const CAPS: Record<string, BackendCaps> = {
  comfy: { txt2img: true, img2img: true, mask: true, negative: true, size: true, model: true, loras: true, batch: false, async: true, local: true },
  sdwebui: { txt2img: true, img2img: true, mask: true, negative: true, size: true, model: true, loras: false, batch: true, async: false, local: true },
  openai: { txt2img: true, img2img: true, mask: true, negative: false, size: true, model: true, loras: false, batch: true, async: false, local: false },
  gemini: { txt2img: true, img2img: true, mask: false, negative: false, size: false, model: true, loras: false, batch: false, async: false, local: false },
  dashscope: { txt2img: true, img2img: false, mask: false, negative: true, size: true, model: true, loras: false, batch: true, async: true, local: false },
};

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

function saveBytes(bytes: Buffer, dir: string, prefix: string, ext: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${prefix}-${stamp()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  writeFileSync(path, bytes);
  return path;
}

function imageExtFromMime(mime: string | undefined, fallback = 'png'): string {
  if (!mime) return fallback;
  if (/jpeg|jpg/.test(mime)) return 'jpg';
  if (/webp/.test(mime)) return 'webp';
  return 'png';
}

function listWorkflows(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
}

/** /object_info 单节点定义带缓存：同一台 ComfyUI 转换多份工作流时不重复问。 */
const infoCache = new Map<string, any>();

async function objectInfoCached(client: ComfyClient, type: string, signal?: AbortSignal): Promise<any | null> {
  const key = `${client.base}|${type}`;
  if (infoCache.has(key)) return infoCache.get(key);
  const info = await client.objectInfo(type, signal).catch(() => null);
  if (info) infoCache.set(key, info);
  return info;
}

export function clearInfoCache(): void {
  infoCache.clear();
}

const formatSizeOf = (size: { width: number; height: number }) => `${size.width}x${size.height}`;

/** 找工作流的路径（画布目录 + 插件目录）。 */
function locateWorkflow(name: string, workflowsDir: string, canvasDir?: string): string {
  if (isAbsolute(name) && existsSync(name)) return name;
  const candidates = [join(workflowsDir, name)];
  if (canvasDir) candidates.push(join(canvasDir, name));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new WorkflowError(
    `找不到工作流「${name}」。看过：${[workflowsDir, canvasDir].filter(Boolean).join('、')}`,
  );
}

export type LoadedWorkflow = {
  workflow: Record<string, any>;
  format: 'api' | 'canvas';
  path: string;
  notes: string[];
};

/** 读工作流：画布格式就地转换成 API 格式，转不动就带原因抛错。 */
export async function loadWorkflow(
  name: string,
  options: { workflowsDir: string; canvasDir?: string; client?: ComfyClient; signal?: AbortSignal },
): Promise<LoadedWorkflow> {
  const path = locateWorkflow(name, options.workflowsDir, options.canvasDir);
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: any) {
    throw new WorkflowError(`这份工作流读不了（${path}）：${String(error?.message ?? error)}`);
  }
  if (!isCanvas(parsed)) return { workflow: parsed, format: 'api', path, notes: [] };

  if (!options.client) throw new WorkflowError(`「${name}」是画布格式，但没连上 ComfyUI，转换不了`);
  try {
    const conversion = await canvasToApi(parsed, (type) => objectInfoCached(options.client as ComfyClient, type, options.signal));
    const notes = [`画布格式已自动转成 API（${Object.keys(conversion.api).length} 个节点）`];
    if (conversion.guessed.length) notes.push(`这些节点用静态表映射：${conversion.guessed.join('、')}`);
    if (conversion.skipped.length) notes.push(`已跳过：${conversion.skipped.join('、')}`);
    return { workflow: conversion.api, format: 'canvas', path, notes };
  } catch (error: any) {
    throw new WorkflowError(`「${name}」画布转 API 失败：${String(error?.message ?? error)}`);
  }
}

function resolveWorkflowPath(dir: string, name: string): string {
  if (!name) throw new WorkflowError(`工作流目录里没有 json：${dir}`);
  if (isAbsolute(name)) return name;
  return join(dir, name);
}

function requestSize(req: GenRequest, backend: BackendCfg): { width: number; height: number } {
  if (req.width && req.height) return { width: req.width, height: req.height };
  return parseSize(backend.size) ?? { width: 832, height: 1216 };
}

async function downloadTo(
  url: string,
  dir: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : undefined });
  if (!res.ok) throw new Error(`下载图片失败（HTTP ${res.status}）`);
  const contentType = res.headers.get('content-type') ?? 'image/png';
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('下载回来的图片是空的（0 字节）');
  return { path: saveBytes(bytes, dir, prefix, imageExtFromMime(contentType)), bytes: bytes.length };
}

/* ────────────────────────────── ComfyUI 直连 ────────────────────────────── */

async function runComfy(req: GenRequest, ctx: ProviderContext): Promise<GenResult> {
  const { backend, outDir, workflowsDir, mappingsDir, canvasDir, modelsDir, signal } = ctx;
  const client = new ComfyClient(backend.baseUrl, Math.min(backend.timeoutMs, 300_000));

  // 没指定工作流、但给了一个本地模型：现场按模型拼一份（模型清单 → 家族 → 参数默认）。
  const preferred = String(req.workflow || backend.workflow || '').trim();
  const autoBuild = Boolean(req.model || req.family || (req.loras ?? []).length) && !preferred && Boolean(ctx.modelsDir || modelsDir);
  // 给了参考图又没指定工作流：走 MOSS-Image Edit 现拼（不需要训角色 LoRA 也能锁住同一张脸）。
  const refImages = [req.image, ...(req.refs ?? [])].filter((item): item is string => Boolean(item));
  const autoEdit = refImages.length > 0 && !preferred;
  let name = preferred;
  let workflow: Record<string, any> | null = null;
  let prepared = false;
  let loadNotes: string[] = [];
  let workflowMeta: { used?: Record<string, string | undefined> } | null = null;

  if (autoEdit) {
    try {
      const inv = await inventory({ baseUrl: backend.baseUrl, modelsDir: String(modelsDir ?? ctx.modelsDir), signal });
      const uploaded: string[] = [];
      for (const local of refImages.slice(0, 4)) uploaded.push(await client.upload(local, signal));
      req.width = req.width ?? 512;
      req.height = req.height ?? 768;
      req.seed = req.seed ?? randomSeed();
      const built = buildMossEditWorkflow(
        {
          prompt: req.prompt,
          negative: req.negative,
          images: uploaded,
          width: req.width,
          height: req.height,
          steps: req.steps,
          cfg: req.cfg,
          seed: req.seed,
          sampler: req.sampler,
          scheduler: req.scheduler,
          editFormat: req.extra?.edit_format ? String(req.extra.edit_format) : undefined,
          characterLora: req.loras?.[0] ? { name: req.loras[0].name, strength: req.loras[0].strength } : undefined,
          imageStrength: req.extra?.image_strength !== undefined ? Number(req.extra.image_strength) : undefined,
        },
        inv,
      );
      if (built.error) return { ok: false, error: built.error, backend: 'comfy' };
      workflow = built.api;
      prepared = true;
      workflowMeta = { used: built.used };
      name = `edit:moss:${uploaded[0]}`;
      loadNotes = [
        ...built.notes,
        `参考图锁脸：${uploaded.length} 张，尺寸 ${built.defaults.width}x${built.defaults.height}，${built.defaults.steps} 步，cfg ${built.defaults.cfg}`,
      ];
    } catch (error: any) {
      return { ok: false, error: `拼参考图工作流失败：${String(error?.message ?? error)}`, backend: 'comfy' };
    }
  } else if (autoBuild) {
    try {
      const inv = await inventory({
        baseUrl: backend.baseUrl,
        modelsDir: String(modelsDir ?? ctx.modelsDir),
        signal,
      });
      const said = req.model ? String(req.model) : '';
      const asCheckpoint = said ? inv.checkpoints.find((item) => item.name === said) : undefined;
      const built = buildWorkflow(
        {
          prompt: req.prompt,
          family: req.family,
          loras: req.loras,
          negative: req.negative,
          unet: asCheckpoint ? undefined : said,
          checkpoint: asCheckpoint ? said : undefined,
          width: req.width,
          height: req.height,
          steps: req.steps,
          cfg: req.cfg,
          sampler: req.sampler,
          scheduler: req.scheduler,
          seed: req.seed,
        },
        inv,
      );
      if (built.error) return { ok: false, error: built.error, backend: 'comfy' };
      workflow = built.api;
      workflowMeta = { used: built.used };
      name = `auto:${built.family}:${said || (req.loras ?? []).map((item) => item.name).join('+') || built.family}`;
      loadNotes = [...built.notes, `按模型现拼工作流（${built.family}）：尺寸 ${built.defaults.width}x${built.defaults.height}，${built.defaults.steps} 步，cfg ${built.defaults.cfg}，${built.defaults.sampler}/${built.defaults.scheduler}`];
    } catch (error: any) {
      return { ok: false, error: `拼工作流失败：${String(error?.message ?? error)}`, backend: 'comfy' };
    }
  } else {
    name = name || listWorkflows(workflowsDir)[0];
  }

  if (!workflow) {
    if (!name) {
      return {
        ok: false,
        error: `工作流目录是空的：${workflowsDir}。放一份 API 格式 json 进去，或者直接传 model（插件会按本地模型拼一份）`,
        backend: 'comfy',
      };
    }
    try {
      const loaded = await loadWorkflow(name, { workflowsDir, canvasDir, client, signal });
      workflow = loaded.workflow;
      loadNotes = loaded.notes;
    } catch (error: any) {
      return { ok: false, error: String(error?.message ?? error), backend: 'comfy' };
    }
  }
  let filled: { prompt: any; applied: string[]; notes: string[] };
  let mapping: ReturnType<typeof inferMapping> | null = null;
  let seed = req.seed;
  if (prepared) {
    // 现拼的整份工作流：提示词、尺寸、种子都已经写进去了，不用再走槽位那一套。
    filled = { prompt: workflow, applied: ['prompt→edit'], notes: [] };
  } else {
  const cached = loadCachedMapping(mappingsDir, name, workflow);
  mapping = cached ?? inferMapping(workflow);
  if (!cached) saveCachedMapping(mappingsDir, name, workflow, mapping);

  seed = req.seed ?? (mapping.slots.seed ? randomSeed() : undefined);
  const values: Record<string, any> = { prompt: req.prompt };
  if (req.negative !== undefined && mapping.slots.negative) values.negative = req.negative;
  if (req.width) values.width = req.width;
  if (req.height) values.height = req.height;
  if (seed !== undefined) values.seed = seed;
  if (req.steps !== undefined) values.steps = req.steps;
  if (req.cfg !== undefined) values.cfg = req.cfg;
  if (req.sampler) values.sampler_name = req.sampler;
  if (req.scheduler) values.scheduler = req.scheduler;
  if (req.image && mapping.slots.image_1) values.image_1 = req.image;
  if (req.mask && mapping.slots.mask) values.mask = req.mask;
  // extra 是逃生口：工作流里认出什么槽，就允许调用方填什么（length、denoise、fps……）
  for (const [key, value] of Object.entries(req.extra ?? {})) {
    if (mapping.slots[key] && value !== undefined && value !== null) values[key] = value;
  }
  for (const [index, lora] of (req.loras ?? []).entries()) {
    if (mapping.slots[`lora_${index + 1}_name`]) values[`lora_${index + 1}_name`] = lora.name;
    if (mapping.slots[`lora_${index + 1}_strength`] && lora.strength !== undefined) {
      values[`lora_${index + 1}_strength`] = lora.strength;
    }
  }

  try {
    filled = await fillWorkflow(workflow, mapping, values, {
      uploadImage: async (path) => client.upload(path, signal),
      inlineBase64: (path) => client.inline(path),
    });
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error), backend: 'comfy' };
  }
  }

  const notes = [...(mapping?.warnings ?? []), ...filled.notes, ...loadNotes];
  if (!filled.applied.some((item) => item.startsWith('prompt→'))) {
    return { ok: false, error: `工作流「${name}」没有可写的提示词入口：${describeSlots(mapping!)}`, backend: 'comfy' };
  }

  let taskId = '';
  try {
    taskId = await client.submit(filled.prompt, signal);
    const item = await client.waitFor(taskId, signal, backend.timeoutMs);
    const outputs = client.collectFiles(item);
    if (!outputs.length) return { ok: false, error: 'ComfyUI 跑完了但没产出文件', backend: 'comfy' };
    const files: GenFile[] = [];
    for (const [index, file] of outputs.entries()) {
      const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.filename)?.[1] ?? 'png').toLowerCase();
      const target = join(outDir, `comfy-${safeName(req.prompt, 20)}-${stamp()}-${index}.${ext}`);
      const bytes = await client.download(file, target, signal);
      files.push({ path: target, bytes, kind: /mp4|webm|mov|gif|webp/.test(ext) ? 'video' : 'image' });
    }
    return {
      ok: true,
      backend: 'comfy',
      files,
      seed,
      width: req.width,
      height: req.height,
      notes: [...notes, `工作流 ${name} · 任务 ${taskId}`],
      meta: { workflow: name, applied: filled.applied, taskId },
    };
  } catch (error: any) {
    const raw = String(error?.message ?? error);
    // 现拼的工作流出错时，把实际用到的模型点出来 —— 换底模是唯一出路时别让人猜。
    const used = (workflowMeta?.used ?? {}) as Record<string, string | undefined>;
    const parts = Object.entries(used)
      .filter(([key]) => key !== 'accelLora')
      .map(([key, value]) => `${key}=${value}`);
    const context = parts.length ? `（这次用的：${parts.join('，')}）` : '';
    return { ok: false, error: raw + context, backend: 'comfy' };
  }
}

/** LoadImage / ETN_* 都直接吃 png-jpg-webp，不需要在这里转格式。 */

/* ────────────────────────────── SD-WebUI ────────────────────────────── */

async function runSdWebui(req: GenRequest, ctx: ProviderContext): Promise<GenResult> {
  const { backend, outDir, signal } = ctx;
  const wanted = requestSize(req, backend);
  const size = snapSize(wanted.width, wanted.height, [], 8);
  const common: any = {
    prompt: req.prompt,
    negative_prompt: req.negative ?? '',
    width: size.width,
    height: size.height,
    steps: req.steps,
    cfg_scale: req.cfg,
    seed: req.seed ?? -1,
    sampler_name: req.sampler,
    batch_size: Math.max(1, Math.min(8, req.n ?? 1)),
  };
  if (req.model) common.override_settings = { sd_model_checkpoint: req.model };
  const endpoint = req.image ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img';
  if (req.image) {
    common.init_images = [b64(readFileSync(req.image))];
    common.denoising_strength = req.strength ?? 0.55;
    if (req.mask) {
      common.mask = b64(readFileSync(req.mask));
      common.inpaint_full_res = true;
      common.inpaint_full_res_padding = 32;
    }
  }
  const r = await httpJson(joinUrl(backend.baseUrl, endpoint), { method: 'POST', body: common, signal, timeoutMs: backend.timeoutMs });
  if (!r.ok) {
    const hint = /refused|10061/i.test(r.error ?? '') ? '（SD-WebUI 没在跑，注意要带 --api）' : '';
    return { ok: false, error: describeFailure(r, 'SD-WebUI 出图') + hint, backend: 'sdwebui' };
  }
  const images = Array.isArray(r.json?.images) ? r.json.images : [];
  if (!images.length) return { ok: false, error: 'SD-WebUI 没有返回图片', backend: 'sdwebui' };
  const files: GenFile[] = images.map((text: string, index: number) => {
    const bytes = decodeB64(stripDataUri(text));
    const path = saveBytes(bytes, outDir, `sd-${safeName(req.prompt, 20)}`, 'png');
    return { path, bytes: bytes.length, width: size.width, height: size.height, kind: 'image' as const };
  });
  let info: any = null;
  try {
    info = r.json?.info ? JSON.parse(r.json.info) : null;
  } catch {
    info = null;
  }
  return { ok: true, backend: 'sdwebui', files, seed: info?.seed ?? req.seed, width: size.width, height: size.height, meta: { info } };
}

/* ────────────────────────────── OpenAI 兼容 ────────────────────────────── */

async function runOpenai(req: GenRequest, ctx: ProviderContext): Promise<GenResult> {
  const { backend, outDir, signal } = ctx;
  if (!backend.apiKey) return { ok: false, error: '没填 API Key', backend: 'openai' };
  const model = req.model || backend.model || 'gpt-image-1';
  const dalle3 = /dall-e-3/i.test(model);
  const allowed: Array<[number, number]> = dalle3
    ? [[1024, 1024], [1792, 1024], [1024, 1792]]
    : [[1024, 1024], [1536, 1024], [1024, 1536]];
  const wanted = requestSize(req, backend);
  const snapped = snapSize(wanted.width, wanted.height, allowed);
  const headers = { Authorization: `Bearer ${backend.apiKey}` };
  const n = Math.max(1, Math.min(dalle3 ? 1 : 4, req.n ?? 1));

  let r;
  if (req.image) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', req.prompt);
    form.append('n', String(n));
    form.append('size', formatSizeOf(snapped));
    if (!dalle3) form.append('response_format', 'b64_json');
    form.append('image', new Blob([readFileSync(req.image)], { type: 'image/png' }), 'image.png');
    if (req.mask) form.append('mask', new Blob([readFileSync(req.mask)], { type: 'image/png' }), 'mask.png');
    r = await httpJson(joinUrl(backend.baseUrl, '/images/edits'), { method: 'POST', form, headers, signal, timeoutMs: backend.timeoutMs });
  } else {
    r = await httpJson(joinUrl(backend.baseUrl, '/images/generations'), {
      method: 'POST',
      headers,
      signal,
      timeoutMs: backend.timeoutMs,
      body: {
        model,
        prompt: req.prompt,
        n,
        size: formatSizeOf(snapped),
        response_format: dalle3 ? 'url' : 'b64_json',
        ...(req.extra?.quality ? { quality: req.extra.quality } : {}),
      },
    });
  }
  if (!r.ok) return { ok: false, error: describeFailure(r, 'OpenAI 兼容接口出图'), backend: 'openai' };
  const data = Array.isArray(r.json?.data) ? r.json.data : [];
  if (!data.length) return { ok: false, error: '接口没有返回图片', backend: 'openai' };
  const files: GenFile[] = [];
  for (const entry of data) {
    if (typeof entry?.b64_json === 'string') {
      const bytes = decodeB64(stripDataUri(entry.b64_json));
      const path = saveBytes(bytes, outDir, `oa-${safeName(req.prompt, 20)}`, 'png');
      files.push({ path, bytes: bytes.length, kind: 'image' });
    } else if (typeof entry?.url === 'string') {
      const file = await downloadTo(entry.url, outDir, `oa-${safeName(req.prompt, 20)}`, signal);
      files.push({ path: file.path, bytes: file.bytes, kind: 'image' });
    }
  }
  if (!files.length) return { ok: false, error: '接口返回里没有可用的图片数据', backend: 'openai' };
  return {
    ok: true,
    backend: 'openai',
    files,
    width: snapped.width,
    height: snapped.height,
    notes: snapped.adjusted ? [`尺寸吸到了 ${snapped.width}x${snapped.height}（该模型只接受固定档位）`] : [],
    meta: { model },
  };
}

/* ────────────────────────────── Google Gemini ────────────────────────────── */

async function runGemini(req: GenRequest, ctx: ProviderContext): Promise<GenResult> {
  const { backend, outDir, signal } = ctx;
  if (!backend.apiKey) return { ok: false, error: '没填 API Key', backend: 'gemini' };
  const model = req.model || backend.model || 'gemini-2.5-flash-image';
  const parts: any[] = [{ text: req.prompt }];
  if (req.image) {
    parts.push({ inline_data: { mime_type: 'image/png', data: b64(readFileSync(req.image)) } });
  }
  const r = await httpJson(joinUrl(backend.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`), {
    method: 'POST',
    headers: { 'x-goog-api-key': backend.apiKey },
    body: { contents: [{ role: 'user', parts }] },
    signal,
    timeoutMs: backend.timeoutMs,
  });
  if (!r.ok) return { ok: false, error: describeFailure(r, 'Gemini 出图'), backend: 'gemini' };
  const candidates = Array.isArray(r.json?.candidates) ? r.json.candidates : [];
  const replyParts = candidates[0]?.content?.parts ?? [];
  const files: GenFile[] = [];
  const texts: string[] = [];
  for (const part of replyParts) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (typeof inline?.data === 'string') {
      const bytes = decodeB64(stripDataUri(inline.data));
      const path = saveBytes(bytes, outDir, `gem-${safeName(req.prompt, 20)}`, imageExtFromMime(inline.mimeType ?? inline.mime_type));
      files.push({ path, bytes: bytes.length, kind: 'image' });
    } else if (typeof part?.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  if (!files.length) {
    return { ok: false, error: `Gemini 只回了文字，没有图片：${texts.join(' ').slice(0, 300) || '（空）'}`, backend: 'gemini' };
  }
  return {
    ok: true,
    backend: 'gemini',
    files,
    notes: ['Gemini 不接受尺寸参数，出图尺寸由模型决定', ...(texts.length ? [`附言：${texts.join(' ').slice(0, 200)}`] : [])],
    meta: { model },
  };
}

/* ────────────────────────────── 通义万相 ────────────────────────────── */

async function runDashscope(req: GenRequest, ctx: ProviderContext): Promise<GenResult> {
  const { backend, outDir, signal } = ctx;
  if (!backend.apiKey) return { ok: false, error: '没填 API Key', backend: 'dashscope' };
  if (req.image || req.mask) return { ok: false, error: '万相这里只接了文生图；图生图要另配模型接口', backend: 'dashscope' };
  const model = req.model || backend.model || 'wanx2.2-t2i-flash';
  const wanted = requestSize(req, backend);
  const snapped = snapSize(wanted.width, wanted.height, [[1024, 1024], [720, 1280], [1280, 720]]);
  const headers = { Authorization: `Bearer ${backend.apiKey}`, 'X-DashScope-Async': 'enable' };
  const r = await httpJson(joinUrl(backend.baseUrl, '/api/v1/services/aigc/text2image/image-synthesis'), {
    method: 'POST',
    headers,
    body: {
      model,
      input: { prompt: req.prompt, ...(req.negative ? { negative_prompt: req.negative } : {}) },
      parameters: { size: `${snapped.width}*${snapped.height}`, n: Math.max(1, Math.min(4, req.n ?? 1)), ...(req.seed !== undefined ? { seed: req.seed } : {}) },
    },
    signal,
    timeoutMs: 60_000,
  });
  if (!r.ok) return { ok: false, error: describeFailure(r, '万相提交任务'), backend: 'dashscope' };
  const taskId = r.json?.output?.task_id;
  if (typeof taskId !== 'string' || !taskId) return { ok: false, error: '万相没返回任务编号', backend: 'dashscope' };

  const deadline = Date.now() + backend.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000, signal);
    const poll = await httpJson(joinUrl(backend.baseUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}`), {
      headers: { Authorization: `Bearer ${backend.apiKey}` },
      signal,
      timeoutMs: 30_000,
    });
    if (!poll.ok) return { ok: false, error: describeFailure(poll, '查万相任务'), backend: 'dashscope' };
    const status = String(poll.json?.output?.task_status ?? '');
    if (status === 'SUCCEEDED') {
      const results = Array.isArray(poll.json?.output?.results) ? poll.json.output.results : [];
      const urls = results.map((item: any) => item?.url).filter((url: any) => typeof url === 'string');
      if (!urls.length) return { ok: false, error: '万相成功但没给图片地址', backend: 'dashscope' };
      const files: GenFile[] = [];
      for (const url of urls) {
        const file = await downloadTo(url, outDir, `wan-${safeName(req.prompt, 20)}`, signal);
        files.push({ path: file.path, bytes: file.bytes, width: snapped.width, height: snapped.height, kind: 'image' });
      }
      return { ok: true, backend: 'dashscope', files, width: snapped.width, height: snapped.height, seed: req.seed, meta: { model, taskId } };
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const message = poll.json?.output?.message ?? poll.json?.message ?? '';
      return { ok: false, error: `万相任务 ${status}：${String(message).slice(0, 200)}`, backend: 'dashscope' };
    }
  }
  return { ok: false, error: `万相任务 ${taskId} 超时（${Math.round(backend.timeoutMs / 1000)} 秒），可稍后重试`, backend: 'dashscope' };
}

/* ────────────────────────────── 分发与体检 ────────────────────────────── */

const RUNNERS: Record<string, (req: GenRequest, ctx: ProviderContext) => Promise<GenResult>> = {
  comfy: runComfy,
  sdwebui: runSdWebui,
  openai: runOpenai,
  gemini: runGemini,
  dashscope: runDashscope,
};

export function backendName(cfg: StudioConfig, requested?: string): { name: string; backend: BackendCfg } | { error: string } {
  const name = String(requested ?? cfg.defaultBackend ?? 'comfy').trim().toLowerCase();
  const backend = cfg.backends[name];
  if (!backend) return { error: `没有这个后端：${name}（可选 comfy / sdwebui / openai / gemini / dashscope）` };
  if (!backend.enabled) return { error: `后端 ${name} 没启用，去设置页打开` };
  return { name, backend };
}

export async function runBackend(
  name: string,
  req: GenRequest,
  ctx: ProviderContext,
): Promise<GenResult> {
  const runner = RUNNERS[name];
  if (!runner) return { ok: false, error: `没有这个后端：${name}`, backend: name };
  if (!req.prompt || !String(req.prompt).trim()) return { ok: false, error: 'prompt 不能为空', backend: name };
  try {
    return await runner(req, ctx);
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error), backend: name };
  }
}

/** 各后端的健康检查：能便宜查到的就查，查不到只报「已配置」。 */
export async function health(name: string, backend: BackendCfg, signal?: AbortSignal): Promise<any> {
  const base = { backend: name, enabled: backend.enabled, baseUrl: backend.baseUrl, local: CAPS[name]?.local ?? false };
  try {
    if (name === 'comfy') {
      const client = new ComfyClient(backend.baseUrl, 10_000);
      const stats = await client.stats(signal);
      const device = stats?.devices?.[0] ?? {};
      return {
        ...base,
        online: true,
        version: stats?.system?.comfyui_version,
        device: String(device.name ?? '').split(':')[0],
        vramFreeMiB: Math.round(Number(device.vram_free ?? 0) / 1024 / 1024),
        vramTotalMiB: Math.round(Number(device.vram_total ?? 0) / 1024 / 1024),
      };
    }
    if (name === 'sdwebui') {
      const r = await httpJson(joinUrl(backend.baseUrl, '/sdapi/v1/sd-models'), { signal, timeoutMs: 15_000 });
      const models = Array.isArray(r.json) ? r.json.map((m: any) => m.title ?? m.model_name) : [];
      return { ...base, online: r.ok, models: models.slice(0, 20) };
    }
    if (name === 'openai') {
      if (!backend.apiKey) return { ...base, online: null, reason: '没填 API Key' };
      const r = await httpJson(joinUrl(backend.baseUrl, '/models'), {
        headers: { Authorization: `Bearer ${backend.apiKey}` },
        signal,
        timeoutMs: 10_000,
      });
      return { ...base, online: r.ok, model: backend.model, reason: r.ok ? undefined : describeFailure(r, '查模型列表') };
    }
    if (name === 'gemini') {
      if (!backend.apiKey) return { ...base, online: null, reason: '没填 API Key' };
      const r = await httpJson(joinUrl(backend.baseUrl, '/v1beta/models'), {
        headers: { 'x-goog-api-key': backend.apiKey },
        signal,
        timeoutMs: 10_000,
      });
      return { ...base, online: r.ok, model: backend.model, reason: r.ok ? undefined : describeFailure(r, '查模型列表') };
    }
    if (name === 'dashscope') {
      return { ...base, online: null, model: backend.model, reason: backend.apiKey ? '异步接口，提交时才知道通不通' : '没填 API Key' };
    }
  } catch (error: any) {
    return { ...base, online: false, reason: String(error?.message ?? error) };
  }
  return { ...base, online: null };
}

export { listWorkflows };
