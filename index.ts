/*! 画室（studio）· 父插件：一套后端配置，供 image / video 两个子插件共用。
 *
 * 父级只做三件事：存配置、体检每个后端、把工作流槽位摊开给人核对。
 * 真正的出图和拍视频在 sub/image 与 sub/video 里，各自只读这里的配置。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from 'whalelife';
import { applyPatch, BACKEND_NAMES, normalize, publicConfig, resolvePython, type StudioConfig } from './lib/config.ts';
import { describeSlots, inferMapping } from './lib/comfy-workflow.ts';
import { ComfyClient } from './lib/comfy.ts';
import { buildWorkflow } from './lib/graph.ts';
import { clearInventoryCache, inventory, type ModelInventory } from './lib/models.ts';
import { backendName, health, listWorkflows, loadWorkflow, runBackend } from './lib/providers.ts';
import { requestOf } from './lib/request.ts';
import type { GenResult } from './lib/types.ts';
import { renderSettings } from './lib/ui.ts';
import { createWordEngine } from './lib/words.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = '/plugins/studio/';

export type WorkflowEntry = {
  name: string;
  format: 'api' | 'canvas';
  kind?: 'image' | 'video';
  slots?: string;
  notes?: string[];
  error?: string;
  /** 同一份工作流的另一种存在形式（api 与画布同名时） */
  alternatives?: string[];
};

export type StudioService = {
  config(): Promise<StudioConfig>;
  save(patch: any): Promise<StudioConfig>;
  paths(): Promise<{ dataDir: string; outDir: string; workflowsDir: string; canvasDir: string; modelsDir: string; mappingsDir: string; python: string; script: string }>;
  /** 列出能用工作流（插件目录 + ComfyUI 画布目录两边），可选只挑出图或只挑出视频的。 */
  workflows(options?: { kind?: 'image' | 'video'; probe?: boolean }): Promise<WorkflowEntry[]>;
  /** 本地模型清单（ComfyUI 认得的 + 文件系统兜底）。 */
  models(options?: { refresh?: boolean }): Promise<ModelInventory>;
  /** 出图后端体检：不传 name 就查 defaultBackend。online=true 可用，false 连不上，null 配置了但没法便宜地探。 */
  health(name?: string): Promise<any>;
  /**
   * 公开出图：给别的插件直接要一张图，不必走工具调用。
   * 参数与 draw 一致（prompt/negative/width/height/model/workflow……），返回归一化后的 GenResult。
   */
  generate(input: any, signal?: AbortSignal): Promise<GenResult>;
};

/** ComfyUI 的画布工作流目录：配置优先，否则按常见安装位置猜。 */
function guessDir(kind: 'workflows' | 'models'): string {
  const roots = [String(process.env.COMFY_ROOT ?? '').trim(), 'D:\\ComfyUI', 'C:\\ComfyUI'].filter(Boolean);
  for (const root of roots) {
    const candidate = kind === 'workflows' ? join(root, 'user', 'default', 'workflows') : join(root, 'models');
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

export function apply(ctx: Context) {
  const dataDir = join(HERE, 'data');

  const abs = (value: string, fallback: string) => {
    const raw = String(value ?? '').trim() || fallback;
    return isAbsolute(raw) ? raw : join(dataDir, raw);
  };

  const readConfig = async (): Promise<StudioConfig> => {
    let stored: any = null;
    try {
      stored = await ctx.config.read('config.json');
    } catch {
      stored = null;
    }
    return normalize(stored);
  };

  const pathsOf = async () => {
    const cfg = await readConfig();
    const configured = String(cfg.backends.comfy.canvasDir ?? '').trim();
    const canvasDir = configured ? abs(configured, '') : guessDir('workflows');
    const configuredModels = String(cfg.backends.comfy.modelsDir ?? '').trim();
    const modelsDir = configuredModels ? abs(configuredModels, '') : guessDir('models');
    return {
      dataDir,
      outDir: abs(cfg.outputDir, 'out'),
      workflowsDir: abs(cfg.backends.comfy.workflowsDir, 'workflows'),
      canvasDir: canvasDir && existsSync(canvasDir) ? canvasDir : '',
      modelsDir: modelsDir && existsSync(modelsDir) ? modelsDir : '',
      mappingsDir: join(dataDir, 'mappings'),
      python: resolvePython(cfg, process.env.COMFY_ROOT ?? ''),
      script: join(HERE, 'imgtool.py'),
    };
  };

  /** 一份工作流能不能用：读进来（画布就地转 API）+ 推断槽位，顺手把映射缓存存好。 */
  const inspectWorkflow = async (
    name: string,
    paths: { workflowsDir: string; canvasDir: string; mappingsDir: string },
    client: ComfyClient,
    signal?: AbortSignal,
  ): Promise<WorkflowEntry> => {
    try {
      const loaded = await loadWorkflow(name, { ...paths, client, signal });
      const mapping = inferMapping(loaded.workflow);
      return {
        name,
        format: loaded.format,
        kind: mapping.outputKind,
        slots: describeSlots(mapping),
        notes: loaded.notes,
      };
    } catch (error: any) {
      return { name, format: 'api', error: String(error?.message ?? error) };
    }
  };

  const service: StudioService = {
    config: readConfig,
    save: async (patch: any) => {
      const next = applyPatch(await readConfig(), patch);
      await ctx.config.save('config.json', next);
      return next;
    },
    paths: pathsOf,
    workflows: async (options: any = {}) => {
      const cfg = await readConfig();
      const paths = await pathsOf();
      const client = new ComfyClient(cfg.backends.comfy.baseUrl, 20_000);
      const names: string[] = [];
      for (const name of listWorkflows(paths.workflowsDir)) names.push(name);
      if (paths.canvasDir) {
        for (const name of listWorkflows(paths.canvasDir)) if (!names.includes(name)) names.push(name);
      }
      const entries: WorkflowEntry[] = [];
      for (const name of names) entries.push(await inspectWorkflow(name, paths, client, ctx.signal));

      // 同一份工作流可能既有 API 版又有画布版：合并成一条，优先用能直接跑的那个。
      const groups = new Map<string, WorkflowEntry[]>();
      for (const entry of entries) {
        const base = entry.name.replace(/\.api\.json$/i, '').replace(/\.json$/i, '');
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base)!.push(entry);
      }
      const merged: WorkflowEntry[] = [];
      for (const group of groups.values()) {
        const usable = group.filter((item) => !item.error);
        const best = usable.find((item) => item.format === 'api') ?? usable[0] ?? group[0];
        merged.push({ ...best, alternatives: group.filter((item) => item !== best).map((item) => item.name) });
      }
      const kind = options?.kind;
      return kind ? merged.filter((entry) => entry.kind === kind) : merged;
    },
    models: async (options: any = {}) => {
      const cfg = await readConfig();
      const paths = await pathsOf();
      if (options?.refresh) clearInventoryCache();
      return inventory({
        baseUrl: cfg.backends.comfy.baseUrl,
        modelsDir: paths.modelsDir,
        signal: ctx.signal,
        refresh: options?.refresh,
      });
    },
    health: async (name?: string) => {
      const cfg = await readConfig();
      const picked = backendName(cfg, name);
      if ('error' in picked) {
        return { backend: String(name ?? cfg.defaultBackend ?? 'comfy'), enabled: false, online: false, reason: picked.error };
      }
      return health(picked.name, picked.backend, ctx.signal);
    },
    generate: async (input: any, signal?: AbortSignal) => {
      const cfg = await readConfig();
      const paths = await pathsOf();
      const picked = backendName(cfg, input?.backend);
      if ('error' in picked) return { ok: false, error: picked.error };
      return runBackend(picked.name, requestOf(input), {
        backend: picked.backend,
        cfg,
        outDir: paths.outDir,
        workflowsDir: paths.workflowsDir,
        canvasDir: paths.canvasDir,
        modelsDir: paths.modelsDir,
        mappingsDir: paths.mappingsDir,
        signal: signal ?? ctx.signal,
      });
    },
  };
  ctx.provide('studio', service);

  // 提示词小抄：词库引擎常驻父级，画画子插件和「提示词小抄」设置页共用。
  // 词库与补词配置归子插件（sub/promptkit/data），父级只读，不写用户数据。
  const wordsFile = join(HERE, 'sub', 'promptkit', 'data', 'prompts.json');
  const wordsConfig = join(HERE, 'sub', 'promptkit', 'data', 'config.json');
  if (existsSync(wordsFile)) {
    ctx.provide(
      'promptkit',
      createWordEngine({
        file: wordsFile,
        readConfig: async () => {
          try {
            return JSON.parse(readFileSync(wordsConfig, 'utf8'));
          } catch {
            return null;
          }
        },
      }),
    );
  }

  ctx.tools.register({
    name: 'studio_status',
    description:
      '查画室的后端通不通：ComfyUI 直连、SD-WebUI、OpenAI 兼容、Gemini、通义万相。' +
      '同时给出默认后端、本地模型数量、可用工作流和显存。出图前想确认环境时先看这个。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const cfg = await readConfig();
      const paths = await pathsOf();
      const checks = await Promise.all(BACKEND_NAMES.map((name) => health(name, cfg.backends[name], ctx.signal)));
      const lines: string[] = [`默认后端：${cfg.defaultBackend}`];
      for (const check of checks) {
        if (!check.enabled) {
          lines.push(`· ${check.backend}：未启用`);
          continue;
        }
        const state = check.online === true ? '在线' : check.online === false ? '离线' : '已配置';
        const extras = [
          check.version ? `v${check.version}` : '',
          check.device ?? '',
          check.vramFreeMiB ? `显存空闲 ${check.vramFreeMiB}/${check.vramTotalMiB} MiB` : '',
          check.reason ?? '',
        ].filter(Boolean);
        lines.push(`· ${check.backend}：${state}${extras.length ? '（' + extras.join('，') + '）' : ''}`);
      }
      const all = await service.workflows({});
      const usable = all.filter((entry) => !entry.error);
      lines.push(`工作流：${usable.length ? usable.map((entry) => `${entry.name}（${entry.format === 'canvas' ? '画布→自动转' : 'API'}·${entry.kind}）`).join('、') : '（空，可直接传 model 现场拼）'}`);
      try {
        const inv = await service.models({});
        lines.push(
          `本地模型：checkpoint ${inv.checkpoints.length} · unet ${inv.unets.length} · vae ${inv.vaes.length} · 文本编码器 ${inv.clips.length} · LoRA ${inv.loras.length}`,
        );
        if (inv.modelsDir) lines.push(`模型目录：${inv.modelsDir}（来源 ${inv.source}）`);
        if (inv.notes.length) lines.push(...inv.notes.map((item) => `注意：${item}`));
      } catch (error: any) {
        lines.push(`本地模型读不出来：${String(error?.message ?? error)}`);
      }
      if (paths.canvasDir) lines.push(`ComfyUI 工作流目录：${paths.canvasDir}`);
      if (cfg.video.backend) lines.push(`视频后端：${cfg.video.backend}`);
      lines.push(paths.python ? `Python：${paths.python}` : 'Python：没找到（看图/画蒙版不可用）');
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'studio_workflow',
    description:
      '列出 ComfyUI 能用的工作流（插件目录里的 API 格式 + ComfyUI 自己存的画布格式，后者会自动转），' +
      '或摊开某一份的槽位（提示词写进哪个节点、尺寸和种子在哪、到底出图还是出视频）。' +
      '换了工作流之后提示词写不进去，先用它核对。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: '工作流文件名；省略只列清单' },
        kind: { type: 'string', enum: ['image', 'video'], description: '只看某一类' },
      },
      additionalProperties: false,
    },
    run: async (args: any) => {
      const wanted = String(args?.workflow ?? '').trim();
      const all = await service.workflows({ kind: args?.kind });
      if (!wanted) {
        if (!all.length) return '一份工作流都没找到：插件目录和 ComfyUI 的 workflows 目录都是空的。';
        return [
          '可用工作流：',
          ...all.map((entry) => {
            if (entry.error) return `· ${entry.name}：不可用（${entry.error}）`;
            return `· ${entry.name}：${entry.format === 'canvas' ? '画布→自动转 API' : 'API 格式'}，出${entry.kind === 'video' ? '视频' : '图'}`;
          }),
          '要看某一份的槽位就再传 workflow；只想看图片/视频的可以传 kind。',
        ].join('\n');
      }
      const entry = all.find((item) => item.name === wanted);
      if (!entry) return `没有这份工作流：${wanted}。现有：${all.map((item) => item.name).join('、')}`;
      if (entry.error) return `${wanted} 不可用：${entry.error}`;
      const lines = [
        `${wanted}：${entry.format === 'canvas' ? '画布格式，已自动转成 API' : 'API 格式'}，输出${entry.kind === 'video' ? '视频' : '图片'}`,
        `槽位：${entry.slots}`,
      ];
      if (entry.notes?.length) lines.push(...entry.notes.map((item) => `说明：${item}`));
      return lines.join('\n');
    },
  });

  const sizeText = (bytes?: number) => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '');

  ctx.tools.register({
    name: 'studio_models',
    description:
      '列出本机 ComfyUI 真正能用的模型：checkpoint、unet（扩散模型）、VAE、文本编码器、LoRA，带家族判断和体积。' +
      '要给某个模型配工作流，先用它看有什么；想重新扫一遍传 refresh。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '忽略缓存重新扫' } },
      additionalProperties: false,
    },
    run: async (args: any) => {
      const inv = await service.models({ refresh: Boolean(args?.refresh) });
      const rows = (list: any[]) => list.map((item) => ({ name: item.name, family: item.family, size: sizeText(item.bytes) }));
      return {
        status: 'ok',
        source: inv.source,
        modelsDir: inv.modelsDir,
        counts: {
          checkpoints: inv.checkpoints.length,
          unets: inv.unets.length,
          vaes: inv.vaes.length,
          clips: inv.clips.length,
          loras: inv.loras.length,
        },
        checkpoints: rows(inv.checkpoints),
        unets: rows(inv.unets),
        vaes: rows(inv.vaes),
        clips: rows(inv.clips),
        loras: rows(inv.loras),
        clipTypes: inv.clipTypes,
        notes: inv.notes,
        hint: '出图可以不指定工作流：draw(prompt=…, model="某个 unet 或 checkpoint") 会按家族自动拼一份；想先看拼出来什么样就调 studio_build。',
      };
    },
  });

  ctx.tools.register({
    name: 'studio_build',
    description:
      '按本地模型拼一份能直接跑的出图工作流（现在覆盖 MOSS / Qwen-Image / Flux / SDXL / SD1.5）。' +
      '给 model（unet 或 checkpoint 文件名）就能自动配 VAE、文本编码器、步数、CFG、采样器；' +
      'save_as 传了就写进 data/workflows，之后 draw 用 workflow 引用它。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'unet 或 checkpoint 的文件名（studio_models 里能看到）' },
        prompt: { type: 'string', description: '写进正面提示词的示例文本' },
        negative: { type: 'string', description: '负面提示词' },
        family: { type: 'string', description: '强制指定家族：moss / qwen / flux / sdxl / sd15' },
        clip: { type: 'string', description: '指定文本编码器（默认按家族配）' },
        vae: { type: 'string', description: '指定 VAE（默认按家族配）' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        steps: { type: 'integer' },
        cfg: { type: 'number' },
        sampler: { type: 'string' },
        scheduler: { type: 'string' },
        save_as: { type: 'string', description: '存成 data/workflows 里的文件名，省略不存' },
        preview: { type: 'boolean', description: '把整份工作流 JSON 也返回' },
      },
      required: ['model'],
      additionalProperties: false,
    },
    run: async (args: any) => {
      const inv = await service.models({});
      const said = String(args?.model ?? '').trim();
      if (!said) return { status: 'error', error: '要给 model（studio_models 里能看到有哪些）' };
      // model 既可能是 unet，也可能是 checkpoint：按清单决定走哪条
      const where = inv.checkpoints.some((item) => item.name === said) ? 'checkpoint' : 'unet';
      const builtFinal = buildWorkflow(
        {
          prompt: String(args?.prompt ?? 'a photo of a young woman, natural light'),
          negative: args?.negative,
          ...(where === 'checkpoint' ? { checkpoint: said } : { unet: said }),
          family: args?.family,
          clip: args?.clip,
          vae: args?.vae,
          width: args?.width,
          height: args?.height,
          steps: args?.steps,
          cfg: args?.cfg,
          sampler: args?.sampler,
          scheduler: args?.scheduler,
        },
        inv,
      );
      if (builtFinal.error) return { status: 'error', error: builtFinal.error };

      let slots = '';
      try {
        slots = describeSlots(inferMapping(builtFinal.api));
      } catch (error: any) {
        return { status: 'error', error: `拼出来了但槽位认不出：${String(error?.message ?? error)}` };
      }

      let saved = '';
      const saveAs = String(args?.save_as ?? '').trim();
      if (saveAs) {
        const file = saveAs.toLowerCase().endsWith('.json') ? saveAs : `${saveAs}.json`;
        const paths = await pathsOf();
        mkdirSync(paths.workflowsDir, { recursive: true });
        writeFileSync(join(paths.workflowsDir, file), JSON.stringify(builtFinal.api, null, 2), 'utf8');
        saved = join(paths.workflowsDir, file);
      }

      return {
        status: 'ok',
        family: builtFinal.family,
        used: builtFinal.used,
        defaults: builtFinal.defaults,
        nodes: Object.keys(builtFinal.api).length,
        slots,
        saved,
        notes: builtFinal.notes,
        workflow: args?.preview ? builtFinal.api : undefined,
        hint: saved
          ? `已存成 ${saved}：draw 传 workflow="${saveAs.toLowerCase().endsWith('.json') ? saveAs : saveAs + '.json'}" 即可；或者直接 draw(model="...") 现场拼。`
          : '没存盘：想复用就传 save_as；也可以直接 draw 时传 model，插件会按同一套规则现拼。',
      };
    },
  });

  const json = (res: any, code: number, value: any) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
  };

  const readBody = async (req: any, signal: AbortSignal) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 256 * 1024) throw new Error('提交的内容太大');
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('提交的内容不是合法 JSON');
    }
  };

  ctx.web.page(
    BASE + 'settings',
    async (_req, res, { signal }) => {
      const cfg = await readConfig();
      const paths = await pathsOf();
      const workflows = listWorkflows(paths.workflowsDir);
      let checks: Record<string, any> = {};
      try {
        const results = await Promise.all(BACKEND_NAMES.map((name) => health(name, cfg.backends[name], signal)));
        checks = Object.fromEntries(results.map((item) => [item.backend, item]));
      } catch {
        checks = {};
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(renderSettings({ cfg, publicCfg: publicConfig(cfg), workflows, checks }));
    },
    { title: '画室设置', settings: true, navigation: true },
  );

  ctx.web.api(BASE + 'config', async (req, res, { signal }) => {
    try {
      const patch = await readBody(req, signal);
      const next = applyPatch(await readConfig(), patch);
      await ctx.config.save('config.json', next);
      json(res, 200, { ok: true, config: publicConfig(next) });
    } catch (error: any) {
      json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(BASE + 'health', async (req, res, { signal }) => {
    try {
      const url = new URL(String(req.url ?? ''), 'http://localhost');
      const name = String(url.searchParams.get('name') ?? '').trim();
      const cfg = await readConfig();
      if (name && !(BACKEND_NAMES as readonly string[]).includes(name)) {
        return json(res, 400, { ok: false, error: `没有这个后端：${name}` });
      }
      if (name) {
        const result = await health(name, cfg.backends[name], signal);
        return json(res, 200, { ok: true, ...result });
      }
      const results = await Promise.all(BACKEND_NAMES.map((item) => health(item, cfg.backends[item], signal)));
      json(res, 200, { ok: true, backends: results });
    } catch (error: any) {
      json(res, 200, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.logger.info(`画室已加载：${join(HERE, 'data')}`);
}
