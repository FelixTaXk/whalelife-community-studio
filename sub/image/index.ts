/*! 画室 · 画画：出图、看图、画蒙版、批量。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, MultimodalToolOutput } from 'whalelife';
import { backendName, runBackend, type ProviderContext } from '../../lib/providers.ts';
import { requestOf } from '../../lib/request.ts';
import { SIZE_FOR, normalizePaintingStyle, paintPrompt, selfPortraitPrompt, selfiePrompt, snapshotPrompt, type ShootKind } from './lib/look.ts';
import { randomPaintingStyle, randomSubject, resolveSelfieContext, resolveSnapshotContext } from './lib/context.ts';
import { runImgtool } from '../../lib/media.ts';
import { renderImageSettings } from '../../lib/sub-settings.ts';
import { describeTask, TaskBox } from '../../lib/tasks.ts';
import type { GenRequest, GenResult } from '../../lib/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type StudioService = {
  config(): Promise<any>;
  save(patch: any): Promise<any>;
  paths(): Promise<{ dataDir: string; pluginsRoot: string; outDir: string; workflowsDir: string; canvasDir: string; modelsDir: string; mappingsDir: string; python: string; script: string }>;
  workflows(options?: { kind?: 'image' | 'video' }): Promise<
    Array<{ name: string; format: 'api' | 'canvas'; kind?: 'image' | 'video'; slots?: string; notes?: string[]; error?: string }>
  >;
  models(options?: { refresh?: boolean }): Promise<any>;
  health(name?: string): Promise<any>;
};

/** 画室子插件「提示词小抄」暴露的可选服务；没装或停用时按原文出图。 */
type PromptkitService = {
  enrich?(input: { text: string; kind?: string; signal?: AbortSignal }): Promise<
    { text?: string; added?: Array<{ cat?: string; word?: string }>; skipped?: string } | null
  >;
  /** 随机配方：按小抄选中的层各挑一个词，用来给「随便画」补完整内容。 */
  recipe?(input: { extra?: string; lang?: string; layers?: string[] }): Promise<{ status?: string; text?: string; layers?: any[] } | null>;
  /** 共用负面提示词；空串表示没设置（不覆盖工作流自带的负面）。 */
  negativePrompt?(): Promise<string>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function apply(ctx: Context) {
  const studio = () => ctx.get('studio') as unknown as StudioService;
  /** 把 studio 配置翻译成场景解析器要的形状；没有对应段就按关闭处理。 */
  const sceneOptionsOf = (cfg: any, pluginsRoot?: string) => ({
    root: pluginsRoot,
    schedule: cfg?.integrations?.schedule,
    wardrobe: cfg?.integrations?.wardrobe,
    sceneDetails: cfg?.integrations?.sceneDetails,
    defaultOutfit: cfg?.persona?.defaultOutfit,
    selfieFallbackScene: cfg?.persona?.selfieFallbackScene,
    snapshotFallbackScene: cfg?.persona?.snapshotFallbackScene,
    randomSubjects: cfg?.persona?.randomSubjects,
    paintStyles: cfg?.persona?.paintStyles,
  });
  let promptkit: PromptkitService | null = null;
  type OptionalHook = <T>(name: string, onChange: (binding: any) => void) => () => void;
  const optional = (ctx as unknown as { optional?: OptionalHook }).optional;
  if (typeof optional === 'function') {
    optional<PromptkitService>('promptkit', (binding: any) => {
      promptkit = binding?.service ?? null;
      if (promptkit) ctx.logger.info('[画画] 提示词小抄已接入：出图前按小抄设置自动补词');
    });
  }

  /** 出图前让小抄补几个细节词；插件没装、关了自动补词或出错都按原文走。 */
  const enrichPrompt = async (text: string, kind: string, signal?: AbortSignal) => {
    const service = promptkit;
    if (!service?.enrich) return { text, added: [] as Array<{ cat: string; word: string }> };
    try {
      const result = await service.enrich({ text, kind, signal });
      const added = Array.isArray(result?.added)
        ? result!.added.filter((item: any) => item?.word).map((item: any) => ({ cat: String(item.cat ?? ''), word: String(item.word) }))
        : [];
      const next = String(result?.text ?? '').trim();
      return { text: next || text, added };
    } catch (error: any) {
      ctx.logger.warn(`[画画] 提示词小抄补词失败：${String(error?.message ?? error)}`);
      return { text, added: [] as Array<{ cat: string; word: string }> };
    }
  };

  /** 共用负面提示词：小抄里设置过才用；没装、没设置、出错都返回空串（不覆盖工作流自带的负面）。 */
  const sharedNegative = async () => {
    const service = promptkit;
    if (typeof service?.negativePrompt !== 'function') return '';
    try {
      return String((await service.negativePrompt()) ?? '').trim();
    } catch (error: any) {
      ctx.logger.warn(`[画画] 读取共用负面提示词失败：${String(error?.message ?? error)}`);
      return '';
    }
  };

  const tasks = new TaskBox({
    dir: join(DATA, 'tasks'),
    signal: ctx.signal,
    limit: 1,
    logger: (message) => ctx.logger.warn(`[画画] ${message}`),
  });
  ctx.effect(() => () => tasks.dispose());

  const waitTask = async (id: string, waitMs: number, signal?: AbortSignal) => {
    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      const record = tasks.get(id);
      if (!record) return null;
      if (record.status === 'done' || record.status === 'failed' || record.status === 'canceled') return record;
      await sleep(1000);
    }
    return tasks.get(id) ?? null;
  };

  const ingest = async (file: string, description: string, signal?: AbortSignal): Promise<any> => {
    try {
      const gallery = (ctx as any).get?.('gallery', false);
      if (!gallery?.ingest) return null;
      const bytes = readFileSync(file);
      const result = await gallery.ingest(
        {
          base64: bytes.toString('base64'),
          name: file.split(/[\\/]/).pop(),
          description: description.slice(0, 500),
          tags: ['画室', '生成'],
          purposes: ['image'],
          source: 'studio',
        },
        { signal },
      );
      return result?.id ?? null;
    } catch {
      return null;
    }
  };

  const finish = async (task: any, extra: Record<string, any> = {}) => {
    if (!task) return { status: 'error', error: '任务不存在或已被清理' };
    if (task.status === 'done') {
      const files = (task.files ?? []).filter((file: any) => file.kind === 'image');
      const first = files[0]?.path;
      const galleryId = first ? await ingest(first, String(task.prompt ?? '')) : null;
      return {
        status: 'ok',
        backend: task.backend,
        files: (task.files ?? []).map((file: any) => file.path),
        seed: task.seed,
        width: task.width,
        height: task.height,
        galleryId,
        imageUrl: galleryId ? `/plugins/gallery/image?id=${galleryId}` : null,
        sendHint: galleryId
          ? `想发出去就用 qq_send_gallery：先 qq_list_recipients 确认收件人，parts 里放 {"type":"image","id":"${galleryId}"}；配字最多一条、一句话，别描述画面里有什么（不报衣服、光、镜头），没话说就不配字；actionId 每次自己起一个稳定的。图库 id 只能用这一次这句，不要改 ID 重发。`
          : '这张还没进图库（图库插件没在跑？），只能给本地路径，发给别人之前先确认图库是否有这张。',
        notes: task.notes,
        taskId: task.id,
        ...extra,
      };
    }
    if (task.status === 'failed') return { status: 'error', error: task.error ?? '出图失败', taskId: task.id, backend: task.backend };
    if (task.status === 'canceled') return { status: 'canceled', taskId: task.id };
    return {
      status: 'running',
      taskId: task.id,
      backend: task.backend,
      hint: `还在跑。用 draw_task 工具传 id="${task.id}" 再查一次；完成后再看 image_view。`,
    };
  };

  /** 出一张图并等结果：自拍/随手拍/画 都走这里，只是提示词和默认画幅不同。 */
  const shoot = async (
    args: any,
    session: any,
    text: string,
    preset: Partial<GenRequest> = {},
    waitDefault = 180,
    anchor: boolean | 'full' | 'lora' | 'none' = false,
    kind: 'draw' | 'selfie' | 'snapshot' | 'paint' = 'draw',
  ) => {
    const cfg = await studio().config();
    const paths = await studio().paths();
    const picked = backendName(cfg, args?.backend);
    if ('error' in picked) return { status: 'error', error: picked.error };
    const explicit: Record<string, any> = requestOf(args);
    for (const key of Object.keys(explicit)) if (explicit[key] === undefined) delete explicit[key];
    const req: GenRequest = { ...preset, ...explicit, prompt: text };
    // 共用负面：这次没自己传 negative 才用设置里的那条；传了就以传的为准。
    if (!String(req.negative ?? '').trim()) {
      const shared = await sharedNegative();
      if (shared) req.negative = shared;
    }
    // 小抄补词：只补画面细节，不改人设、年龄和已写好的外观。
    const enriched = await enrichPrompt(req.prompt, kind, session?.signal);
    const promptNotes: string[] = [];
    if (enriched.added.length) {
      req.prompt = enriched.text;
      promptNotes.push(`小抄补词：${enriched.added.map((item) => item.word).join(', ')}`);
    }
    // 没给参考图、但设置里存了定妆照：默认拿它锁脸（只在自拍这类「必须是本人」的动作上生效）。
    const lockFace = anchor === true || anchor === 'full';
    const lockLora = lockFace || anchor === 'lora';
    if (lockFace && !req.image && !(req.refs ?? []).length && cfg.faceRef) req.image = String(cfg.faceRef);
    // 没定妆照、但有角色 LoRA：直接接 LoRA 出图（给 family，插件自己挑 moss 底模）。
    if (lockLora && cfg.faceLora) {
      req.loras = [{ name: String(cfg.faceLora), strength: Number(cfg.faceLoraStrength ?? 0.85) }];
      if (!req.image && !(req.refs ?? []).length) req.family = req.family ?? 'moss';
    }
    const provider: ProviderContext = {
      backend: picked.backend,
      cfg,
      outDir: paths.outDir,
      workflowsDir: paths.workflowsDir,
      canvasDir: paths.canvasDir,
      modelsDir: paths.modelsDir,
      mappingsDir: paths.mappingsDir,
    };
    const record = tasks.create(
      { kind: 'image', backend: picked.name, prompt: req.prompt, width: req.width, height: req.height },
      (signal) => runBackend(picked.name, req, { ...provider, signal }),
    );
    const waited = Number(args?.wait_seconds ?? waitDefault);
    const finished = await waitTask(record.id, Math.min(600, Math.max(0, waited)) * 1000, session?.signal);
    const out: any = await finish(finished);
    if (promptNotes.length) out.notes = [...promptNotes, ...(out.notes ?? [])];
    return out;
  };

  ctx.tools.register({
    name: 'draw',
    description:
      '画一张图（也用来生成照片）。用户说「随便画一幅 / 画个我 / 来张图 / 给我看看 / 发个自拍 / 拍个风景」时都用它：' +
      '自拍和风景只是提示词不同 —— prompt 里写清楚"自拍、手机前置、近景"或"没人入镜的角落、自然光"，别只写"一个人"。' +
      '要人物出镜，外貌按设置里的人设写全（appearance / defaultOutfit / prop），否则每张脸都不一样；人设留空就按参考图或通用人物。' +
      '默认走画室配好的后端；backend 可以指定 comfy / sdwebui / openai / gemini / dashscope。' +
      '只给 model（本地模型文件名）不给 workflow 时，插件会按这个模型现拼一份工作流再跑。' +
      '要给参考图传 image（本地路径），要重绘传 mask（与原图同尺寸的黑白蒙版，白=重画）。' +
      '一分钟内完的会直接给文件路径；更久会给任务号，用 draw_task 查。' +
      '出图后返回值里的 galleryId 就是发图要用的图库 ID，照 sendHint 发出去 —— 只说"画好了"用户看不到图。' +
      '发出去时不要描述画面里有什么（不报穿了什么、光怎么样、镜头在哪），最多一句说不出来的那点，或者干脆不配字。' +
      '图里要出现中文就直接写进 prompt、用中文引号括住（例如 招牌上用红色黑体写着"热牛奶"），一句七八个字以内，' +
      '并说明"字很大、占画面宽度一半"；一句话塞好几处、或者很小的字会糊成伪字，那种改用 image_text 压字。' +
      '想换工作流先看 image_workflows，想看有哪些模型先看 studio_models。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: '画面描述' },
        negative: { type: 'string', description: '不要出现的东西（部分后端不支持）' },
        size: { type: 'string', description: '宽x高，例如 832x1216' },
        width: { type: 'integer', description: '宽（和 height 一起用，优先于 size）' },
        height: { type: 'integer', description: '高' },
        n: { type: 'integer', description: '张数，默认 1' },
        seed: { type: 'integer', description: '种子，省略随机' },
        steps: { type: 'integer', description: '步数' },
        cfg: { type: 'number', description: 'CFG' },
        sampler: { type: 'string', description: '采样器名' },
        scheduler: { type: 'string', description: '调度器名' },
        model: { type: 'string', description: '底模 / 线上模型名；comfy 后端下给本地模型名，会自动拼工作流' },
        backend: { type: 'string', description: '指定后端，省略用默认' },
        workflow: { type: 'string', description: 'ComfyUI 工作流文件名（image_workflows 列出来的那些）' },
        image: { type: 'string', description: '参考图 / 首图的本地路径' },
        mask: { type: 'string', description: '蒙版本地路径，白=重画' },
        strength: { type: 'number', description: '重绘强度 0–1' },
        wait_seconds: { type: 'integer', description: '最多等多久，默认 180；超时给任务号' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args: any, session) {
      const req = requestOf(args);
      if (!req.prompt) return { status: 'error', error: 'prompt 不能为空' };
      return shoot(args, session, req.prompt);
    },
  });

  /** 自拍：同一个人的同一张脸，换场景/心情/衣服。 */
  ctx.tools.register({
    name: 'selfie',
    description:
      '一张自拍。外貌按设置里的人设（appearance / defaultOutfit / prop），只换场景和心情，所以每次都是同一个人；人设留空就按参考图或通用人物。' +
      '用户说「发个自拍 / 看看你 / 你在干嘛 / 来张照片 / 今天穿什么」时用这个，比 draw 省事。' +
      'scene 写具体地点和时间（"放学后的楼道""阳台，傍晚"）；mood 写神态（"刚睡醒""笑得眼睛往下垂"）；' +
      'outfit 换衣服（不填就按衣柜 / 默认穿搭自动补）；style=photo 默认、film 更像旧胶片；要画出来的形象用 self_portrait。' +
      'scene/outfit/mood 不填时，会按当前日程和衣柜自动补，写了就以写的为准。' +
      '也可以不等人开口就自己拍一张发过去 —— 想分享的时候直接调，不用说"我给你拍一张"再拍。' +
      '返回的 galleryId 按 sendHint 发出去，帖子/私聊都行；没发出去等于没拍。' +
      '发出去别描述画面（不报衣服、光、镜头、相机在哪），最多一句图里看不出来的话，或者只发图。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '在哪、什么时候。用英文短句最跟得住，例如 balcony at dusk, city lights just on；中文也行但模型常忽略' },
        mood: { type: 'string', description: '神态或心情，英文最好，例如 just woke up, hair still loose, sleepy smile' },
        outfit: { type: 'string', description: '穿什么；不填按衣柜当前这套自动补，再没有就用设置里的默认穿搭' },
        style: { type: 'string', enum: ['photo', 'film'], description: '默认 photo；要画成非写实画风用 self_portrait' },
        reference: { type: 'string', description: '参考图（本地路径）：给了就用 MOSS-Image Edit 锁脸；不填则用设置页里的定妆照' },
        image_strength: { type: 'number', description: '参考图强度 0–100，默认 1；想让衣服/动作改动大一点就调到 0.6–0.8' },
        model: { type: 'string', description: '本地模型名，不填用默认' },
        seed: { type: 'integer' },
        wait_seconds: { type: 'integer', description: '最多等多久，默认 180' },
      },
      additionalProperties: false,
    },
    async run(args: any, session) {
      const input = args ?? {};
      // 没写的字段按「日程 → 衣柜 → 人设默认」自动补；用户写了的就覆盖。
      const cfg = await studio().config();
      const paths = await studio().paths();
      const context = resolveSelfieContext(input, new Date(), sceneOptionsOf(cfg, paths.pluginsRoot));
      const merged = {
        ...input,
        scene: String(input.scene ?? '').trim() || context.scene,
        outfit: String(input.outfit ?? '').trim() || context.outfit,
        mood: String(input.mood ?? '').trim() || context.mood,
      };
      const built = selfiePrompt({ ...merged, persona: cfg.persona });
      const size = SIZE_FOR.selfie;
      const result: any = await shoot(merged, session, built.prompt, {
        negative: built.negative,
        width: size.width,
        height: size.height,
      }, 180, 'full', 'selfie');
      if (result.status === 'ok') {
        result.notes = [`自拍：${String(merged.scene ?? '') || '默认场景'}`, ...context.notes, ...(result.notes ?? [])];
      }
      return result;
    },
  });

  /** 随手拍：没人入镜的角落、光、东西。 */
  ctx.tools.register({
    name: 'snapshot',
    description:
      '随手拍的一张照片：没人入镜的角落、晾着的床单、雨后自行车座上的水珠这类。' +
      '用户说「拍个风景 / 拍张照 / 外面什么样 / 今天天气」时用它；scene 要写具体的物和光，别写"美丽的风景"。' +
      'style=film 默认（旧胶片味），photo 是手机直出；要画出来的景物用 paint。' +
      'scene 不填时按当前日程的地点和天气自动补，写了就以写的为准。' +
      '同样可以自己随手拍一张就发，不必等用户开口。返回的 galleryId 按 sendHint 发出去，别描述拍到了什么。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '拍什么，越具体越好，英文最好，例如 the stairwell at dusk, half the lights dead' },
        mood: { type: 'string', description: '光或气氛，例如 just rained, the ground still wet' },
        style: { type: 'string', enum: ['film', 'photo'], description: '默认 film' },
        model: { type: 'string' },
        seed: { type: 'integer' },
        wait_seconds: { type: 'integer', description: '最多等多久，默认 180' },
      },
      additionalProperties: false,
    },
    async run(args: any, session) {
      const input = args ?? {};
      const cfg = await studio().config();
      const paths = await studio().paths();
      const context = resolveSnapshotContext(input, new Date(), sceneOptionsOf(cfg, paths.pluginsRoot));
      const merged = {
        ...input,
        scene: String(input.scene ?? '').trim() || context.scene,
      };
      const built = snapshotPrompt({ ...merged, persona: cfg.persona });
      const size = SIZE_FOR.snapshot;
      const result: any = await shoot(merged, session, built.prompt, {
        negative: built.negative,
        width: size.width,
        height: size.height,
      }, 180, 'none', 'snapshot');
      if (result.status === 'ok') {
        result.notes = [`随手拍：${String(merged.scene ?? '') || '默认场景'}`, ...context.notes, ...(result.notes ?? [])];
      }
      return result;
    },
  });

  /** 画一幅：水彩/速写/插画，业余但不精；不写主体就随机画一张。 */
  ctx.tools.register({
    name: 'paint',
    description:
      '手绘的一幅画（水彩 / 速写 / 插画），不是照片。用户说「画一幅 / 随便画一张 / 画今天看到的」时用它。' +
      'subject 写画什么（人、街、桌上的东西都行）；不写 subject 就随机主体 + 随机画风，小抄会补构图和光影。' +
      '画面会带手绘的不完美：水色不均、铅笔底稿、纸纹。要画人物肖像用 self_portrait。' +
      '想把这幅画"递"给对方，同样按 sendHint 把 galleryId 发出去；递的时候不用解说画了什么。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '画什么，英文最好，例如 her brother sitting by the window；不填就随机' },
        mood: { type: 'string', description: '色调或情绪，例如「阴天，蓝得发灰」' },
        style: { type: 'string', enum: ['watercolor', 'sketch', 'illustration'], description: '不填默认水彩；随机画时随机挑' },
        model: { type: 'string' },
        seed: { type: 'integer' },
        wait_seconds: { type: 'integer', description: '最多等多久，默认 180' },
      },
      additionalProperties: false,
    },
    async run(args: any, session) {
      const input = args ?? {};
      const cfg = await studio().config();
      const explicitSubject = String(input.subject ?? '').trim();
      const fixedSubject = String(cfg?.persona?.paintFallbackSubject ?? '').trim();
      const hasSubject = Boolean(explicitSubject || fixedSubject);
      const style = input.style
        ? normalizePaintingStyle(String(input.style))
        : hasSubject
          ? 'watercolor'
          : normalizePaintingStyle(randomPaintingStyle(cfg?.persona?.paintStyles));
      const notes: string[] = [];
      let subject = explicitSubject || fixedSubject;
      if (!subject) {
        subject = randomSubject(cfg?.persona?.randomSubjects);
        notes.push(`随机主体：${subject}`, `随机画风：${style}`);
        const service = promptkit;
        if (typeof service?.recipe === 'function') {
          try {
            const recipe = await service.recipe({ layers: ['composition', 'lighting', 'style'] });
            const mergedText = String(recipe?.text ?? '').trim();
            if (mergedText) {
              subject = `${subject}, ${mergedText}`;
              notes.push('小抄配方：已补构图/光影词');
            }
          } catch (error: any) {
            ctx.logger.warn(`[画画] 随机配方失败：${String(error?.message ?? error)}`);
          }
        }
      }
      const built = paintPrompt({ subject, mood: input.mood, style, persona: cfg?.persona });
      const size = SIZE_FOR.paint;
      const result: any = await shoot(input, session, built.prompt, {
        negative: built.negative,
        width: size.width,
        height: size.height,
      }, 180, 'none', 'paint');
      if (result.status === 'ok') {
        result.notes = [explicitSubject || fixedSubject ? `画的：${subject}` : '画的：随机一张', ...notes, ...(result.notes ?? [])];
      }
      return result;
    },
  });

  /** 自画像：画出来的本人，保留配置外观，不接日程和衣柜。 */
  ctx.tools.register({
    name: 'self_portrait',
    description:
      '一张自画像，不是自拍、不是照片。用户说「画个我 / 画一张自己 / 来张自画像」时用它。' +
      '外貌按设置里的人设（appearance / defaultOutfit / prop），画风走水彩/速写/插画；不接日程和衣柜。' +
      '有角色 LoRA 时会尽量锁住同一张脸；人设留空就用通用人物。返回的 galleryId 按 sendHint 发出去。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        style: { type: 'string', enum: ['watercolor', 'sketch', 'illustration'], description: '默认 watercolor' },
        mood: { type: 'string', description: '神态或色调，例如「低着眼，安静」' },
        reference: { type: 'string', description: '参考图（本地路径），不填就只用角色 LoRA' },
        model: { type: 'string' },
        seed: { type: 'integer' },
        wait_seconds: { type: 'integer', description: '最多等多久，默认 180' },
      },
      additionalProperties: false,
    },
    async run(args: any, session) {
      const input = args ?? {};
      const cfg = await studio().config();
      const built = selfPortraitPrompt({ mood: input.mood, style: input.style, persona: cfg?.persona });
      const size = { width: 768, height: 1024 };
      const anchor = cfg?.faceLora ? 'lora' : 'none';
      const result: any = await shoot(input, session, built.prompt, {
        negative: built.negative,
        width: size.width,
        height: size.height,
      }, 180, anchor, 'paint');
      if (result.status === 'ok') {
        result.notes = [`自画像：${normalizePaintingStyle(String(input.style ?? ''))}`, ...(result.notes ?? [])];
      }
      return result;
    },
  });

  /** 在图上压中文字：字要卡死字体/排版时的补充手段（大字 MOSS 自己就能写）。 */
  ctx.tools.register({
    name: 'image_text',
    description:
      '给已有图片压中文字（表情包那种白条黑字，或者居中带描边的大字）。' +
      '大字其实 MOSS 自己就能写对：一句七八个字、高对比、背景干净，直接写在 draw 的 prompt 里、用中文引号括住就行。' +
      '这个工具用在三种情况：要固定字体（黑体/宋体）、要精确排版位置、或者字特别小/一大段——这些模型会糊成伪字。' +
      '用户说「做成表情包 / 加一句字 / 图上写点话 / 配个字」时用它：先 draw/selfie 出图，再把图路径传进来。' +
      'style=meme 是底部（或顶部）白条黑字，style=big 是直接压在画面上、带描边。' +
      '出图后按 sendHint 把 galleryId 发出去，也不用解说画面。',
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '底图的本地路径（draw/selfie/paint 返回的 files[0]）' },
        text: { type: 'string', description: '要写的字，短一点；想换行就写 \\n' },
        style: { type: 'string', enum: ['meme', 'big'], description: '默认 meme（白条黑字）' },
        position: { type: 'string', enum: ['bottom', 'top', 'center'], description: '默认 bottom' },
        size: { type: 'integer', description: '字号像素，省略按图宽自动（约 7.5%）' },
        color: { type: 'string', description: '字色，#RRGGBB，默认 #111111' },
        out: { type: 'string', description: '另存路径，省略存到输出目录' },
      },
      required: ['image', 'text'],
      additionalProperties: false,
    },
    async run(args: any) {
      const paths = await studio().paths();
      if (!paths.python) {
        return { status: 'error', error: '没找到 Python，压字用不了。在画室设置页填 python.exe 路径。' };
      }
      const image = String(args?.image ?? '').trim();
      if (!image) return { status: 'error', error: 'image 要给底图路径' };
      const cli = [
        'text',
        '--path', image,
        '--text', String(args?.text ?? ''),
        '--style', ['meme', 'big'].includes(String(args?.style)) ? String(args.style) : 'meme',
        '--position', ['bottom', 'top', 'center'].includes(String(args?.position)) ? String(args.position) : 'bottom',
        '--color', String(args?.color ?? '#111111'),
        '--out-dir', paths.outDir,
      ];
      if (Number(args?.size) > 0) cli.push('--size', String(Math.round(Number(args.size))));
      if (args?.out) cli.push('--out', String(args.out));
      const result = await runImgtool(paths.python, paths.script, cli, 60_000, ctx.signal);
      if (!result.ok) return { status: 'error', error: result.error ?? '压字失败' };
      const galleryId = await ingest(result.path, String(args?.text ?? ''));
      return {
        status: 'ok',
        files: [result.path],
        width: result.out?.width,
        height: result.out?.height,
        font: result.font,
        lines: result.lines,
        galleryId,
        imageUrl: galleryId ? `/plugins/gallery/image?id=${galleryId}` : null,
        sendHint: galleryId
          ? `想发出去就用 qq_send_gallery：先 qq_list_recipients 确认收件人，parts 里放 {"type":"image","id":"${galleryId}"}；配字最多一条、一句话，别把图上的字再抄一遍。`
          : '这张还没进图库，只能给本地路径。',
      };
    },
  });

  ctx.tools.register({
    name: 'draw_batch',
    description:
      '批量出图：每个 item 一套参数，任务排队逐个跑（同一张卡不并行）。立刻返回任务号，用 task 查进度。' +
      '一次最多 100 条；860 套这种规模按目录分批提交。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '每项至少有 prompt，可带 negative/size/seed/steps/model/image/mask/workflow',
          items: { type: 'object' },
          minItems: 1,
        },
        backend: { type: 'string', description: '统一指定后端；item 里的 backend 会覆盖它' },
      },
      required: ['items'],
      additionalProperties: false,
    },
    async run(args: any) {
      const cfg = await studio().config();
      const paths = await studio().paths();
      const items = Array.isArray(args?.items) ? args.items : [];
      if (!items.length) return { status: 'error', error: 'items 不能为空' };
      if (items.length > 100) return { status: 'error', error: `一次最多 100 条，收到 ${items.length} 条；分批提交` };
      const ids: string[] = [];
      const problems: string[] = [];
      for (const [index, item] of items.entries()) {
        const picked = backendName(cfg, item?.backend ?? args?.backend);
        if ('error' in picked) {
          problems.push(`#${index}: ${picked.error}`);
          continue;
        }
        const req = requestOf(item);
        if (!req.prompt) {
          problems.push(`#${index}: prompt 为空`);
          continue;
        }
        const enriched = await enrichPrompt(req.prompt, 'draw');
        if (enriched.added.length) req.prompt = enriched.text;
        // 共用负面（每张单独判断：这一张自己传了 negative 就用它的）
        if (!String(req.negative ?? '').trim()) {
          const shared = await sharedNegative();
          if (shared) req.negative = shared;
        }
        const provider: ProviderContext = {
          backend: picked.backend,
          cfg,
          outDir: paths.outDir,
          workflowsDir: paths.workflowsDir,
          canvasDir: paths.canvasDir,
          modelsDir: paths.modelsDir,
          mappingsDir: paths.mappingsDir,
        };
        const record = tasks.create(
          { kind: 'image', backend: picked.name, prompt: req.prompt, width: req.width, height: req.height },
          (signal) => runBackend(picked.name, req, { ...provider, signal }),
        );
        ids.push(record.id);
      }
      return {
        status: 'queued',
        count: ids.length,
        taskIds: ids,
        problems,
        hint: `${ids.length} 个任务已排队（逐个跑）。用 draw_task 工具 action=list 看全部，或 action=get + id 看单个。`,
      };
    },
  });

  ctx.tools.register({
    name: 'draw_task',
    description: '查画室的出图任务：给 id 看结果（含文件路径、种子、错误），action=list 看最近的，action=cancel 取消还在排队的。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务号' },
        action: { type: 'string', enum: ['get', 'list', 'cancel'], description: '默认 get' },
        limit: { type: 'integer', description: 'list 时最多几条，默认 20' },
      },
      additionalProperties: false,
    },
    async run(args: any) {
      const action = String(args?.action ?? (args?.id ? 'get' : 'list'));
      if (action === 'list') {
        const records = tasks.list(Number(args?.limit ?? 20));
        if (!records.length) return { status: 'ok', text: '还没有任务' };
        return { status: 'ok', tasks: records.map((record) => ({ ...record, summary: describeTask(record) })) };
      }
      const id = String(args?.id ?? '').trim();
      if (!id) return { status: 'error', error: '要给任务号' };
      if (action === 'cancel') {
        const done = tasks.cancel(id);
        return { status: done ? 'ok' : 'error', text: done ? `已取消 ${id}` : `${id} 不在可取消状态` };
      }
      const record = tasks.get(id);
      if (!record) return { status: 'error', error: `没有这个任务：${id}` };
      return { status: 'ok', task: { ...record, summary: describeTask(record) } };
    },
  });

  // ── 看图：带原图像素刻度 ─────────────────────────────────
  if (typeof ctx.tools.registerMultimodal === 'function') {
    ctx.tools.registerMultimodal({
      name: 'image_view',
      description:
        '看一张本地图片，返回带「原图像素」坐标刻度的图。可以裁剪、放大、标十字。' +
        '图上刻度就是原图坐标，报位置、画蒙版都按这个数。',
      danger: 'safe',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片完整路径（png/jpg/jpeg/webp）' },
          crop: { type: 'string', description: '只看一块：x,y,w,h（原图像素）' },
          scale: { type: 'number', description: '放大倍数 1–12，省略按 max_width 缩' },
          max_width: { type: 'integer', description: '成品最大宽度，默认 1024' },
          grid: { type: 'integer', description: '网格间距（原图像素），0=不画' },
          marks: { type: 'string', description: '十字标记点：x,y;x,y' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async run(args: any): Promise<MultimodalToolOutput> {
        const text = (value: string) => ({ type: 'text' as const, text: value });
        const raw = String(args?.path ?? '').trim();
        if (!raw) return { content: [text('要给一个图片路径。')], receipt: null };
        if (!existsSync(raw)) return { content: [text(`文件不存在：${raw}`)], receipt: null };
        if (!/\.(png|jpg|jpeg|webp)$/i.test(raw)) return { content: [text('只支持 png / jpg / jpeg / webp。')], receipt: null };
        const paths = await studio().paths();
        if (!paths.python) {
          return { content: [text('没找到 Python，看图用不了。在画室设置页填一个 python.exe 的完整路径（ComfyUI 的 venv 就行）。')], receipt: null };
        }
        if (!existsSync(paths.script)) return { content: [text(`看图脚本不见了：${paths.script}`)], receipt: null };
        const cli = ['view', '--path', raw, '--out-dir', paths.outDir];
        if (args?.crop) cli.push('--crop', String(args.crop));
        if (args?.scale) cli.push('--scale', String(args.scale));
        if (args?.max_width) cli.push('--max-width', String(args.max_width));
        if (args?.grid !== undefined && args?.grid !== null) cli.push('--grid', String(args.grid));
        if (args?.marks) cli.push('--marks', String(args.marks));
        const result = await runImgtool(paths.python, paths.script, cli, 60_000, ctx.signal);
        if (!result.ok) return { content: [text(`看图失败：${result.error}`)], receipt: null };
        try {
          const bytes = readFileSync(result.path);
          if (bytes.length > MAX_IMAGE_BYTES) {
            return { content: [text(`预览图 ${(bytes.length / 1024 / 1024).toFixed(1)} MB，超过 4 MB 上限；缩小 crop 再看。`)], receipt: null };
          }
          const crop = result.crop ?? {};
          const grid = result.grid ?? {};
          const lines = [
            `原图 ${result.src?.width}x${result.src?.height}；区域 x=${crop.x} y=${crop.y} w=${crop.w} h=${crop.h}${crop.clamped ? '（请求超出图，已夹到边界）' : ''}`,
            `缩放 x${result.scale}，成品 ${result.out?.width}x${result.out?.height}`,
            grid.step
              ? `网格 ${grid.step}px：竖线数字是原图 x（${(grid.x ?? []).join('、')}），横线是原图 y（${(grid.y ?? []).join('、')}）`
              : '没有画网格',
            '图上的数字就是原图像素坐标。',
            `文件：${result.path}`,
          ];
          if (result.compressed) lines.push('（图偏大，已压成 256 色）');
          if (result.marks?.length) lines.push(`标记点：${result.marks.map((p: number[]) => p.join(',')).join(' ; ')}`);
          return {
            content: [text(lines.join('\n')), { type: 'image' as const, mimeType: 'image/png' as const, data: bytes, detail: 'high' as const }],
            receipt: { action: 'image_view', file: result.path, crop: `${crop.x},${crop.y},${crop.w},${crop.h}` },
          };
        } catch (error: any) {
          return { content: [text(`读取预览图失败：${String(error?.message ?? error)}`)], receipt: null };
        }
      },
    });
  } else {
    ctx.logger.info('宿主没有 registerMultimodal，image_view 未注册（出图仍可用）。');
  }

  ctx.tools.register({
    name: 'image_mask',
    description:
      '在原图尺寸上画一张黑白蒙版（白=重画，黑=保留），拿去给 draw 的 mask 用。' +
      '给 boxes（x,y,w,h;x,y,w,h）或 poly（x,y x,y x,y，用分号隔开各点）。坐标就是 image_view 图上标的原图坐标。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '原图路径（蒙版会和它同尺寸）' },
        boxes: { type: 'string', description: '矩形区域：x,y,w,h，多个用分号隔开' },
        poly: { type: 'string', description: '多边形：x,y x,y x,y，点之间用分号隔开' },
        feather: { type: 'integer', description: '边缘羽化像素，默认 0（推荐硬边，重绘时工具会自己扩）' },
        invert: { type: 'boolean', description: '黑白反转' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    async run(args: any) {
      const paths = await studio().paths();
      if (!paths.python) return { status: 'error', error: '没找到 Python，画蒙版用不了。在画室设置页填 python.exe 路径。' };
      if (!existsSync(paths.script)) return { status: 'error', error: `边车脚本不见了：${paths.script}` };
      if (!args?.boxes && !args?.poly) return { status: 'error', error: 'boxes 和 poly 至少给一个' };
      const cli = ['mask', '--source', String(args.source), '--out-dir', paths.outDir];
      if (args?.boxes) cli.push('--boxes', String(args.boxes));
      if (args?.poly) cli.push('--poly', String(args.poly));
      if (args?.feather) cli.push('--feather', String(args.feather));
      if (args?.invert) cli.push('--invert');
      const result = await runImgtool(paths.python, paths.script, cli, 60_000, ctx.signal);
      if (!result.ok) return { status: 'error', error: result.error };
      return {
        status: 'ok',
        mask: result.path,
        width: result.width,
        height: result.height,
        coverage: result.coverage,
        text: `蒙版已生成：${result.path}（${result.width}x${result.height}，覆盖 ${Math.round(Number(result.coverage ?? 0) * 100)}%）。直接传给 draw 的 mask。`,
      };
    },
  });

  /** 画画这边能选哪些工作流：只列真正出图的，画布格式的会自动转。 */
  ctx.tools.register({
    name: 'image_workflows',
    description:
      '列出能拿来出图的 ComfyUI 工作流（插件目录的 API 格式 + ComfyUI 里存的画布格式，后者自动转），' +
      '带每份的槽位和可用性。选好后把名字传给 draw 的 workflow —— 先选工作流，再出图。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cfg = await studio().config();
      const all = await studio().workflows({ kind: 'image' });
      if (!all.length) return { status: 'ok', text: '没有能出图的工作流。检查 ComfyUI 的 workflows 目录，或往 data/workflows 里放 API 格式 json。' };
      return {
        status: 'ok',
        defaultBackend: cfg.defaultBackend,
        current: cfg.backends.comfy.workflow || null,
        workflows: all.map((entry) => ({
          name: entry.name,
          format: entry.format === 'canvas' ? '画布（自动转）' : 'API',
          usable: !entry.error,
          slots: entry.slots,
          error: entry.error,
        })),
        hint: '把 name 传给 draw 的 workflow；想换默认就改设置页的「工作流」。',
      };
    },
  });

  const readJsonBody = async (req: any, signal?: AbortSignal) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 64 * 1024) throw Error('提交的内容太大');
      chunks.push(Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  };

  ctx.web.page('/plugins/studio/image/settings', async (_req: any, res: any) => {
    const studioSvc = studio();
    const cfg = await studioSvc.config();
    const paths = await studioSvc.paths();
    let workflows: any[] = [];
    let models: any = {};
    let health: any = null;
    try {
      workflows = await studioSvc.workflows({ kind: 'image' });
    } catch {
      workflows = [];
    }
    try {
      models = await studioSvc.models({});
    } catch {
      models = {};
    }
    try {
      health = await studioSvc.health();
    } catch (error: any) {
      health = { online: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderImageSettings({ cfg, paths, workflows, models, health }));
  }, { title: '画画设置', settings: true, navigation: true });

  ctx.web.api('/plugins/studio/image/settings/save', async (req: any, res: any, { signal }: any) => {
    const json = (code: number, value: any) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    try {
      const body = await readJsonBody(req, signal);
      const patch: any = {};
      const backends = ['comfy', 'sdwebui', 'openai', 'gemini', 'dashscope'];
      if (typeof body?.defaultBackend === 'string' && backends.includes(body.defaultBackend)) patch.defaultBackend = body.defaultBackend;
      if (typeof body?.outputDir === 'string') patch.outputDir = body.outputDir.slice(0, 400);
      if (typeof body?.python === 'string') patch.python = body.python.slice(0, 400);
      if (body?.backends?.comfy && typeof body.backends.comfy === 'object') {
        patch.backends = { comfy: {} };
        for (const key of ['workflow', 'model', 'size']) {
          if (typeof body.backends.comfy[key] === 'string') patch.backends.comfy[key] = body.backends.comfy[key].slice(0, 300);
        }
      }
      await studio().save(patch);
      json(200, { ok: true });
    } catch (error: any) {
      json(400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  /** 让别的插件（比如自主性、QQ）也能直接要一张图，不必经过工具调用。 */
  ctx.provide('image', {
    generate: async (input: any, signal: AbortSignal): Promise<GenResult> => {
      const cfg = await studio().config();
      const paths = await studio().paths();
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
        signal,
      });
    },
    root: (await studio().paths()).outDir,
  });

  ctx.logger.info(`画画已加载：任务目录 ${join(DATA, 'tasks')}`);
}
