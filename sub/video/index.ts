/*! 画室 · 拍视频：走 ComfyUI 的视频工作流（MiniMax-H3 那类）。
 *
 * 一条片子要几分钟，远超一次工具调用的等待窗口，所以统一走任务表：
 * 先给任务号，之后用 video_task 查。宿主重启会把这些任务标成中断，不会假装还在跑。
 *
 * 不做「按模型拼视频工作流」：视频工作流里的自定义节点（sigma shift、私有三采样）太多，
 * 硬拼出来容易跑到一半报错，用你在 ComfyUI 里已经跑通的那份更稳。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'whalelife';
import { inferMapping } from '../../lib/comfy-workflow.ts';
import { ComfyClient } from '../../lib/comfy.ts';
import { loadWorkflow, runBackend } from '../../lib/providers.ts';
import { renderVideoSettings } from '../../lib/sub-settings.ts';
import { describeTask, TaskBox } from '../../lib/tasks.ts';
import type { GenResult } from '../../lib/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');

type StudioService = {
  config(): Promise<any>;
  save(patch: any): Promise<any>;
  paths(): Promise<{
    dataDir: string;
    outDir: string;
    workflowsDir: string;
    canvasDir: string;
    modelsDir: string;
    mappingsDir: string;
    python: string;
    script: string;
  }>;
  workflows(options?: { kind?: 'image' | 'video' }): Promise<
    Array<{ name: string; format: 'api' | 'canvas'; kind?: 'image' | 'video'; slots?: string; notes?: string[]; error?: string }>
  >;
  health(name?: string): Promise<any>;
};

export async function apply(ctx: Context) {
  const studio = () => ctx.get('studio') as unknown as StudioService;
  const tasks = new TaskBox({
    dir: join(DATA, 'tasks'),
    signal: ctx.signal,
    limit: 1,
    logger: (message) => ctx.logger.warn(`[拍视频] ${message}`),
  });
  ctx.effect(() => () => tasks.dispose());

  const runComfyVideo = async (cfg: any, paths: any, args: any, signal: AbortSignal): Promise<GenResult> => {
    const backend = cfg.backends.comfy;
    if (!backend?.enabled) return { ok: false, error: 'ComfyUI 后端没启用', backend: 'comfy' };
    const name = String(args.workflow || cfg.video.workflow || '').trim();
    if (!name) {
      return {
        ok: false,
        error: '还没指定视频工作流：在设置页把「视频工作流」填成输出视频的那份，或调用时传 workflow',
        backend: 'comfy',
      };
    }
    return runBackend(
      'comfy',
      {
        prompt: args.prompt,
        width: args.width ?? cfg.video.width,
        height: args.height ?? cfg.video.height,
        image: args.image,
        seed: args.seed,
        workflow: name,
        extra: { length: args.length ?? cfg.video.length, ...(args.fps ? { fps: args.fps } : {}) },
      },
      {
        backend,
        cfg,
        outDir: paths.outDir,
        workflowsDir: paths.workflowsDir,
        canvasDir: paths.canvasDir,
        modelsDir: paths.modelsDir,
        mappingsDir: paths.mappingsDir,
        signal,
      },
    );
  };

  /** 参数不对就别排队了：这些错当场能看出来，让调用方立刻拿到。 */
  const preflight = async (cfg: any, paths: any, args: any): Promise<string | null> => {
    if (!String(args?.prompt ?? '').trim()) return 'prompt 不能为空';
    if (args?.image && !existsSync(args.image)) return `首帧不存在：${args.image}`;
    const name = String(args.workflow || cfg.video.workflow || '').trim();
    if (!name) {
      return '还没指定视频工作流：设置页「视频工作流」空着，现在也没有能自动拼的视频家族。用 video_workflows 看有哪些可用';
    }
    try {
      const loaded = await loadWorkflow(name, {
        workflowsDir: paths.workflowsDir,
        canvasDir: paths.canvasDir,
        client: new ComfyClient(cfg.backends.comfy.baseUrl, 20_000),
      });
      const mapping = inferMapping(loaded.workflow);
      if (mapping.outputKind !== 'video') {
        return `${name} 输出的是图片，不是视频；请换一份带 SaveVideo / VHS_VideoCombine 的工作流`;
      }
    } catch (error: any) {
      return `读不了这份工作流：${String(error?.message ?? error)}`;
    }
    return null;
  };

  ctx.tools.register({
    name: 'make_video',
    description:
      '用 ComfyUI 的视频工作流出片（MiniMax-H3 图生视频那类）。她说的「拍个视频 / 录一段 / 发个动态 / 动一下」都是这个。' +
      'prompt 写动作和镜头：她在做什么、镜头怎么动、光怎么变。' +
      '要她本人动起来，先用 selfie（或 draw）出一张首帧，把那张图路径传给 image —— 视频只认首帧，不认文字描述的长相。' +
      '默认 864x480、124 帧（约 5 秒）。几分钟起，立刻返回任务号，用 video_task 查。' +
      '发出去之后别描述画面里有什么，最多一句当时在忙什么。' +
      '不确定能用哪份工作流就先调 video_workflows；没有可用工作流时它会直接说清楚，不要拿生图工作流硬凑。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, description: '视频里在发生什么、镜头怎么动' },
        width: { type: 'integer', description: '宽，默认取设置页' },
        height: { type: 'integer', description: '高，默认取设置页' },
        length: { type: 'integer', description: '帧数。MiniMax-H3 按 17k+5 对齐、24fps：73≈3 秒、124≈5 秒、227≈9.5 秒；训练区间是 124–362' },
        fps: { type: 'integer', description: '帧率（可选）' },
        image: { type: 'string', description: '首帧图片的本地路径（可选）' },
        seed: { type: 'integer', description: '种子' },
        workflow: { type: 'string', description: '视频工作流文件名，省略用设置页里的' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args: any) {
      if (!String(args?.prompt ?? '').trim()) return { status: 'error', error: 'prompt 不能为空' };
      const cfg = await studio().config();
      const paths = await studio().paths();
      const problem = await preflight(cfg, paths, args);
      if (problem) return { status: 'error', error: problem };
      const record = tasks.create(
        { kind: 'video', backend: 'comfy', prompt: String(args.prompt), width: args.width, height: args.height },
        (signal) => runComfyVideo(cfg, paths, args, signal),
      );
      return {
        status: 'queued',
        taskId: record.id,
        backend: 'comfy',
        workflow: String(args.workflow || cfg.video.workflow),
        hint: `已排队。用 video_task 传 id="${record.id}" 查进度；一条片子通常几分钟。`,
      };
    },
  });

  ctx.tools.register({
    name: 'video_workflows',
    description:
      '列出能出视频的 ComfyUI 工作流（插件目录的 API 格式 + ComfyUI 里存的画布格式，后者自动转），' +
      '带槽位和可用性。选好后把名字传 make_video 的 workflow。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cfg = await studio().config();
      const all = await studio().workflows({ kind: 'video' });
      if (!all.length) {
        return {
          status: 'ok',
          text: '没有能出视频的 ComfyUI 工作流。在 ComfyUI 里存一份带 SaveVideo / VHS_VideoCombine 的工作流，' +
            '或者把一份已经跑通的视频工作流「导出 → API」放进 data/workflows。',
          current: cfg.video.workflow || null,
        };
      }
      return {
        status: 'ok',
        current: cfg.video.workflow || null,
        workflows: all.map((entry) => ({
          name: entry.name,
          format: entry.format === 'canvas' ? '画布（自动转）' : 'API',
          usable: !entry.error,
          slots: entry.slots,
          error: entry.error,
        })),
        hint: '把 name 传给 make_video 的 workflow；想换默认就改设置页的「视频工作流」。',
      };
    },
  });

  ctx.tools.register({
    name: 'video_task',
    description: '查视频任务：给 id 看结果（本地 mp4 路径、尺寸、帧数），action=list 看最近的，action=cancel 取消还没开始的那条。',
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
        if (!records.length) return { status: 'ok', text: '还没有视频任务' };
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
      if (record.status === 'running') {
        const elapsed = record.startedAt ? Math.round((Date.now() - Date.parse(record.startedAt)) / 1000) : 0;
        return { status: 'running', task: record, text: `${id} 还在跑，已 ${elapsed} 秒` };
      }
      return { status: 'ok', task: { ...record, summary: describeTask(record) } };
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

  ctx.web.page('/plugins/studio/video/settings', async (_req: any, res: any) => {
    const studioSvc = studio();
    const cfg = await studioSvc.config();
    const paths = await studioSvc.paths();
    let workflows: any[] = [];
    let health: any = null;
    try {
      workflows = await studioSvc.workflows({ kind: 'video' });
    } catch {
      workflows = [];
    }
    try {
      health = await studioSvc.health(cfg.video?.backend);
    } catch (error: any) {
      health = { online: false, reason: String(error?.message ?? error).slice(0, 200) };
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderVideoSettings({ cfg, paths, workflows, health }));
  }, { title: '拍视频设置', settings: true, navigation: true });

  ctx.web.api('/plugins/studio/video/settings/save', async (req: any, res: any, { signal }: any) => {
    const json = (code: number, value: any) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    try {
      const body = await readJsonBody(req, signal);
      const source = body?.video && typeof body.video === 'object' ? body.video : {};
      const int = (value: any, min: number, max: number) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : undefined;
      };
      const patch: any = { video: {} };
      const backends = ['comfy', 'sdwebui', 'openai', 'gemini', 'dashscope'];
      if (typeof source.backend === 'string' && backends.includes(source.backend)) patch.video.backend = source.backend;
      if (typeof source.workflow === 'string') patch.video.workflow = source.workflow.slice(0, 300);
      for (const [key, min, max] of [['width', 64, 4096], ['height', 64, 4096], ['length', 1, 1000], ['timeoutMs', 60_000, 3_600_000]] as const) {
        const value = int(source[key], min, max);
        if (value !== undefined) patch.video[key] = value;
      }
      await studio().save(patch);
      json(200, { ok: true });
    } catch (error: any) {
      json(400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.logger.info(`拍视频已加载：任务目录 ${join(DATA, 'tasks')}`);
}
