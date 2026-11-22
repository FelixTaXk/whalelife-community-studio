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
import { join, isAbsolute } from 'node:path';
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
  const baseUrl = options.baseUrl || '';
  const foundRoot = options.root && existsSync(join(options.root, 'main.py')) ? options.root : '';
  const candidates = [
    options.pythonHint || '',
    foundRoot ? join(foundRoot, 'venv', 'Scripts', 'python.exe') : '',
    foundRoot ? join(foundRoot, 'venv', 'bin', 'python') : '',
    foundRoot ? join(foundRoot, 'python_embeded', 'python.exe') : '',
  ].filter(Boolean);

  const [gpu, python, git, health] = await Promise.all([
    probeGpu(),
    probePython(candidates),
    run('git', ['--version'], 10_000),
    baseUrl ? comfyHealth(baseUrl) : Promise.resolve({ online: false, version: '', device: '' }),
  ]);

  const diskPath = foundRoot || os.homedir();
  const disk = probeDisk(diskPath);
  const modelsDir = foundRoot ? join(foundRoot, 'models') : '';
  const venvPython = foundRoot ? [
    join(foundRoot, 'venv', 'Scripts', 'python.exe'),
    join(foundRoot, 'venv', 'bin', 'python'),
    join(foundRoot, 'python_embeded', 'python.exe'),
    join(foundRoot, 'python_embedded', 'python.exe'),
  ].find((p) => existsSync(p)) || '' : '';

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
    candidates: candidates.filter(Boolean),
  };
}

export type { ModelRec, Recommendation } from './model-catalog.ts';
export { recommend } from './model-catalog.ts';

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

async function sdHealth(baseUrl: string, timeoutMs = 4_000) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { online: false, models: [] as string[] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/sdapi/v1/sd-models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { online: false, models: [] as string[] };
    const body: any = await res.json().catch(() => []);
    return { online: true, models: Array.isArray(body) ? body.map((item: any) => String(item.title ?? item.model_name ?? '')).filter(Boolean) : [] };
  } catch {
    return { online: false, models: [] as string[] };
  }
}

async function waitSd(baseUrl: string, timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await sdHealth(baseUrl, 3_000);
    if (health.online) return health;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { online: false, models: [] as string[] };
}

function writeSdLauncher(root: string) {
  if (process.platform !== 'win32') return '';
  const bat = join(root, 'start-sd-webui.bat');
  const body = [
    '@echo off',
    'cd /d "%~dp0"',
    'if exist "venv\\Scripts\\python.exe" (',
    '  "venv\\Scripts\\python.exe" launch.py --api --listen 127.0.0.1 --port 7860',
    ') else (',
    '  python launch.py --api --listen 127.0.0.1 --port 7860',
    ')',
  ].join('\r\n');
  writeFileSync(bat, body + '\r\n', 'utf8');
  return bat;
}

/** 起 SD-WebUI（A1111 / Forge 兼容 launch.py）。 */
export async function startSd(root: string, dataDir: string, baseUrl = ''): Promise<DeployState> {
  const url = baseUrl || 'http://127.0.0.1:7860';
  const health = await sdHealth(url);
  if (health.online) {
    return writeDeployState(dataDir, { state: 'running', step: '已有实例', message: 'SD-WebUI 已经在跑', root, url });
  }
  const python = [join(root, 'venv', 'Scripts', 'python.exe'), join(root, 'venv', 'bin', 'python')].find((item) => existsSync(item));
  if (!existsSync(join(root, 'launch.py')) || !python) throw Error('这个目录不是装好的 SD-WebUI（缺 launch.py 或 venv）');

  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const log = join(dataDir, 'logs', 'sdwebui.log');
  writeDeployState(dataDir, { state: 'starting', step: '启动 SD-WebUI', message: '正在启动 ' + root, root, url, log });
  const fd = openSync(log, 'a');
  const child = spawn(python, ['launch.py', '--api', '--listen', '127.0.0.1', '--port', '7860'], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  const waited = await waitSd(url);
  if (waited.online) {
    return writeDeployState(dataDir, { state: 'running', step: '已启动', message: 'SD-WebUI 已就绪', root, url, pid: child.pid, log });
  }
  return writeDeployState(dataDir, {
    state: 'failed',
    step: '启动超时',
    message: '已拉起进程但 4 分钟内没等到 /sdapi/v1/sd-models，看日志：' + log,
    root,
    url,
    pid: child.pid,
    log,
  });
}

/** 一键部署 SD-WebUI：git clone → venv → torch → requirements → 起 7860。 */
export async function deploySd(root: string, dataDir: string, options: { baseUrl?: string } = {}): Promise<DeployState> {
  if (busy) throw Error('已经有一个部署任务在跑');
  if (!isAbsolute(root)) throw Error('安装目录要给绝对路径');
  const baseUrl = options.baseUrl || 'http://127.0.0.1:7860';
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const logPath = join(dataDir, 'logs', 'deploy.log');
  const log = (line: string) => {
    try {
      writeFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' });
    } catch {
      /* 日志写不进去不影响主流程 */
    }
  };
  const step = (state: DeployState['state'], stepText: string, message: string) =>
    writeDeployState(dataDir, { state, step: stepText, message, root, url: baseUrl, log: logPath });

  busy = true;
  step('installing', '体检', '正在检查 Python / Git / 显卡');
  try {
    const info = await probe({ baseUrl: '' });
    if (!info.python) throw Error('没找到 Python 3：先装 https://www.python.org/downloads/windows/（勾选 Add to PATH），再回来点一次。');
    if (!info.git) throw Error('没找到 git：先装 https://git-scm.com/download/win，或用 git 手动 clone SD-WebUI 到该目录。');
    const venvPython = process.platform === 'win32' ? join(root, 'venv', 'Scripts', 'python.exe') : join(root, 'venv', 'bin', 'python');
    if (!existsSync(join(root, 'launch.py'))) {
      step('installing', '下载 SD-WebUI', 'git clone 到 ' + root);
      log('git clone ' + root);
      const created = await run('git', ['clone', '--depth', '1', 'https://github.com/AUTOMATIC1111/stable-diffusion-webui.git', root], 600_000);
      log(created.out);
      if (!existsSync(join(root, 'launch.py'))) throw Error('git clone 失败：' + created.out.slice(0, 400));
    }
    if (!existsSync(venvPython)) {
      step('installing', '建虚拟环境', 'python -m venv venv');
      const made = await run(info.python.path, ['-m', 'venv', join(root, 'venv')], 180_000);
      log(made.out);
      if (!existsSync(venvPython)) throw Error('建 venv 失败：' + made.out.slice(0, 400));
    }
    step('installing', '装 pip', '升级 pip / wheel');
    log((await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], 300_000, root)).out);
    const torch = torchSpec(info.gpu);
    step('installing', '装 PyTorch', torch.label);
    const torchRun = await run(venvPython, ['-m', 'pip', 'install', ...torch.args, '--index-url', torch.url], 3_600_000, root);
    log(torchRun.out);
    if (!torchRun.ok) throw Error('装 torch 失败：' + torchRun.out.slice(-600));
    const requirements = existsSync(join(root, 'requirements_versions.txt')) ? 'requirements_versions.txt' : 'requirements.txt';
    step('installing', '装依赖', 'pip install -r ' + requirements);
    const req = await run(venvPython, ['-m', 'pip', 'install', '-r', join(root, requirements)], 3_600_000, root);
    log(req.out);
    if (!req.ok) throw Error('装依赖失败：' + req.out.slice(-600));
    log('launcher: ' + (writeSdLauncher(root) || 'n/a'));
    return await startSd(root, dataDir, baseUrl);
  } catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 800);
    log('FAILED: ' + message);
    return writeDeployState(dataDir, { state: 'failed', step: '部署失败', message, root, url: baseUrl, log: logPath });
  } finally {
    busy = false;
  }
}

/** 一键部署：git clone → venv → torch → requirements → 起服务。整个过程后台跑，状态落盘。 */
export async function deploy(root: string, dataDir: string, options: { baseUrl?: string } = {}): Promise<DeployState> {
  if (busy) throw Error('已经有一个部署任务在跑');
  if (!isAbsolute(root)) throw Error('安装目录要给绝对路径，例如用户目录下的 ComfyUI');
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

