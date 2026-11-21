/*! 画室 · 本机环境体检、模型推荐与 ComfyUI 一键部署。
 *
 * 只做三件事：
 * 1) probe()：看硬件（GPU / 显存 / 内存 / 磁盘）、Python、Git、已有的 ComfyUI 和是否在跑；
 * 2) recommend()：按显存和本机已有模型给一套「够用且跑得动」的模型 + 工作流建议；
 * 3) deploy：git clone + venv + torch + requirements，装完起 8188，状态写 data/deploy.json。
 *
 * 不自动下载大模型权重：只给下载地址和放置目录，避免替用户吃带宽和版权。
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

type RunResult = { ok: boolean; out: string };

async function run(cmd: string, args: string[], timeout = 30_000, cwd?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, cwd });
    return { ok: true, out: String(stdout || stderr || '').trim() };
  } catch (error: any) {
    return { ok: false, out: String(error?.stdout || error?.stderr || error?.message || error).trim() };
  }
}

const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** 同一进程里只允许一个部署任务在跑。 */
let busy = false;

export type DeployState = {
  state: 'idle' | 'installing' | 'starting' | 'running' | 'failed';
  step: string;
  message: string;
  root: string;
  log: string;
  updatedAt: string;
  url: string;
  pid?: number;
};

export function deployStatePath(dataDir: string) {
  return join(dataDir, 'deploy.json');
}

export function readDeployState(dataDir: string): DeployState {
  const file = deployStatePath(dataDir);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      state: ['idle', 'installing', 'starting', 'running', 'failed'].includes(raw?.state) ? raw.state : 'idle',
      step: String(raw?.step ?? ''),
      message: String(raw?.message ?? ''),
      root: String(raw?.root ?? ''),
      log: String(raw?.log ?? ''),
      updatedAt: String(raw?.updatedAt ?? ''),
      url: String(raw?.url ?? ''),
      pid: Number.isFinite(Number(raw?.pid)) ? Number(raw.pid) : undefined,
    };
  } catch {
    return { state: 'idle', step: '', message: '', root: '', log: '', updatedAt: '', url: '' };
  }
}

function writeDeployState(dataDir: string, patch: Partial<DeployState>) {
  const next: DeployState = {
    ...readDeployState(dataDir),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(deployStatePath(dataDir), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function deployBusy() {
  return busy;
}

type GpuInfo = {
  name: string;
  vramTotalMiB: number;
  vramUsedMiB: number;
  driver: string;
  source: 'nvidia-smi' | 'wmi' | 'none';
};

export type SystemProbe = {
  os: { platform: string; arch: string; release: string; hostname: string };
  cpu: { name: string; cores: number };
  memory: { totalGB: number; freeGB: number };
  disk: { path: string; freeGB: number; totalGB: number } | null;
  gpu: GpuInfo[];
  python: { path: string; version: string; system: string } | null;
  git: { version: string } | null;
  comfy: {
    exists: boolean;
    root: string;
    mainPy: string;
    modelsDir: string;
    venvPython: string;
    baseUrl: string;
    online: boolean;
    version: string;
    device: string;
  };
  candidates: string[];
};

async function probeGpu(): Promise<GpuInfo[]> {
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'], 15_000);
  if (smi.ok && smi.out) {
    const out: GpuInfo[] = [];
    for (const line of smi.out.split(/\r?\n/)) {
      const parts = line.split(',').map((item) => item.trim());
      if (parts.length < 4) continue;
      out.push({
        name: parts[0],
        vramTotalMiB: Math.round(Number(parts[1]) || 0),
        vramUsedMiB: Math.round(Number(parts[2]) || 0),
        driver: parts[3],
        source: 'nvidia-smi',
      });
    }
    if (out.length) return out;
  }
  if (process.platform === 'win32') {
    const wmi = await run(
      'powershell',
      ['-NoProfile', '-Command', "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join \"`n\""],
      20_000,
    );
    if (wmi.ok && wmi.out.trim()) {
      return wmi.out
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ name, vramTotalMiB: 0, vramUsedMiB: 0, driver: '', source: 'wmi' as const }));
    }
  }
  return [];
}

function probeDisk(path: string) {
  try {
    const stats = statfsSync(path);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return { path, freeGB: gib(free), totalGB: gib(total) };
  } catch {
    return null;
  }
}

async function probePython(candidates: string[]) {
  const tries: string[][] = [];
  if (process.platform === 'win32') {
    tries.push(['py', '-3', '-c', 'import sys;print(sys.executable);print(sys.version.split()[0])']);
  }
  for (const candidate of candidates) {
    if (candidate) tries.push([candidate, '-c', 'import sys;print(sys.executable);print(sys.version.split()[0])']);
  }
  tries.push(['python3', '-c', 'import sys;print(sys.executable);print(sys.version.split()[0])']);
  tries.push(['python', '-c', 'import sys;print(sys.executable);print(sys.version.split()[0])']);
  for (const [cmd, ...args] of tries) {
    if (cmd.includes('WindowsApps')) continue;
    const got = await run(cmd, args, 15_000);
    if (!got.ok) continue;
    const lines = got.out.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const path = lines.find((item) => isAbsolute(item)) || cmd;
    const version = lines.find((item) => /^\d+\.\d+/.test(item)) || '';
    if (path) return { path, version, system: path };
  }
  return null;
}

function candidateRoots(hint: string) {
  const list = [
    String(process.env.COMFY_ROOT ?? '').trim(),
    hint,
    'D:\\ComfyUI',
    'C:\\ComfyUI',
    'D:\\AI\\ComfyUI',
    join(os.homedir(), 'ComfyUI'),
  ].filter(Boolean);
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function comfyHealth(baseUrl: string, timeoutMs = 4_000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/system_stats`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { online: false, version: '', device: '' };
    const body: any = await res.json().catch(() => ({}));
    const device = String(body?.devices?.[0]?.name ?? body?.system?.device ?? '');
    return { online: true, version: String(body?.system?.comfyui_version ?? ''), device };
  } catch {
    return { online: false, version: '', device: '' };
  }
}

/** 本机体检：所有探测都不抛异常，缺什么就报缺什么。 */
export async function probe(options: { baseUrl?: string; modelsDirHint?: string; pythonHint?: string; root?: string } = {}): Promise<SystemProbe> {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:8188';
  const roots = candidateRoots(options.root || (options.modelsDirHint ? dirname(String(options.modelsDirHint)) : ''));
  const foundRoot = roots.find((root) => existsSync(join(root, 'main.py'))) || '';
  const candidates = [
    options.pythonHint || '',
    foundRoot ? join(foundRoot, 'venv', 'Scripts', 'python.exe') : '',
    foundRoot ? join(foundRoot, 'python_embeded', 'python.exe') : '',
  ].filter(Boolean);

  const [gpu, python, git, health] = await Promise.all([
    probeGpu(),
    probePython(candidates),
    run('git', ['--version'], 10_000),
    comfyHealth(baseUrl),
  ]);

  const diskPath = foundRoot || (process.platform === 'win32' ? 'D:\\' : '/');
  const disk = probeDisk(diskPath);
  const modelsDir = foundRoot ? join(foundRoot, 'models') : options.modelsDirHint || '';
  const venvPython = foundRoot ? [join(foundRoot, 'venv', 'Scripts', 'python.exe'), join(foundRoot, 'python_embeded', 'python.exe')].find((p) => existsSync(p)) || '' : '';

  return {
    os: { platform: process.platform, arch: process.arch, release: os.release(), hostname: os.hostname() },
    cpu: { name: os.cpus()[0]?.model?.trim() || '', cores: os.cpus().length },
    memory: { totalGB: gib(os.totalmem()), freeGB: gib(os.freemem()) },
    disk,
    gpu,
    python,
    git: git.ok ? { version: git.out.replace(/^git version\s+/, '') } : null,
    comfy: {
      exists: Boolean(foundRoot),
      root: foundRoot,
      mainPy: foundRoot ? join(foundRoot, 'main.py') : '',
      modelsDir,
      venvPython,
      baseUrl,
      online: health.online,
      version: health.version,
      device: health.device || gpu[0]?.name || '',
    },
    candidates: roots,
  };
}

export type ModelRec = {
  id: string;
  name: string;
  family: 'moss' | 'qwen' | 'flux' | 'sdxl' | 'sd15' | 'minimax';
  purpose: string;
  vramGB: number;
  fit: 'best' | 'ok' | 'heavy' | 'light';
  local: boolean;
  /** 本机命中的真实文件名（有就能直接 studio_build） */
  localModel?: string;
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

const WORKFLOWS: Record<string, ModelRec['workflow']> = {
  moss: { width: 768, height: 1024, steps: 8, cfg: 2.5, sampler: 'er_sde', scheduler: 'simple', note: 'MOSS 8 步加速 LoRA，1024 长边' },
  qwen: { width: 768, height: 1024, steps: 6, cfg: 1, sampler: 'euler', scheduler: 'simple', note: 'Qwen-Image 6 步加速' },
  flux: { width: 1024, height: 1024, steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', note: 'Flux 标准 20 步' },
  sdxl: { width: 1024, height: 1024, steps: 28, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', note: 'SDXL 28 步' },
  sd15: { width: 512, height: 768, steps: 25, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', note: 'SD1.5 512×768' },
  minimax: { width: 864, height: 480, steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple', note: 'MiniMax H3 4 步 Turbo，视频' },
};

/** 按显存分档 + 本机已有权重，给一套先能跑起来的组合。 */
export function recommend(probe: SystemProbe, inventory?: { checkpoints?: Array<{ name: string }>; unets?: Array<{ name: string }>; vaes?: Array<{ name: string }>; clips?: Array<{ name: string }>; loras?: Array<{ name: string }> }): Recommendation {
  const gpu = probe.gpu[0];
  const vramGB = gpu?.vramTotalMiB ? gpu.vramTotalMiB / 1024 : 0;
  const allNames: string[] = [];
  for (const list of [inventory?.checkpoints, inventory?.unets, inventory?.vaes, inventory?.clips, inventory?.loras]) {
    for (const item of list || []) if (item?.name) allNames.push(String(item.name));
  }
  const names = new Set(allNames.map((name) => name.toLowerCase()));
  const has = (needle: string) => [...names].some((name) => name.includes(needle.toLowerCase()));
  const pick = (needles: string[]) =>
    allNames.find((name) => needles.some((needle) => name.toLowerCase().includes(needle.toLowerCase()))) || '';

  let tier = 'cpu';
  if (vramGB >= 24) tier = '24G+';
  else if (vramGB >= 16) tier = '16–24G';
  else if (vramGB >= 11) tier = '11–16G';
  else if (vramGB >= 7) tier = '7–11G';
  else if (vramGB >= 4) tier = '4–7G';

  const items: ModelRec[] = [];

  const mossLocal = pick(['moss_image', 'moss']);
  items.push({
    id: 'moss',
    name: 'MOSS（int8 量化）',
    family: 'moss',
    purpose: '中文提示词友好、人像和文字都稳，适合日常自拍/插画',
    vramGB: 12,
    fit: vramGB >= 11 ? (vramGB >= 16 ? 'best' : 'ok') : 'heavy',
    local: Boolean(mossLocal),
    localModel: mossLocal || undefined,
    files: [
      { dir: 'models/unet', name: 'moss_image_sft_int8_convrot.safetensors', note: '需自备（本机若无，插件无法代下）' },
      { dir: 'models/text_encoders', name: 'qwen3.5_9b_w4a8_gptq.safetensors', note: 'CLIPLoader.type=moss_image' },
      { dir: 'models/vae', name: 'flux2-vae_small.safetensors' },
      { dir: 'models/loras', name: 'MOSS_8_step_lora.safetensors', note: '8 步加速' },
    ],
    workflow: WORKFLOWS.moss,
    notes: ['显存 ≥11G 建议首选；768×1024 起步，爆显存就把长边降到 640。'],
  });

  items.push({
    id: 'sdxl',
    name: 'SDXL 1.0',
    family: 'sdxl',
    purpose: '通用写实/插画底模，生态最全，LoRA 最多',
    vramGB: 8,
    fit: vramGB >= 10 ? 'best' : vramGB >= 6 ? 'ok' : 'light',
    local: has('sd_xl_base') || has('sdxl'),
    localModel: pick(['sd_xl_base', 'sdxl']) || undefined,
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
    workflow: WORKFLOWS.sdxl,
    notes: ['1024×1024 约 8G 显存；显存紧张可 768×1024 + fp16。'],
  });

  items.push({
    id: 'sd15',
    name: 'SD 1.5（写实底模：majicMIX realistic 等）',
    family: 'sd15',
    purpose: '低显存/CPU 也能跑，出图快，适合先跑通链路',
    vramGB: 4,
    fit: vramGB >= 6 ? 'ok' : 'best',
    local: has('v1-5-pruned') || has('majicmix'),
    localModel: pick(['v1-5-pruned', 'majicmix']) || undefined,
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
    workflow: WORKFLOWS.sd15,
    notes: ['SD1.5 原生 512×768；人像建议再加写实 LoRA（可选）。'],
  });

  items.push({
    id: 'qwen',
    name: 'Qwen-Image 2.1',
    family: 'qwen',
    purpose: '中文语义强、出图干净，适合海报/文字排版',
    vramGB: 16,
    fit: vramGB >= 20 ? 'ok' : 'heavy',
    local: has('qwen_image'),
    localModel: pick(['qwen_image']) || undefined,
    files: [{ dir: 'models/unet', name: 'qwen_image_*.safetensors', note: '需自备权重（本机没有可用的 qwen 权重）' }],
    workflow: WORKFLOWS.qwen,
    notes: ['本机若无权重就先不折腾；有 20G+ 显存再上。'],
  });

  items.push({
    id: 'minimax',
    name: 'MiniMax H3（文生视频）',
    family: 'minimax',
    purpose: '图生/文生视频，带原生音频',
    vramGB: 16,
    fit: vramGB >= 24 ? 'ok' : 'heavy',
    local: has('minimax_h3'),
    localModel: pick(['minimax_h3_fl2va', 'minimax_h3']) || undefined,
    files: [{ dir: 'models/unet', name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', note: '需自备整组 H3 权重' }],
    workflow: WORKFLOWS.minimax,
    notes: ['H3 是整套权重（unet + 文本编码器 + 双 VAE + turbo LoRA），显存不够会直接 OOM。'],
  });

  const rank = { best: 0, ok: 1, light: 2, heavy: 3 } as const;
  items.sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    return rank[a.fit] - rank[b.fit];
  });

  const gpuName = gpu ? `${gpu.name}（${vramGB ? vramGB.toFixed(0) + 'G 显存' : '显存未知'}）` : '没识别到 NVIDIA 显卡';
  const summary =
    !gpu || !vramGB
      ? '没读出显存：先按 SD1.5 跑通，或改用网络后端；有 NVIDIA 显卡的话装好驱动再体检一次。'
      : vramGB >= 11
        ? '可以直接跑 MOSS + SDXL；视频等显存 ≥16G 再说。'
        : vramGB >= 7
          ? '优先 SDXL 768×1024；MOSS 可能吃力，想稳就 SD1.5。'
          : '显存偏小：SD1.5 512×768 或直接用网络后端。';

  return {
    tier,
    summary,
    gpu: gpuName,
    vramGB: Math.round(vramGB),
    items,
    next: [
      '模型放到 ' + (probe.comfy.modelsDir || '<ComfyUI>/models') + ' 对应的子目录（checkpoints / unet / vae / text_encoders / loras）。',
      '放好后调用 studio_models(refresh=true)，再 studio_build(model=…, save_as=…) 生成工作流并设为默认。',
      '没有本地显卡或显存太小：设置页把默认后端切到 OpenAI 兼容 / Gemini / 通义万相。',
    ],
  };
}

function writeLauncher(root: string) {
  if (process.platform !== 'win32') return '';
  const bat = join(root, 'start-comfyui.bat');
  const body = [
    '@echo off',
    'cd /d "%~dp0"',
    'if exist "venv\\Scripts\\python.exe" (',
    '  "venv\\Scripts\\python.exe" main.py --listen 127.0.0.1 --port 8188',
    ') else (',
    '  python main.py --listen 127.0.0.1 --port 8188',
    ')',
  ].join('\r\n');
  writeFileSync(bat, body + '\r\n', 'utf8');
  return bat;
}

function torchSpec(gpu: GpuInfo[]) {
  if (!gpu.length) return { args: ['torch', 'torchvision', 'torchaudio'], url: 'https://download.pytorch.org/whl/cpu', label: 'CPU' };
  const driver = Number((gpu[0].driver || '').split('.')[0]);
  if (driver && driver < 525) return { args: ['torch', 'torchvision', 'torchaudio'], url: 'https://download.pytorch.org/whl/cu118', label: 'CUDA 11.8（驱动较旧）' };
  if (driver && driver < 550) return { args: ['torch', 'torchvision', 'torchaudio'], url: 'https://download.pytorch.org/whl/cu121', label: 'CUDA 12.1' };
  return { args: ['torch', 'torchvision', 'torchaudio'], url: 'https://download.pytorch.org/whl/cu124', label: 'CUDA 12.4' };
}

async function waitOnline(baseUrl: string, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await comfyHealth(baseUrl, 3_000);
    if (health.online) return health;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { online: false, version: '', device: '' };
}

/** 起 ComfyUI（已在跑就直接返回）。日志写到 data/logs/comfyui.log。 */
export async function startComfy(root: string, dataDir: string, baseUrl = 'http://127.0.0.1:8188'): Promise<DeployState> {
  const health = await comfyHealth(baseUrl);
  if (health.online) {
    return writeDeployState(dataDir, { state: 'running', step: '已有实例', message: 'ComfyUI 已经在跑', root, url: baseUrl });
  }
  const python = [join(root, 'venv', 'Scripts', 'python.exe'), join(root, 'venv', 'bin', 'python'), join(root, 'python_embeded', 'python.exe')].find((item) => existsSync(item));
  if (!existsSync(join(root, 'main.py')) || !python) throw Error('这个目录不是装好的 ComfyUI（缺 main.py 或 venv）');

  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const log = join(dataDir, 'logs', 'comfyui.log');
  writeDeployState(dataDir, { state: 'starting', step: '启动 ComfyUI', message: '正在启动 ' + root, root, url: baseUrl, log });
  const fd = openSync(log, 'a');
  const child = spawn(python, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  const waited = await waitOnline(baseUrl);
  if (waited.online) {
    return writeDeployState(dataDir, {
      state: 'running',
      step: '已启动',
      message: `ComfyUI ${waited.version || ''} 已就绪`,
      root,
      url: baseUrl,
      pid: child.pid,
      log,
    });
  }
  return writeDeployState(dataDir, {
    state: 'failed',
    step: '启动超时',
    message: '已拉起进程但 3 分钟内没等到 /system_stats，看日志：' + log,
    root,
    url: baseUrl,
    pid: child.pid,
    log,
  });
}

/** 一键部署：git clone → venv → torch → requirements → 起服务。整个过程后台跑，状态落盘。 */
export async function deploy(root: string, dataDir: string, options: { baseUrl?: string } = {}): Promise<DeployState> {
  if (busy) throw Error('已经有一个部署任务在跑');
  if (!isAbsolute(root)) throw Error('安装目录要给绝对路径，例如 D:\\ComfyUI');
  const baseUrl = options.baseUrl || 'http://127.0.0.1:8188';
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const logPath = join(dataDir, 'logs', 'deploy.log');
  const log = (line: string) => {
    try {
      writeFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' });
    } catch {
      /* 日志写不进去不影响主流程 */
    }
  };
  const step = (state: DeployState['state'], title: string, message: string) =>
    writeDeployState(dataDir, { state, step: title, message, root, url: baseUrl, log: logPath });

  busy = true;
  step('installing', '体检', '正在检查 Python / Git / 显卡');
  try {
    const info = await probe({ baseUrl });
    if (!info.python) throw Error('没找到 Python 3：先装 https://www.python.org/downloads/windows/（勾选 Add to PATH），再回来点一次。');
    const venvPython = process.platform === 'win32' ? join(root, 'venv', 'Scripts', 'python.exe') : join(root, 'venv', 'bin', 'python');
    // 已经装好就直接起，不重复 pip。
    if (existsSync(join(root, 'main.py')) && existsSync(venvPython)) {
      step('starting', '启动已有实例', '目录里已有 ComfyUI，直接启动');
      return await startComfy(root, dataDir, baseUrl);
    }
    if (!existsSync(join(root, 'main.py'))) {
      if (!info.git) throw Error('没找到 git：先装 https://git-scm.com/download/win，或用 git 手动 clone ComfyUI 到该目录。');
      step('installing', '下载 ComfyUI', 'git clone 到 ' + root);
      log('git clone ' + root);
      const created = await run('git', ['clone', '--depth', '1', 'https://github.com/comfyanonymous/ComfyUI.git', root], 600_000);
      log(created.out);
      if (!existsSync(join(root, 'main.py'))) throw Error('git clone 失败：' + created.out.slice(0, 400));
    }
    if (!existsSync(venvPython)) {
      step('installing', '建虚拟环境', 'python -m venv venv');
      const made = await run(info.python.path, ['-m', 'venv', join(root, 'venv')], 180_000);
      log(made.out);
      if (!existsSync(venvPython)) throw Error('建 venv 失败：' + made.out.slice(0, 400));
    }

    step('installing', '装 pip', '升级 pip / wheel');
    const pip = await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], 300_000, root);
    log(pip.out);

    const torch = torchSpec(info.gpu);
    step('installing', '装 PyTorch', torch.label);
    const torchRun = await run(
      venvPython,
      ['-m', 'pip', 'install', ...torch.args, '--index-url', torch.url],
      3_600_000,
      root,
    );
    log(torchRun.out);
    if (!torchRun.ok) throw Error('装 torch 失败：' + torchRun.out.slice(-600));

    step('installing', '装依赖', 'pip install -r requirements.txt');
    const req = await run(venvPython, ['-m', 'pip', 'install', '-r', join(root, 'requirements.txt')], 3_600_000, root);
    log(req.out);
    if (!req.ok) throw Error('装依赖失败：' + req.out.slice(-600));

    const launcher = writeLauncher(root);
    log('launcher: ' + (launcher || 'n/a'));
    return await startComfy(root, dataDir, baseUrl);
  } catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 800);
    log('FAILED: ' + message);
    return writeDeployState(dataDir, { state: 'failed', step: '部署失败', message, root, url: baseUrl, log: logPath });
  } finally {
    busy = false;
  }
}

export const SETUP_README = [
  '一键部署只装 ComfyUI 本体和依赖，不下载任何模型权重。',
  '装完会写 start-comfyui.bat，之后也可以自己双击启动。',
  '模型按 recommend() 给的目录放好，再用 studio_build 生成工作流。',
].join('\n');
