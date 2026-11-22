/*! 画室（studio）配置：默认值、校验、密钥只报「有没有填」。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSize } from './util.ts';

export type BackendCfg = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
  timeoutMs: number;
  /** ComfyUI 专用 */
  workflow: string;
  workflowsDir: string;
  /** ComfyUI 自己的画布工作流目录（留空自动探测） */
  canvasDir: string;
  /** ComfyUI 的 models 目录（留空自动探测） */
  modelsDir: string;
  /** 兼容旧字段（小桥年代留下的），现在是空壳 */
  style: string;
  profile: string;
};

export type VideoCfg = {
  backend: string;
  width: number;
  height: number;
  length: number;
  timeoutMs: number;
  workflow: string;
};

/** 一个可选的人设外观。空着就按参考图/通用人物出图，不再写死某个角色。 */
export type PersonaCfg = {
  /** 固定外貌，英文更跟得住；不要写衣服和道具 */
  appearance: string;
  /** 没接衣柜、也没显式传 outfit 时的默认衣服 */
  defaultOutfit: string;
  /** 每张都带的标志性道具，例如 a film camera around the neck；留空就不加 */
  prop: string;
  /** 自拍没有日程时的默认场景 */
  selfieFallbackScene: string;
  /** 随手拍没有日程时的默认场景 */
  snapshotFallbackScene: string;
  /** 画画时追加的画者说明；留空用通用业余画者文案 */
  painterStyle: string;
  /** 画画没有指定主体时的默认主体 */
  paintFallbackSubject: string;
  /** 随机画的主体池；留空用内置通用池 */
  randomSubjects: string[];
  /** 画画的随机风格池；留空用 watercolor/sketch/illustration */
  paintStyles: string[];
};

/** 日程 / 衣柜是可选外部插件；路径和 personId 都可以按安装环境改。 */
export type ScheduleCfg = {
  enabled: boolean;
  /** 相对 plugins 根目录，或绝对路径 */
  dataDir: string;
};
export type WardrobeCfg = {
  enabled: boolean;
  /** 相对 plugins 根目录，或绝对路径 */
  dataDir: string;
  /** 衣柜 state 里的 persona key；留空自动取第一个 */
  personaId: string;
};
export type PoseCfg = {
  enabled: boolean;
  /** 相对 plugins 根目录，或绝对路径；姿势子插件 data 目录 */
  dataDir: string;
  /** 姿势 state 里的 persona key；留空自动取第一个 */
  personaId: string;
  /** 允许 draw 显式指定 private（性感系）姿势；默认关，未成年人格不要打开 */
  allowPrivate: boolean;
};
export type IntegrationsCfg = {
  schedule: ScheduleCfg;
  wardrobe: WardrobeCfg;
  pose: PoseCfg;
  /** 随手拍没有日程时用来补细节的英文短语池 */
  sceneDetails: string[];
};

export type StudioConfig = {
  /** local=本地生图工具，network=网络生图接口 */
  mode: 'local' | 'network';
  defaultBackend: string;
  python: string;
  outputDir: string;
  /** 人设参考图（本地图片路径）：自拍/画人设时当参考图，锁同一张脸 */
  faceRef: string;
  /** 人设 LoRA（文件名）：没有参考图时用它锁脸 */
  faceLora: string;
  faceLoraStrength: number;
  /** 本机 ComfyUI 根目录；留空不预填 */
  comfyRoot: string;
  /** 本机 SD-WebUI 根目录；留空不预填 */
  sdRoot: string;
  persona: PersonaCfg;
  integrations: IntegrationsCfg;
  backends: Record<string, BackendCfg>;
  video: VideoCfg;
};

const backend = (patch: Partial<BackendCfg> = {}): BackendCfg => ({
  enabled: true,
  baseUrl: '',
  apiKey: '',
  model: '',
  size: '',
  timeoutMs: 300_000,
  workflow: '',
  workflowsDir: '',
  canvasDir: '',
  modelsDir: '',
  style: '',
  profile: '',
  ...patch,
});

const DEFAULT_RANDOM_SUBJECTS = [
  'a glass of water on a windowsill, afternoon light',
  'the stairwell after rain, half the lights dead',
  'a desk with scattered pencils and a half-finished sketch',
  'a cat sleeping on a chair by the window',
  'the street outside the window at dusk',
  'a bowl of noodles on the kitchen table, steam rising',
  'the balcony with laundry drying in the wind',
  'a bicycle seat wet from the rain, leaves on the ground',
  'the corner of a classroom, chalk dust in the sun',
  'a stack of books and a small vase of flowers',
];
const DEFAULT_SCENE_DETAILS = [
  'steam from a cup on the desk',
  'a half-finished sketch and scattered pencils',
  'laundry drying on the balcony',
  'light falling across the floor',
  'a chair by the window, nobody sitting in it',
  'chalk dust floating in the sunlight',
  'a row of empty desks by the window',
  'a wet bicycle seat after the rain',
  'traffic lights just coming on',
];

export const DEFAULTS: StudioConfig = {
  mode: 'local',
  defaultBackend: 'comfy',
  python: '',
  outputDir: 'data/out',
  faceRef: '',
  faceLora: '',
  faceLoraStrength: 0.85,
  comfyRoot: '',
  sdRoot: '',
  persona: {
    appearance: '',
    defaultOutfit: '',
    prop: '',
    selfieFallbackScene: 'by the window',
    snapshotFallbackScene: 'a quiet corner by the window',
    painterStyle: '',
    paintFallbackSubject: '',
    randomSubjects: DEFAULT_RANDOM_SUBJECTS.slice(),
    paintStyles: ['watercolor', 'sketch', 'illustration'],
  },
  integrations: {
    schedule: { enabled: false, dataDir: 'schedule/data/days' },
    wardrobe: { enabled: false, dataDir: 'schedule/sub/wardrobe/data', personaId: '' },
    pose: { enabled: true, dataDir: 'studio/sub/pose/data', personaId: '', allowPrivate: false },
    sceneDetails: DEFAULT_SCENE_DETAILS.slice(),
  },
  backends: {
    comfy: backend({ enabled: false, baseUrl: '', workflowsDir: '', canvasDir: '', modelsDir: '' }),
    sdwebui: backend({ enabled: false, baseUrl: '', model: '' }),
    openai: backend({ enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', size: '1024x1024', timeoutMs: 180_000 }),
    gemini: backend({ enabled: false, baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image', timeoutMs: 180_000 }),
    dashscope: backend({ enabled: false, baseUrl: 'https://dashscope.aliyuncs.com', model: 'wanx2.2-t2i-flash', size: '1024*1024' }),
  },
  video: {
    backend: 'comfy',
    width: 864,
    height: 480,
    length: 124,
    timeoutMs: 2_400_000,
    workflow: '',
  },
};

export const BACKEND_NAMES = ['comfy', 'sdwebui', 'openai', 'gemini', 'dashscope'] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

const clampInt = (value: any, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const text = (value: any, fallback = '', max = 500): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : fallback;

const list = (value: any, fallback: string[], maxItems = 30, maxLen = 200): string[] => {
  if (!Array.isArray(value)) return fallback.slice();
  const items = value.map((item) => text(item, '', maxLen)).filter(Boolean).slice(0, maxItems);
  return items.length ? items : fallback.slice();
};

const http = (value: any, fallback: string): string => {
  const raw = text(value, fallback, 300).replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/.test(raw) ? raw : fallback;
};

/** 合并用户配置与默认值，逐字段校验；坏字段回退到默认而不是把整个配置打空。 */
export function normalize(raw: any): StudioConfig {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out: StudioConfig = JSON.parse(JSON.stringify(DEFAULTS));

  out.mode = source.mode === 'network' ? 'network' : 'local';
  const defaultBackend = text(source.defaultBackend);
  if ((BACKEND_NAMES as readonly string[]).includes(defaultBackend)) out.defaultBackend = defaultBackend;

  out.python = text(source.python, '', 400);
  out.outputDir = text(source.outputDir, DEFAULTS.outputDir, 400) || DEFAULTS.outputDir;
  out.faceRef = text(source.faceRef, '', 400);
  out.faceLora = text(source.faceLora, '', 200);
  out.faceLoraStrength = Number.isFinite(Number(source.faceLoraStrength))
    ? Math.max(0, Math.min(1.5, Number(source.faceLoraStrength)))
    : DEFAULTS.faceLoraStrength;
  out.comfyRoot = text(source.comfyRoot, '', 400);
  out.sdRoot = text(source.sdRoot, '', 400);

  const persona = source.persona && typeof source.persona === 'object' ? source.persona : {};
  out.persona = {
    appearance: text(persona.appearance, '', 600),
    defaultOutfit: text(persona.defaultOutfit, '', 400),
    prop: text(persona.prop, '', 300),
    selfieFallbackScene: text(persona.selfieFallbackScene, DEFAULTS.persona.selfieFallbackScene, 400) || DEFAULTS.persona.selfieFallbackScene,
    snapshotFallbackScene: text(persona.snapshotFallbackScene, DEFAULTS.persona.snapshotFallbackScene, 400) || DEFAULTS.persona.snapshotFallbackScene,
    painterStyle: text(persona.painterStyle, '', 400),
    paintFallbackSubject: text(persona.paintFallbackSubject, '', 400),
    randomSubjects: list(persona.randomSubjects, DEFAULTS.persona.randomSubjects),
    paintStyles: list(persona.paintStyles, DEFAULTS.persona.paintStyles, 10, 40),
  };

  const integrations = source.integrations && typeof source.integrations === 'object' ? source.integrations : {};
  const schedule = integrations.schedule && typeof integrations.schedule === 'object' ? integrations.schedule : {};
  const wardrobe = integrations.wardrobe && typeof integrations.wardrobe === 'object' ? integrations.wardrobe : {};
  const pose = integrations.pose && typeof integrations.pose === 'object' ? integrations.pose : {};
  out.integrations = {
    schedule: {
      enabled: typeof schedule.enabled === 'boolean' ? schedule.enabled : DEFAULTS.integrations.schedule.enabled,
      dataDir: text(schedule.dataDir, DEFAULTS.integrations.schedule.dataDir, 400) || DEFAULTS.integrations.schedule.dataDir,
    },
    wardrobe: {
      enabled: typeof wardrobe.enabled === 'boolean' ? wardrobe.enabled : DEFAULTS.integrations.wardrobe.enabled,
      dataDir: text(wardrobe.dataDir, DEFAULTS.integrations.wardrobe.dataDir, 400) || DEFAULTS.integrations.wardrobe.dataDir,
      personaId: text(wardrobe.personaId, '', 100),
    },
    pose: {
      enabled: typeof pose.enabled === 'boolean' ? pose.enabled : DEFAULTS.integrations.pose.enabled,
      dataDir: text(pose.dataDir, DEFAULTS.integrations.pose.dataDir, 400) || DEFAULTS.integrations.pose.dataDir,
      personaId: text(pose.personaId, '', 100),
      allowPrivate: pose.allowPrivate === true,
    },
    sceneDetails: list(integrations.sceneDetails, DEFAULTS.integrations.sceneDetails),
  };

  const incoming = source.backends && typeof source.backends === 'object' ? source.backends : {};
  for (const name of BACKEND_NAMES) {
    const base = DEFAULTS.backends[name];
    const value = incoming[name] && typeof incoming[name] === 'object' ? incoming[name] : {};
    const next: BackendCfg = { ...base };
    if (typeof value.enabled === 'boolean') next.enabled = value.enabled;
    next.baseUrl = http(value.baseUrl, base.baseUrl);
    next.apiKey = text(value.apiKey, base.apiKey, 300);
    next.model = text(value.model, base.model, 200);
    next.size = parseSize(value.size) ? text(value.size) : base.size;
    next.timeoutMs = clampInt(value.timeoutMs, 30_000, 3_600_000, base.timeoutMs);
    next.workflow = text(value.workflow, base.workflow, 200);
    next.workflowsDir = text(value.workflowsDir, base.workflowsDir, 400);
    next.canvasDir = text(value.canvasDir, base.canvasDir, 400);
    next.modelsDir = text(value.modelsDir, base.modelsDir, 400);
    next.style = text(value.style, base.style, 40);
    next.profile = text(value.profile, base.profile, 40);
    out.backends[name] = next;
  }

  const video = source.video && typeof source.video === 'object' ? source.video : {};
  out.video = {
    backend: (BACKEND_NAMES as readonly string[]).includes(video.backend) ? video.backend : DEFAULTS.video.backend,
    width: clampInt(video.width, 128, 4096, DEFAULTS.video.width),
    height: clampInt(video.height, 128, 4096, DEFAULTS.video.height),
    length: clampInt(video.length, 1, 2001, DEFAULTS.video.length),
    timeoutMs: clampInt(video.timeoutMs, 60_000, 3_600_000, DEFAULTS.video.timeoutMs),
    workflow: text(video.workflow, '', 200),
  };
  return out;
}

/** 设置页 / 接口回给前端时不带密钥明文，只说明填没填。 */
export function publicConfig(cfg: StudioConfig): any {
  const copy: any = JSON.parse(JSON.stringify(cfg));
  for (const name of BACKEND_NAMES) {
    const item = copy.backends[name];
    item.apiKeySet = Boolean(cfg.backends[name].apiKey);
    delete item.apiKey;
  }
  return copy;
}

/**
 * 表单只允许改这些字段：整份替换 backends 里某一项时，apiKey 留空表示「保持原值」，
 * 避免用户一点保存就把已经填好的密钥清掉。
 */
export function applyPatch(current: StudioConfig, patch: any): StudioConfig {
  const merged: any = JSON.parse(JSON.stringify(current));
  if (patch && typeof patch === 'object') {
    if (patch.mode !== undefined) merged.mode = patch.mode;
    if (patch.defaultBackend !== undefined) merged.defaultBackend = patch.defaultBackend;
    if (patch.outputDir !== undefined) merged.outputDir = patch.outputDir;
    if (patch.faceRef !== undefined) merged.faceRef = patch.faceRef;
    if (patch.faceLora !== undefined) merged.faceLora = patch.faceLora;
    if (patch.faceLoraStrength !== undefined) merged.faceLoraStrength = patch.faceLoraStrength;
    if (patch.python !== undefined) merged.python = patch.python;
    if (patch.comfyRoot !== undefined) merged.comfyRoot = patch.comfyRoot;
    if (patch.sdRoot !== undefined) merged.sdRoot = patch.sdRoot;
    if (patch.persona && typeof patch.persona === 'object') {
      for (const key of ['appearance', 'defaultOutfit', 'prop', 'selfieFallbackScene', 'snapshotFallbackScene', 'painterStyle', 'paintFallbackSubject', 'randomSubjects', 'paintStyles']) {
        if (patch.persona[key] !== undefined) merged.persona[key] = patch.persona[key];
      }
    }
    if (patch.integrations && typeof patch.integrations === 'object') {
      if (patch.integrations.schedule && typeof patch.integrations.schedule === 'object') {
        for (const key of ['enabled', 'dataDir']) {
          if (patch.integrations.schedule[key] !== undefined) merged.integrations.schedule[key] = patch.integrations.schedule[key];
        }
      }
      if (patch.integrations.wardrobe && typeof patch.integrations.wardrobe === 'object') {
        for (const key of ['enabled', 'dataDir', 'personaId']) {
          if (patch.integrations.wardrobe[key] !== undefined) merged.integrations.wardrobe[key] = patch.integrations.wardrobe[key];
        }
      }
      if (patch.integrations.pose && typeof patch.integrations.pose === 'object') {
        for (const key of ['enabled', 'dataDir', 'personaId', 'allowPrivate']) {
          if (patch.integrations.pose[key] !== undefined) merged.integrations.pose[key] = patch.integrations.pose[key];
        }
      }
      if (patch.integrations.sceneDetails !== undefined) merged.integrations.sceneDetails = patch.integrations.sceneDetails;
    }
    if (patch.backends && typeof patch.backends === 'object') {
      for (const name of BACKEND_NAMES) {
        const item = patch.backends[name];
        if (!item || typeof item !== 'object') continue;
        const target = merged.backends[name];
        for (const key of ['enabled', 'baseUrl', 'model', 'size', 'timeoutMs', 'workflow', 'workflowsDir', 'canvasDir', 'modelsDir', 'style', 'profile']) {
          if (item[key] !== undefined) target[key] = item[key];
        }
        if (typeof item.apiKey === 'string' && item.apiKey.trim()) target.apiKey = item.apiKey.trim();
      }
    }
    if (patch.video && typeof patch.video === 'object') {
      for (const key of ['backend', 'width', 'height', 'length', 'timeoutMs', 'workflow']) {
        if (patch.video[key] !== undefined) merged.video[key] = patch.video[key];
      }
    }
  }
  return normalize(merged);
}

/** ComfyUI 根目录：只认显式配置或 COMFY_ROOT；不再猜用户目录。 */
export function defaultComfyRoot(cfg?: Pick<StudioConfig, 'comfyRoot'> | null): string {
  return String(cfg?.comfyRoot ?? '').trim() || String(process.env.COMFY_ROOT ?? '').trim();
}

/** 找 Python：配置 → 环境变量 → ComfyUI 自带 → 常见位置 → PATH。找不到返回空串。 */
export function resolvePython(cfg: StudioConfig, comfyRootHint = ''): string {
  const store = /[\\/]WindowsApps[\\/]/i;
  const ok = (p: string) => Boolean(p) && existsSync(p) && !store.test(p);
  if (ok(cfg.python)) return cfg.python;
  const env = String(process.env.STUDIO_PYTHON ?? '').trim();
  if (ok(env)) return env;
  const roots = [
    String(process.env.COMFY_ROOT ?? '').trim(),
    comfyRootHint,
    defaultComfyRoot(cfg),
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of [['venv', 'Scripts', 'python.exe'], ['python_embeded', 'python.exe'], ['python_embedded', 'python.exe']]) {
      const candidate = join(root, ...rel);
      if (ok(candidate)) return candidate;
    }
  }
  const local = process.env.LOCALAPPDATA ?? '';
  const guesses = [
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
    local ? join(local, 'Programs', 'Python', 'Python312', 'python.exe') : '',
    local ? join(local, 'Programs', 'Python', 'Python313', 'python.exe') : '',
  ].filter(Boolean);
  for (const guess of guesses) if (ok(guess)) return guess;
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of String(process.env.PATH ?? '').split(sep)) {
    if (!dir || store.test(dir)) continue;
    for (const name of process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']) {
      const full = join(dir, name);
      if (ok(full)) return full;
    }
  }
  return '';
}
