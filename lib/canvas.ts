/*! 画室：把 ComfyUI 的「画布格式」工作流转成「API 格式」。
 *
 * 为什么要这一步：ComfyUI 界面另存出来的是画布格式（有 nodes / links 数组，没有 class_type），
 * 而 /prompt 只吃 API 格式。手动「导出 → API」每次换工作流都要点一遍，所以这里在内存里转。
 *
 * 两套映射：
 *   1) 优先问 ComfyUI 的 /object_info 要节点定义 —— 自定义节点（MiniMax、外部工具包）也能转；
 *   2) 问不到（ComfyUI 没开）就退回静态表，只认常用的十几种节点，认不出就报错，不猜。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

/** 注释 / 路由节点：不参与执行。 */
const SKIP_TYPES = new Set(['Note', 'MarkdownNote', 'PrimitiveNode', 'Reroute', 'Reroute (rgthree)']);

/** 这些类型在画布上是「控件」（直接在节点上填值），不是连线。 */
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/** seed 后面那格「生成后怎么变」，画布会多塞一个值，转换时要跳过。 */
const CONTROL_VALUES = new Set(['fixed', 'randomize', 'increment', 'decrement']);
const SEED_NAMES = new Set(['seed', 'noise_seed', 'batch_seed']);

/** 静态表：object_info 拿不到时的兜底。值是 widgets_values 的下标 → inputs 字段名。 */
const STATIC_WIDGETS: Record<string, Array<string | null>> = {
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type', 'device'],
  VAELoader: ['vae_name'],
  CheckpointLoaderSimple: ['ckpt_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  CLIPSetLastLayer: ['stop_at_clip_layer'],
  CLIPTextEncode: ['text'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['add_noise', 'noise_seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  VAEDecode: [],
  VAEEncode: [],
  VAEEncodeForInpaint: ['grow_mask_by'],
  SaveImage: ['filename_prefix'],
  PreviewImage: [],
  LoadImage: ['image', null],
  LoadImageMask: ['image', 'channel'],
  UpscaleModelLoader: ['model_name'],
  ImageUpscaleWithModel: [],
};

/** 静态表：入线顺序（target_slot 下标）→ inputs 字段名。 */
const STATIC_LINKS: Record<string, string[]> = {
  CLIPTextEncode: ['clip'],
  KSampler: ['model', 'positive', 'negative', 'latent_image'],
  KSamplerAdvanced: ['model', 'positive', 'negative', 'latent_image'],
  VAEDecode: ['samples', 'vae'],
  VAEEncode: ['pixels', 'vae'],
  VAEEncodeForInpaint: ['pixels', 'vae', 'mask'],
  SaveImage: ['images'],
  PreviewImage: ['images'],
  LoraLoader: ['model', 'clip'],
  CLIPSetLastLayer: ['clip'],
  ImageUpscaleWithModel: ['upscale_model', 'image'],
};

export type CanvasLookup = (type: string) => Promise<any | null>;

/** 判断这份 json 是画布格式还是已经是 API 格式。 */
export function isCanvas(value: any): boolean {
  return Boolean(value) && Array.isArray(value.nodes) && !value.nodes.every?.((node: any) => node?.class_type);
}

type Slot = { name: string; kind: 'widget' | 'link'; control?: boolean };

/** 从 object_info 的单节点定义里，按定义顺序拆出「控件」和「连线」两类输入。 */
function slotsFromObjectInfo(info: any): { widget: Slot[]; link: Slot[] } {
  const required = info?.input?.required ?? {};
  const optional = info?.input?.optional ?? {};
  const widget: Slot[] = [];
  const link: Slot[] = [];
  for (const [name, spec] of [...Object.entries<any>(required), ...Object.entries<any>(optional)]) {
    const type = Array.isArray(spec) ? spec[0] : spec;
    const options = Array.isArray(spec) ? spec[1] ?? {} : {};
    const isCombo = Array.isArray(type);
    const isWidget = isCombo || (typeof type === 'string' && WIDGET_TYPES.has(type));
    if (options?.forceInput === true) {
      link.push({ name, kind: 'link' });
      continue;
    }
    if (isWidget) {
      const control = SEED_NAMES.has(name) || options?.control_after_generate === true;
      widget.push({ name, kind: 'widget', control });
    } else {
      link.push({ name, kind: 'link' });
    }
  }
  return { widget, link };
}

/** 静态表转成同样形状的槽位列表。 */
function slotsFromStatic(type: string): { widget: Slot[]; link: Slot[] } | null {
  const widgets = STATIC_WIDGETS[type];
  const links = STATIC_LINKS[type];
  if (!widgets || !links) return null;
  return {
    widget: widgets.filter((name): name is string => Boolean(name)).map((name) => ({ name, kind: 'widget' as const })),
    link: links.map((name) => ({ name, kind: 'link' as const })),
  };
}

export type CanvasConversion = {
  api: Record<string, any>;
  /** 用了静态兜底表的节点类型 */
  guessed: string[];
  /** 被跳过的节点（注释、静音） */
  skipped: string[];
};

/**
 * 画布 → API。
 * lookup 拿不到定义时退回静态表；两边都不认识就抛，并点名是哪个节点类型。
 */
export async function canvasToApi(canvas: any, lookup?: CanvasLookup): Promise<CanvasConversion> {
  const nodes: any[] = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const links: any[] = Array.isArray(canvas?.links) ? canvas.links : [];

  const origin = new Map<number, { id: number; slot: number }>();
  const into = new Map<string, { link: number }>();
  for (const item of links) {
    if (!Array.isArray(item) || item.length < 5) continue;
    const linkId = Number(item[0]);
    origin.set(linkId, { id: Number(item[1]), slot: Number(item[2]) });
    into.set(`${Number(item[3])}:${Number(item[4])}`, { link: linkId });
  }

  const api: Record<string, any> = {};
  const guessed: string[] = [];
  const skipped: string[] = [];

  for (const node of nodes) {
    const type = String(node?.type ?? '');
    if (!type) continue;
    if (SKIP_TYPES.has(type) || type.startsWith('Reroute')) {
      skipped.push(type);
      continue;
    }
    // mode 2 = 静音（永远不会执行）；4 = 旁路，画面链路会直接从上游接过来，这里按静音处理并提示。
    if (Number(node?.mode) === 2 || Number(node?.mode) === 4) {
      skipped.push(`${type}#${node?.id}${Number(node?.mode) === 4 ? '（旁路）' : ''}`);
      continue;
    }

    let slots: { widget: Slot[]; link: Slot[] } | null = null;
    if (lookup) {
      const info = await lookup(type).catch(() => null);
      if (info) slots = slotsFromObjectInfo(info);
    }
    if (!slots) {
      slots = slotsFromStatic(type);
      if (slots) guessed.push(type);
    }
    if (!slots) {
      throw new Error(
        `不认识节点类型 '${type}'（id=${node?.id}）：ComfyUI 没给 /object_info 定义，静态表里也没有。` +
        `请在 ComfyUI 里用「导出 → API 格式」手动导出这份工作流。`,
      );
    }

    const inputs: Record<string, any> = {};
    const raw = node?.widgets_values;
    if (Array.isArray(raw)) {
      let index = 0;
      for (const slot of slots.widget) {
        if (index >= raw.length) break;
        const value = raw[index];
        index += 1;
        // seed 后面常跟一格「fixed / randomize」，那不是输入字段。
        if (slot.control && typeof raw[index] === 'string' && CONTROL_VALUES.has(raw[index])) index += 1;
        inputs[slot.name] = value;
      }
    } else if (raw && typeof raw === 'object') {
      Object.assign(inputs, raw);
    }

    slots.link.forEach((slot, position) => {
      const target = into.get(`${Number(node?.id)}:${position}`);
      if (!target) return;
      const source = origin.get(target.link);
      if (!source) throw new Error(`节点 ${node?.id} 的连线 ${target.link} 找不到起点`);
      inputs[slot.name] = [String(source.id), source.slot];
    });

    api[String(node.id)] = { class_type: type, inputs };
  }

  if (!Object.keys(api).length) throw new Error('转换后一个节点都没有，这份工作流可能是空的');
  return { api, guessed, skipped };
}
