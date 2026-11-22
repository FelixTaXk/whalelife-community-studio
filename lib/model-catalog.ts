import type { SystemProbe } from './setup.ts';

export type ModelKind = 'image' | 'video';

export type ModelRec = {
  id: string;
  name: string;
  family: string;
  kind: ModelKind;
  purpose: string;
  params: string;
  license: string;
  /** 实际推荐运行的显存档（不是权重文件大小） */
  vramGB: number;
  /** 能勉强跑起来的最低档，低于这个直接标显存不够 */
  minVRAM: number;
  fit: 'best' | 'ok' | 'heavy' | 'light';
  local: boolean;
  /** 本机命中的真实文件名（有就能直接 studio_build） */
  localModel?: string;
  /** 质量/综合优先级，越大越靠前 */
  score: number;
  /** 当前 studio_build 是否有对应的图构建器 */
  buildable: boolean;
  files: Array<{ dir: string; name: string; sizeGB?: number; url?: string; note?: string }>;
  workflow: { width: number; height: number; steps: number; cfg: number; sampler: string; scheduler: string; note: string };
  notes: string[];
};

export type Recommendation = {
  tier: string;
  summary: string;
  gpu: string;
  vramGB: number;
  items: ModelRec[];
  next: string[];
};

type InventoryLike = {
  checkpoints?: Array<{ name: string }>;
  unets?: Array<{ name: string }>;
  vaes?: Array<{ name: string }>;
  clips?: Array<{ name: string }>;
  loras?: Array<{ name: string }>;
};

type CatalogItem = Omit<ModelRec, 'fit' | 'local' | 'localModel'> & {
  needles: string[];
};

const hf = (repo: string) => `https://huggingface.co/${repo}`;

const wf = (
  width: number,
  height: number,
  steps: number,
  cfg: number,
  sampler: string,
  scheduler: string,
  note: string,
): ModelRec['workflow'] => ({ width, height, steps, cfg, sampler, scheduler, note });

/**
 * 目录只收“能在 ComfyUI 本地方便跑起来”的公开权重。
 * vramGB 是保守可用的档，不是文件大小；实际还受分辨率、文本编码器和 offload 影响。
 */
const CATALOG: CatalogItem[] = [
  {
    id: 'flux3klein',
    name: 'FLUX.3 Klein（2026-10）',
    family: 'flux3klein',
    kind: 'image',
    purpose: '当前综合最强的小模型：文生图、改图、多参考、原生 4K 一把抓',
    params: '5.6B DiT + Qwen3-VL-4B',
    license: 'FLUX Kommunity：非商用免费；年收入低于 500 万美元可商用出图',
    vramGB: 11,
    minVRAM: 8,
    score: 100,
    buildable: true,
    needles: ['flux3-image-klein', 'flux-3-image-klein', 'flux3_image_klein'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'flux3-image-klein-int8-convrot.safetensors',
        sizeGB: 5.6,
        url: hf('black-forest-labs/flux-3-image-klein-comfy'),
        note: '需在仓库接受许可；8–12G 用 int8 蒸馏版',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_4b_int8_convrot.safetensors',
        sizeGB: 4.2,
        url: hf('black-forest-labs/flux-3-image-klein-comfy'),
        note: 'CLIPLoader.type=flux3',
      },
      {
        dir: 'models/vae',
        name: 'flux2-vae.safetensors',
        sizeGB: 0.3,
        url: hf('black-forest-labs/flux-3-image-klein-comfy'),
        note: '与 FLUX.2 共用 VAE',
      },
    ],
    workflow: wf(1024, 1024, 16, 1, 'euler', 'simple', 'Klein 蒸馏版 16 步；全量版 50 步'),
    notes: [
      '8G 卡用 INT8 + 16 步；12G 可以 1024 方图，4K 会明显吃内存。',
      '改图/多参考直接用它，不必再单独挂一个编辑模型。',
      '需要 ComfyUI 0.41.0+，旧版模板里找不到。',
    ],
  },
  {
    id: 'qwen21',
    name: 'Qwen-Image 2.1（7B）',
    family: 'qwen21',
    kind: 'image',
    purpose: '中文文字、海报、透明底、多图改图都很强，消费级卡友好',
    params: '7B DiT + Qwen3-VL-8B',
    license: 'Qwen Research License：研究和非商用为主',
    vramGB: 11,
    minVRAM: 10,
    score: 97,
    buildable: true,
    needles: ['qwen_image_2.1', 'qwen_image_2_1', 'qwen-image-2.1'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
        sizeGB: 7.3,
        url: hf('Comfy-Org/Qwen-Image-2.1'),
        note: '8 步 Turbo；也有非 Turbo 的 40 步版本',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_8b_int8_convrot.safetensors',
        sizeGB: 8.7,
        url: hf('Comfy-Org/Qwen-Image-2.1'),
        note: '12G 首选；官方模板默认。CLIPLoader.device 设 cpu 更稳。',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_8b_bf16.safetensors',
        sizeGB: 16.3,
        url: hf('Comfy-Org/Qwen-Image-2.1'),
        note: '完整精度；内存充足时再用。',
      },
      {
        dir: 'models/vae',
        name: 'qwen_image_2.1_vae_bf16.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/Qwen-Image-2.1'),
        note: '原生 RGBA，透明底直接出',
      },
    ],
    workflow: wf(1024, 1024, 8, 1, 'euler', 'simple', 'Turbo 8 步；原生 2K'),
    notes: [
      '12G 用 int8 + 1024 方图最稳；2048 原生输出需要更大显存或分块。',
      '透明底、角色三视图、商品抠图优先选它。',
      '非商用许可，商用要先看 Qwen 授权。',
    ],
  },
  {
    id: 'zimage',
    name: 'Z-Image Turbo（6B）',
    family: 'zimage',
    kind: 'image',
    purpose: '8G 就能跑的快档，中英文字准，Apache 2.0 可商用',
    params: '6B S3-DiT + Qwen3-4B',
    license: 'Apache 2.0',
    vramGB: 10,
    minVRAM: 6,
    score: 92,
    buildable: true,
    needles: ['z_image_turbo', 'z-image-turbo', 'zimage'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'z_image_turbo_bf16.safetensors',
        sizeGB: 12,
        url: hf('Comfy-Org/z_image_turbo'),
        note: '12G 可用 bf16；8G 换 FP8/Q8',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen_3_4b.safetensors',
        sizeGB: 8,
        url: hf('Comfy-Org/z_image_turbo'),
        note: '官方模板用它',
      },
      {
        dir: 'models/vae',
        name: 'ae.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/z_image_turbo'),
      },
    ],
    workflow: wf(1024, 1024, 8, 1, 'euler', 'simple', 'Turbo 8 步；1024 方图'),
    notes: [
      '8G：FP8/Q8，768–1024；6G：Q4_K_M，512–768。',
      '海报、标题字、双语内容优先；复杂人脸细节不如 FLUX.3/Qwen 2.1。',
      'Apache 2.0，是这份清单里商用最省心的。',
    ],
  },
  {
    id: 'sdxl',
    name: 'SDXL 1.0',
    family: 'sdxl',
    kind: 'image',
    purpose: '最稳的通用底模，LoRA / ControlNet / 动漫生态最大',
    params: '3.5B UNet',
    license: 'CreativeML Open RAIL++-M（商用基本可用，需遵守使用限制）',
    vramGB: 10,
    minVRAM: 8,
    score: 88,
    buildable: true,
    needles: ['sd_xl_base', 'sdxl'],
    files: [
      {
        dir: 'models/checkpoints',
        name: 'sd_xl_base_1.0.safetensors',
        sizeGB: 6.9,
        url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      },
      {
        dir: 'models/vae',
        name: 'sdxl_vae.safetensors',
        sizeGB: 0.3,
        url: 'https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors',
      },
    ],
    workflow: wf(1024, 1024, 28, 7, 'dpmpp_2m', 'karras', 'SDXL 28 步'),
    notes: [
      '8G 用 768×1024；12G 可以 1024 方图。',
      '要动漫/写实人物，优先找 Illustrious / Pony / 写实大模型，不要死磕官方底模。',
      '生态成熟，出问题最容易搜到答案。',
    ],
  },
  {
    id: 'moss',
    name: 'MOSS-Image（5B）',
    family: 'moss',
    kind: 'image',
    purpose: '中文提示词、画面内文字和版式稳，Apache 2.0',
    params: '5B DiT + Qwen3.5-9B',
    license: 'Apache 2.0',
    vramGB: 12,
    minVRAM: 10,
    score: 86,
    buildable: true,
    needles: ['moss_image', 'moss-image', 'moss'],
    files: [
      {
        dir: 'models/unet',
        name: 'moss_image_sft_int8_convrot.safetensors',
        sizeGB: 5.4,
        url: hf('Comfy-Org/MOSS-Image'),
        note: '需自备整组权重',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3.5_9b_w4a8_gptq.safetensors',
        sizeGB: 6.7,
        url: hf('Comfy-Org/MOSS-Image'),
        note: 'CLIPLoader.type=moss_image',
      },
      {
        dir: 'models/vae',
        name: 'flux2-vae_small.safetensors',
        sizeGB: 0.2,
        url: hf('Comfy-Org/MOSS-Image'),
      },
      {
        dir: 'models/loras',
        name: 'MOSS_8_step_lora.safetensors',
        sizeGB: 0.2,
        url: hf('Comfy-Org/MOSS-Image'),
        note: '8 步加速',
      },
    ],
    workflow: wf(768, 1024, 8, 2.5, 'er_sde', 'simple', 'MOSS 8 步加速 LoRA'),
    notes: [
      '10–12G 可跑；768×1024 起步，爆显存把长边降到 640。',
      '中文海报、封面字、版式图优先；纯写实人像不如 Qwen/FLUX。',
      '本机已有的话是最省事的本地中文档。',
    ],
  },
  {
    id: 'qwen2512',
    name: 'Qwen-Image 2512（20B）',
    family: 'qwen2512',
    kind: 'image',
    purpose: '写实人像和自然细节最强的开源中文档之一，Apache 2.0',
    params: '20B MMDiT',
    license: 'Apache 2.0',
    vramGB: 14,
    minVRAM: 8,
    score: 94,
    buildable: false,
    needles: ['qwen_image_2512', 'qwen-image-2512'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'qwen_image_2512_fp8_e4m3fn.safetensors',
        sizeGB: 20.4,
        url: hf('Comfy-Org/Qwen-Image_ComfyUI'),
        note: 'FP8；12G 可 GGUF Q4/Q5',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
        sizeGB: 8.6,
        url: hf('Comfy-Org/Qwen-Image_ComfyUI'),
      },
      {
        dir: 'models/vae',
        name: 'qwen_image_vae.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/Qwen-Image_ComfyUI'),
      },
      {
        dir: 'models/loras',
        name: 'Qwen-Image-Lightning-4steps-V1.0.safetensors',
        sizeGB: 0.4,
        url: hf('lightx2v/Qwen-Image-Lightning'),
        note: '可选 4 步加速',
      },
    ],
    workflow: wf(1328, 1328, 20, 4, 'euler', 'simple', '2512；4 步 Lightning 可选'),
    notes: [
      '12G 走 GGUF Q4/Q5 + 1024 档，不要直接上 20G FP8 全量。',
      '写实人像、皮肤、布料、自然细节优先；中文文字也强。',
      'Apache 2.0，商用最自由的大模型。',
    ],
  },
  {
    id: 'krea2',
    name: 'Krea 2 Turbo（12.9B）',
    family: 'krea2',
    kind: 'image',
    purpose: '审美和风格化强，8 步出图，适合摄影感和概念图',
    params: '12.9B DiT + Qwen3-VL-4B',
    license: 'Krea 2 社区许可：非商用/研究为主，商用需看授权',
    vramGB: 16,
    minVRAM: 12,
    score: 90,
    buildable: false,
    needles: ['krea2', 'krea_2', 'krea-2'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'krea2_turbo_int8_convrot.safetensors',
        sizeGB: 6.5,
        url: hf('Comfy-Org/Krea-2'),
        note: '12G 用 int8；24G 可 FP8',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_4b_fp8_scaled.safetensors',
        sizeGB: 4.5,
        url: hf('Comfy-Org/Krea-2'),
        note: 'CLIPLoader.type=krea2',
      },
      {
        dir: 'models/vae',
        name: 'qwen_image_vae.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/Krea-2'),
      },
    ],
    workflow: wf(1024, 1024, 8, 0, 'euler', 'simple', 'Turbo 8 步，cfg 0'),
    notes: [
      '12G 只能 1024 档，16G 再上 2K。',
      '风格参考要额外下 krea2_style_reference LoRA。',
      '不支持指令改图，改图另找 Qwen/FLUX.3。',
    ],
  },
  {
    id: 'sd35',
    name: 'SD 3.5 Large（8B）',
    family: 'sd35',
    kind: 'image',
    purpose: '老牌通用模型，生态和教程多，文字一般',
    params: '8B MMDiT',
    license: 'Stability 社区许可：商用需看营收门槛',
    vramGB: 14,
    minVRAM: 8,
    score: 72,
    buildable: false,
    needles: ['sd3.5', 'sd35', 'stable-diffusion-3.5'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'sd3.5_large_fp8_scaled.safetensors',
        sizeGB: 8.2,
        url: hf('stabilityai/stable-diffusion-3.5-large'),
        note: '8G 可 fp8；更好质量用 bf16',
      },
      {
        dir: 'models/text_encoders',
        name: 'clip_l.safetensors / clip_g.safetensors / t5xxl_fp16.safetensors',
        sizeGB: 9.5,
        url: hf('Comfy-Org/stable-diffusion-3.5-fp8'),
        note: '三件套，T5 最占内存',
      },
      {
        dir: 'models/vae',
        name: 'sd3.5_vae.safetensors',
        sizeGB: 0.3,
        url: hf('stabilityai/stable-diffusion-3.5-large'),
      },
    ],
    workflow: wf(1024, 1024, 28, 4.5, 'dpmpp_2m', 'karras', 'SD3.5 28 步'),
    notes: [
      '8G 用 fp8 + 1024；12G 可以 T5 fp8。',
      '现在不建议新项目首选，生态正在往 FLUX/Qwen/Z-Image 迁。',
      '老工作流、ControlNet、LoRA 兼容性还可以。',
    ],
  },
  {
    id: 'qwenimage',
    name: 'Qwen-Image（20B 初版）',
    family: 'qwen',
    kind: 'image',
    purpose: '中文文字/海报老牌强者，工作流和 ControlNet 成熟',
    params: '20B MMDiT',
    license: 'Apache 2.0',
    vramGB: 16,
    minVRAM: 12,
    score: 78,
    buildable: true,
    needles: ['qwen_image_fp8_e4m3fn', 'qwen_image_distill', 'qwen_image_bf16'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'qwen_image_fp8_e4m3fn.safetensors',
        sizeGB: 20.4,
        url: hf('Comfy-Org/Qwen-Image_ComfyUI'),
        note: '12G 需 GGUF 或强 offload',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
        sizeGB: 8.6,
        url: hf('Comfy-Org/Qwen-Image_ComfyUI'),
      },
      {
        dir: 'models/vae',
        name: 'qwen_image_vae.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/Qwen-Image_ComfyUI'),
      },
    ],
    workflow: wf(768, 1024, 6, 1, 'euler', 'simple', 'Qwen-Image 6 步加速'),
    notes: [
      '12G 会很吃力；16G 起步更稳。',
      '已有工作流/ControlNet 的继续用，新项目优先 2512 或 2.1。',
    ],
  },
  {
    id: 'flux2dev',
    name: 'FLUX.2 dev（32B）',
    family: 'flux2dev',
    kind: 'image',
    purpose: '开源顶级写实和编辑质量，32B 大模型',
    params: '32B DiT',
    license: 'FLUX.2 非商用许可',
    vramGB: 32,
    minVRAM: 24,
    score: 102,
    buildable: false,
    needles: ['flux2-dev', 'flux2_dev', 'flux2'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'flux2-dev-Q4_K_M.gguf',
        sizeGB: 18,
        url: hf('city96/FLUX.2-dev-gguf'),
        note: '24G 用 Q4；32G+ 可 int8/bf16',
      },
      {
        dir: 'models/text_encoders',
        name: 'mistral3_8b_fp8_scaled.safetensors',
        sizeGB: 8,
        url: hf('Comfy-Org/flux2-dev'),
        note: 'FLUX.2 文本编码器',
      },
      {
        dir: 'models/vae',
        name: 'flux2-vae.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/flux2-dev'),
      },
    ],
    workflow: wf(1024, 1024, 28, 4, 'euler', 'simple', 'FLUX.2 dev 28 步'),
    notes: [
      '12G 不要碰，24G 也只能 Q4 + 1024。',
      '顶级写实/改图，但下载量和显存都重。',
      '非商用许可。',
    ],
  },
  {
    id: 'ideogram4',
    name: 'Ideogram 4.0（9.3B）',
    family: 'ideogram4',
    kind: 'image',
    purpose: '开源里最强的画面内文字/版式/Logo，适合海报和招牌',
    params: '9.3B DiT + Qwen3-VL-8B',
    license: 'Ideogram 非商用许可',
    vramGB: 24,
    minVRAM: 16,
    score: 85,
    buildable: false,
    needles: ['ideogram'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'ideogram4_uncond_int8_convrot.safetensors',
        sizeGB: 9.6,
        url: hf('Comfy-Org/Ideogram-4'),
        note: '双分支，cond + uncond 两份都要',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_8b_int8_convrot.safetensors',
        sizeGB: 10.6,
        url: hf('Comfy-Org/Ideogram-4'),
      },
      {
        dir: 'models/vae',
        name: 'ideogram4_vae.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/Ideogram-4'),
      },
    ],
    workflow: wf(1024, 1024, 28, 4, 'euler', 'simple', 'Ideogram 4 默认 28 步'),
    notes: [
      '16G 只能 nvfp4/GGUF Q4，24G 才舒服。',
      '做招牌、包装、海报字优先；普通写实人像没必要上它。',
      '非商用许可。',
    ],
  },
  {
    id: 'ming',
    name: 'Ming-Image 0.1 Design（6B）',
    family: 'ming',
    kind: 'image',
    purpose: 'UI、信息图、海报版式，支持 RGBA 透明输出，MIT',
    params: '6B DiT + Ling-mini-2.0',
    license: 'MIT',
    vramGB: 24,
    minVRAM: 16,
    score: 75,
    buildable: false,
    needles: ['ming_image', 'ming-image'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'ming_image_0.1_design_int8_convrot.safetensors',
        sizeGB: 6.2,
        url: hf('Comfy-Org/Ming-Image'),
      },
      {
        dir: 'models/text_encoders',
        name: 'ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors',
        sizeGB: 19.5,
        url: hf('Comfy-Org/Ming-Image'),
        note: '文本编码器比图像模型还大',
      },
      {
        dir: 'models/vae',
        name: 'ming_image_vae_bf16.safetensors',
        sizeGB: 0.3,
        url: hf('Comfy-Org/Ming-Image'),
      },
    ],
    workflow: wf(1024, 1024, 12, 1, 'euler', 'simple', 'Ming 12 步；2048 最佳'),
    notes: [
      '16G 需要 int8 + w4a8 编码器 + offload，24G 才稳。',
      '做 UI/信息图/透明分层素材优先。',
      '提示词增强会再加载 Qwen3.8-27B，小卡建议关掉。',
    ],
  },
  {
    id: 'minimax_img',
    name: 'MiniMax-H3-Image（33B）',
    family: 'minimax_img',
    kind: 'image',
    purpose: '单张 16MP、6 步、参考图改图，适合大幅海报',
    params: '33B DiT + Qwen3-VL-32B',
    license: 'H3 社区许可（有地区限制，商用先读条款）',
    vramGB: 24,
    minVRAM: 16,
    score: 92,
    buildable: false,
    needles: ['minimax_h3_image', 'minimax-h3-image'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'minimax_h3_image_pruned_int8_convrot.safetensors',
        sizeGB: 21,
        url: hf('Comfy-Org/MiniMax-H3-Image'),
        note: '16G 用 w4a8 / Q4 GGUF',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
        sizeGB: 25.3,
        url: hf('Comfy-Org/MiniMax-H3-Image'),
        note: '文本编码器比图像模型还大',
      },
      {
        dir: 'models/vae',
        name: 'minimax_h3_image_vae_fp16.safetensors',
        sizeGB: 1.2,
        url: hf('Comfy-Org/MiniMax-H3-Image'),
      },
    ],
    workflow: wf(2048, 2048, 6, 1, 'euler', 'simple', '6 步；约 16MP'),
    notes: [
      '24G 用 int8 + 4MP 起步；16G 用 w4a8 + 2–4MP + offload。',
      '系统内存至少 64G，文本编码器很大。',
      '做 4K 海报、超大幅面优先；普通 1024 图浪费。',
    ],
  },
  {
    id: 'sd15',
    name: 'SD 1.5',
    family: 'sd15',
    kind: 'image',
    purpose: '最低门槛，4G 也能跑，适合先跑通链路',
    params: '0.9B UNet',
    license: 'CreativeML Open RAIL-M',
    vramGB: 6,
    minVRAM: 4,
    score: 60,
    buildable: true,
    needles: ['v1-5-pruned', 'majicmix', 'sd15'],
    files: [
      {
        dir: 'models/checkpoints',
        name: 'v1-5-pruned-emaonly.safetensors',
        sizeGB: 4.0,
        url: 'https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
      },
      {
        dir: 'models/vae',
        name: 'vae-ft-mse-840000-ema-pruned.safetensors',
        sizeGB: 0.3,
        url: 'https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors',
      },
    ],
    workflow: wf(512, 768, 25, 7, 'dpmpp_2m', 'karras', 'SD1.5 512×768'),
    notes: [
      '4–6G 显存或 CPU 也能跑，但画质上限低。',
      '人像/动漫靠社区大模型和 LoRA 撑，不要用官方底模直接出片。',
      '只建议当兜底或测试链路。',
    ],
  },
];

const VIDEO: CatalogItem[] = [
  {
    id: 'minimax',
    name: 'MiniMax H3（文生视频）',
    family: 'minimax',
    kind: 'video',
    purpose: '图生/文生视频，带原生立体音频',
    params: '33B 多模态',
    license: 'H3 社区许可（有地区限制）',
    vramGB: 24,
    minVRAM: 16,
    score: 80,
    buildable: true,
    needles: ['minimax_h3_fl2va', 'minimax_h3'],
    files: [
      {
        dir: 'models/diffusion_models',
        name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
        sizeGB: 20,
        url: hf('Comfy-Org/MiniMax-H3'),
        note: '需整组 H3 权重',
      },
      {
        dir: 'models/text_encoders',
        name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        sizeGB: 15.7,
        url: hf('Comfy-Org/MiniMax-H3'),
      },
      {
        dir: 'models/vae',
        name: 'minimax_h3_video_vae_fp16.safetensors / minimax_h3_audio_vae_fp32.safetensors',
        sizeGB: 2,
        url: hf('Comfy-Org/MiniMax-H3'),
        note: '视频 + 音频两个 VAE',
      },
    ],
    workflow: wf(864, 480, 4, 1, 'euler', 'simple', 'MiniMax H3 4 步 Turbo，视频'),
    notes: [
      '12G 可以跑但需要重 offload，短片/低分辨率；24G 才舒服。',
      '显存不够会直接 OOM，不适合当默认视频档。',
      '视频和音频一次生成。',
    ],
  },
];

function fitFor(vramGB: number, minVRAM: number, recommended: number, score: number): ModelRec['fit'] {
  if (!vramGB) return 'heavy';
  if (vramGB >= recommended) return score >= 70 ? 'best' : 'light';
  if (vramGB >= minVRAM) return 'ok';
  if (vramGB >= minVRAM - 2) return 'light';
  return 'heavy';
}

/** 按显存、模型质量、本机已有权重给一套能落地的组合。 */
export function recommend(probe: SystemProbe, inventory?: InventoryLike): Recommendation {
  const gpu = probe.gpu[0];
  const vramGB = gpu?.vramTotalMiB ? gpu.vramTotalMiB / 1024 : 0;
  const allNames: string[] = [];
  for (const list of [inventory?.checkpoints, inventory?.unets, inventory?.vaes, inventory?.clips, inventory?.loras]) {
    for (const item of list || []) if (item?.name) allNames.push(String(item.name));
  }
  const names = allNames.map((name) => name.toLowerCase());
  const pick = (needles: string[]) =>
    allNames.find((name) => needles.some((needle) => name.toLowerCase().includes(needle.toLowerCase()))) || '';

  let tier = 'cpu';
  if (vramGB >= 24) tier = '24G+';
  else if (vramGB >= 16) tier = '16–24G';
  else if (vramGB >= 11) tier = '11–16G';
  else if (vramGB >= 7) tier = '7–11G';
  else if (vramGB >= 4) tier = '4–7G';

  const items: ModelRec[] = [...CATALOG, ...VIDEO].map((entry) => {
    const { needles, ...rest } = entry;
    const localModel = pick(needles);
    return {
      ...rest,
      fit: fitFor(vramGB, entry.minVRAM, entry.vramGB, entry.score),
      local: Boolean(localModel),
      localModel: localModel || undefined,
    };
  });

  const rank = { best: 0, ok: 1, light: 2, heavy: 3 } as const;
  items.sort((a, b) => {
    const byFit = rank[a.fit] - rank[b.fit];
    if (byFit) return byFit;
    if (a.score !== b.score) return b.score - a.score;
    if (a.local !== b.local) return a.local ? -1 : 1;
    return a.vramGB - b.vramGB;
  });

  const top = items
    .filter((item) => item.kind === 'image' && (item.fit === 'best' || item.fit === 'ok'))
    .sort((a, b) => rank[a.fit] - rank[b.fit] || b.score - a.score)
    .slice(0, 3);
  const topNames = top.map((item) => item.name.replace(/（.*?）/g, '').trim()).join(' / ');
  const gpuName = gpu ? `${gpu.name}（${vramGB ? vramGB.toFixed(0) + 'G 显存' : '显存未知'}）` : '没识别到 NVIDIA 显卡';
  const summary = !gpu || !vramGB
    ? '没读出显存：先按 SD1.5 跑通，或切网络后端；有 NVIDIA 卡就装好驱动再体检。'
    : vramGB >= 24
      ? `24G+：优先 ${topNames}；FLUX.2 dev / Qwen-Image 2512 可以放开跑，SDXL 留作 LoRA 兜底。`
      : vramGB >= 16
        ? `16–24G：优先 ${topNames}；Qwen-Image 2512 / Krea 2 也能上 2K，MiniMax 图要开 offload。`
        : vramGB >= 11
          ? `11–16G：优先 ${topNames}；SDXL 是最稳的 LoRA 底模，视频等 16G+ 再说。`
          : vramGB >= 7
            ? `7–11G：优先 ${topNames}；出图从 768×1024 起，1080P 要量化或分块。`
            : `4–7G：优先 ${topNames || 'SD 1.5'}；512×768 起步，或直接用网络后端。`;

  return {
    tier,
    summary,
    gpu: gpuName,
    vramGB: Math.round(vramGB),
    items,
    next: [
      '模型放到 ' + (probe.comfy.modelsDir || '<ComfyUI>/models') + ' 对应的子目录（checkpoints / diffusion_models / text_encoders / vae / loras）。',
      '放好后调用 studio_models(refresh=true)，再 studio_build(model=…, save_as=…) 生成工作流并设为默认。',
      '标“暂不自动生成工作流”的新模型，先在 ComfyUI 模板库跑通官方模板，再决定要不要接进画室。',
      '没有本地显卡或显存太小：设置页把默认后端切到 OpenAI 兼容 / Gemini / 通义万相。',
    ],
  };
}

export const MODEL_CATALOG_COUNT = CATALOG.length + VIDEO.length;
