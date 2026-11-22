/*! 画室（studio）：ComfyUI API 工作流的校验、槽位识别与填充。
 *
 * 和上游那版的三处关键差别：
 *   1. 正面提示词默认 replace（上游默认 append，会把工作流里烤死的主体描述静默拼进每一张图）；
 *   2. 图片/蒙版区分「服务端文件名」和「base64 内联」，LoadImage 走真实上传，不再把本地路径塞进文件名槽；
 *   3. 认不出提示词入口时明确报错，不假装成功（否则上层填 prompt 会在下游炸掉）。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type SlotKind = 'text' | 'int' | 'float' | 'image-name' | 'image-b64' | 'mask-name' | 'mask-b64' | 'lora-name';
export type SlotMode = 'replace' | 'append' | 'preserve';
export type SlotTarget = { node: string; input: string; kind: SlotKind; mode: SlotMode };
export type Mapping = {
  version: 1;
  outputNode: string;
  outputKind: 'image' | 'video';
  slots: Record<string, SlotTarget[]>;
  warnings: string[];
};

export class WorkflowError extends Error {}

const MAX_NODES = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

/** 提示词字段的优先顺序：先认语义明确的，再认各家自定义节点的常见命名。 */
const TEXT_FIELDS = ['prompt', 'text', 't5xxl', 'clip_l', 'text_g', 'text_l', 'positive_prompt', 'string', 'value'];
const SAMPLER_HINTS = ['sampler', 'guider', 'samplercustom', 'cfguider'];
const IMAGE_OUTPUT = ['SaveImage', 'PreviewImage'];
const VIDEO_OUTPUT = ['SaveVideo', 'SaveWEBM', 'SaveAnimatedWEBP', 'VHS_VideoCombine'];
const LATENT_NODES = ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage', 'EmptyHunyuanLatentVideo', 'EmptyMochiLatentVideo', 'ResolutionMaster', 'EmptyLatentAudio', 'EmptyMiniMaxH3LatentAV', 'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxMusic3LatentAudio'];

export function stableStringify(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function fingerprint(workflow: any): string {
  return createHash('sha256').update(stableStringify(workflow)).digest('hex');
}

function isLink(value: any): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
}

/** 严格校验一份「API 格式」工作流；画布格式、坏连线、超大文件都在这里挡住。 */
export function parseApiWorkflow(input: any): Record<string, any> {
  let value = input;
  if (typeof value === 'string') {
    const raw = value.replace(/^\uFEFF/, '').trim();
    if (!raw) throw new WorkflowError('工作流是空的');
    try {
      value = JSON.parse(raw);
    } catch {
      throw new WorkflowError('这不是合法 JSON');
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && value.prompt && typeof value.prompt === 'object' && value.nodes === undefined) {
    value = value.prompt;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('工作流必须是一个对象');
  if (Array.isArray((value as any).nodes)) {
    throw new WorkflowError('这是画布格式。在 ComfyUI 里用「导出 → API 格式」重新导出一次');
  }
  const nodes = Object.entries(value as Record<string, any>);
  if (!nodes.length) throw new WorkflowError('工作流里没有节点');
  if (nodes.length > MAX_NODES) throw new WorkflowError(`节点太多（${nodes.length}，上限 ${MAX_NODES}）`);
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_BYTES) throw new WorkflowError('工作流超过 4 MB');

  for (const [id, node] of nodes) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.class_type) {
      throw new WorkflowError(`节点 ${id} 缺少 class_type`);
    }
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw new WorkflowError(`节点 ${id} 缺少 inputs`);
    }
    for (const [field, item] of Object.entries(node.inputs)) {
      if (Array.isArray(item) && !isLink(item)) {
        throw new WorkflowError(`节点 ${id}.${field} 的连线形状不对（应为 [节点id, 输出序号]）`);
      }
      if (isLink(item) && !(item[0] in (value as any))) {
        throw new WorkflowError(`节点 ${id}.${field} 指向不存在的节点 ${item[0]}`);
      }
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function readWorkflowFile(path: string): Record<string, any> {
  if (!existsSync(path)) throw new WorkflowError(`工作流文件不存在：${path}`);
  if (statSync(path).size > MAX_BYTES) throw new WorkflowError('工作流超过 4 MB');
  return parseApiWorkflow(readFileSync(path, 'utf8'));
}

/** 从输出节点往上走，收集所有上游节点（含自己）。 */
export function ancestors(workflow: Record<string, any>, roots: string[]): Set<string> {
  const found = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop() as string;
    if (found.has(id) || !workflow[id]) continue;
    found.add(id);
    const inputs = workflow[id].inputs ?? {};
    for (const value of Object.values(inputs)) if (isLink(value)) pending.push(value[0]);
  }
  return found;
}

/** 距离输出越近越先遍历，用来找「最后一个采样器」。 */
function walkOrder(workflow: Record<string, any>, root: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id) || !workflow[id]) continue;
    seen.add(id);
    order.push(id);
    for (const value of Object.values(workflow[id].inputs ?? {})) if (isLink(value)) queue.push(value[0]);
  }
  return order;
}

function textFieldOf(node: any): string | null {
  for (const field of TEXT_FIELDS) {
    const value = node.inputs?.[field];
    if (typeof value === 'string') return field;
  }
  return null;
}

function looksLikeTextNode(workflow: Record<string, any>, id: string): boolean {
  const node = workflow[id];
  // 有字符串形态的提示词字段就算提示词节点；CLIP 加载器这类没有文本字段，自然被排除。
  return Boolean(node) && Boolean(textFieldOf(node));
}

/** 顺着一条 conditioning 连线往上找第一个真正带文本的节点。 */
function firstTextNode(workflow: Record<string, any>, rootId: string): { node: string; field: string } | null {
  for (const id of walkOrder(workflow, rootId)) {
    if (looksLikeTextNode(workflow, id)) return { node: id, field: textFieldOf(workflow[id]) as string };
  }
  return null;
}

function isSampler(node: any): boolean {
  const cls = String(node?.class_type ?? '').toLowerCase();
  if (!node?.inputs) return false;
  const hasCond = isLink(node.inputs.positive) || isLink(node.inputs.negative) || isLink(node.inputs.guider);
  if (!hasCond) return false;
  return SAMPLER_HINTS.some((hint) => cls.includes(hint)) || 'seed' in node.inputs || 'noise_seed' in node.inputs;
}

/** 找最终输出节点：视频优先（工作流里只要有视频输出就是视频工作流）。 */
function pickOutput(workflow: Record<string, any>): { id: string; kind: 'image' | 'video' } {
  const video = Object.entries(workflow).filter(([, node]) => VIDEO_OUTPUT.includes(node.class_type));
  const image = Object.entries(workflow).filter(([, node]) => IMAGE_OUTPUT.includes(node.class_type));
  if (video.length === 1) return { id: video[0][0], kind: 'video' };
  if (video.length > 1) {
    // 多个视频输出时取上游最多的那个，通常就是最终产物。
    const scored = video.map(([id]) => ({ id, size: ancestors(workflow, [id]).size })).sort((a, b) => b.size - a.size);
    return { id: scored[0].id, kind: 'video' };
  }
  if (image.length === 1) return { id: image[0][0], kind: 'image' };
  if (image.length > 1) {
    const scored = image.map(([id]) => ({ id, size: ancestors(workflow, [id]).size })).sort((a, b) => b.size - a.size);
    return { id: scored[0].id, kind: 'image' };
  }
  throw new WorkflowError('找不到图片/视频输出节点（需要 SaveImage、SaveVideo 或 VHS_VideoCombine）');
}

/** 识别槽位。认不出来就抛，不返回半张映射。 */
export function inferMapping(workflow: Record<string, any>): Mapping {
  const output = pickOutput(workflow);
  const active = ancestors(workflow, [output.id]);
  const warnings: string[] = [];
  const slots: Record<string, SlotTarget[]> = {};
  const bind = (name: string, target: SlotTarget) => {
    if (!slots[name]) slots[name] = [];
    slots[name].push(target);
  };

  const samplers = walkOrder(workflow, output.id).filter((id) => active.has(id) && isSampler(workflow[id]));
  if (!samplers.length) {
    // 最常见的两种「认不出」：这份工作流根本没接完，或者输出节点挂的是图片不是采样结果。
    const outputNode = workflow[output.id];
    const wired = Object.values(outputNode?.inputs ?? {}).some(isLink);
    if (!wired) {
      throw new WorkflowError(
        `输出节点 ${output.id}（${outputNode?.class_type}）没接上任何东西 —— 这份工作流在 ComfyUI 里少了一根线，补好再存一次`,
      );
    }
    throw new WorkflowError('没找到采样器（KSampler / SamplerCustom 之类），无法确定提示词入口');
  }
  if (samplers.length > 1) warnings.push(`有 ${samplers.length} 个采样器，提示词按最后一个阶段的为准`);

  // 1) 提示词：最后一个采样器的 positive / negative 各自反向找文本节点
  const main = samplers[0];
  const mainNode = workflow[main];
  // SamplerCustomAdvanced 自己没有 positive/negative，藏在 guider 里（BasicGuider / CFGGuider）
  const guiderNode = isLink(mainNode.inputs.guider) ? workflow[mainNode.inputs.guider[0]] : null;
  const positiveLink = isLink(mainNode.inputs.positive)
    ? mainNode.inputs.positive
    : isLink(guiderNode?.inputs?.positive)
      ? guiderNode.inputs.positive
      : isLink(guiderNode?.inputs?.conditioning)
        ? guiderNode.inputs.conditioning
        : undefined;
  const negativeLink = isLink(mainNode.inputs.negative)
    ? mainNode.inputs.negative
    : isLink(guiderNode?.inputs?.negative)
      ? guiderNode.inputs.negative
      : undefined;
  const positiveText = isLink(positiveLink) ? firstTextNode(workflow, positiveLink[0]) : null;
  if (!positiveText) throw new WorkflowError('认不出正面提示词入口：采样器的 positive 连线没走到任何文本节点');
  bind('prompt', { node: positiveText.node, input: positiveText.field, kind: 'text', mode: 'replace' });

  // Qwen-Image 2.1 把正负提示词塞进同一个 TextEncodeQwenImage21：prompt / negative_prompt 各一个输入。
  // 采样器 positive/negative 都指向这个节点的 0/1 输出，不能按「两个不同来源」去找负面节点。
  const positiveNode = workflow[positiveText.node];
  let inlineNegative = false;
  if (positiveNode?.class_type === 'TextEncodeQwenImage21' && typeof positiveNode.inputs?.negative_prompt === 'string') {
    bind('negative', { node: positiveText.node, input: 'negative_prompt', kind: 'text', mode: 'append' });
    inlineNegative = true;
  }

  let negativeText: { node: string; field: string } | null = null;
  if (!inlineNegative && isLink(negativeLink)) {
    const source = negativeLink[0];
    if (source !== (isLink(positiveLink) ? positiveLink[0] : '')) negativeText = firstTextNode(workflow, source);
  }
  if (negativeText) bind('negative', { node: negativeText.node, input: negativeText.field, kind: 'text', mode: 'append' });
  else if (!inlineNegative) warnings.push('这个工作流没有独立的负面提示词（cfg=1 的蒸馏模型常见），negative 参数会被忽略');

  // 2) 采样参数
  for (const field of ['steps', 'cfg', 'seed', 'noise_seed']) {
    if (!(field in mainNode.inputs)) continue;
    const value = mainNode.inputs[field];
    if (typeof value !== 'number') continue;
    const name = field === 'noise_seed' ? 'seed' : field;
    if (slots[name]) continue;
    bind(name, { node: main, input: field, kind: Number.isInteger(value) ? 'int' : 'float', mode: 'replace' });
  }
  for (const field of ['sampler_name', 'scheduler']) {
    if (typeof mainNode.inputs[field] !== 'string') continue;
    // 这两个不是数字槽，但保留可填能力
    bind(field, { node: main, input: field, kind: 'text', mode: 'replace' });
  }
  // SamplerCustom 把参数拆到了兄弟节点（RandomNoise / BasicScheduler / KSamplerSelect），从上游补齐
  for (const id of walkOrder(workflow, main)) {
    if (!active.has(id) || id === main) continue;
    const inputs = workflow[id].inputs ?? {};
    if (!slots.steps && typeof inputs.steps === 'number' && typeof inputs.denoise === 'number') {
      bind('steps', { node: id, input: 'steps', kind: 'int', mode: 'replace' });
    }
    if (!slots.seed && typeof inputs.noise_seed === 'number') {
      bind('seed', { node: id, input: 'noise_seed', kind: 'int', mode: 'replace' });
    }
    if (!slots.sampler_name && typeof inputs.sampler_name === 'string') {
      bind('sampler_name', { node: id, input: 'sampler_name', kind: 'text', mode: 'replace' });
    }
    if (!slots.scheduler && typeof inputs.scheduler === 'string' && typeof inputs.steps === 'number') {
      bind('scheduler', { node: id, input: 'scheduler', kind: 'text', mode: 'replace' });
    }
  }

  // 3) 尺寸：从主采样器的 latent_image 往上找空 latent / 分辨率节点
  const latentLink = mainNode.inputs.latent_image;
  if (isLink(latentLink)) {
    for (const id of walkOrder(workflow, latentLink[0])) {
      const node = workflow[id];
      if (!node || !LATENT_NODES.includes(node.class_type)) continue;
      for (const field of ['width', 'height']) {
        if (typeof node.inputs[field] === 'number' && !slots[field]) {
          bind(field, { node: id, input: field, kind: 'int', mode: 'replace' });
        }
      }
      // 视频 latent 的帧数：各家命名不一，认到哪个是哪个
      if (!slots.length) {
        for (const field of ['length', 'num_frames', 'video_length', 'frames']) {
          if (typeof node.inputs[field] === 'number') {
            bind('length', { node: id, input: field, kind: 'int', mode: 'replace' });
            break;
          }
        }
      }
      if (slots.width && slots.height && (slots.length || output.kind === 'image')) break;
    }
  }
  if (!slots.width) warnings.push('工作流里没有固定宽高（可能由放大节点或参考图决定），size 参数会被忽略');

  // 4) 参考图 / 蒙版 / LoRA
  let imageIndex = 0;
  let loraIndex = 0;
  for (const id of Object.keys(workflow)) {
    if (!active.has(id)) continue;
    const node = workflow[id];
    const cls = node.class_type;
    const inputs = node.inputs;
    if (cls === 'ETN_LoadImageBase64' && typeof inputs.image === 'string') {
      imageIndex += 1;
      bind(`image_${imageIndex}`, { node: id, input: 'image', kind: 'image-b64', mode: 'replace' });
    } else if ((cls === 'LoadImage' || cls === 'LoadImageOutput' || cls === 'ImageLoadByPath') && typeof inputs.image === 'string') {
      imageIndex += 1;
      bind(`image_${imageIndex}`, { node: id, input: 'image', kind: 'image-name', mode: 'replace' });
    } else if (cls === 'ETN_LoadMaskBase64' && typeof inputs.mask === 'string') {
      bind('mask', { node: id, input: 'mask', kind: 'mask-b64', mode: 'replace' });
    } else if ((cls === 'LoadImageMask' || cls === 'ImageLoadAsMaskByPath') && typeof inputs.image === 'string') {
      bind('mask', { node: id, input: 'image', kind: 'mask-name', mode: 'replace' });
    } else if (/^LoraLoader/.test(cls)) {
      if (typeof inputs.lora_name === 'string') {
        loraIndex += 1;
        bind(`lora_${loraIndex}_name`, { node: id, input: 'lora_name', kind: 'lora-name', mode: 'replace' });
        if (typeof inputs.strength_model === 'number') {
          bind(`lora_${loraIndex}_strength`, { node: id, input: 'strength_model', kind: 'float', mode: 'replace' });
        }
      }
    }
  }

  return { version: 1, outputNode: output.id, outputKind: output.kind, slots, warnings };
}

/** 手工映射落盘前的校验：只能指向真实存在、且确实在输出上游的输入。 */
export function validateMapping(workflow: Record<string, any>, mapping: any): Mapping {
  const outputNode = String(mapping?.outputNode ?? '');
  if (!workflow[outputNode]) throw new WorkflowError('映射里的输出节点不存在');
  const active = ancestors(workflow, [outputNode]);
  const slots: Record<string, SlotTarget[]> = {};
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(mapping?.slots ?? {})) {
    if (!Array.isArray(raw) || !raw.length) throw new WorkflowError(`槽位 ${name} 没有绑定`);
    slots[name] = [];
    for (const item of raw as any[]) {
      const node = String(item?.node ?? '');
      const input = String(item?.input ?? '');
      if (!workflow[node] || !(node in workflow)) throw new WorkflowError(`槽位 ${name} 指向不存在的节点 ${node}`);
      if (!active.has(node)) throw new WorkflowError(`槽位 ${name} 指向的节点 ${node} 不影响最终输出`);
      if (!(input in workflow[node].inputs)) throw new WorkflowError(`节点 ${node}.${input} 不存在`);
      const key = `${node}.${input}`;
      if (seen.has(key)) throw new WorkflowError(`同一个输入被重复映射：${key}`);
      seen.add(key);
      const kind = item.kind as SlotKind;
      if (!['text', 'int', 'float', 'image-name', 'image-b64', 'mask-name', 'mask-b64', 'lora-name'].includes(kind)) {
        throw new WorkflowError(`槽位 ${name} 的 kind 不合法`);
      }
      if (kind === 'text' && /filename|directory|path|url|api_key|password|token/i.test(input)) {
        throw new WorkflowError(`槽位 ${name} 指向文件或连接设置，不能当提示词写`);
      }
      const value = workflow[node].inputs[input];
      if ((kind === 'int' || kind === 'float') && typeof value !== 'number') {
        throw new WorkflowError(`槽位 ${name} 指向的不是数字输入`);
      }
      slots[name].push({ node, input, kind, mode: (item.mode ?? 'replace') as SlotMode });
    }
  }
  const outputKind = VIDEO_OUTPUT.includes(workflow[outputNode].class_type) ? 'video' : 'image';
  return { version: 1, outputNode, outputKind, slots, warnings: [] };
}

/** 同一段提示词重复追加时按 tag 去重，而不是把两个整块拼起来。 */
function appendText(original: string, incoming: string): string {
  const tags = new Set<string>();
  for (const part of `${original}, ${incoming}`.split(',')) {
    const tag = part.trim();
    if (tag) tags.add(tag);
  }
  return [...tags].join(', ');
}

export type FillValues = Record<string, any>;

export type FillHooks = {
  /** LoadImage 这类要先把文件传到 ComfyUI，再把返回的文件名写进去 */
  uploadImage?: (localPath: string, kind: 'image' | 'mask') => Promise<string>;
  /** ETN_* 这类吃 base64，返回 data URI */
  inlineBase64?: (localPath: string) => string;
};

/** 把请求填进工作流副本。填不了的槽保留原值，不会清空。 */
export async function fillWorkflow(
  workflow: Record<string, any>,
  mapping: Mapping,
  values: FillValues,
  hooks: FillHooks = {},
): Promise<{ prompt: Record<string, any>; applied: string[]; notes: string[] }> {
  const result = JSON.parse(JSON.stringify(workflow));
  const applied: string[] = [];
  const notes: string[] = [];

  const resolveImage = async (localPath: string, kind: SlotKind): Promise<string> => {
    if (!existsSync(localPath)) throw new WorkflowError(`图片不存在：${localPath}`);
    if (kind === 'image-b64' || kind === 'mask-b64') {
      if (!hooks.inlineBase64) throw new WorkflowError('这个工作流用 ETN_* 节点吃 base64，但没配置内联能力');
      return hooks.inlineBase64(localPath);
    }
    if (!hooks.uploadImage) throw new WorkflowError('这个工作流用 LoadImage 读服务端文件，但没有可用上传通道');
    return hooks.uploadImage(localPath, kind === 'mask-name' ? 'mask' : 'image');
  };

  for (const [name, raw] of Object.entries(values)) {
    const targets = mapping.slots[name];
    if (!targets) {
      notes.push(`工作流没有「${name}」这一项，已忽略`);
      continue;
    }
    for (const target of targets) {
      if (target.mode === 'preserve') continue;
      const inputs = result[target.node].inputs;
      const current = inputs[target.input];

      if (target.kind === 'text') {
        if (typeof raw !== 'string') throw new WorkflowError(`${name} 必须是字符串`);
        if (raw.length > 16_000) throw new WorkflowError(`${name} 太长（上限 16000 字）`);
        inputs[target.input] = target.mode === 'append' ? appendText(String(current ?? ''), raw) : raw;
        applied.push(`${name}→${target.node}.${target.input}`);
      } else if (target.kind === 'int' || target.kind === 'float') {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new WorkflowError(`${name} 必须是有限数字`);
        if (target.kind === 'int' && !Number.isInteger(n)) throw new WorkflowError(`${name} 必须是整数`);
        inputs[target.input] = n;
        applied.push(`${name}→${target.node}.${target.input}`);
      } else if (['image-name', 'image-b64', 'mask-name', 'mask-b64'].includes(target.kind)) {
        const path = String(raw);
        inputs[target.input] = await resolveImage(path, target.kind);
        applied.push(`${name}→${target.node}.${target.input}`);
      } else if (target.kind === 'lora-name') {
        inputs[target.input] = String(raw);
        applied.push(`${name}→${target.node}.${target.input}`);
      }
    }
  }
  return { prompt: result, applied, notes };
}

/** 槽位清单给人看的一行摘要。 */
export function describeSlots(mapping: Mapping): string {
  const entries = Object.entries(mapping.slots).map(([name, targets]) => {
    const where = targets.map((t) => `${t.node}.${t.input}`).join('+');
    return `${name}(${targets[0].kind},${targets[0].mode})@${where}`;
  });
  return entries.join(' · ');
}

/** 映射缓存：指纹对不上就重新识别，不让旧规则写进新工作流。 */
export function mappingPath(dir: string, name: string): string {
  return join(dir, createHash('sha256').update(name).digest('hex').slice(0, 16) + '.json');
}

export function loadCachedMapping(dir: string, name: string, workflow: Record<string, any>): Mapping | null {
  const path = mappingPath(dir, name);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record?.fingerprint !== fingerprint(workflow)) return null;
    return validateMapping(workflow, record.mapping);
  } catch {
    return null;
  }
}

export function saveCachedMapping(dir: string, name: string, workflow: Record<string, any>, mapping: Mapping): void {
  const path = mappingPath(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ fingerprint: fingerprint(workflow), name, mapping }, null, 2), 'utf8');
}

export function copyWorkflowInto(dir: string, source: string, name?: string): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name ?? basename(source));
  copyFileSync(source, target);
  return target;
}
