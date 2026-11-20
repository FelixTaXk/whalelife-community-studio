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

export type StudioConfig = {
  defaultBackend: string;
  python: string;
  outputDir: string;
  /** 她的定妆照（本地图片路径）：自拍/画她时当参考图，锁同一张脸 */
  faceRef: string;
  /** 她的角色 LoRA（文件名）：没有定妆照时用它锁脸 */
  faceLora: string;
  faceLoraStrength: number;
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

export const DEFAULTS: StudioConfig = {
  defaultBackend: 'comfy',
  python: '',
  outputDir: 'data/out',
  faceRef: '',
  faceLora: '',
  faceLoraStrength: 0.85,
  backends: {
    comfy: backend({ baseUrl: 'http://127.0.0.1:8188', workflowsDir: 'workflows', canvasDir: '', modelsDir: 'D:\\ComfyUI\\models' }),
    sdwebui: backend({ enabled: false, baseUrl: 'http://127.0.0.1:7860' }),
    openai: backend({ enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', size: '1024x1024', timeoutMs: 180_000 }),
    gemini: backend({ enabled: false, baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image', timeoutMs: 180_000 }),
    dashscope: backend({ enabled: false, baseUrl: 'https://dashscope.aliyuncs.com', model: 'wanx2.2-t2i-flash', size: '1024*1024' }),
  },
  video: {
    backend: 'comfy',
    width: 480,
    height: 832,
    length: 97,
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

const http = (value: any, fallback: string): string => {
  const raw = text(value, fallback, 300).replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/.test(raw) ? raw : fallback;
};

/** 合并用户配置与默认值，逐字段校验；坏字段回退到默认而不是把整个配置打空。 */
export function normalize(raw: any): StudioConfig {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out: StudioConfig = JSON.parse(JSON.stringify(DEFAULTS));

  const defaultBackend = text(source.defaultBackend);
  if ((BACKEND_NAMES as readonly string[]).includes(defaultBackend)) out.defaultBackend = defaultBackend;

  out.python = text(source.python, '', 400);
  out.outputDir = text(source.outputDir, DEFAULTS.outputDir, 400) || DEFAULTS.outputDir;
  out.faceRef = text(source.faceRef, '', 400);
  out.faceLora = text(source.faceLora, '', 200);
  out.faceLoraStrength = Number.isFinite(Number(source.faceLoraStrength))
    ? Math.max(0, Math.min(1.5, Number(source.faceLoraStrength)))
    : DEFAULTS.faceLoraStrength;

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
    if (patch.defaultBackend !== undefined) merged.defaultBackend = patch.defaultBackend;
    if (patch.outputDir !== undefined) merged.outputDir = patch.outputDir;
    if (patch.faceRef !== undefined) merged.faceRef = patch.faceRef;
    if (patch.faceLora !== undefined) merged.faceLora = patch.faceLora;
    if (patch.faceLoraStrength !== undefined) merged.faceLoraStrength = patch.faceLoraStrength;
    if (patch.python !== undefined) merged.python = patch.python;
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
    'D:\\ComfyUI',
    'C:\\ComfyUI',
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
