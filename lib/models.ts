/*! 画室：模型清单。
 *
 * 只走 ComfyUI 的 /object_info 网络接口 —— 每个加载节点的可选文件名枚举，
 * 就是「这台 ComfyUI 认得的模型」。不再扫描本机下载目录，避免离线环境和路径差异。
 *
 * 只做清单和归族判断，不写工作流；工作流在 graph.ts 里拼。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { ComfyClient } from './comfy.ts';

export type ModelFamily = 'moss' | 'qwen' | 'qwen21' | 'qwen2512' | 'flux' | 'flux3klein' | 'zimage' | 'sdxl' | 'sd15' | 'video' | 'unknown';

export type ModelEntry = {
  name: string;
  /** 文件在 models 下的相对路径，拿不到就是空 */
  path?: string;
  bytes?: number;
  family: ModelFamily;
};

export type ModelInventory = {
  source: 'object_info' | 'files' | 'mixed' | 'network';
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
  if (/flux[-_]?3|flux3_image_klein|flux3-image-klein/.test(lower)) return 'flux3klein';
  if (/qwen[_-]?image[_-]?2[._-]1|qwen2[._-]1/.test(lower)) return 'qwen21';
  if (/qwen[_-]?image[_-]?2512/.test(lower)) return 'qwen2512';
  if (/z[_-]?image/.test(lower)) return 'zimage';
  if (/moss/.test(lower)) return 'moss';
  if (/qwen[_-]?image|qwen2[._]?1/i.test(lower)) return 'qwen';
  if (/flux/.test(lower)) return 'flux';
  if (/minimax|h3_|_h3|wan\d|_i2v|_t2v|video/.test(lower)) return 'video';
  if (/sdxl|_xl|xl_refiner|juggernaut|realvis|dreamshaper/i.test(lower)) return 'sdxl';
  if (/sd15|v1[._-]?5|majicmix|guofeng|animefull|anything|counterfeit/i.test(lower)) return 'sd15';
  return 'unknown';
}

const entry = (name: string): ModelEntry => ({
  name,
  family: guessFamily(name),
});

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
 * 取模型清单：只通过 ComfyUI 的 /object_info 网络查询。
 * 连不上就返回空清单并说明，不再回退到扫描本机模型目录。
 */
export async function inventory(options: {
  baseUrl: string;
  modelsDir?: string;
  signal?: AbortSignal;
  refresh?: boolean;
}): Promise<ModelInventory> {
  const key = String(options.baseUrl || '');
  const cached = MODELS_CACHE.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const notes: string[] = [];
  let info: any = null;
  if (!options.baseUrl) {
    notes.push('还没有配置本地工具地址，无法查询模型');
  } else {
    try {
      info = await new ComfyClient(options.baseUrl, 60_000).allObjectInfo(options.signal);
    } catch {
      notes.push('ComfyUI 没连上：模型清单按网络查询为空');
    }
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

  const value: ModelInventory = {
    source: info ? 'object_info' : 'network',
    modelsDir: options.modelsDir || '',
    checkpoints: fromInfo.checkpoints.map(entry),
    unets: fromInfo.unets.map(entry),
    vaes: fromInfo.vaes.map(entry),
    clips: fromInfo.clips.map(entry),
    clips2: fromInfo.clips2.map(entry),
    loras: fromInfo.loras.map(entry),
    clipTypes: clipTypes.length ? clipTypes : ['stable_diffusion', 'sdxl', 'flux', 'flux3', 'lumina2', 'qwen_image', 'moss_image'],
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
    qwen21: kind === 'vae' ? [/qwen_image_2[._-]1.*vae/i, /qwen.*image.*vae/i] : [/qwen3vl[_-]?8b.*int8/i, /qwen3vl[_-]?8b.*bf16/i, /qwen3vl[_-]?8b/i, /qwen3.?vl.*8b/i, /qwen3vl/i],
    flux: kind === 'vae' ? [/(^|[-_])ae\./i, /flux.*vae/i, /flux_ae/i] : [/t5xxl/i, /clip_l/i],
    flux3klein: kind === 'vae' ? [/flux2[._-]?vae/i, /flux.*vae/i] : [/qwen3vl[_-]?4b/i, /qwen3.?vl.*4b/i, /qwen3vl/i],
    zimage: kind === 'vae' ? [/(^|[-_])ae\./i, /z.?image.*vae/i] : [/qwen[_-]?3[_-]?4b/i, /qwen3.*4b/i],
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
