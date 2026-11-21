/*! 画室：本地模型清单。
 *
 * 两路来源：
 *   1) ComfyUI 的 /object_info —— 每个加载节点的可选文件名枚举，就是「ComfyUI 认得的模型」，
 *      比自己扫目录准（藏在子目录里的、重名的都对得上）。
 *   2) 文件系统扫描 —— ComfyUI 没开时兜底，顺便拿到体积。
 *
 * 只做清单和归族判断，不写工作流；工作流在 graph.ts 里拼。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { ComfyClient } from './comfy.ts';

export type ModelFamily = 'moss' | 'qwen' | 'flux' | 'sdxl' | 'sd15' | 'video' | 'unknown';

export type ModelEntry = {
  name: string;
  /** 文件在 models 下的相对路径，拿不到就是空 */
  path?: string;
  bytes?: number;
  family: ModelFamily;
};

export type ModelInventory = {
  source: 'object_info' | 'files' | 'mixed';
  modelsDir: string;
  checkpoints: ModelEntry[];
  unets: ModelEntry[];
  vaes: ModelEntry[];
  clips: ModelEntry[];
  clips2: ModelEntry[];
  loras: ModelEntry[];
  /** ComfyUI 认得的 CLIPLoader.type 取值（moss_image、qwen_image、flux……） */
  clipTypes: string[];
  notes: string[];
};

const MODELS_CACHE = new Map<string, { at: number; value: ModelInventory }>();
const TTL_MS = 60_000;

/** 从文件名猜模型家族：只用于「给个建议」，猜错可以显式指定。 */
export function guessFamily(name: string): ModelFamily {
  const lower = name.toLowerCase();
  if (/moss/.test(lower)) return 'moss';
  if (/qwen[_-]?image|qwen2[._]?1|qwen[-_]?2\.1/i.test(lower)) return 'qwen';
  if (/flux/.test(lower)) return 'flux';
  if (/minimax|h3_|_h3|wan\d|_i2v|_t2v|video/.test(lower)) return 'video';
  if (/sdxl|_xl|xl_refiner|juggernaut|realvis|dreamshaper/i.test(lower)) return 'sdxl';
  if (/sd15|v1[._-]?5|majicmix|guofeng|animefull|anything|counterfeit/i.test(lower)) return 'sd15';
  return 'unknown';
}

function walkModels(root: string): Array<{ rel: string; bytes: number }> {
  const out: Array<{ rel: string; bytes: number }> = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      const ext = extname(item.name).toLowerCase();
      if (!['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf'].includes(ext)) continue;
      try {
        out.push({ rel: relative(root, full).replace(/\\/g, '/'), bytes: statSync(full).size });
      } catch {
        /* 读不到就跳过 */
      }
    }
  };
  visit(root, 0);
  return out;
}

const entry = (name: string, byName: Map<string, { rel: string; bytes: number }>): ModelEntry => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const hit = byName.get(base.toLowerCase()) ?? byName.get(name.toLowerCase());
  return { name, path: hit?.rel, bytes: hit?.bytes, family: guessFamily(name) };
};

const enumOf = (info: any, node: string, field = 0): string[] => {
  const spec = info?.[node]?.input?.required?.ckpt_name
    ?? info?.[node]?.input?.required?.unet_name
    ?? info?.[node]?.input?.required?.vae_name
    ?? info?.[node]?.input?.required?.clip_name
    ?? info?.[node]?.input?.required?.lora_name;
  const first = Array.isArray(spec) ? spec[0] : spec;
  return Array.isArray(first) ? first.filter((item: any) => typeof item === 'string') : [];
};

const namedEnum = (info: any, node: string, field: string): string[] => {
  const first = info?.[node]?.input?.required?.[field];
  const spec = Array.isArray(first) ? first[0] : first;
  return Array.isArray(spec) ? spec.filter((item: any) => typeof item === 'string') : [];
};

/**
 * 取本地模型清单。ComfyUI 在线就用 /object_info（并附带体积），离线只扫目录。
 */
export async function inventory(options: {
  baseUrl: string;
  modelsDir: string;
  signal?: AbortSignal;
  refresh?: boolean;
}): Promise<ModelInventory> {
  const key = `${options.baseUrl}|${options.modelsDir}`;
  const cached = MODELS_CACHE.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const notes: string[] = [];
  let byBase = new Map<string, { rel: string; bytes: number }>();
  if (options.modelsDir && existsSync(options.modelsDir)) {
    for (const file of walkModels(options.modelsDir)) {
      byBase.set((file.rel.split('/').pop() ?? '').toLowerCase(), file);
      byBase.set(file.rel.toLowerCase(), file);
    }
  } else if (options.modelsDir) {
    notes.push(`模型目录不存在：${options.modelsDir}`);
  }

  let info: any = null;
  try {
    info = await new ComfyClient(options.baseUrl, 60_000).allObjectInfo(options.signal);
  } catch {
    notes.push('ComfyUI 没连上，只能按文件目录猜模型');
  }

  const fromInfo = {
    checkpoints: info ? namedEnum(info, 'CheckpointLoaderSimple', 'ckpt_name') : [],
    unets: info ? namedEnum(info, 'UNETLoader', 'unet_name') : [],
    vaes: info ? namedEnum(info, 'VAELoader', 'vae_name') : [],
    clips: info ? namedEnum(info, 'CLIPLoader', 'clip_name') : [],
    clips2: info ? namedEnum(info, 'DualCLIPLoader', 'clip_name1') : [],
    loras: info ? namedEnum(info, 'LoraLoader', 'lora_name') : [],
  };
  const clipTypesSpec = info?.CLIPLoader?.input?.required?.type;
  const clipTypes = Array.isArray(clipTypesSpec) && Array.isArray(clipTypesSpec[0]) ? clipTypesSpec[0] : [];

  // 有 object_info 就以它为准；某一类为空时用目录扫描补齐（按 models 子目录归堆）。
  const scanBy = (prefixes: string[]): string[] => {
    if (!options.modelsDir) return [];
    return walkModels(options.modelsDir)
      .filter((file) => prefixes.some((prefix) => file.rel.toLowerCase().startsWith(prefix)))
      .map((file) => file.rel.split('/').pop() as string);
  };
  const fill = (infoList: string[], prefixes: string[]) => (infoList.length ? infoList : scanBy(prefixes));

  const source: ModelInventory['source'] = info ? (fromInfo.unets.length ? 'object_info' : 'mixed') : 'files';
  const value: ModelInventory = {
    source,
    modelsDir: options.modelsDir,
    checkpoints: fill(fromInfo.checkpoints, ['checkpoints/']).map((name) => entry(name, byBase)),
    unets: fill(fromInfo.unets, ['diffusion_models/', 'unet/']).map((name) => entry(name, byBase)),
    vaes: fill(fromInfo.vaes, ['vae/']).map((name) => entry(name, byBase)),
    clips: fill(fromInfo.clips, ['text_encoders/', 'clip/', 'clip_vision/']).map((name) => entry(name, byBase)),
    clips2: (fromInfo.clips2.length ? fromInfo.clips2 : []).map((name) => entry(name, byBase)),
    loras: fill(fromInfo.loras, ['loras/', 'lora/']).map((name) => entry(name, byBase)),
    clipTypes: clipTypes.length ? clipTypes : ['stable_diffusion', 'sdxl', 'flux', 'qwen_image', 'moss_image'],
    notes,
  };
  MODELS_CACHE.set(key, { at: Date.now(), value });
  return value;
}

export function clearInventoryCache(): void {
  MODELS_CACHE.clear();
}

/** 配对的候选：给定家族，挑最像的 VAE / CLIP。返回 null 表示没找到。 */
export function pairFor(
  family: ModelFamily,
  list: string[],
  kind: 'vae' | 'clip',
): string | null {
  const patterns: Record<string, RegExp[]> = {
    moss: kind === 'vae' ? [/flux.*vae/i, /moss.*vae/i] : [/qwen.*(vl|text|9b|8b)/i, /qwen3/i],
    qwen: kind === 'vae' ? [/qwen.*vae/i, /qwen_image.*vae/i] : [/qwen3vl[_-]?8b/i, /qwen3.?vl.*(small|8b)/i, /qwen3.?vl/i],
    flux: kind === 'vae' ? [/(^|[-_])ae\./i, /flux.*vae/i, /flux_ae/i] : [/t5xxl/i, /clip_l/i],
    sdxl: kind === 'vae' ? [/sdxl.*vae/i, /sdxl_vae/i] : [],
    sd15: kind === 'vae' ? [/vae-ft-mse/i, /sd15.*vae/i] : [],
  };
  const candidates = patterns[family] ?? [];
  // MiniMax 那套文本编码器体积更大、方言也不同，别把 qwen 家族配到它头上。
  const usable = kind === 'clip' ? list.filter((name) => !/minimax|_h3/i.test(name)) : list;
  for (const pattern of candidates) {
    const hit = usable.find((name) => pattern.test(name));
    if (hit) return hit;
  }
  // 同一类只有一份时，那就是它。
  if (usable.length === 1 && family !== 'sdxl' && family !== 'sd15') return usable[0];
  return null;
}
