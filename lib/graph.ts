/*! 画室：按本地模型拼一份能直接跑的工作流。
 *
 * 输入「用哪个模型」，输出「API 格式的图」，中间那些参数（VAE 配谁、CLIP 用哪种类型、
 * 蒸馏模型几步、CFG 多少、采样器用哪个）按家族取默认值，都能覆盖。
 *
 * 目前覆盖：MOSS 系（unet+clip+vae，含 8 步加速 LoRA）、Qwen-Image 系、Flux、
 * SDXL / SD1.5 单 checkpoint。视频家族（MiniMax/Wan）不在这里拼 —— 那类工作流的自定义节点
 * 太多，硬拼出来容易跑一半报错，继续用现成工作流更稳。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { pairFor, type ModelFamily, type ModelInventory } from './models.ts';

export type BuildSpec = {
  prompt: string;
  negative?: string;
  family?: string;
  checkpoint?: string;
  unet?: string;
  clip?: string;
  vae?: string;
  /** Flux 要两份文本编码器 */
  clip2?: string;
  clipType?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  /** 家族自带的加速 LoRA（MOSS 8 步、Qwen lightning 之类），默认带上 */
  accel?: boolean;
  /** 额外的角色 LoRA（锁脸用），按顺序接在加速 LoRA 后面 */
  loras?: Array<{ name: string; strength?: number }>;
  prefix?: string;
};

export type BuiltWorkflow = {
  api: Record<string, any>;
  family: ModelFamily;
  /** 实际用到的模型文件 */
  used: Record<string, string | undefined>;
  defaults: { width: number; height: number; steps: number; cfg: number; sampler: string; scheduler: string };
  notes: string[];
  /** 拼不出来的原因 */
  error?: string;
};

const DEFAULTS: Record<string, { width: number; height: number; steps: number; cfg: number; sampler: string; scheduler: string }> = {
  moss: { width: 768, height: 1024, steps: 8, cfg: 2.5, sampler: 'er_sde', scheduler: 'simple' },
  qwen: { width: 768, height: 1024, steps: 6, cfg: 1.0, sampler: 'euler', scheduler: 'simple' },
  flux: { width: 1024, height: 1024, steps: 20, cfg: 1.0, sampler: 'euler', scheduler: 'simple' },
  sdxl: { width: 832, height: 1216, steps: 28, cfg: 6.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
  sd15: { width: 512, height: 768, steps: 28, cfg: 7.0, sampler: 'dpmpp_2m', scheduler: 'karras' },
};

/** 各家族 CLIPLoader 该填的 type。ComfyUI 认得的取值优先，取不到就用约定值。 */
const CLIP_TYPE: Record<string, string> = {
  moss: 'moss_image',
  qwen: 'qwen_image',
  flux: 'flux',
};

const ACCEL_LORA: Record<string, RegExp> = {
  moss: /moss.*(step|加速|light)/i,
  // Qwen 认「2.1 专用 6 步加速」，不认 Edit 系列的 4 步 LoRA —— 那是改图模型用的，套到文生图上会毁画面
  qwen: /p_q_image|qwen[_-]?image[_-]?2\.1.*(step|turbo)|qwen.*image.*(lightning|turbo)/i,
};

function findAccel(family: ModelFamily, loras: string[]): string | null {
  const pattern = ACCEL_LORA[family];
  if (!pattern) return null;
  return loras.find((name) => pattern.test(name) && !/edit/i.test(name)) ?? null;
}

/** 拼图。认不出家族或缺关键模型就返回 error，不返回半份。 */
export function buildWorkflow(spec: BuildSpec, inv: ModelInventory): BuiltWorkflow {
  const notes: string[] = [];
  const fail = (error: string): BuiltWorkflow => ({
    api: {},
    family: 'unknown',
    used: {},
    defaults: DEFAULTS.sdxl,
    notes,
    error,
  });

  const checkpoint = spec.checkpoint ? String(spec.checkpoint) : '';
  const unet = spec.unet ? String(spec.unet) : '';
  if (!checkpoint && !unet && !spec.family) {
    return fail(
      `要给一个模型：unet（比如 ${inv.unets[0]?.name ?? 'xxx.safetensors'}）或 checkpoint（比如 ${inv.checkpoints[0]?.name ?? 'xxx.safetensors'}）`,
    );
  }

  const family = String(
    spec.family ?? (checkpoint ? (inv.checkpoints.find((item) => item.name === checkpoint)?.family ?? 'unknown') : inv.unets.find((item) => item.name === unet)?.family ?? 'unknown'),
  ) as ModelFamily;

  // 单文件 checkpoint 认不出名字时按体积判断：>=5 GB 当 SDXL，否则当 SD1.5（两者都能直接跑）。
  let familyFinal = family;
  if (checkpoint && family === 'unknown') {
    const bytes = inv.checkpoints.find((item) => item.name === checkpoint)?.bytes ?? 0;
    familyFinal = bytes >= 5 * 1024 * 1024 * 1024 ? 'sdxl' : 'sd15';
    notes.push(`${checkpoint} 名字上看不出家族，按体积 ${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB 当成 ${familyFinal}`);
  }
  const familyKey = familyFinal as ModelFamily;

  if (familyKey === 'video') {
    return fail(`${checkpoint || unet} 是视频模型：生图工作流拼不出来，请用一份现成的视频工作流（video_workflows 里选）`);
  }
  if (!['moss', 'qwen', 'flux', 'sdxl', 'sd15'].includes(familyKey)) {
    return fail(
      `认不出 ${checkpoint || unet} 属于哪个家族（moss / qwen / flux / sdxl / sd15）。可以显式传 family 试试`,
    );
  }

  const d = DEFAULTS[familyKey];
  const defaults = {
    width: spec.width ?? d.width,
    height: spec.height ?? d.height,
    steps: spec.steps ?? d.steps,
    cfg: spec.cfg ?? d.cfg,
    sampler: spec.sampler ?? d.sampler,
    scheduler: spec.scheduler ?? d.scheduler,
  };
  const negative = spec.negative ?? 'blurry, low quality, deformed, bad hands, extra limbs';
  const prefix = spec.prefix ?? 'studio';

  const api: Record<string, any> = {};
  const used: Record<string, string | undefined> = {};
  let modelRef: [string, number];
  let clipRef: [string, number];
  let vaeRef: [string, number];
  let nodeId = 1;

  const put = (class_type: string, inputs: Record<string, any>) => {
    const id = String(nodeId++);
    api[id] = { class_type, inputs };
    return id;
  };

  if (familyKey === 'sdxl' || familyKey === 'sd15') {
    const ckpt = checkpoint || inv.checkpoints.find((item) => item.family === familyKey)?.name;
    if (!ckpt) return fail(`没有 ${familyKey} 的 checkpoint：把文件名传进来，或先在 ComfyUI 里放一个`);
    used.checkpoint = ckpt;
    const loader = put('CheckpointLoaderSimple', { ckpt_name: ckpt });
    modelRef = [loader, 0];
    clipRef = [loader, 1];
    vaeRef = [loader, 2];
    if ((spec.accel ?? false) && findAccel(familyKey, inv.loras.map((item) => item.name))) {
      notes.push(`${familyKey} 的加速 LoRA 没接：单 checkpoint 工作流先按标准步数出`);
    }
  } else {
    // unet + clip + vae 三件套
    const resolvedUnet = unet || inv.unets.find((item) => item.family === familyKey)?.name;
    if (!resolvedUnet) return fail(`没有 ${familyKey} 的 unet：把文件名传进来，或先放一个到 ComfyUI 的 diffusion_models`);
    used.unet = resolvedUnet;

    const clipList = inv.clips.map((item) => item.name);
    const resolvedClip = spec.clip || pairFor(familyKey, clipList, 'clip');
    if (!resolvedClip) {
      return fail(
        `没找到 ${familyKey} 配的文本编码器（text_encoders 里现有：${clipList.join('、') || '空'}）。可以显式传 clip`,
      );
    }
    used.clip = resolvedClip;

    const vaeList = inv.vaes.map((item) => item.name);
    const resolvedVae = spec.vae || pairFor(familyKey, vaeList, 'vae');
    if (!resolvedVae) {
      return fail(
        `没找到 ${familyKey} 配的 VAE（vae 里现有：${vaeList.join('、') || '空'}）。可以显式传 vae`,
      );
    }
    used.vae = resolvedVae;

    const unetId = put('UNETLoader', { unet_name: resolvedUnet, weight_dtype: 'default' });

    if (familyKey === 'flux') {
      const clip2 = spec.clip2 || inv.clips2.find((item) => /t5/i.test(item.name))?.name || clipList.find((name) => /t5/i.test(name));
      const clip1 = resolvedClip;
      if (!clip2) {
        return fail('Flux 需要两份文本编码器（clip_l + t5xxl），本机 text_encoders 里没凑齐');
      }
      used.clip2 = clip2;
      const dual = put('DualCLIPLoader', { clip_name1: clip1, clip_name2: clip2, type: spec.clipType || 'flux', device: 'default' });
      clipRef = [dual, 0];
    } else {
      const clipType = spec.clipType || CLIP_TYPE[familyKey] || 'stable_diffusion';
      if (!inv.clipTypes.includes(clipType)) {
        notes.push(`CLIPLoader.type 填了 ${clipType}，ComfyUI 报的可用值里没有它，跑不通就在设置页改成现成的取值`);
      }
      const clipId = put('CLIPLoader', { clip_name: resolvedClip, type: clipType, device: 'default' });
      clipRef = [clipId, 0];
    }

    const vaeId = put('VAELoader', { vae_name: resolvedVae });
    vaeRef = [vaeId, 0];
    modelRef = [unetId, 0];

    // 加速 LoRA：MOSS 8 步、Qwen lightning 这类，是模型自带的「步数压缩器」，不是角色 LoRA。
    const accelName = spec.accel === false ? null : findAccel(familyKey, inv.loras.map((item) => item.name));
    if (accelName) {
      used.accelLora = accelName;
      const loraId = put('LoraLoader', {
        lora_name: accelName,
        strength_model: 1.0,
        strength_clip: 1.0,
        model: modelRef,
        clip: clipRef,
      });
      modelRef = [loraId, 0];
      clipRef = [loraId, 1];
      notes.push(`带上加速 LoRA ${accelName}（${defaults.steps} 步）`);
    } else if (familyKey === 'moss' || familyKey === 'qwen') {
      notes.push('没找到加速 LoRA：按标准步数出图会慢一些，质量也未必一致');
    }
  }

  // 角色 LoRA：跟加速 LoRA 串在同一条链上，强度默认 0.85（本机观澜那份就是这个值）。
  for (const [index, lora] of (spec.loras ?? []).entries()) {
    if (!lora?.name) continue;
    const weight = lora.strength ?? 0.85;
    const id = put('LoraLoader', {
      lora_name: lora.name,
      strength_model: weight,
      strength_clip: weight,
      model: modelRef,
      clip: clipRef,
    });
    modelRef = [id, 0];
    clipRef = [id, 1];
    used[`lora_${index + 1}`] = lora.name;
    notes.push(`接角色 LoRA ${lora.name}（${weight}）`);
  }

  const positive = put('CLIPTextEncode', { text: spec.prompt, clip: clipRef });
  const negativeId = put('CLIPTextEncode', { text: negative, clip: clipRef });
  const latent = put('EmptyLatentImage', { width: defaults.width, height: defaults.height, batch_size: 1 });
  const sampler = put('KSampler', {
    seed: spec.seed ?? 0,
    steps: defaults.steps,
    cfg: defaults.cfg,
    sampler_name: defaults.sampler,
    scheduler: defaults.scheduler,
    denoise: 1.0,
    model: modelRef,
    positive: [positive, 0],
    negative: [negativeId, 0],
    latent_image: [latent, 0],
  });
  const decode = put('VAEDecode', { samples: [sampler, 0], vae: vaeRef });
  put('SaveImage', { filename_prefix: prefix, images: [decode, 0] });

  return { api, family: familyKey, used, defaults, notes };
}

/* ── MOSS-Image Edit：带参考图的锁脸路径 ─────────────────────────────
 *
 * 本机已有 moss_image_edit_lora_rank_64_bf16 和 TextEncodeMOSSImageEdit，
 * 所以「记住她长什么样」不需要训角色 LoRA：把一张定妆照当参考图喂进去就行。
 * 参考图走 TextEncodeMOSSImageEdit 的 vae 入参（它自己会编码成 reference_latents），
 * 不用再接 ReferenceLatent。图片键是点号形式 images.image_0（ComfyUI V3 autogrow 的写法，
 * 写成 {"images":{"image_0":…}} 会被判 required_input_missing）。
 */

export type EditSpec = {
  prompt: string;
  negative?: string;
  /** 已经上传到 ComfyUI input 目录的文件名，不是本地路径 */
  images: string[];
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  /** edit LoRA 训练时用的布局，默认 Moss-Image-Edit（官方那份 edit LoRA 就是这个） */
  editFormat?: string;
  /** 参考图对画面的影响强度，1=原样，0=完全忽略 */
  imageStrength?: number;
  /** 角色 LoRA：接在 edit LoRA 后面，用来「认脸」里补模型自己的记忆 */
  characterLora?: { name: string; strength?: number };
  prefix?: string;
};

const EDIT_FORMATS = ['Moss-Image-Edit', 'ai-toolkit', 'ai-toolkit (kv_cache off)'];

export function buildMossEditWorkflow(spec: EditSpec, inv: ModelInventory): BuiltWorkflow {
  const notes: string[] = [];
  const fail = (error: string): BuiltWorkflow => ({
    api: {},
    family: 'moss',
    used: {},
    defaults: DEFAULTS.moss,
    notes,
    error,
  });

  const images = (spec.images ?? []).filter(Boolean).slice(0, 4);
  if (!images.length) return fail('MOSS-Image Edit 至少要一张参考图');

  const unet = inv.unets.find((item) => item.family === 'moss')?.name;
  if (!unet) return fail('没有 MOSS 的 unet（diffusion_models 里找 moss_*）');
  const clip = pairFor('moss', inv.clips.map((item) => item.name), 'clip');
  if (!clip) return fail('没找到 MOSS 配的文本编码器（qwen3.5_*）');
  const vae = pairFor('moss', inv.vaes.map((item) => item.name), 'vae');
  if (!vae) return fail('没找到 MOSS 配的 VAE（flux2-vae_*）');

  const editLora = inv.loras.find((item) => /moss.*edit/i.test(item.name))?.name;
  if (!editLora) return fail('没找到 MOSS 的 edit LoRA（loras 里 moss_image_edit_*）');
  const accel = findAccel('moss', inv.loras.map((item) => item.name));

  const d = { ...DEFAULTS.moss };
  const defaults = {
    width: spec.width ?? 512,
    height: spec.height ?? 768,
    steps: spec.steps ?? d.steps,
    cfg: spec.cfg ?? d.cfg,
    sampler: spec.sampler ?? d.sampler,
    scheduler: spec.scheduler ?? d.scheduler,
  };
  const prefix = spec.prefix ?? 'moss-edit';
  const format = EDIT_FORMATS.includes(String(spec.editFormat)) ? String(spec.editFormat) : 'Moss-Image-Edit';
  const used: Record<string, any> = { unet, clip, vae, editLora };

  let nodeId = 1;
  const api: Record<string, any> = {};
  const put = (class_type: string, inputs: Record<string, any>) => {
    const id = String(nodeId++);
    api[id] = { class_type, inputs };
    return id;
  };

  const unetId = put('UNETLoader', { unet_name: unet, weight_dtype: 'default' });
  const clipId = put('CLIPLoader', { clip_name: clip, type: CLIP_TYPE.moss ?? 'moss_image', device: 'default' });
  const vaeId = put('VAELoader', { vae_name: vae });

  let modelRef: [string, number] = [unetId, 0];
  let clipRef: [string, number] = [clipId, 0];
  if (accel) {
    const loraId = put('LoraLoader', {
      lora_name: accel,
      strength_model: 1,
      strength_clip: 1,
      model: modelRef,
      clip: clipRef,
    });
    modelRef = [loraId, 0];
    clipRef = [loraId, 1];
    notes.push(`带上加速 LoRA ${accel}（${defaults.steps} 步）`);
  }
  const editId = put('LoraLoader', {
    lora_name: editLora,
    strength_model: 1,
    strength_clip: 1,
    model: modelRef,
    clip: clipRef,
  });
  modelRef = [editId, 0];
  clipRef = [editId, 1];
  notes.push(`带上 ${editLora}（布局 ${format}），参考图 ${images.length} 张`);

  if (spec.characterLora?.name) {
    const weight = spec.characterLora.strength ?? 0.85;
    const id = put('LoraLoader', {
      lora_name: spec.characterLora.name,
      strength_model: weight,
      strength_clip: weight,
      model: modelRef,
      clip: clipRef,
    });
    modelRef = [id, 0];
    clipRef = [id, 1];
    notes.push(`再接角色 LoRA ${spec.characterLora.name}（${weight}）`);
    used.characterLora = spec.characterLora.name;
  }

  const imageIds = images.map((name) => put('LoadImage', { image: name }));
  const refInputs: Record<string, [string, number]> = {};
  for (const [index, id] of imageIds.entries()) refInputs[`images.image_${index}`] = [id, 0];

  const positive = put('TextEncodeMOSSImageEdit', {
    clip: clipRef,
    prompt: spec.prompt,
    vae: [vaeId, 0],
    edit_format: format,
    image_strength: spec.imageStrength ?? 1,
    ...refInputs,
  });
  const negativeText = spec.negative ?? '低质量，模糊，变形，多余的手指，水印，文字';
  const negative = put('CLIPTextEncode', { text: negativeText, clip: clipRef });

  const latent = put('EmptyLatentImage', { width: defaults.width, height: defaults.height, batch_size: 1 });
  const sampler = put('KSampler', {
    seed: spec.seed ?? 0,
    steps: defaults.steps,
    cfg: defaults.cfg,
    sampler_name: defaults.sampler,
    scheduler: defaults.scheduler,
    denoise: 1,
    model: modelRef,
    positive: [positive, 0],
    negative: [negative, 0],
    latent_image: [latent, 0],
  });
  const decode = put('VAEDecode', { samples: [sampler, 0], vae: [vaeId, 0] });
  put('SaveImage', { filename_prefix: prefix, images: [decode, 0] });

  used.accelLora = accel ?? undefined;
  return {
    api,
    family: 'moss',
    used,
    defaults,
    notes: notes.concat(['参考图锁的是脸和气质，衣服/动作要改就在提示词里直接说，或者把 image_strength 调低']),
  };
}
