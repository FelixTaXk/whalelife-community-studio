/*! 表情包工坊：字幕/气泡/描边 + 自动入库（meme 用途）。 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'whalelife';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(DIR, 'data', 'out');
const TMP_DIR = join(DIR, 'data', 'tmp');
const PROJECTS_DIR = join(DIR, 'data', 'projects');
const PRESETS_FILE = join(DIR, 'data', 'presets.json');
const SCRIPT = join(DIR, 'tools', 'render_meme.py');
const ZIP_SCRIPT = join(DIR, 'tools', 'zip_files.py');

let studioPython = '';
let studioOutDir = '';

const STYLES = ['band', 'bubble', 'plain', 'top', 'auto'];
const FORMATS = ['png', 'webp', 'gif'];
const ANIMATIONS = ['none', 'pop', 'shake', 'zoom'];
const ALIGNS = ['left', 'center', 'right'];
const PLATFORMS: Record<string, { label: string; width: number; format: string }> = {
  qq: { label: 'QQ 表情', width: 512, format: 'png' },
  wechat: { label: '微信表情', width: 240, format: 'png' },
  telegram: { label: 'Telegram 贴纸', width: 512, format: 'png' },
  discord: { label: 'Discord 表情', width: 320, format: 'png' },
  custom: { label: '自定义尺寸', width: 512, format: 'png' },
};
const PAGE = '/plugins/studio/meme/settings';
const API_CONFIG = '/plugins/studio/meme/config';
const API_CLEAR = '/plugins/studio/meme/clear-out';
const API_SOURCE = '/plugins/studio/meme/source';
const API_MAKE = '/plugins/studio/meme/oneclick';
const API_MODEL = '/plugins/studio/meme/model-check';
const API_COMPARE = '/plugins/studio/meme/compare';
const API_BATCH = '/plugins/studio/meme/batch';
const API_SUGGEST = '/plugins/studio/meme/suggest';
const API_PROJECTS = '/plugins/studio/meme/projects';
const API_PROJECT_SRC = '/plugins/studio/meme/project-src';
const API_PRESETS = '/plugins/studio/meme/presets';
const PAGE_OUT = '/plugins/studio/meme/out';
const DEFAULT_STYLE = 'band';
const DEFAULT_WIDTH = 512;
const DEFAULT_LAYOUT = {
  fontSize: 0,
  lineHeight: 1.35,
  align: 'center',
  margin: 18,
  padding: 20,
  maxLines: 4,
  offsetX: 0,
  offsetY: 0,
  strokeWidth: 0,
  shadow: false,
  autoContrast: true,
  textColor: '',
  bandColor: '',
  strokeColor: '',
};
const MAX_JSON = 64 * 1024;
const MAX_IMAGE_JSON = 24 * 1024 * 1024;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const MAX_BATCH = 24;
const OUT_PATTERN = /^meme-(?!src-)[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i;
const SOURCE_PATTERN = /^meme-src-[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i;
const SERVED_PATTERN = /^meme-[\w.-]+\.(png|jpg|jpeg|webp|gif|zip)$/i;
const PROJECT_FILE = /^project-[\w-]+\.json$/i;
const LAYOUT_SCHEMA = {
  type: 'object',
  description: '精确排版：字号、行高、边距、对齐、文字颜色、描边和偏移；都可省略。',
  properties: {
    fontSize: { type: 'integer', minimum: 0, maximum: 200, description: '0 表示自动' },
    lineHeight: { type: 'number', minimum: 0.9, maximum: 2.2 },
    align: { type: 'string', enum: ALIGNS },
    margin: { type: 'integer', minimum: 0, maximum: 160 },
    padding: { type: 'integer', minimum: 0, maximum: 96 },
    maxLines: { type: 'integer', minimum: 1, maximum: 6 },
    offsetX: { type: 'integer', minimum: -240, maximum: 240 },
    offsetY: { type: 'integer', minimum: -240, maximum: 240 },
    strokeWidth: { type: 'integer', minimum: 0, maximum: 16 },
    shadow: { type: 'boolean' },
    autoContrast: { type: 'boolean', description: '按背景亮度自动选字色' },
    textColor: { type: 'string', description: '#RRGGBB' },
    bandColor: { type: 'string', description: '#RRGGBB' },
    strokeColor: { type: 'string', description: '#RRGGBB' },
  },
  additionalProperties: false,
};
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
};

function config(): any {
  try {
    const raw = JSON.parse(readFileSync(join(DIR, 'data', 'config.json'), 'utf8'));
    return {
      python: '',
      font: '',
      allowedDirs: [],
      defaultStyle: DEFAULT_STYLE,
      defaultWidth: DEFAULT_WIDTH,
      defaultFormat: 'png',
      defaultPlatform: 'custom',
      captionModel: '',
      defaultLayout: { ...DEFAULT_LAYOUT },
      ...raw,
      defaultLayout: { ...DEFAULT_LAYOUT, ...(raw?.defaultLayout && typeof raw.defaultLayout === 'object' ? raw.defaultLayout : {}) },
    };
  } catch {
    return {
      python: '',
      font: '',
      allowedDirs: [],
      defaultStyle: DEFAULT_STYLE,
      defaultWidth: DEFAULT_WIDTH,
      defaultFormat: 'png',
      defaultPlatform: 'custom',
      captionModel: '',
      defaultLayout: { ...DEFAULT_LAYOUT },
    };
  }
}

function defaultStyle(cfg: any) {
  return STYLES.includes(String(cfg.defaultStyle)) ? String(cfg.defaultStyle) : DEFAULT_STYLE;
}

function defaultWidth(cfg: any) {
  const n = Number(cfg.defaultWidth);
  return Number.isFinite(n) ? Math.min(1600, Math.max(128, Math.round(n))) : DEFAULT_WIDTH;
}

function colorValue(value: any) {
  const raw = String(value ?? '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw) ? raw : '';
}

function layoutOf(value: any, cfg: any) {
  const base = { ...DEFAULT_LAYOUT, ...(cfg?.defaultLayout || {}), ...(value && typeof value === 'object' ? value : {}) };
  const int = (v: any, fallback: number, min: number, max: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const num = (v: any, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    fontSize: int(base.fontSize, 0, 0, 200),
    lineHeight: num(base.lineHeight, 1.35, 0.9, 2.2),
    align: ALIGNS.includes(String(base.align)) ? String(base.align) : 'center',
    margin: int(base.margin, 18, 0, 160),
    padding: int(base.padding, 20, 0, 96),
    maxLines: int(base.maxLines, 4, 1, 6),
    offsetX: int(base.offsetX, 0, -240, 240),
    offsetY: int(base.offsetY, 0, -240, 240),
    strokeWidth: int(base.strokeWidth, 0, 0, 16),
    shadow: Boolean(base.shadow),
    autoContrast: base.autoContrast === undefined ? true : Boolean(base.autoContrast),
    textColor: colorValue(base.textColor),
    bandColor: colorValue(base.bandColor),
    strokeColor: colorValue(base.strokeColor),
  };
}

function formatOf(value: any, cfg: any, animation: string) {
  if (animation !== 'none') return 'gif';
  const raw = String(value ?? '').trim().toLowerCase();
  const fallback = FORMATS.includes(String(cfg?.defaultFormat)) ? String(cfg.defaultFormat) : 'png';
  return FORMATS.includes(raw) ? raw : fallback;
}

function platformOf(value: any) {
  const raw = String(value ?? '').trim().toLowerCase();
  return PLATFORMS[raw] ? raw : 'custom';
}

function widthOf(value: any, cfg: any, platform: string) {
  const preset = PLATFORMS[platform] || PLATFORMS.custom;
  const fallback = value === undefined || value === null || String(value).trim() === ''
    ? (platform !== 'custom' ? preset.width : defaultWidth(cfg))
    : defaultWidth(cfg);
  return clampWidth(value, fallback);
}

function slug(text: any, fallback = 'meme') {
  const raw = String(text ?? '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return cleaned || fallback;
}

const TONE_LABELS: Record<string, string> = {
  wry: '阴阳', speechless: '无语', cute: '可爱', work: '职场',
  happy: '开心', angry: '生气', tired: '累', food: '干饭',
};

const DEFAULT_TONES: Record<string, string[]> = {
  wry: ['就这？', '啊这', '你礼貌吗', '真的会谢', '绷不住了', '笑死', '有点东西', '不愧是你', '典中典', '我不好说'],
  speechless: ['无语', '啊？', '离大谱', '没眼看', '我不理解', '算了', '随便吧', '你开心就好', '难评', '沉默'],
  cute: ['贴贴', '抱抱', '亲亲', '好耶', '猫猫祟祟', '探头', '小可爱', '软乎乎', '摸摸头', '在呢'],
  work: ['收到', '马上办', '在做了', '需求呢', '排期中', '已读不回', '下班再说', '先对齐', '复盘一下', '加个班'],
  happy: ['开心', '好耶', '起飞', '稳了', '针不戳', '舒服了', '今天真好', '赚到了', '笑出声', '安排'],
  angry: ['气死', '火大', '忍不了', '你再说', '过分了', '想打人', '别惹我', '血压高了', '不行', '够了'],
  tired: ['困了', '累了', '想睡', '没电了', '躺平', '摆烂', '不想动', '救命', '撑不住', '下班'],
  food: ['饿了', '干饭', '吃一口', '真香', '再来一碗', '宵夜', '加菜', '打包', '我请客', '光盘'],
};

const DEFAULT_TEMPLATES = [
  { id: 'classic-band', name: '经典白条', style: 'band', width: 512, layout: { fontSize: 44, padding: 20, margin: 18, align: 'center', maxLines: 2 } },
  { id: 'meme-top', name: '顶部字幕', style: 'top', width: 512, layout: { fontSize: 40, padding: 18, margin: 16, align: 'center', maxLines: 2 } },
  { id: 'bubble-bottom', name: '底部气泡', style: 'bubble', width: 512, layout: { fontSize: 38, padding: 18, margin: 20, align: 'center', maxLines: 3 } },
  { id: 'plain-outline', name: '描边大字', style: 'plain', width: 512, layout: { fontSize: 52, padding: 0, margin: 20, align: 'center', strokeWidth: 5, maxLines: 2, shadow: true } },
  { id: 'auto-clean', name: '自动留白', style: 'auto', width: 512, layout: { fontSize: 42, padding: 22, margin: 18, align: 'center', maxLines: 2, autoContrast: true } },
  { id: 'wechat-small', name: '微信小图', style: 'band', width: 240, layout: { fontSize: 26, padding: 12, margin: 10, align: 'center', maxLines: 2 } },
];

function defaultPresets() {
  return {
    version: 1,
    tones: JSON.parse(JSON.stringify(DEFAULT_TONES)),
    templates: JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)),
  };
}

function readPresets() {
  try {
    const raw = JSON.parse(readFileSync(PRESETS_FILE, 'utf8'));
    return normalizePresets(raw);
  } catch {
    return defaultPresets();
  }
}

function normalizePresets(raw: any) {
  const fallback = defaultPresets();
  const tones: Record<string, string[]> = {};
  const sourceTones = raw?.tones && typeof raw.tones === 'object' ? raw.tones : fallback.tones;
  for (const [id, list] of Object.entries(sourceTones)) {
    if (!/^[a-z0-9_-]{1,32}$/i.test(id) || !Array.isArray(list)) continue;
    const cleaned = list.map((x: any) => String(x ?? '').trim()).filter((x: string) => x && x.length <= 40).slice(0, 30);
    if (cleaned.length) tones[id] = cleaned;
  }
  if (!Object.keys(tones).length) Object.assign(tones, fallback.tones);
  const templates = (Array.isArray(raw?.templates) ? raw.templates : fallback.templates)
    .filter((x: any) => x && typeof x === 'object' && /^[a-z0-9_-]{1,40}$/i.test(String(x.id ?? '')))
    .map((x: any) => ({
      id: String(x.id),
      name: String(x.name ?? x.id).slice(0, 40),
      style: STYLES.includes(String(x.style)) ? String(x.style) : 'band',
      width: clampWidth(x.width, 512),
      layout: layoutOf(x.layout, {}),
    }))
    .slice(0, 30);
  return { version: 1, tones, templates: templates.length ? templates : fallback.templates };
}

function ensurePresetsFile() {
  try { readFileSync(PRESETS_FILE); } catch {
    mkdirSync(dirname(PRESETS_FILE), { recursive: true });
    writeFileSync(PRESETS_FILE, JSON.stringify(defaultPresets(), null, 2));
  }
}

function suggestLocal(tone: string, hint: string, count: number) {
  const presets = readPresets();
  const list = presets.tones[tone] || presets.tones.wry || DEFAULT_TONES.wry;
  const cleanHint = String(hint ?? '').trim().slice(0, 24);
  const items = [...list];
  if (cleanHint && !items.includes(cleanHint)) items.unshift(cleanHint);
  return items.slice(0, count);
}

function parseCaptions(text: any, count: number) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim().replace(/^[-*·•\d.、)\s]+/, '').replace(/^["“”'']+|["“”'']+$/g, '').trim())
    .filter((x) => x && x.length <= 40);
  return [...new Set(lines)].slice(0, count);
}


let chosenPython: string | null = null;
let pythonSource: 'config' | 'studio' | 'path' | 'fallback' = 'fallback';
function hasPillow(cmd: string) {
  try {
    const probe = spawnSync(cmd, ['-c', 'import PIL'], { windowsHide: true, timeout: 20000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}
// 先用设置里填的，再复用画室配置的 Python，最后按 PATH 找带 Pillow 的 python
function pythonPath() {
  if (chosenPython) return chosenPython;
  const cfg = config();
  const chosen = String(cfg.python || '').trim();
  if (chosen && existsSync(chosen)) {
    pythonSource = 'config';
    return (chosenPython = chosen);
  }
  if (studioPython && existsSync(studioPython)) {
    pythonSource = 'studio';
    return (chosenPython = studioPython);
  }
  for (const cmd of ['python', 'python3']) {
    if (hasPillow(cmd)) {
      pythonSource = 'path';
      return (chosenPython = cmd);
    }
  }
  pythonSource = 'fallback';
  return 'python';
}

function allowedRoots(): string[] {
  const roots = [resolve(OUT_DIR)];
  if (studioOutDir && isAbsolute(studioOutDir) && existsSync(studioOutDir)) {
    const full = resolve(studioOutDir);
    if (!roots.includes(full)) roots.push(full);
  }
  const cfg = config();
  const extra = Array.isArray(cfg.allowedDirs) ? cfg.allowedDirs : [];
  for (const item of extra) {
    const raw = String(item ?? '').trim();
    if (!raw || !isAbsolute(raw)) continue;
    const full = resolve(raw);
    if (!roots.includes(full)) roots.push(full);
  }
  return roots;
}

function allowedPath(raw: string) {
  if (!raw || !isAbsolute(raw)) return null;
  const full = resolve(raw);
  const roots = allowedRoots();
  return roots.some((root) => full === root || full.startsWith(root + sep)) ? full : null;
}

function esc(text: any) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch],
  );
}

function sendJson(res: any, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readBody(req: any, signal: AbortSignal, limit = MAX_JSON) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw Error('提交的内容太大');
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Error('提交的内容不是合法 JSON');
  }
}

function outStats() {
  let count = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(OUT_DIR)) {
      if (!OUT_PATTERN.test(name)) continue;
      try {
        bytes += statSync(join(OUT_DIR, name)).size;
        count += 1;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { count, bytes };
}

/** 按文件头认图片格式，避免把 jpg 存成 .png 后用错 Content-Type。 */
function sniff(bytes: Buffer): { ext: string; mime: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF')
    return { ext: 'gif', mime: 'image/gif' };
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/** 把参考图落到 data/out，前端和「换字幕再做一张」都靠这个文件名复用。 */
function saveSource(bytes: Buffer) {
  const kind = sniff(bytes);
  if (!kind) throw Error('只认 PNG / JPEG / WebP / GIF 图片');
  if (bytes.length > MAX_SOURCE_BYTES)
    throw Error(`图片太大（${(bytes.length / 1048576).toFixed(1)} MB），上限 15 MB`);
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  let name = `meme-src-${stamp}.${kind.ext}`;
  let index = 0;
  while (existsSync(join(OUT_DIR, name))) {
    index += 1;
    name = `meme-src-${stamp}-${index}.${kind.ext}`;
  }
  const file = join(OUT_DIR, name);
  writeFileSync(file, bytes);
  return { name, file, mime: kind.mime, bytes: bytes.length, url: PAGE_OUT + '?name=' + encodeURIComponent(name) };
}

function sourcePathOf(name: string) {
  const clean = String(name ?? '').trim();
  if (!SOURCE_PATTERN.test(clean)) return null;
  const full = resolve(OUT_DIR, clean);
  if (!full.startsWith(resolve(OUT_DIR) + sep)) return null;
  if (!existsSync(full)) return null;
  return full;
}

function servedPathOf(name: string) {
  const clean = String(name ?? '').trim();
  if (!SERVED_PATTERN.test(clean)) return null;
  const full = resolve(OUT_DIR, clean);
  if (!full.startsWith(resolve(OUT_DIR) + sep)) return null;
  if (!existsSync(full)) return null;
  return full;
}

function clampWidth(value: any, fallback: number, max = 1600) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(128, n));
}

function runPython(
  input: string,
  output: string,
  text: string,
  style: string,
  width: number,
  font: string,
  layout: any,
  format: string,
  animation: string,
  fps: number,
  duration: number,
  quality: number,
  signal?: AbortSignal,
) {
  return new Promise<any>((resolvePromise, reject) => {
    const child = spawn(pythonPath(), [SCRIPT], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(Error('渲染超时（60 秒）'));
    }, 60_000);
    const abort = () => {
      try { child.kill(); } catch { /* ignore */ }
      reject(Error('已取消'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (error: any) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(Error(error?.code === 'ENOENT' ? '找不到 python：请在插件设置页填 Python 解释器的完整路径（需要装 Pillow）' : error));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code !== 0 && !out.trim()) {
        const text = err.trim();
        if (/No module named 'PIL'/.test(text)) {
          return reject(Error('这个 python 没装 Pillow，请在设置页换成装了 Pillow 的解释器'));
        }
        return reject(Error(text || 'Python 退出码 ' + code));
      }
      try {
        const data = JSON.parse(out.trim());
        if (!data?.ok) return reject(Error(String(data?.error ?? err.trim() ?? '渲染失败')));
        resolvePromise(data);
      } catch {
        reject(Error(err.trim() || '渲染脚本返回的不是 JSON'));
      }
    });
    child.stdin.end(JSON.stringify({
      input, output, text, style, width, font, layout, format, animation, fps, duration, quality,
    }));
  });
}

const SEND_HINT = (ref: string, qqReady: boolean) =>
  '成品已作为临时引用交在图库（mediaRef=' + ref + '，24 小时内有效、只属于当前会话）。' +
  '要真正收进图库就调 gallery_collect，把这个 mediaRef 原样传进去并带 purposes=["meme"]；' +
  (qqReady
    ? '收藏成功后拿返回的 asset id，再用 qq_send_gallery 的 {"type":"image","id":"<asset id>"} 发出去，actionId 每次自己起一个稳定的。'
    : '收藏成功后图库就收下了；要发到 QQ，得先装并启用 QQ 插件，qq_send_gallery 才可用。') +
  'mediaRef 不是图库资产 id，别直接塞给发送接口。';

/** 渲染一份字幕：输入已经是图片字节，来源怎么来的在这里不关心。 */
async function renderBytes(ctx: any, args: any, session: any, index: number, bytes: Buffer, deliver = true) {
  const text = String(args?.text ?? '').trim();
  if (!text) throw Error('text 不能为空');
  if (text.length > 120) throw Error('字幕太长（最多 120 字），做表情包要短');
  const cfg = await (ctx as any).config.read('config.json').catch(() => config());
  const style = STYLES.includes(String(args?.style)) ? String(args.style) : defaultStyle(cfg);
  const animation = ANIMATIONS.includes(String(args?.animation)) ? String(args.animation) : 'none';
  const platform = platformOf(args?.platform);
  const width = widthOf(args?.width, cfg, platform);
  const format = formatOf(args?.format, cfg, animation);
  const layout = layoutOf(args?.layout, cfg);
  const font = String(cfg.font || '').trim();
  const gallery = (ctx as any).get?.('gallery', false);
  const ext = animation !== 'none' ? 'gif' : format;

  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + index;
  const input = join(TMP_DIR, 'meme-' + stamp + '.img');
  const output = join(OUT_DIR, 'meme-' + stamp + '.' + ext);
  writeFileSync(input, bytes);
  try {
    const result = await runPython(
      input, output, text, style, width, font, layout, format, animation,
      Number(args?.fps ?? 12), Number(args?.duration ?? 1.6), Number(args?.quality ?? 88),
      session?.signal,
    );
    const rendered = readFileSync(output);
    // 走图库公开的 offerMedia：只交临时引用（24 小时内、绑定当前会话），入库由 gallery_collect 决定
    let mediaRef: string | null = null;
    let mediaRefExpiresInSeconds: number | null = null;
    let galleryNote = '';
    const sessionId = String(session?.id ?? session?.sessionId ?? '').trim();
    if (!deliver) {
      galleryNote = '对比/批量预览只落本地文件，不占用图库临时引用';
    } else if (!gallery?.offerMedia) {
      galleryNote = '图库没有提供 offerMedia 接口（需要图库 0.1.2 及以上），成品只落本地文件';
    } else if (!sessionId) {
      galleryNote = '这次出图没有会话上下文，图库收不了临时引用；成品只在本地，用工具出图才会交给图库';
    } else {
      try {
        const offered = await gallery.offerMedia(
          { sessionId, base64: rendered.toString('base64'), source: 'meme' },
          { signal: session.signal },
        );
        mediaRef = String(offered?.mediaRef ?? '').trim() || null;
        const ttl = Number(offered?.expiresInSeconds);
        mediaRefExpiresInSeconds = Number.isFinite(ttl) ? ttl : null;
        if (!mediaRef) galleryNote = '图库返回里没有 mediaRef，成品只落本地文件';
      } catch (error: any) {
        galleryNote = '图库拒绝接收这张成品：' + String(error?.message ?? error).slice(0, 200);
      }
    }
    return {
      style: result.style,
      requestedStyle: style,
      file: output,
      name: basename(output),
      url: PAGE_OUT + '?name=' + encodeURIComponent(basename(output)),
      width: result.width,
      height: result.height,
      font: result.font,
      fontSize: result.fontSize,
      format: result.format,
      animation: result.animation,
      frames: result.frames,
      platform,
      layout,
      mediaRef,
      mediaRefExpiresInSeconds,
      galleryNote,
    };
  } finally {
    try { unlinkSync(input); } catch { /* ignore */ }
  }
}

/** 工具体系的原入口：图从图库 id 或受限本地路径来。 */
async function renderOne(ctx: any, args: any, session: any, index: number) {
  const gallery = (ctx as any).get?.('gallery', false);
  let bytes: Buffer;
  if (args?.sourceId) {
    if (!gallery?.readMedia) throw Error('图库没接通，不能按 id 取图');
    const media = await gallery.readMedia(String(args.sourceId), { signal: session.signal });
    bytes = Buffer.from(media.base64, 'base64');
  } else if (args?.sourcePath) {
    const full = allowedPath(String(args.sourcePath));
    if (!full) throw Error('sourcePath 只能指向插件输出目录、画室输出目录或设置里允许的目录；更推荐传图库 sourceId');
    bytes = readFileSync(full);
  } else {
    throw Error('要给图：sourceId（图库 id）或 sourcePath（本地路径）');
  }
  return renderBytes(ctx, args, session, index, bytes);
}

function projectDirOf(id: string) {
  if (!/^[a-z0-9-]{3,80}$/i.test(id)) return null;
  const dir = join(PROJECTS_DIR, id);
  return dir.startsWith(PROJECTS_DIR + sep) ? dir : null;
}

function projectData(id: string) {
  const dir = projectDirOf(id);
  if (!dir) return null;
  try {
    const data = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return { ...data, id };
  } catch {
    return null;
  }
}

function projectSource(id: string) {
  const data = projectData(id);
  const dir = projectDirOf(id);
  if (!data || !dir) return null;
  const name = String(data.source || '').trim();
  if (!/^source\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return null;
  const full = join(dir, name);
  if (!existsSync(full)) return null;
  return { file: full, name, data };
}

function projectPublic(data: any) {
  if (!data) return null;
  return {
    id: data.id,
    name: String(data.name || data.id),
    createdAt: data.createdAt || '',
    updatedAt: data.updatedAt || '',
    text: String(data.text || ''),
    texts: Array.isArray(data.texts) ? data.texts.map(String).slice(0, 30) : [],
    style: data.style || 'band',
    width: data.width || 512,
    format: data.format || 'png',
    animation: data.animation || 'none',
    platform: data.platform || 'custom',
    layout: data.layout || { ...DEFAULT_LAYOUT },
    sourceUrl: API_PROJECT_SRC + '?id=' + encodeURIComponent(data.id),
  };
}

function listProjects() {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  const items: any[] = [];
  for (const id of readdirSync(PROJECTS_DIR)) {
    const data = projectData(id);
    if (!data) continue;
    items.push(projectPublic(data));
  }
  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function saveProject(body: any) {
  const name = String(body?.name ?? '').trim().slice(0, 60) || '未命名表情包项目';
  const sourceFile = String(body?.sourceFile ?? '').trim();
  const source = sourcePathOf(sourceFile);
  if (!source) throw Error('先准备一张参考图，再保存项目');
  const bytes = readFileSync(source);
  const kind = sniff(bytes);
  if (!kind) throw Error('参考图格式不支持');
  const id = 'project-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const dir = join(PROJECTS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const sourceName = 'source.' + kind.ext;
  writeFileSync(join(dir, sourceName), bytes);
  const cfg = config();
  const texts = Array.isArray(body?.texts)
    ? body.texts.map((x: any) => String(x ?? '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const data = {
    id, name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: sourceName,
    text: String(body?.text ?? '').trim().slice(0, 120),
    texts,
    style: STYLES.includes(String(body?.style)) ? String(body.style) : defaultStyle(cfg),
    width: widthOf(body?.width, cfg, platformOf(body?.platform)),
    format: formatOf(body?.format, cfg, ANIMATIONS.includes(String(body?.animation)) ? String(body.animation) : 'none'),
    animation: ANIMATIONS.includes(String(body?.animation)) ? String(body.animation) : 'none',
    platform: platformOf(body?.platform),
    layout: layoutOf(body?.layout, cfg),
  };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(data, null, 2));
  return projectPublic(data);
}

function updateProject(id: string, patch: any) {
  const data = projectData(id);
  if (!data) throw Error('项目不存在');
  const dir = projectDirOf(id);
  if (!dir) throw Error('项目 ID 无效');
  const cfg = config();
  const next = { ...data };
  if (patch?.name !== undefined) next.name = String(patch.name).trim().slice(0, 60) || next.name;
  if (patch?.text !== undefined) next.text = String(patch.text).trim().slice(0, 120);
  if (patch?.texts !== undefined && Array.isArray(patch.texts)) {
    next.texts = patch.texts.map((x: any) => String(x ?? '').trim()).filter(Boolean).slice(0, 30);
  }
  if (patch?.style !== undefined && STYLES.includes(String(patch.style))) next.style = String(patch.style);
  if (patch?.width !== undefined) next.width = widthOf(patch.width, cfg, platformOf(next.platform));
  if (patch?.format !== undefined) next.format = formatOf(patch.format, cfg, next.animation);
  if (patch?.animation !== undefined && ANIMATIONS.includes(String(patch.animation))) next.animation = String(patch.animation);
  if (patch?.platform !== undefined) next.platform = platformOf(patch.platform);
  if (patch?.layout !== undefined) next.layout = layoutOf(patch.layout, cfg);
  next.updatedAt = new Date().toISOString();
  writeFileSync(join(dir, 'project.json'), JSON.stringify(next, null, 2));
  return projectPublic(next);
}

function deleteProject(id: string) {
  const dir = projectDirOf(id);
  if (!dir || !existsSync(dir)) throw Error('项目不存在');
  rmSync(dir, { recursive: true, force: true });
}

function runZip(files: Array<{ path: string; name: string }>, output: string, manifest: any, signal?: AbortSignal) {
  return new Promise<any>((resolvePromise, reject) => {
    const child = spawn(pythonPath(), [ZIP_SCRIPT], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(Error('打包超时'));
    }, 30_000);
    const abort = () => {
      try { child.kill(); } catch { /* ignore */ }
      reject(Error('已取消'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code !== 0) return reject(Error(err.trim() || '打包失败'));
      try {
        const data = JSON.parse(out.trim());
        if (!data?.ok) return reject(Error(String(data?.error || '打包失败')));
        resolvePromise(data);
      } catch {
        reject(Error('打包脚本返回的不是 JSON'));
      }
    });
    child.stdin.end(JSON.stringify({ output, files, manifest }));
  });
}

async function renderBatch(ctx: any, body: any, session: any) {
  const source = sourcePathOf(String(body?.sourceFile ?? '').trim());
  if (!source) throw Error('先选一张参考图');
  const texts = (Array.isArray(body?.texts) ? body.texts : [])
    .map((x: any) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH);
  if (!texts.length) throw Error('批量字幕不能为空');
  const styles = (Array.isArray(body?.styles) ? body.styles : [body?.style])
    .map((x: any) => STYLES.includes(String(x)) ? String(x) : null)
    .filter(Boolean) as string[];
  const useStyles = styles.length ? styles : [String(body?.style || 'band')];
  if (texts.length * useStyles.length > MAX_BATCH) throw Error('一次最多生成 ' + MAX_BATCH + ' 张');
  const bytes = readFileSync(source);
  const items: any[] = [];
  let n = 0;
  for (const text of texts) {
    for (const style of useStyles) {
      n += 1;
      const one = await renderBytes(ctx, { ...body, text, style, deliver: false }, session, n, bytes, false);
      items.push({
        text, style: one.style, url: one.url, name: one.name, file: one.file,
        width: one.width, height: one.height, format: one.format, animation: one.animation,
      });
    }
  }
  const outName = 'meme-export-' + Date.now() + '.zip';
  const zipPath = join(OUT_DIR, outName);
  const zipItems = items.map((x, i) => ({
    path: x.file,
    name: String(i + 1).padStart(2, '0') + '-' + slug(x.style, 'style') + '.' + String(x.name.split('.').pop() || 'png'),
  }));
  const manifest = {
    generator: 'studio/meme',
    createdAt: new Date().toISOString(),
    platform: platformOf(body?.platform),
    items: items.map((x, i) => ({
      text: x.text, style: x.style, file: zipItems[i].name, width: x.width, height: x.height,
    })),
  };
  const zip = await runZip(zipItems, zipPath, manifest, session?.signal);
  return {
    items,
    zip: { name: outName, file: zipPath, bytes: zip.bytes, url: PAGE_OUT + '?name=' + encodeURIComponent(outName) + '&download=1' },
  };
}

async function suggestCaptions(ctx: any, body: any, session: any) {
  const tone = String(body?.tone ?? '').trim() || 'wry';
  const hint = String(body?.hint ?? '').trim().slice(0, 60);
  const count = Math.max(1, Math.min(12, Math.round(Number(body?.count) || 6)));
  const sourceFile = String(body?.sourceFile ?? '').trim();
  const source = sourceFile ? sourcePathOf(sourceFile) : null;
  const cfg = config();
  let bytes: Buffer | null = null;
  let mime = '';
  if (source) {
    bytes = readFileSync(source);
    const kind = sniff(bytes);
    mime = kind?.mime || '';
  }
  const fallback = (note = '') => ({
    ok: true,
    source: 'local',
    tone,
    captions: suggestLocal(tone, hint, count),
    note,
  });
  const llm = (ctx as any).llm;
  const models = (ctx as any).models;
  if (!llm?.chat || !models?.list) return fallback('当前宿主没有可用的文案模型，已使用内置短语库');
  let model = String(cfg.captionModel || '').trim();
  let candidates: any[] = [];
  try {
    candidates = models.list('chat') || [];
  } catch { /* ignore */ }
  if (!model) {
    const first = candidates.find((x: any) => x && x.id);
    model = String(first?.id || '').trim();
  }
  if (!model) return fallback('没有配置可用的文案模型，已使用内置短语库');
  const prompt = [
    '你是表情包文案助手。根据图片和用户给的方向，写短句。',
    '规则：每条不超过8个汉字，口语化，不解释，不加编号，不重复；只输出短句，一行一条。',
    '语气：' + tone,
    hint ? '方向：' + hint : '方向：贴图本身的情绪',
    '最多输出 ' + count + ' 条。',
  ].join('\n');
  const messages: any[] = [
    { role: 'system', content: '只输出表情包短句，一行一条。每条不超过8个汉字，不要标点解释。' },
    { role: 'user', content: prompt },
  ];
  if (bytes && (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp')) {
    messages[1] = {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + bytes.toString('base64'), detail: 'low' } },
      ],
    };
  }
  try {
    const reply = await llm.chat({ model, messages, max_tokens: 320, signal: session?.signal });
    const captions = parseCaptions(reply?.text, count);
    if (captions.length) return { ok: true, source: 'model', model, tone, captions, note: '' };
    return fallback('文案模型没有返回可用短句，已使用内置短语库');
  } catch (error: any) {
    // 有些模型不支持图片输入；退回纯文字再试一次，仍失败就用本地库。
    if (bytes) {
      try {
        const reply = await llm.chat({
          model,
          messages: [
            { role: 'system', content: '只输出表情包短句，一行一条。每条不超过8个汉字，不要标点解释。' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 320,
          signal: session?.signal,
        });
        const captions = parseCaptions(reply?.text, count);
        if (captions.length) return { ok: true, source: 'model-text', model, tone, captions, note: '' };
      } catch { /* fall through */ }
    }
    return fallback('文案模型调用失败，已使用内置短语库：' + String(error?.message ?? error).slice(0, 120));
  }
}


async function collectAndMaybeSend(ctx: any, one: any, args: any, session: any) {
  if (!args?.collect && !args?.send) return { collected: null, sent: null, note: '' };
  if (!one?.mediaRef) return { collected: null, sent: null, note: one?.galleryNote || '没有可收藏的图库引用' };
  try {
    const call = await (ctx as any).tools.call('gallery_collect', {
      mediaRef: one.mediaRef,
      description: String(args?.description ?? args?.text ?? '').slice(0, 160),
      purposes: ['meme'],
    }, session);
    const result: any = (call as any)?.ok === true ? (call as any).result : call;
    const assetId = String(
      result?.asset?.id ?? result?.assetId ?? result?.id ??
      result?.result?.asset?.id ?? result?.result?.assetId ?? '',
    ).trim();
    if (!args?.send) return { collected: { ok: true, assetId, result }, sent: null, note: '' };
    if (!assetId) return { collected: { ok: true, assetId: '', result }, sent: null, note: '已收藏，但返回里没有 asset id，不能继续发送' };
    if (!args?.userId) return { collected: { ok: true, assetId, result }, sent: null, note: '已收藏；要发 QQ 需要明确给 userId' };
    if (session?.permission !== 'full') return { collected: { ok: true, assetId, result }, sent: null, note: '已收藏；当前工具权限不是 full，不能直接发 QQ' };
    const actionId = String(args?.actionId ?? '').trim() || ('meme-' + Date.now());
    const sent = await (ctx as any).tools.call('qq_send_gallery', {
      userId: String(args.userId),
      actionId,
      parts: [{ type: 'image', id: assetId, mode: 'meme' }],
    }, session);
    return { collected: { ok: true, assetId, result }, sent, note: '' };
  } catch (error: any) {
    return { collected: null, sent: null, note: '收藏/发送失败：' + String(error?.message ?? error).slice(0, 160) };
  }
}

function renderPage(ctx: any, studioReady: boolean) {
  const cfg = config();
  const py = pythonPath();
  const pyFound = py !== 'python' && existsSync(py);
  const pyState =
    pythonSource === 'studio'
      ? '<span class="ok">复用画室配置的 Python（已找到）</span>'
      : pythonSource === 'path'
        ? '<span class="ok">PATH 中已确认 Pillow</span>'
        : pythonSource === 'fallback'
          ? '<span class="bad">没找到带 Pillow 的 python，请填完整路径</span>'
          : pyFound
            ? '<span class="ok">文件存在（Pillow 未验证）</span>'
            : '<span class="bad">文件不存在</span>';
  const fontPlaceholder = '留空自动匹配，或填字体文件绝对路径';
  const dirPlaceholder = '一行一个绝对路径，留空只允许插件输出目录';
  const fontConfigured = String(cfg.font || '').trim();
  const stat = outStats();
  const galleryReady = Boolean((ctx as any).get?.('gallery', false));
  const styleOptions = [
    ['band', 'band：底部白条'],
    ['bubble', 'bubble：白气泡带尾巴'],
    ['plain', 'plain：描边大字'],
    ['top', 'top：顶部白条'],
    ['auto', 'auto：自动选位置'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${defaultStyle(cfg) === value ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const presets = readPresets();
  const toneOptions = Object.keys(presets.tones)
    .map((id) => `<option value="${esc(id)}">${esc(TONE_LABELS[id] || id)}</option>`)
    .join('');
  const templateOptions = (presets.templates || [])
    .map((t: any) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>表情包工坊 · 画室</title>
<style>
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;padding:32px 28px 36px}
main{max-width:880px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}
h1{font-size:27px;letter-spacing:-.5px;margin:0 0 4px;font-weight:650}
p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:18px 0}
h2{font-size:16px;margin:0 0 6px}
p.hint{margin:0 0 14px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px;align-items:start}
label{display:grid;gap:6px;font-size:13px;color:var(--muted);min-width:0}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%;height:40px;min-width:0;box-sizing:border-box;line-height:1.5;vertical-align:middle}
textarea{height:auto}
input[type=checkbox]{width:auto;height:auto}
select{cursor:pointer}
input[type=number]{font-variant-numeric:tabular-nums}
.row{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
button,a.btn{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:#b23c3c;border-color:#b23c3c}
button:disabled{opacity:.5;cursor:not-allowed}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.tab{border-radius:999px;padding:6px 14px;font-size:13px;color:var(--muted)}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
.pane{margin:0}
.drop{display:flex;align-items:center;justify-content:center;min-height:110px;border:1px dashed var(--line);border-radius:12px;background:var(--soft);color:var(--muted);font-size:13px;text-align:center;padding:16px;cursor:pointer}
.drop.over{border-color:var(--accent);color:var(--accent)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}
.chips button{border-radius:999px;padding:5px 12px;font-size:12px;color:var(--muted)}
.source{display:flex;gap:16px;align-items:flex-start;margin-top:16px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--soft)}
.source img{max-width:220px;max-height:170px;border-radius:8px;border:1px solid var(--line);background:#fff;object-fit:contain}
.meta{font-size:13px;color:var(--muted);word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);word-break:break-all}
th{color:var(--muted);font-weight:500;width:130px}
.ok{color:#126e68}.bad{color:#b23c3c}
.msg{min-height:22px;margin-top:10px;font-size:13px;color:var(--accent)}
.msg.bad{color:#b23c3c}
.model-badge{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--soft);color:var(--muted);margin-bottom:14px}
.model-badge.ok{color:#126e68;border-color:#9ccfca}
.model-badge.bad{color:#b23c3c;border-color:#e0b4b4}
.model-badge a{color:inherit;text-decoration:underline;font-size:12px}
.hint-inline{font-size:12px;color:var(--muted)}
.result{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.result img{max-width:320px;max-height:320px;border-radius:10px;border:1px solid var(--line);background:#fff}
#msg{min-height:22px;margin-top:12px;font-size:13px;color:var(--accent)}
#msg.bad{color:#b23c3c}
@media(max-width:640px){.grid{grid-template-columns:1fr}.source{flex-direction:column}.result img{max-width:100%}}
</style></head><body><main>
<header><div><h1>表情包工坊</h1><p class="sub">输出 ${stat.count} 张 · ${(stat.bytes / 1048576).toFixed(2)} MB · 图库${galleryReady ? '已接通' : '未接通'} · 画室${studioReady ? '已接通' : '未接通'}</p></div></header>

<section class="card">
  <h2>一键出图</h2>
  <p class="hint">选一张参考图（上传 / 图库 / 让画室画一张），写一句字幕，点一下直接出成品。成品先交图库作临时引用，收藏入库由 gallery_collect 完成。</p>
  <div class="tabs" role="tablist">
    <button type="button" class="tab on" data-pane="upload">上传图片</button>
    <button type="button" class="tab" data-pane="gallery">图库 ID</button>
    <button type="button" class="tab" data-pane="ai">AI 画参考图</button>
  </div>

  <div class="pane" id="pane-upload">
    <label class="drop" id="drop" for="file">
      <span>把图片拖进来，或点这里选一张<br>PNG / JPG / WebP / GIF，≤15 MB</span>
      <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    </label>
  </div>

  <div class="pane" id="pane-gallery" hidden>
    <label>图库图片 ID
      <input id="galleryId" placeholder="画室出图返回的 galleryId" autocomplete="off">
    </label>
    <div class="row"><button type="button" id="loadGallery">载入这张</button><span class="hint-inline">图库没接通就取不到</span></div>
  </div>

  <div class="pane" id="pane-ai" hidden>
    <div class="model-badge checking" id="modelBadge">正在检查出图模型…</div>
    <label>画面描述
      <textarea id="prompt" rows="3" placeholder="小鲸鱼趴在便签上，Q 版，白底，正面"></textarea>
    </label>
    <p class="hint" style="margin:8px 0 0">图里要出现中文，就把字用“”写进描述，并说明「字很大、占画面宽度一半」；一句七八个字以内，一张图只放一处，越小越糊。字体排版要卡死的表情包，先画干净图，再用下面的字幕压字——别让模型直接写字。</p>
    <div class="chips">
      <button type="button" data-prompt="小鲸鱼趴在便签上，Q 版，白底，正面，圆滚滚">小鲸鱼</button>
      <button type="button" data-prompt="一只橘猫抱着一条鱼，卡通贴纸风，白底，居中">猫抱鱼</button>
      <button type="button" data-prompt="熊猫人无语表情，黑白线稿，白底，半身">熊猫人</button>
      <button type="button" data-prompt="店招上用红色黑体写着“热牛奶”，字很大、占画面宽度一半，正面拍摄">带字招牌</button>
      <button type="button" data-prompt="一张撕下来的便签纸，阴影柔和，留大量空白，正面拍摄">空白便签</button>
    </div>
    <div class="grid" style="margin-top:14px">
      <label>画幅
        <select id="aiSize">
          <option value="1024x1024">方形 1024×1024</option>
          <option value="832x1216">竖版 832×1216</option>
          <option value="1216x832">横版 1216×832</option>
          <option value="512x512">小方图 512×512</option>
        </select>
      </label>
    </div>
    <div class="row"><button type="button" id="aiDraw" disabled>让 AI 画一张</button><button type="button" id="recheck">重新检查</button><span class="hint-inline">走画室当前后端，本地模型可能要一两分钟</span></div>
  </div>

  <div class="source" id="source" hidden>
    <img id="sourceImg" alt="参考图">
    <div>
      <div id="sourceMeta" class="meta"></div>
      <div class="row"><button type="button" id="clearSource">换一张</button></div>
    </div>
  </div>

  <div class="grid" style="margin-top:16px">
    <label>字幕
      <input id="text" maxlength="120" placeholder="就这？" autocomplete="off">
    </label>
    <label>样式
      <select id="style">${styleOptions}</select>
    </label>
    <label>成品宽度（128–1600）
      <input id="width" type="number" min="128" max="1600" step="1" value="${defaultWidth(cfg)}">
    </label>
    <label>平台预设
      <select id="platform">
        <option value="custom">自定义尺寸</option>
        <option value="qq">QQ 表情 512</option>
        <option value="wechat">微信表情 240</option>
        <option value="telegram">Telegram 贴纸 512</option>
        <option value="discord">Discord 表情 320</option>
      </select>
    </label>
    <label>输出格式
      <select id="format">
        <option value="png">PNG</option>
        <option value="webp">WebP（更小）</option>
        <option value="gif">GIF（静态）</option>
      </select>
    </label>
    <label>动效（选非 none 自动出 GIF）
      <select id="animation">
        <option value="none">none：静态</option>
        <option value="pop">pop：弹入</option>
        <option value="shake">shake：轻微抖动</option>
        <option value="zoom">zoom：缓慢放大</option>
      </select>
    </label>
  </div>
  <div class="chips">
    <button type="button" data-text="就这？">就这？</button>
    <button type="button" data-text="困成鱼干">困成鱼干</button>
    <button type="button" data-text="气死我了">气死我了</button>
    <button type="button" data-text="？？？">？？？</button>
  </div>

  <div class="grid" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
    <label>配文语气
      <select id="tone">${toneOptions}</select>
    </label>
    <label>方向提示（可选）
      <input id="hint" maxlength="60" placeholder="例如：被老板催稿" autocomplete="off">
    </label>
  </div>
  <div class="row"><button type="button" id="suggest">给我配文</button><span id="suggestState" class="hint-inline"></span></div>
  <div class="chips" id="suggestChips"></div>

  <details class="card" style="margin-top:16px;background:var(--soft);padding:14px 16px">
    <summary style="cursor:pointer;font-weight:600">精细排版（可选）</summary>
    <p class="hint" style="margin:10px 0">留空或 0 表示自动。字号、行高、边距和颜色会同时作用于单张 / 批量 / 项目重出。</p>
    <div class="grid">
      <label>字号（0 自动）
        <input id="fontSize" type="number" min="0" max="200" step="1" placeholder="0">
      </label>
      <label>行高（0.9–2.2）
        <input id="lineHeight" type="number" min="0.9" max="2.2" step="0.05" placeholder="1.35">
      </label>
      <label>对齐
        <select id="align"><option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option></select>
      </label>
      <label>外边距（0–160）
        <input id="margin" type="number" min="0" max="160" step="1" placeholder="18">
      </label>
      <label>内边距（0–96）
        <input id="padding" type="number" min="0" max="96" step="1" placeholder="20">
      </label>
      <label>最多行数（1–6）
        <input id="maxLines" type="number" min="1" max="6" step="1" placeholder="4">
      </label>
      <label>横向偏移（-240–240）
        <input id="offsetX" type="number" min="-240" max="240" step="1" placeholder="0">
      </label>
      <label>纵向偏移（-240–240）
        <input id="offsetY" type="number" min="-240" max="240" step="1" placeholder="0">
      </label>
      <label>描边宽度（0–16）
        <input id="strokeWidth" type="number" min="0" max="16" step="1" placeholder="0">
      </label>
      <label>文字颜色
        <input id="textColor" maxlength="9" placeholder="#111111" autocomplete="off">
      </label>
      <label>色块颜色
        <input id="bandColor" maxlength="9" placeholder="#ffffff" autocomplete="off">
      </label>
      <label>描边颜色
        <input id="strokeColor" maxlength="9" placeholder="#000000" autocomplete="off">
      </label>
    </div>
    <div class="row" style="margin-top:10px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="shadow"> 阴影</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="autoContrast" checked> 自动字色</label>
    </div>
  </details>

  <div class="row">
    <button type="button" class="primary" id="make">一键出图</button>
    <button type="button" id="compare">四风格对比</button>
    <button type="button" id="saveProject">保存为项目</button>
    <span id="ocState" class="hint-inline"></span>
  </div>
  <div id="ocMsg" class="msg"></div>

  <div class="result" id="result" hidden>
    <img id="resultImg" alt="成品">
    <div style="flex:1;min-width:240px">
      <table>
        <tr><th>成品</th><td id="resultName">—</td></tr>
        <tr><th>尺寸</th><td id="resultSize">—</td></tr>
        <tr><th>样式</th><td id="resultStyle">—</td></tr>
        <tr><th>格式</th><td id="resultFormat">—</td></tr>
        <tr><th>字体</th><td id="resultFont">—</td></tr>
        <tr><th>图库引用</th><td id="resultId">—</td></tr>
      </table>
      <div class="row"><a class="btn" id="download" download>下载这张</a></div>
    </div>
  </div>

  <div id="compareResult" hidden style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line)">
    <h2 style="font-size:15px">四风格对比</h2>
    <div id="compareGrid" class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:10px"></div>
  </div>
</section>

<section class="card" id="batchCard">
  <h2>批量套图 / 导出包</h2>
  <p class="hint">一行一条字幕，一次出整套；同一张底图可换不同版式。生成后按 01、02 命名并打包 zip，里面带 manifest.json。</p>
  <label>字幕列表（每行一条，最多 24 张）
    <textarea id="batchTexts" rows="5" placeholder="开心&#10;困了&#10;干饭"></textarea>
  </label>
  <div class="grid" style="margin-top:12px">
    <label>批量样式
      <select id="batchStyle">${styleOptions}</select>
    </label>
    <label>批量格式
      <select id="batchFormat"><option value="png">PNG</option><option value="webp">WebP</option><option value="gif">GIF</option></select>
    </label>
    <label>批量平台
      <select id="batchPlatform"><option value="custom">自定义</option><option value="qq">QQ 512</option><option value="wechat">微信 240</option><option value="telegram">Telegram 512</option><option value="discord">Discord 320</option></select>
    </label>
  </div>
  <div class="row"><button type="button" class="primary" id="batchMake">批量出图并打包</button><span id="batchState" class="hint-inline"></span></div>
  <div id="batchMsg" class="msg"></div>
  <div id="batchResult"></div>
</section>

<section class="card">
  <h2>项目</h2>
  <p class="hint">把当前底图、字幕、样式和精细排版存成项目；之后改一句字就能重出，不用重新画图。</p>
  <div class="row" style="margin-top:0">
    <input id="projectName" maxlength="60" placeholder="项目名，例如：猫猫无语套图" style="flex:1;min-width:220px">
    <button type="button" id="projectSave">保存当前项目</button>
    <button type="button" id="projectRefresh">刷新列表</button>
  </div>
  <div id="projectMsg" class="msg"></div>
  <div id="projectList"></div>
</section>

<section class="card">
  <h2>模板与词库</h2>
  <p class="hint">模板只改样式和排版，不执行代码；词库和模板都可以导出 JSON 备份，再导入到别的实例。</p>
  <div class="grid">
    <label>套用模板
      <select id="templateSelect">${templateOptions}</select>
    </label>
    <label>导入 / 导出
      <span class="row" style="margin-top:0">
        <button type="button" class="btn" id="presetExport">导出 JSON</button>
        <label class="btn" for="presetFile" style="margin:0;cursor:pointer">导入 JSON</label>
        <input id="presetFile" type="file" accept="application/json,.json" hidden>
      </span>
    </label>
  </div>
  <div class="row"><button type="button" id="applyTemplate">套用这个模板</button><span id="presetMsg" class="hint-inline"></span></div>
</section>


<section class="card">
  <h2>默认参数</h2>
  <p class="hint">工具没传 <code>style</code> / <code>width</code> 时用这里的默认值。</p>
  <div class="grid">
    <label>默认样式
      <select id="style2">
        <option value="band"${defaultStyle(cfg) === 'band' ? ' selected' : ''}>band：底部白条</option>
        <option value="bubble"${defaultStyle(cfg) === 'bubble' ? ' selected' : ''}>bubble：白气泡带尾巴</option>
        <option value="plain"${defaultStyle(cfg) === 'plain' ? ' selected' : ''}>plain：描边大字</option>
        <option value="top"${defaultStyle(cfg) === 'top' ? ' selected' : ''}>top：顶部白条</option>
        <option value="auto"${defaultStyle(cfg) === 'auto' ? ' selected' : ''}>auto：自动选位置</option>
      </select>
    </label>
    <label>默认宽度（128–1600）
      <input id="width2" type="number" min="128" max="1600" step="1" value="${defaultWidth(cfg)}">
    </label>
    <label>默认格式
      <select id="format2">
        <option value="png"${String(cfg.defaultFormat || 'png') === 'png' ? ' selected' : ''}>PNG</option>
        <option value="webp"${String(cfg.defaultFormat) === 'webp' ? ' selected' : ''}>WebP</option>
        <option value="gif"${String(cfg.defaultFormat) === 'gif' ? ' selected' : ''}>GIF</option>
      </select>
    </label>
    <label>默认平台
      <select id="platform2">
        <option value="custom"${String(cfg.defaultPlatform || 'custom') === 'custom' ? ' selected' : ''}>自定义</option>
        <option value="qq"${String(cfg.defaultPlatform) === 'qq' ? ' selected' : ''}>QQ 512</option>
        <option value="wechat"${String(cfg.defaultPlatform) === 'wechat' ? ' selected' : ''}>微信 240</option>
        <option value="telegram"${String(cfg.defaultPlatform) === 'telegram' ? ' selected' : ''}>Telegram 512</option>
        <option value="discord"${String(cfg.defaultPlatform) === 'discord' ? ' selected' : ''}>Discord 320</option>
      </select>
    </label>
    <label>文案模型 ID（留空自动挑一个可用的 chat 模型）
      <input id="captionModel" maxlength="120" placeholder="留空自动" value="${esc(cfg.captionModel || '')}" autocomplete="off">
    </label>
    <label>允许读取的本地目录（一行一个绝对路径，留空只允许插件输出目录）
      <textarea id="allowedDirs" rows="3" placeholder="${esc(dirPlaceholder)}">${esc((Array.isArray(cfg.allowedDirs) ? cfg.allowedDirs : []).join('\n'))}</textarea>
    </label>
  </div>
</section>

<section class="card">
  <h2>Python</h2>
  <p class="hint">渲染用 Pillow。留空就按 PATH 找带 Pillow 的 <code>python</code> / <code>python3</code>；都没装 Pillow 时请在下面填解释器的完整路径。</p>
  <label>python 解释器路径
    <input id="python" type="text" placeholder="留空自动探测" value="${esc(cfg.python || '')}">
  </label>
  <table style="margin-top:14px">
    <tr><th>实际使用</th><td><code>${esc(py)}</code> ${pyState}</td></tr>
  </table>
</section>

<section class="card">
  <h2>字体</h2>
  <p class="hint">字幕要用中文字体渲染。留空会按当前系统找常见中文字体（Windows 微软雅黑/黑体、macOS 苹方、Linux Noto CJK）；都找不到时会明确报错，不会把中文画成方块。</p>
  <label>中文字体文件（.ttf / .ttc / .otf）
    <input id="font" type="text" placeholder="${esc(fontPlaceholder)}" value="${esc(fontConfigured)}">
  </label>
  <table style="margin-top:14px">
    <tr><th>当前</th><td>${fontConfigured ? '<code>' + esc(fontConfigured) + '</code>' : '自动匹配系统字体'}</td></tr>
  </table>
</section>

<section class="card">
  <h2>输出</h2>
  <table>
    <tr><th>目录</th><td><code>${esc(OUT_DIR)}</code></td></tr>
    <tr><th>文件</th><td>${stat.count} 张 · ${(stat.bytes / 1048576).toFixed(2)} MB</td></tr>
    <tr><th>入库</th><td>${galleryReady ? '成品只交图库临时引用（mediaRef，24 小时），入库由 gallery_collect 完成' : '图库插件没在跑，只落本地文件'}</td></tr>
  </table>
  <div class="row"><button class="danger" id="clear">清空输出目录</button></div>
</section>

<div class="row"><button id="reset">恢复默认</button><button class="primary" id="save">保存设置</button></div>
<div id="msg"></div>
<script>
const $ = (s) => document.querySelector(s);
const msg = (t, bad) => { const el = $('#msg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; };
const ocMsg = (t, bad) => { const el = $('#ocMsg'); el.textContent = t || ''; el.className = 'msg' + (bad ? ' bad' : ''); };
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
const state = { tab: 'upload', sourceFile: '', sourceUrl: '', projectId: '', busy: false, model: null, presets: null, lastResult: null };

function busy(flag, label) {
  state.busy = flag;
  for (const id of ['make', 'compare', 'saveProject', 'batchMake', 'aiDraw', 'loadGallery', 'suggest', 'projectSave']) {
    const el = $('#' + id);
    if (el) el.disabled = flag || (id === 'aiDraw' && !(state.model && state.model.ok));
  }
  $('#ocState').textContent = label || '';
}
function showSource(url, meta) {
  state.sourceUrl = url;
  $('#source').hidden = false;
  $('#sourceImg').src = url;
  $('#sourceMeta').textContent = meta;
}
function clearSource() {
  state.sourceFile = '';
  state.sourceUrl = '';
  $('#source').hidden = true;
  $('#sourceImg').removeAttribute('src');
  $('#sourceMeta').textContent = '';
  $('#file').value = '';
}
$('#sourceImg').onerror = () => {
  if (!state.sourceUrl) return;
  clearSource();
  ocMsg('参考图预览加载失败，重新选一张', true);
};

function paintModel(data) {
  const badge = $('#modelBadge');
  badge.className = 'model-badge ' + (data.ok ? 'ok' : 'bad');
  badge.textContent = data.ok
    ? '出图模型：' + data.label + (data.online ? '（在线）' : '（已配置）')
    : '没有可用的出图模型：' + (data.message || '未配置') + '，先配置再出图';
  if (!data.ok && data.settingsUrl) {
    const link = document.createElement('a');
    link.href = data.settingsUrl;
    link.target = '_blank';
    link.textContent = '去画室设置 →';
    badge.appendChild(link);
  }
  $('#aiDraw').disabled = !data.ok;
}

async function checkModel(manual) {
  const badge = $('#modelBadge');
  badge.className = 'model-badge checking';
  badge.textContent = '正在检查出图模型…';
  $('#aiDraw').disabled = true;
  try {
    const res = await fetch('${API_MODEL}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({ ok: false, message: '检查接口返回了看不懂的内容' }));
    state.model = data;
    paintModel(data);
    if (!data.ok && (manual || state.tab === 'ai')) {
      ocMsg('AI 画参考图先禁用：' + (data.message || '出图模型没配好') + '。上传图片和图库 ID 两条路不受影响。', true);
    } else if (data.ok && state.tab === 'ai') {
      ocMsg('');
    }
    return Boolean(data.ok);
  } catch (error) {
    state.model = { ok: false, message: error.message };
    badge.className = 'model-badge bad';
    badge.textContent = '检查出图模型失败：' + error.message;
    return false;
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('on', item === tab));
    ['upload', 'gallery', 'ai'].forEach((name) => { $('#pane-' + name).hidden = name !== tab.dataset.pane; });
    state.tab = tab.dataset.pane;
  };
});

document.querySelectorAll('.chips button[data-text]').forEach((chip) => {
  chip.onclick = () => { $('#text').value = chip.dataset.text; };
});
document.querySelectorAll('.chips button[data-prompt]').forEach((chip) => {
  chip.onclick = () => { $('#prompt').value = chip.dataset.prompt; };
});

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读不出这个文件'));
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  if (!file) return;
  if (!/^image\\/(png|jpeg|webp|gif)$/.test(file.type)) return ocMsg('只支持 PNG / JPG / WebP / GIF', true);
  if (file.size > 15 * 1048576) return ocMsg('图片超过 15 MB，换小一点的', true);
  let dataUrl = '';
  try { dataUrl = await readFile(file); } catch (error) { return ocMsg(error.message, true); }
  showSource(dataUrl, file.name + ' · ' + (file.size / 1048576).toFixed(2) + ' MB · 正在载入');
  busy(true, '正在载入图片…');
  try {
    const data = await post('${API_SOURCE}', { type: 'upload', base64: dataUrl.split(',')[1] || '' });
    state.projectId = '';
    state.sourceFile = data.sourceFile;
    showSource(data.sourceUrl + '&t=' + Date.now(), file.name + ' · ' + (data.bytes / 1048576).toFixed(2) + ' MB');
    ocMsg('参考图已就绪，写一句字幕就能出图');
  } catch (error) {
    clearSource();
    ocMsg('载入失败：' + error.message, true);
  } finally {
    busy(false);
  }
}

$('#file').onchange = (event) => uploadFile(event.target.files && event.target.files[0]);
const drop = $('#drop');
['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  uploadFile(file);
});

$('#loadGallery').onclick = async () => {
  const id = $('#galleryId').value.trim();
  if (!id) return ocMsg('先填图库 ID', true);
  busy(true, '正在取图…');
  try {
    const data = await post('${API_SOURCE}', { type: 'gallery', galleryId: id });
    state.projectId = '';
    state.sourceFile = data.sourceFile;
    showSource(data.sourceUrl + '&t=' + Date.now(), '图库 ' + id + ' · ' + (data.bytes / 1048576).toFixed(2) + ' MB');
    ocMsg('参考图已就绪');
  } catch (error) {
    ocMsg('取图失败：' + error.message, true);
  } finally {
    busy(false);
  }
};

async function aiDraw() {
  if (!state.model?.ok && !(await checkModel(true))) {
    ocMsg('出图模型还没配好，先到画室设置页配置（或改用上传图片 / 图库 ID）', true);
    return false;
  }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { ocMsg('先写一句画面描述', true); return false; }
  const size = $('#aiSize').value.split('x');
  busy(true, '正在画参考图…本地模型要一两分钟，别关页面');
  try {
    const data = await post('${API_SOURCE}', { type: 'ai', prompt: prompt, width: Number(size[0]), height: Number(size[1]) });
    state.projectId = '';
    state.sourceFile = data.sourceFile;
    showSource(data.sourceUrl + '&t=' + Date.now(), 'AI 画的：' + prompt + (data.backend ? '（' + data.backend + '）' : ''));
    ocMsg('参考图已就绪，写一句字幕就能出图');
    return true;
  } catch (error) {
    ocMsg('画图失败：' + error.message, true);
    return false;
  } finally {
    busy(false);
  }
}
$('#aiDraw').onclick = () => aiDraw();
$('#recheck').onclick = () => checkModel(true);

function layoutFromPage() {
  const num = (id) => {
    const raw = $('#' + id).value.trim();
    return raw === '' ? undefined : Number(raw);
  };
  return {
    fontSize: num('fontSize'),
    lineHeight: num('lineHeight'),
    align: $('#align').value,
    margin: num('margin'),
    padding: num('padding'),
    maxLines: num('maxLines'),
    offsetX: num('offsetX'),
    offsetY: num('offsetY'),
    strokeWidth: num('strokeWidth'),
    shadow: $('#shadow').checked,
    autoContrast: $('#autoContrast').checked,
    textColor: $('#textColor').value.trim(),
    bandColor: $('#bandColor').value.trim(),
    strokeColor: $('#strokeColor').value.trim(),
  };
}
function renderBody() {
  return {
    sourceFile: state.sourceFile,
    text: $('#text').value.trim(),
    style: $('#style').value,
    width: Number($('#width').value),
    layout: layoutFromPage(),
    format: $('#format').value,
    animation: $('#animation').value,
    platform: $('#platform').value,
  };
}
function showResult(data) {
  state.lastResult = data;
  $('#result').hidden = false;
  $('#resultImg').src = data.url + '&t=' + Date.now();
  $('#resultName').textContent = data.name;
  $('#resultSize').textContent = data.width + '×' + data.height;
  $('#resultStyle').textContent = data.style;
  $('#resultFormat').textContent = (data.format || 'png') + (data.animation && data.animation !== 'none' ? ' / ' + data.animation + ' ' + (data.frames || '') + ' 帧' : '');
  $('#resultFont').textContent = data.font || '自动';
  $('#resultId').textContent = data.mediaRef ? (data.mediaRef + '（24 小时内有效）') : (data.galleryNote || '图库没接收，成品只落了本地文件');
  $('#download').href = data.url + '&download=1';
}
const PLATFORM_WIDTH = { qq: 512, wechat: 240, telegram: 512, discord: 320 };
$('#platform').onchange = () => {
  const width = PLATFORM_WIDTH[$('#platform').value];
  if (width) $('#width').value = width;
};
$('#make').onclick = async () => {
  if (state.busy) return;
  const text = $('#text').value.trim();
  if (!text) return ocMsg('先写一句字幕', true);
  if (!state.projectId && !state.sourceFile && state.tab === 'ai') {
    const ok = await aiDraw();
    if (!ok) return;
  }
  if (!state.projectId && !state.sourceFile) return ocMsg('先选一张参考图：上传 / 图库 ID / 让 AI 画一张', true);
  busy(true, '正在排字幕…');
  try {
    const body = renderBody();
    const data = state.projectId
      ? await post('${API_PROJECTS}', { action: 'render', id: state.projectId, ...body })
      : await post('${API_MAKE}', body);
    showResult(data);
    ocMsg('出好了' + (data.mediaRef ? '，已交图库作临时引用' : ''));
  } catch (error) {
    ocMsg('出图失败：' + error.message, true);
  } finally {
    busy(false);
  }
};
$('#compare').onclick = async () => {
  if (state.busy) return;
  if (!state.sourceFile) return ocMsg('先选一张参考图，再做四风格对比', true);
  const text = $('#text').value.trim();
  if (!text) return ocMsg('先写一句字幕', true);
  busy(true, '正在出四种版式…');
  try {
    const data = await post('${API_COMPARE}', { ...renderBody(), text });
    const grid = $('#compareGrid');
    grid.innerHTML = '';
    for (const item of data.items || []) {
      const cell = document.createElement('div');
      cell.style.cursor = 'pointer';
      const img = document.createElement('img');
      img.src = item.url + '&t=' + Date.now();
      img.alt = item.style;
      img.style.width = '100%';
      img.style.borderRadius = '8px';
      img.style.border = '1px solid var(--line)';
      const label = document.createElement('div');
      label.textContent = item.style;
      label.style.fontSize = '12px';
      label.style.color = 'var(--muted)';
      label.style.marginTop = '4px';
      cell.append(img, label);
      cell.onclick = () => { $('#style').value = item.style; ocMsg('已选 ' + item.style + '，点一键出图或保存项目'); };
      grid.appendChild(cell);
    }
    $('#compareResult').hidden = false;
    ocMsg('四种版式已出，点任意一张可切到对应样式');
  } catch (error) {
    ocMsg('对比失败：' + error.message, true);
  } finally {
    busy(false);
  }
};
$('#suggest').onclick = async () => {
  const btn = $('#suggest');
  btn.disabled = true;
  $('#suggestState').textContent = '正在想…';
  try {
    const data = await post('${API_SUGGEST}', {
      sourceFile: state.sourceFile,
      tone: $('#tone').value,
      hint: $('#hint').value.trim(),
      count: 8,
    });
    const chips = $('#suggestChips');
    chips.innerHTML = '';
    for (const text of data.captions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.onclick = () => { $('#text').value = text; ocMsg('已填入：' + text); };
      chips.appendChild(b);
    }
    $('#suggestState').textContent = data.source === 'local' ? '内置短语库' : '模型生成';
    if (data.note) ocMsg(data.note, true);
  } catch (error) {
    $('#suggestState').textContent = '';
    ocMsg('配文失败：' + error.message, true);
  } finally {
    btn.disabled = false;
  }
};
async function saveCurrentProject(inProjectCard) {
  const say = inProjectCard
    ? (t, bad) => { const el = $('#projectMsg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; }
    : ocMsg;
  if (!state.sourceFile) return say('先选一张参考图再保存项目', true);
  const name = $('#projectName').value.trim() || $('#text').value.trim() || '未命名表情包项目';
  try {
    const body = { action: 'save', name, ...renderBody(), texts: $('#batchTexts').value.split(/\\r?\\n/).map((x) => x.trim()).filter(Boolean) };
    const data = await post('${API_PROJECTS}', body);
    state.projectId = data.project.id;
    say('项目已保存：' + data.project.name);
    loadProjects();
  } catch (error) {
    say('保存项目失败：' + error.message, true);
  }
}
$('#saveProject').onclick = () => saveCurrentProject(false);
$('#projectSave').onclick = () => saveCurrentProject(true);
function paintTemplates(templates) {
  const select = $('#templateSelect');
  select.innerHTML = '';
  for (const t of templates || []) {
    const option = document.createElement('option');
    option.value = t.id;
    option.textContent = t.name;
    select.appendChild(option);
  }
  state.presets = { ...(state.presets || {}), templates: templates || [] };
}
function paintTones(tones) {
  const select = $('#tone');
  select.innerHTML = '';
  for (const [id, list] of Object.entries(tones || {})) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = (${JSON.stringify(TONE_LABELS)}[id] || id);
    select.appendChild(option);
  }
  state.presets = { ...(state.presets || {}), tones: tones || {} };
}
async function loadPresets() {
  try {
    const data = await post('${API_PRESETS}', {});
    state.presets = data.presets || data;
    paintTemplates(state.presets.templates);
    paintTones(state.presets.tones);
  } catch { /* ignore */ }
}
$('#presetExport').onclick = async () => {
  try {
    if (!state.presets) await loadPresets();
    const data = state.presets || {};
    const blob = new Blob([JSON.stringify({ tones: data.tones || {}, templates: data.templates || [] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'meme-presets.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    $('#presetMsg').textContent = '已导出';
  } catch (error) {
    $('#presetMsg').textContent = '导出失败：' + error.message;
  }
};
$('#applyTemplate').onclick = () => {
  const id = $('#templateSelect').value;
  const t = (state.presets?.templates || []).find((x) => x.id === id);
  if (!t) return ($('#presetMsg').textContent = '模板还没载入');
  $('#style').value = t.style || 'band';
  if (t.width) $('#width').value = t.width;
  const l = t.layout || {};
  for (const key of ['fontSize', 'lineHeight', 'margin', 'padding', 'maxLines', 'offsetX', 'offsetY', 'strokeWidth']) {
    if (l[key] !== undefined) $('#' + key).value = l[key];
  }
  if (l.align) $('#align').value = l.align;
  if (l.textColor) $('#textColor').value = l.textColor;
  if (l.bandColor) $('#bandColor').value = l.bandColor;
  if (l.strokeColor) $('#strokeColor').value = l.strokeColor;
  $('#shadow').checked = Boolean(l.shadow);
  $('#autoContrast').checked = l.autoContrast !== false;
  $('#presetMsg').textContent = '已套用：' + t.name;
};
$('#presetFile').onchange = async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    await post('${API_PRESETS}', { tones: raw.tones, templates: raw.templates });
    await loadPresets();
    $('#presetMsg').textContent = '已导入';
  } catch (error) {
    $('#presetMsg').textContent = '导入失败：' + error.message;
  } finally {
    event.target.value = '';
  }
};
$('#batchMake').onclick = async () => {
  if (state.busy) return;
  if (!state.sourceFile) return ocMsg('先选一张参考图，再批量出图', true);
  const texts = $('#batchTexts').value.split(/\\r?\\n/).map((x) => x.trim()).filter(Boolean);
  if (!texts.length) return ($('#batchMsg').textContent = '先写至少一条字幕');
  busy(true, '正在批量出图…');
  $('#batchState').textContent = '正在出图并打包…';
  try {
    const data = await post('${API_BATCH}', {
      sourceFile: state.sourceFile,
      texts,
      style: $('#batchStyle').value,
      width: Number($('#width').value),
      layout: layoutFromPage(),
      format: $('#batchFormat').value,
      animation: $('#animation').value,
      platform: $('#batchPlatform').value,
    });
    const box = $('#batchResult');
    box.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.style.gridTemplateColumns = 'repeat(4,minmax(0,1fr))';
    for (const item of data.items || []) {
      const cell = document.createElement('div');
      const img = document.createElement('img');
      img.src = item.url + '&t=' + Date.now();
      img.style.width = '100%';
      img.style.borderRadius = '8px';
      img.style.border = '1px solid var(--line)';
      const label = document.createElement('div');
      label.textContent = item.text + ' · ' + item.style;
      label.style.fontSize = '12px';
      label.style.color = 'var(--muted)';
      cell.append(img, label);
      grid.appendChild(cell);
    }
    box.appendChild(grid);
    const link = document.createElement('a');
    link.className = 'btn';
    link.href = data.zip.url;
    link.textContent = '下载整套 zip（' + (data.zip.bytes / 1024).toFixed(1) + ' KB）';
    link.style.marginTop = '12px';
    box.appendChild(link);
    $('#batchMsg').textContent = '已生成 ' + data.items.length + ' 张，zip 内含 manifest.json';
    $('#batchState').textContent = '';
  } catch (error) {
    $('#batchMsg').textContent = '批量失败：' + error.message;
  } finally {
    busy(false);
  }
};
async function loadProjects() {
  try {
    const data = await post('${API_PROJECTS}', { action: 'list' });
    const box = $('#projectList');
    box.innerHTML = '';
    if (!data.items.length) {
      box.innerHTML = '<p class="hint" style="margin:10px 0 0">还没有项目</p>';
      return;
    }
    for (const p of data.items) {
      const row = document.createElement('div');
      row.className = 'result';
      row.style.marginTop = '12px';
      row.style.paddingTop = '12px';
      const img = document.createElement('img');
      img.src = p.sourceUrl + '&t=' + Date.now();
      img.alt = p.name;
      img.style.maxWidth = '96px';
      img.style.maxHeight = '96px';
      const body = document.createElement('div');
      body.style.flex = '1';
      body.style.minWidth = '220px';
      const title = document.createElement('div');
      title.textContent = p.name;
      title.style.fontWeight = '600';
      const meta = document.createElement('div');
      meta.className = 'hint-inline';
      meta.textContent = [p.text, p.style, p.width + 'px', p.format, p.animation].filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'row';
      actions.style.marginTop = '8px';
      const open = document.createElement('button');
      open.textContent = '载入';
      open.onclick = () => {
        state.projectId = p.id;
        state.sourceFile = '';
        state.sourceUrl = p.sourceUrl;
        $('#source').hidden = false;
        $('#sourceImg').src = p.sourceUrl + '&t=' + Date.now();
        $('#sourceMeta').textContent = '项目：' + p.name;
        $('#text').value = p.text || '';
        $('#style').value = p.style || 'band';
        $('#width').value = p.width || 512;
        $('#format').value = p.format || 'png';
        $('#animation').value = p.animation || 'none';
        $('#platform').value = p.platform || 'custom';
        if (Array.isArray(p.texts) && p.texts.length) $('#batchTexts').value = p.texts.join('\\n');
        if (p.layout) {
          for (const key of ['fontSize', 'lineHeight', 'margin', 'padding', 'maxLines', 'offsetX', 'offsetY', 'strokeWidth']) {
            if (p.layout[key] !== undefined) $('#' + key).value = p.layout[key];
          }
          $('#align').value = p.layout.align || 'center';
          $('#shadow').checked = Boolean(p.layout.shadow);
          $('#autoContrast').checked = p.layout.autoContrast !== false;
        }
        ocMsg('已载入项目：' + p.name);
      };
      const render = document.createElement('button');
      render.textContent = '重出';
      render.onclick = async () => {
        try {
          const d = await post('${API_PROJECTS}', { action: 'render', id: p.id, text: $('#text').value.trim() || p.text, style: p.style, width: p.width, layout: p.layout, format: p.format, animation: p.animation, platform: p.platform });
          showResult(d);
          ocMsg('项目重出完成');
        } catch (e) { ocMsg('重出失败：' + e.message, true); }
      };
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除';
      del.onclick = async () => {
        if (!confirm('删除项目“' + p.name + '”？只删项目文件，不影响已生成的成品。')) return;
        try {
          await post('${API_PROJECTS}', { action: 'delete', id: p.id });
          if (state.projectId === p.id) { state.projectId = ''; }
          loadProjects();
        } catch (e) { ocMsg('删除失败：' + e.message, true); }
      };
      actions.append(open, render, del);
      body.append(title, meta, actions);
      row.append(img, body);
      box.appendChild(row);
    }
  } catch (error) {
    $('#projectList').textContent = '读取项目失败：' + error.message;
  }
}
$('#projectRefresh').onclick = loadProjects;
loadPresets();
loadProjects();
$('#clearSource').onclick = () => { state.projectId = ''; clearSource(); ocMsg('已清掉参考图，重新选一张'); };


checkModel();

$('#save').onclick = async () => {
  try {
    const body = {
      python: $('#python').value.trim(),
      font: $('#font').value.trim(),
      defaultStyle: $('#style2').value,
      defaultWidth: Number($('#width2').value),
      defaultFormat: $('#format2').value,
      defaultPlatform: $('#platform2').value,
      captionModel: $('#captionModel').value.trim(),
      allowedDirs: $('#allowedDirs').value.split(/\\r?\\n/).map((x) => x.trim()).filter(Boolean),
    };
    await post('${API_CONFIG}', body);
    msg('已保存');
  } catch (e) { msg('保存失败：' + e.message, true); }
};
$('#reset').onclick = () => {
  $('#python').value = '';
  $('#font').value = '';
  $('#style2').value = '${DEFAULT_STYLE}';
  $('#width2').value = '${DEFAULT_WIDTH}';
  $('#format2').value = 'png';
  $('#platform2').value = 'custom';
  $('#captionModel').value = '';
  msg('已恢复成默认（还没保存）');
};
$('#clear').onclick = async () => {
  if (!confirm('清空所有已生成的表情包和参考图？已经发出去的不受影响。')) return;
  try {
    const data = await post('${API_CLEAR}');
    msg('已清空 ' + data.removed + ' 个文件，释放 ' + (data.bytes / 1048576).toFixed(2) + ' MB');
  } catch (e) { msg('清空失败：' + e.message, true); }
};
</script>
</main></body></html>`;
}

export function apply(ctx: Context) {
  let studioBinding: any;
  const bindStudio = (binding: any) => {
    studioBinding = binding;
    chosenPython = null;
    const service = binding?.service;
    if (!service?.paths) return;
    Promise.resolve()
      .then(() => service.paths())
      .then((paths: any) => {
        studioPython = String(paths?.python ?? '').trim();
        studioOutDir = String(paths?.outDir ?? '').trim();
        chosenPython = null;
      })
      .catch(() => { /* 画室没给路径就继续用设置/PATH */ });
  };
  try {
    const service = (ctx as any).get?.('studio', false);
    if (service) bindStudio({ service, signal: ctx.signal });
  } catch { /* ignore */ }

  const describeBackend = (name: string, backend: any) => {
    const base = String(backend?.baseUrl ?? '').trim();
    if (name === 'comfy') return 'ComfyUI' + (base ? ' ' + base : '');
    if (name === 'sdwebui') return 'SD-WebUI' + (base ? ' ' + base : '');
    if (name === 'openai') return 'OpenAI 兼容' + (backend?.model ? ' · ' + backend.model : '');
    if (name === 'gemini') return 'Gemini' + (backend?.model ? ' · ' + backend.model : '');
    if (name === 'dashscope') return '通义万相' + (backend?.model ? ' · ' + backend.model : '');
    return name;
  };

  /** 出图前先确认画室里真的有能用的后端，别等生成了才报错。 */
  const checkImageModel = async () => {
    const service = studioBinding?.service;
    const settingsUrl = service ? '/plugins/studio/settings' : '';
    const fail = (message: string) => ({
      ok: false,
      backend: '',
      label: '',
      online: null,
      message,
      settingsUrl,
    });
    if (!service?.config) return fail('画室（studio）没接通；上传图片和图库两条路不受影响');
    let cfg: any;
    try {
      cfg = await service.config();
    } catch (error: any) {
      return fail('读不到画室配置：' + String(error?.message ?? error));
    }
    const backend = String(cfg?.defaultBackend || 'comfy').trim() || 'comfy';
    const backendCfg = cfg?.backends?.[backend];
    if (!backendCfg) return fail('画室里没有这个后端：' + backend);
    const label = describeBackend(backend, backendCfg);
    if (backendCfg.enabled === false) {
      return { ...fail(label + ' 没启用'), backend, label };
    }

    let probe: any = null;
    try {
      if (service.health) probe = await service.health(backend);
    } catch (error: any) {
      return { ...fail(label + ' 体检失败：' + String(error?.message ?? error)), backend, label };
    }
    if (probe?.online === false) {
      return {
        ...fail(label + ' 连不上：' + String(probe.reason || '连接被拒绝')),
        backend,
        label,
        detail: String(probe.reason || ''),
      };
    }
    if (probe?.online === null && !backendCfg.apiKey) {
      return { ...fail(label + ' 没填 API Key'), backend, label };
    }
    if (backend === 'comfy' && !String(backendCfg.workflow || '').trim()) {
      return { ...fail(label + ' 还没有选默认出图工作流'), backend, label };
    }

    return {
      ok: true,
      backend,
      label,
      online: probe?.online ?? null,
      version: probe?.version ?? '',
      device: probe?.device ?? '',
      message: label + ' 已配置',
      settingsUrl: '/plugins/studio/settings',
    };
  };

  /** 让画室画一张参考图：调用 studio 公开的 generate()，落成本插件的一份源图。 */
  const generateReference = async (input: any, signal: AbortSignal) => {
    const check = await checkImageModel();
    if (!check.ok) throw Error(check.message + '；先去画室设置页（' + check.settingsUrl + '）配置好');
    const service = studioBinding?.service;
    if (!service?.generate) throw Error('画室（studio）没接通：先到画室设置页配好出图后端，或者直接上传一张图');
    const prompt = String(input?.prompt ?? '').trim();
    if (!prompt) throw Error('请写一句画面描述');
    if (prompt.length > 800) throw Error('画面描述太长（最多 800 字）');
    const width = clampWidth(input?.width, 1024, 2048);
    const height = clampWidth(input?.height, 1024, 2048);
    const merged = studioBinding.signal ? AbortSignal.any([signal, studioBinding.signal]) : signal;
    const result = await service.generate(
      {
        prompt,
        negative: input?.negative ? String(input.negative) : undefined,
        width,
        height,
        n: 1,
        model: input?.model ? String(input.model) : undefined,
      },
      merged,
    );
    if (!result?.ok) throw Error(result?.error || '画室出图失败');
    const files = Array.isArray(result.files) ? result.files : [];
    const file = files.find((item: any) => item?.kind === 'image') ?? files[0];
    if (!file?.path || !existsSync(file.path)) throw Error('画室说画好了，但没拿到图片文件');
    const saved = saveSource(readFileSync(file.path));
    return {
      sourceFile: saved.name,
      sourceUrl: saved.url,
      bytes: saved.bytes,
      prompt,
      backend: result.backend ?? '',
      seed: result.seed ?? null,
      notes: result.notes ?? [],
    };
  };

  ctx.tools.register({
    name: 'studio_meme_make',
    description:
      '把一张图做成表情包：加底部字幕（band）、白气泡（bubble）、描边大字（plain）或顶部字幕（top）。' +
      '图可以从图库拿（sourceId，画室刚出的图返回值里就有）或给本地路径（sourcePath）。' +
      '做完会把成品作为临时引用交给图库并返回 mediaRef（24 小时内、只属于当前会话）；' +
      '要入库就调 gallery_collect（mediaRef 原样传，purposes=["meme"]）；装了 QQ 插件，收藏拿到 asset id 后再用 qq_send_gallery 发送。' +
      '字幕一条一句话、口语化，七八个字以内（"就这？""困成鱼干"），别在一张图里塞好几处字，越小越糊。' +
      '如果图里也要出现中文（招牌、贴纸上的字），先在 draw 的 prompt 里用中文引号写出来，' +
      '并说明"字很大、占画面宽度一半"，一句七八个字以内；字体排版要卡死的表情包靠这层字幕压字，' +
      '不要让模型直接在画面里写字，image_text 只是补充手段。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '图库资产 id（画室出图返回的 galleryId）' },
        sourcePath: { type: 'string', description: '本地图片路径；只接受插件输出目录、画室输出目录或用户在设置里允许的目录' },
        text: { type: 'string', minLength: 1, description: '表情包字幕，最多 120 字' },
        style: { type: 'string', enum: STYLES, description: 'band / bubble / plain / top / auto；默认 band' },
        width: { type: 'integer', description: '成品宽度，默认 512，范围 128–1600' },
        layout: LAYOUT_SCHEMA,
        format: { type: 'string', enum: FORMATS, description: 'png / webp / gif；默认 png' },
        animation: { type: 'string', enum: ANIMATIONS, description: 'none / pop / shake / zoom；非 none 时输出 gif' },
        platform: { type: 'string', enum: Object.keys(PLATFORMS), description: '平台尺寸预设；custom 用 width' },
        fps: { type: 'integer', minimum: 4, maximum: 24 },
        duration: { type: 'number', minimum: 0.6, maximum: 4 },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'webp 质量，默认 88' },
        collect: { type: 'boolean', description: '出图后直接调用 gallery_collect 入库；默认 false，只给 mediaRef' },
        send: { type: 'boolean', description: '收藏后直接发 QQ；需要 userId 和 full 权限' },
        userId: { type: 'string', description: 'QQ 好友 QQ 号；仅在 send=true 时需要' },
        actionId: { type: 'string', description: 'QQ 发送的稳定 actionId；省略自动生成' },
        description: { type: 'string', description: '入库到图库时的描述，省略就用字幕' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args: any, session: any) {
      const one = await renderOne(ctx, args, session, 1);
      const delivery = await collectAndMaybeSend(ctx, one, args, session);
      return {
        status: 'ok',
        mediaRef: one.mediaRef,
        mediaRefExpiresInSeconds: one.mediaRefExpiresInSeconds,
        galleryNote: one.galleryNote,
        file: one.file,
        url: one.url,
        size: one.width + 'x' + one.height,
        style: one.style,
        format: one.format,
        animation: one.animation,
        frames: one.frames,
        fontSize: one.fontSize,
        collected: delivery.collected,
        sent: delivery.sent,
        deliveryNote: delivery.note,
        sendHint: one.mediaRef ? SEND_HINT(one.mediaRef, Boolean((ctx as any).get?.('qq', false))) : one.galleryNote || '成品只在本地，没有可发给图库的引用。',
      };
    },
  });

  ctx.tools.register({
    name: 'studio_meme_set',
    description:
      '同一张原图做一整套表情包：给一组字幕，每条出一张，全部交给图库作临时引用（mediaRef，24 小时有效）。' +
      '适合 "给她做一套表情包" —— 字幕按情绪排：开心、生气、困、无语、干饭。最多 8 条。' +
      '每条一句话、七八个字以内，别塞长句；图里要带中文的规则和 studio_meme_make 一样：字写进 draw 的 prompt 并用中文引号括住、说明大小，精确排版靠字幕层压字。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '图库图片 id' },
        sourcePath: { type: 'string', description: '本地图片路径（限插件输出目录、画室输出目录或设置里允许的目录）' },
        texts: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: '每条一个字幕，最多 8 条',
        },
        style: { type: 'string', enum: STYLES, description: '默认 band' },
        width: { type: 'integer', description: '默认 512' },
        layout: LAYOUT_SCHEMA,
        format: { type: 'string', enum: FORMATS, description: 'png / webp / gif' },
        animation: { type: 'string', enum: ANIMATIONS, description: 'none / pop / shake / zoom' },
        platform: { type: 'string', enum: Object.keys(PLATFORMS), description: '平台尺寸预设' },
        fps: { type: 'integer', minimum: 4, maximum: 24 },
        duration: { type: 'number', minimum: 0.6, maximum: 4 },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        description: { type: 'string', description: '入库描述前缀，省略用字幕' },
      },
      required: ['texts'],
      additionalProperties: false,
    },
    async run(args: any, session: any) {
      const texts = Array.isArray(args?.texts) ? args.texts : [];
      if (!texts.length) return { status: 'error', error: 'texts 不能为空' };
      if (texts.length > 8) return { status: 'error', error: '一次最多 8 张' };
      const items: any[] = [];
      const errors: any[] = [];
      for (let i = 0; i < texts.length; i++) {
        try {
          const one = await renderOne(
            ctx,
            { ...args, text: texts[i], description: args?.description ? args.description + '：' + texts[i] : '' },
            session,
            i + 1,
          );
          items.push({
            text: texts[i],
            mediaRef: one.mediaRef,
            galleryNote: one.galleryNote,
            url: one.url,
            file: one.file,
            style: one.style,
            format: one.format,
            animation: one.animation,
          });
        } catch (error: any) {
          errors.push({ text: texts[i], error: error?.message ?? String(error) });
        }
      }
      const first = items.find((x) => x.mediaRef);
      return {
        status: items.length ? 'ok' : 'error',
        count: items.length,
        failed: errors.length,
        items,
        errors,
        sendHint: first?.mediaRef ? SEND_HINT(first.mediaRef, Boolean((ctx as any).get?.('qq', false))) : (items[0]?.galleryNote || '成品只在本地，没有可发给图库的引用。'),
      };
    },
  });

  ctx.tools.register({
    name: 'studio_meme_batch',
    description:
      '同一张原图批量出整套表情包：一行一条字幕，最多 24 张；可指定一种样式，或传 styles 数组一次对比 band/bubble/plain/top。' +
      '出完后打包成 zip，返回每张的本地 URL、尺寸和压缩包下载链接。适合“做一整套表情包”“四版式各来一张”。' +
      '字幕规则：一条一句话、七八个字以内，别塞长句。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '图库图片 id' },
        sourcePath: { type: 'string', description: '本地图片路径（限插件输出目录、画室输出目录或设置里允许的目录）' },
        texts: { type: 'array', items: { type: 'string', minLength: 1 }, description: '每条一个字幕，最多 24 条' },
        style: { type: 'string', enum: STYLES, description: '单一样式，默认 band' },
        styles: { type: 'array', items: { type: 'string', enum: STYLES }, description: '可选：一次出多种版式，总数不超过 24' },
        width: { type: 'integer', description: '成品宽度' },
        layout: LAYOUT_SCHEMA,
        format: { type: 'string', enum: FORMATS },
        animation: { type: 'string', enum: ANIMATIONS },
        platform: { type: 'string', enum: Object.keys(PLATFORMS) },
        fps: { type: 'integer', minimum: 4, maximum: 24 },
        duration: { type: 'number', minimum: 0.6, maximum: 4 },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['texts'],
      additionalProperties: false,
    },
    async run(args: any, session: any) {
      let bytes: Buffer;
      if (args?.sourceId) {
        const gallery = (ctx as any).get?.('gallery', false);
        if (!gallery?.readMedia) throw Error('图库没接通，不能按 id 取图');
        bytes = Buffer.from((await gallery.readMedia(String(args.sourceId), { signal: session?.signal }))?.base64 ?? '', 'base64');
      } else if (args?.sourcePath) {
        const full = allowedPath(String(args.sourcePath));
        if (!full) throw Error('sourcePath 只能指向插件输出目录、画室输出目录或设置里允许的目录');
        bytes = readFileSync(full);
      } else {
        throw Error('要给图：sourceId 或 sourcePath');
      }
      const saved = saveSource(bytes);
      const result = await renderBatch(ctx, { ...args, sourceFile: saved.name }, session);
      return { status: 'ok', count: result.items.length, ...result };
    },
  });

  ctx.tools.register({
    name: 'studio_meme_suggest',
    description:
      '给表情包配文：可按语气（wry 阴阳 / speechless 无语 / cute 可爱 / work 职场 / happy 开心 / angry 生气 / tired 累 / food 干饭）出短句候选。' +
      '如果配置了文案模型，会结合图片内容生成；没有模型就用内置短语库。每条候选都控制在短句范围，可直接挑一条交给 studio_meme_make。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '图库图片 id，可选；不给就只按语气出候选' },
        sourcePath: { type: 'string', description: '本地图片路径，可选' },
        tone: { type: 'string', description: '语气 id，默认 wry' },
        hint: { type: 'string', description: '方向提示，例如“被老板催稿”' },
        count: { type: 'integer', minimum: 1, maximum: 12, description: '候选数量，默认 6' },
      },
      additionalProperties: false,
    },
    async run(args: any, session: any) {
      let sourceFile = '';
      if (args?.sourceId) {
        const gallery = (ctx as any).get?.('gallery', false);
        if (!gallery?.readMedia) throw Error('图库没接通，不能按 id 取图');
        const media = await gallery.readMedia(String(args.sourceId), { signal: session?.signal });
        sourceFile = saveSource(Buffer.from(String(media?.base64 ?? ''), 'base64')).name;
      } else if (args?.sourcePath) {
        const full = allowedPath(String(args.sourcePath));
        if (!full) throw Error('sourcePath 只能指向插件输出目录、画室输出目录或设置里允许的目录');
        sourceFile = saveSource(readFileSync(full)).name;
      }
      const result = await suggestCaptions(ctx, { ...args, sourceFile }, session);
      return { status: 'ok', ...result, sourceFile };
    },
  });

  ctx.tools.register({
    name: 'studio_meme_project',
    description:
      '表情包项目：把底图、字幕、样式、精确排版、格式和动效存成一个项目，之后可反复改字重出。' +
      'action=list/save/get/update/delete/render；save 需要 sourceId 或 sourcePath，render 用 id 和可选新字幕。',
    danger: 'ask',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'get', 'update', 'delete', 'render'] },
        id: { type: 'string', description: '项目 id' },
        name: { type: 'string', description: '项目名' },
        sourceId: { type: 'string', description: '图库图片 id（save 时用）' },
        sourcePath: { type: 'string', description: '本地图片路径（save 时用）' },
        text: { type: 'string', description: '字幕' },
        texts: { type: 'array', items: { type: 'string' }, description: '批量字幕' },
        style: { type: 'string', enum: STYLES },
        width: { type: 'integer' },
        layout: LAYOUT_SCHEMA,
        format: { type: 'string', enum: FORMATS },
        animation: { type: 'string', enum: ANIMATIONS },
        platform: { type: 'string', enum: Object.keys(PLATFORMS) },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args: any, session: any) {
      const action = String(args?.action ?? '').trim();
      if (action === 'list') return { status: 'ok', items: listProjects() };
      if (action === 'get') {
        const project = projectPublic(projectData(String(args?.id ?? '')));
        if (!project) throw Error('项目不存在');
        return { status: 'ok', project };
      }
      if (action === 'delete') {
        deleteProject(String(args?.id ?? ''));
        return { status: 'ok' };
      }
      if (action === 'update') {
        return { status: 'ok', project: updateProject(String(args?.id ?? ''), args) };
      }
      if (action === 'save') {
        let sourceFile = '';
        if (args?.sourceId) {
          const gallery = (ctx as any).get?.('gallery', false);
          if (!gallery?.readMedia) throw Error('图库没接通，不能按 id 取图');
          const media = await gallery.readMedia(String(args.sourceId), { signal: session?.signal });
          sourceFile = saveSource(Buffer.from(String(media?.base64 ?? ''), 'base64')).name;
        } else if (args?.sourcePath) {
          const full = allowedPath(String(args.sourcePath));
          if (!full) throw Error('sourcePath 只能指向插件输出目录、画室输出目录或设置里允许的目录');
          sourceFile = saveSource(readFileSync(full)).name;
        }
        if (!sourceFile) throw Error('save 需要 sourceId 或 sourcePath');
        return { status: 'ok', project: saveProject({ ...args, sourceFile }) };
      }
      if (action === 'render') {
        const src = projectSource(String(args?.id ?? ''));
        if (!src) throw Error('项目或源图不存在');
        const data = src.data;
        const merged = { ...data, ...args, text: args?.text ?? data.text };
        const text = String(merged.text ?? '').trim();
        if (!text) throw Error('项目还没有字幕');
        const one = await renderBytes(ctx, merged, session, 1, readFileSync(src.file), true);
        return { status: 'ok', ...one, project: projectPublic(data) };
      }
      throw Error('action 只能是 list / save / get / update / delete / render');
    },
  });

  ctx.web.page(PAGE, async (_req: any, res: any) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderPage(ctx, Boolean(studioBinding?.service)));
  }, { title: '表情包工坊', settings: true, navigation: true });

  /** 给设置页预览 / 下载成品和参考图，只放 data/out 里 meme-* 的文件。 */
  ctx.web.page(PAGE_OUT, async (req: any, res: any) => {
    try {
      const url = new URL(String(req.url ?? '/'), 'http://local');
      const file = servedPathOf(String(url.searchParams.get('name') ?? ''));
      if (!file) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('没有这张图');
        return;
      }
      const ext = (file.match(/\.[a-z]+$/i)?.[0] ?? '.png').toLowerCase();
      const bytes = readFileSync(file);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Disposition',
        (url.searchParams.get('download') ? 'attachment' : 'inline') + '; filename="' + basename(file) + '"',
      );
      res.end(bytes);
    } catch (error: any) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('读图失败');
    }
  });

  /** 给设置页用的模型体检：不生成图，只看画室当前后端能不能用。 */
  ctx.web.api(API_MODEL, async (_req: any, res: any) => {
    const check = await checkImageModel();
    sendJson(res, 200, check);
  });

  /** 一键出图的第一步：上传 / 图库 / 让画室画，统一落成一份源图。 */
  ctx.web.api(API_SOURCE, async (req: any, res: any, { signal }: any) => {
    try {
      const body = await readBody(req, signal, MAX_IMAGE_JSON);
      const type = String(body?.type ?? '').trim();
      if (type === 'ai') {
        const generated = await generateReference(body, signal);
        return sendJson(res, 200, { ok: true, ...generated });
      }

      let bytes: Buffer;
      if (type === 'gallery') {
        const gallery = (ctx as any).get?.('gallery', false);
        if (!gallery?.readMedia) throw Error('图库没接通，取不到这张图');
        const id = String(body?.galleryId ?? '').trim();
        if (!id) throw Error('要给图库图片 ID');
        const media = await gallery.readMedia(id, { signal });
        bytes = Buffer.from(String(media?.base64 ?? ''), 'base64');
        if (!bytes.length) throw Error('图库返回空图片');
      } else if (type === 'upload') {
        const base64 = String(body?.base64 ?? '').replace(/^data:[^,]*;base64,/i, '').trim();
        if (!base64) throw Error('没有收到图片');
        bytes = Buffer.from(base64, 'base64');
        if (!bytes.length) throw Error('图片编码无效');
      } else {
        throw Error('type 只能是 upload / gallery / ai');
      }

      const saved = saveSource(bytes);
      sendJson(res, 200, {
        ok: true,
        sourceFile: saved.name,
        sourceUrl: saved.url,
        mime: saved.mime,
        bytes: saved.bytes,
      });
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  /** 一键出图的第二步：拿源图名字 + 字幕，直接渲染并入库。 */
  ctx.web.api(API_MAKE, async (req: any, res: any, { signal }: any) => {
    try {
      const body = await readBody(req, signal);
      const text = String(body?.text ?? '').trim();
      if (!text) throw Error('字幕不能为空');
      if (text.length > 120) throw Error('字幕太长（最多 120 字），做表情包要短');
      const sourceFile = String(body?.sourceFile ?? '').trim();
      if (!sourceFile) throw Error('先选一张参考图：上传 / 图库 / 让 AI 画');
      const file = sourcePathOf(sourceFile);
      if (!file) throw Error('参考图不见了，重新选一张');
      const cfg = await (ctx as any).config.read('config.json').catch(() => ({}));
      const style = STYLES.includes(String(body?.style)) ? String(body.style) : defaultStyle(cfg);
      const width = clampWidth(body?.width, defaultWidth(cfg));
      const one = await renderBytes(
        ctx,
        {
          text,
          style: body?.style,
          width: body?.width,
          layout: body?.layout,
          format: body?.format,
          animation: body?.animation,
          platform: body?.platform,
          fps: body?.fps,
          duration: body?.duration,
          quality: body?.quality,
          description: String(body?.description ?? '').trim(),
        },
        { signal },
        1,
        readFileSync(file),
      );
      sendJson(res, 200, {
        ok: true,
        ...one,
        sendHint: one.mediaRef ? SEND_HINT(one.mediaRef, Boolean((ctx as any).get?.('qq', false))) : (one.galleryNote || '成品只在本地，没有可发给图库的引用。'),
      });
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  /** 同一张图一次出四种版式，供设置页对比选择。 */
  ctx.web.api(API_COMPARE, async (req: any, res: any, { signal }: any) => {
    try {
      const body = await readBody(req, signal);
      const source = sourcePathOf(String(body?.sourceFile ?? '').trim());
      if (!source) throw Error('先选一张参考图');
      const text = String(body?.text ?? '').trim();
      if (!text) throw Error('字幕不能为空');
      const bytes = readFileSync(source);
      const items: any[] = [];
      for (const style of ['band', 'bubble', 'plain', 'top']) {
        const one = await renderBytes(ctx, { ...body, text, style }, { signal }, items.length + 1, bytes, false);
        items.push({ style, url: one.url, name: one.name, width: one.width, height: one.height });
      }
      sendJson(res, 200, { ok: true, items });
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_BATCH, async (req: any, res: any, { signal }: any) => {
    try {
      const body = await readBody(req, signal);
      const result = await renderBatch(ctx, body, { signal });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_SUGGEST, async (req: any, res: any, { signal }: any) => {
    try {
      const body = await readBody(req, signal);
      const result = await suggestCaptions(ctx, body, { signal });
      sendJson(res, 200, result);
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_PROJECTS, async (req: any, res: any, { signal }: any) => {
    try {
      const body = req.method === 'GET' ? {} : await readBody(req, signal);
      const action = String(body?.action ?? (req.method === 'GET' ? 'list' : 'save')).trim();
      if (action === 'list') return sendJson(res, 200, { ok: true, items: listProjects() });
      if (action === 'save') return sendJson(res, 200, { ok: true, project: saveProject(body) });
      if (action === 'update') {
        const project = updateProject(String(body?.id ?? ''), body);
        return sendJson(res, 200, { ok: true, project });
      }
      if (action === 'delete') {
        deleteProject(String(body?.id ?? ''));
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'get') {
        const project = projectPublic(projectData(String(body?.id ?? '')));
        if (!project) throw Error('项目不存在');
        return sendJson(res, 200, { ok: true, project });
      }
      if (action === 'render') {
        const src = projectSource(String(body?.id ?? ''));
        if (!src) throw Error('项目或源图不存在');
        const data = src.data;
        const merged = {
          ...body,
          style: body?.style ?? data.style,
          width: body?.width ?? data.width,
          layout: body?.layout ?? data.layout,
          format: body?.format ?? data.format,
          animation: body?.animation ?? data.animation,
          platform: body?.platform ?? data.platform,
          text: body?.text ?? data.text,
        };
        const text = String(merged.text ?? '').trim();
        if (!text) throw Error('项目还没有字幕');
        const one = await renderBytes(ctx, merged, { signal }, 1, readFileSync(src.file), false);
        return sendJson(res, 200, { ok: true, ...one, project: projectPublic(data) });
      }
      throw Error('action 只能是 list / save / update / get / delete / render');
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.page(API_PROJECT_SRC, async (req: any, res: any) => {
    try {
      const url = new URL(String(req.url ?? '/'), 'http://local');
      const src = projectSource(String(url.searchParams.get('id') ?? ''));
      if (!src) {
        res.statusCode = 404;
        res.end('没有这个项目图片');
        return;
      }
      const ext = (src.name.match(/\.[a-z]+$/i)?.[0] ?? '.png').toLowerCase();
      const bytes = readFileSync(src.file);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(bytes);
    } catch {
      if (!res.headersSent) res.statusCode = 404;
      res.end('没有这个项目图片');
    }
  });

  /** 模板 / 文案词库：JSON 导入导出；只接受固定结构，不执行代码。 */
  ctx.web.api(API_PRESETS, async (req: any, res: any, { signal }: any) => {
    try {
      ensurePresetsFile();
      if (req.method === 'GET') {
        const presets = readPresets();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (String(new URL(String(req.url ?? '/'), 'http://local').searchParams.get('download') ?? '') === '1') {
          res.setHeader('Content-Disposition', 'attachment; filename="meme-presets.json"');
        }
        res.end(JSON.stringify(presets, null, 2));
        return;
      }
      const body = await readBody(req, signal);
      const current = readPresets();
      const next = normalizePresets({
        tones: body?.tones !== undefined ? body.tones : current.tones,
        templates: body?.templates !== undefined ? body.templates : current.templates,
      });
      writeFileSync(PRESETS_FILE, JSON.stringify(next, null, 2));
      sendJson(res, 200, { ok: true, presets: next });
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });


  ctx.web.api(API_CONFIG, async (req: any, res: any, { signal }: any) => {
    try {
      const patch = await readBody(req, signal);
      const next: any = { ...config() };
      if (patch?.python !== undefined) {
        const raw = String(patch.python ?? '').trim();
        if (raw && (!existsSync(raw) || !statSync(raw).isFile())) throw Error('这个 python 路径不存在：' + raw);
        next.python = raw;
        chosenPython = null;
      }
      if (patch?.font !== undefined) {
        const raw = String(patch.font ?? '').trim();
        if (raw) {
          if (!isAbsolute(raw)) throw Error('字体文件要填绝对路径：' + raw);
          if (!existsSync(raw) || !statSync(raw).isFile()) throw Error('字体文件不存在：' + raw);
          if (!/\.(ttf|ttc|otf|otc)$/i.test(raw)) throw Error('字体文件只支持 .ttf / .ttc / .otf / .otc：' + raw);
        }
        next.font = raw;
      }
      if (patch?.defaultStyle !== undefined) {
        if (!STYLES.includes(String(patch.defaultStyle))) throw Error('样式只能是 band / bubble / plain / top / auto');
        next.defaultStyle = String(patch.defaultStyle);
      }
      if (patch?.defaultWidth !== undefined) {
        const n = Number(patch.defaultWidth);
        if (!Number.isFinite(n) || n < 128 || n > 1600) throw Error('默认宽度要在 128–1600 之间');
        next.defaultWidth = Math.round(n);
      }
      if (patch?.defaultFormat !== undefined) {
        if (!FORMATS.includes(String(patch.defaultFormat))) throw Error('默认格式只能是 png / webp / gif');
        next.defaultFormat = String(patch.defaultFormat);
      }
      if (patch?.defaultPlatform !== undefined) {
        if (!PLATFORMS[String(patch.defaultPlatform)]) throw Error('默认平台不在支持列表里');
        next.defaultPlatform = String(patch.defaultPlatform);
      }
      if (patch?.captionModel !== undefined) {
        next.captionModel = String(patch.captionModel ?? '').trim().slice(0, 120);
      }
      if (patch?.defaultLayout !== undefined) {
        next.defaultLayout = layoutOf(patch.defaultLayout, {});
      }
      if (patch?.allowedDirs !== undefined) {
        const list = (Array.isArray(patch.allowedDirs) ? patch.allowedDirs : String(patch.allowedDirs ?? '').split(/\r?\n/))
          .map((x: any) => String(x ?? '').trim())
          .filter(Boolean);
        const checked: string[] = [];
        for (const raw of list) {
          if (!isAbsolute(raw)) throw Error('要填绝对路径：' + raw);
          if (!existsSync(raw) || !statSync(raw).isDirectory()) throw Error('目录不存在：' + raw);
          const full = resolve(raw);
          if (!checked.includes(full)) checked.push(full);
        }
        next.allowedDirs = checked;
      }
      await ctx.config.save('config.json', next);
      sendJson(res, 200, { ok: true, config: next, out: outStats() });
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_CLEAR, async (_req: any, res: any) => {
    try {
      let removed = 0;
      let bytes = 0;
      for (const [dir, pattern] of [[OUT_DIR, /^meme-.*\.(png|jpg|jpeg|webp|gif|zip)$/i], [TMP_DIR, /^meme-.*\.(img|json)$/i]] as const) {
        let names: string[] = [];
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (!pattern.test(name)) continue;
          const full = join(dir, name);
          try {
            bytes += statSync(full).size;
            unlinkSync(full);
            removed += 1;
          } catch { /* ignore */ }
        }
      }
      sendJson(res, 200, { ok: true, removed, bytes });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ensurePresetsFile();
  mkdirSync(PROJECTS_DIR, { recursive: true });
  ctx.logger.info('表情包工坊已加载', { python: pythonPath(), out: OUT_DIR, settings: PAGE });
}
