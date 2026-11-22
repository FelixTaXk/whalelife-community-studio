/*! 表情包工坊：字幕/气泡/描边 + 自动入库（meme 用途）。 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'whalelife';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(DIR, 'data', 'out');
const TMP_DIR = join(DIR, 'data', 'tmp');
const SCRIPT = join(DIR, 'tools', 'render_meme.py');

let studioPython = '';
let studioOutDir = '';

const STYLES = ['band', 'bubble', 'plain', 'top'];
const PAGE = '/plugins/studio/meme/settings';
const API_CONFIG = '/plugins/studio/meme/config';
const API_CLEAR = '/plugins/studio/meme/clear-out';
const API_SOURCE = '/plugins/studio/meme/source';
const API_MAKE = '/plugins/studio/meme/oneclick';
const API_MODEL = '/plugins/studio/meme/model-check';
const PAGE_OUT = '/plugins/studio/meme/out';
const DEFAULT_STYLE = 'band';
const DEFAULT_WIDTH = 512;
const MAX_JSON = 64 * 1024;
const MAX_IMAGE_JSON = 24 * 1024 * 1024;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const OUT_PATTERN = /^meme-(?!src-)[\w.-]+\.(png|jpg|jpeg|webp)$/i;
const SOURCE_PATTERN = /^meme-src-[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i;
const SERVED_PATTERN = /^meme-[\w.-]+\.(png|jpg|jpeg|webp|gif)$/i;
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function config(): any {
  try {
    return JSON.parse(readFileSync(join(DIR, 'data', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function defaultStyle(cfg: any) {
  return STYLES.includes(String(cfg.defaultStyle)) ? String(cfg.defaultStyle) : DEFAULT_STYLE;
}

function defaultWidth(cfg: any) {
  const n = Number(cfg.defaultWidth);
  return Number.isFinite(n) ? Math.min(1600, Math.max(256, Math.round(n))) : DEFAULT_WIDTH;
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
  return Math.min(max, Math.max(256, n));
}

function runPython(input: string, output: string, text: string, style: string, width: number, font: string, signal?: AbortSignal) {
  return new Promise<any>((resolvePromise, reject) => {
    const child = spawn(pythonPath(), [SCRIPT], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(Error('渲染超时（30 秒）'));
    }, 30_000);
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
    child.stdin.end(JSON.stringify({ input, output, text, style, width, font }));
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
async function renderBytes(ctx: any, args: any, session: any, index: number, bytes: Buffer) {
  const text = String(args?.text ?? '').trim();
  if (!text) throw Error('text 不能为空');
  if (text.length > 120) throw Error('字幕太长（最多 120 字），做表情包要短');
  const cfg = await (ctx as any).config.read('config.json').catch(() => ({}));
  const style = STYLES.includes(String(args?.style)) ? String(args.style) : defaultStyle(cfg);
  const width = clampWidth(args?.width, defaultWidth(cfg));
  const font = String(cfg.font || '').trim();
  const gallery = (ctx as any).get?.('gallery', false);

  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + index;
  const input = join(TMP_DIR, 'meme-' + stamp + '.img');
  const output = join(OUT_DIR, 'meme-' + stamp + '.png');
  writeFileSync(input, bytes);
  try {
    const result = await runPython(input, output, text, style, width, font, session.signal);
    const rendered = readFileSync(output);
    // 走图库公开的 offerMedia：只交临时引用（24 小时内、绑定当前会话），入库由 gallery_collect 决定
    let mediaRef: string | null = null;
    let mediaRefExpiresInSeconds: number | null = null;
    let galleryNote = '';
    const sessionId = String(session?.id ?? session?.sessionId ?? '').trim();
    if (!gallery?.offerMedia) {
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
      file: output,
      name: basename(output),
      url: PAGE_OUT + '?name=' + encodeURIComponent(basename(output)),
      width: result.width,
      height: result.height,
      font: result.font,
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
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${defaultStyle(cfg) === value ? ' selected' : ''}>${label}</option>`,
    )
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
    <label>成品宽度（256–1600）
      <input id="width" type="number" min="256" max="1600" step="1" value="${defaultWidth(cfg)}">
    </label>
  </div>
  <div class="chips">
    <button type="button" data-text="就这？">就这？</button>
    <button type="button" data-text="困成鱼干">困成鱼干</button>
    <button type="button" data-text="气死我了">气死我了</button>
    <button type="button" data-text="？？？">？？？</button>
  </div>

  <div class="row"><button type="button" class="primary" id="make">一键出图</button><span id="ocState" class="hint-inline"></span></div>
  <div id="ocMsg" class="msg"></div>

  <div class="result" id="result" hidden>
    <img id="resultImg" alt="成品">
    <div style="flex:1;min-width:240px">
      <table>
        <tr><th>成品</th><td id="resultName">—</td></tr>
        <tr><th>尺寸</th><td id="resultSize">—</td></tr>
        <tr><th>样式</th><td id="resultStyle">—</td></tr>
        <tr><th>字体</th><td id="resultFont">—</td></tr>
        <tr><th>图库引用</th><td id="resultId">—</td></tr>
      </table>
      <div class="row"><a class="btn" id="download" download>下载这张</a></div>
    </div>
  </div>
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
      </select>
    </label>
    <label>默认宽度（256–1600）
      <input id="width2" type="number" min="256" max="1600" step="1" value="${defaultWidth(cfg)}">
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
const state = { tab: 'upload', sourceFile: '', sourceUrl: '', busy: false, model: null };

function busy(flag, label) {
  state.busy = flag;
  $('#make').disabled = flag;
  $('#aiDraw').disabled = flag || !(state.model && state.model.ok);
  $('#loadGallery').disabled = flag;
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

function showResult(data) {
  $('#result').hidden = false;
  $('#resultImg').src = data.url + '&t=' + Date.now();
  $('#resultName').textContent = data.name;
  $('#resultSize').textContent = data.width + '×' + data.height;
  $('#resultStyle').textContent = data.style;
  $('#resultFont').textContent = data.font || '自动';
  $('#resultId').textContent = data.mediaRef ? (data.mediaRef + '（24 小时内有效）') : (data.galleryNote || '图库没接收，成品只落了本地文件');
  $('#download').href = data.url + '&download=1';
}
$('#make').onclick = async () => {
  if (state.busy) return;
  const text = $('#text').value.trim();
  if (!text) return ocMsg('先写一句字幕', true);
  if (!state.sourceFile && state.tab === 'ai') {
    const ok = await aiDraw();
    if (!ok) return;
  }
  if (!state.sourceFile) return ocMsg('先选一张参考图：上传 / 图库 ID / 让 AI 画一张', true);
  busy(true, '正在排字幕…');
  try {
    const data = await post('${API_MAKE}', {
      sourceFile: state.sourceFile,
      text: text,
      style: $('#style').value,
      width: Number($('#width').value),
    });
    showResult(data);
    ocMsg('出好了' + (data.mediaRef ? '，已交图库作临时引用' : ''));
  } catch (error) {
    ocMsg('出图失败：' + error.message, true);
  } finally {
    busy(false);
  }
};
$('#clearSource').onclick = () => { clearSource(); ocMsg('已清掉参考图，重新选一张'); };

checkModel();

$('#save').onclick = async () => {
  try {
    const body = { python: $('#python').value.trim(), font: $('#font').value.trim(), defaultStyle: $('#style2').value, defaultWidth: Number($('#width2').value), allowedDirs: $('#allowedDirs').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) };
    await post('${API_CONFIG}', body);
    msg('已保存');
  } catch (e) { msg('保存失败：' + e.message, true); }
};
$('#reset').onclick = () => {
  $('#python').value = '';
  $('#font').value = '';
  $('#style2').value = '${DEFAULT_STYLE}';
  $('#width2').value = '${DEFAULT_WIDTH}';
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
        style: { type: 'string', enum: STYLES, description: '默认 band' },
        width: { type: 'integer', description: '成品宽度，默认 512，范围 256–1600' },
        description: { type: 'string', description: '入库到图库时的描述，省略就用字幕' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args: any, session: any) {
      const one = await renderOne(ctx, args, session, 1);
      return {
        status: 'ok',
        mediaRef: one.mediaRef,
        mediaRefExpiresInSeconds: one.mediaRefExpiresInSeconds,
        galleryNote: one.galleryNote,
        file: one.file,
        url: one.url,
        size: one.width + 'x' + one.height,
        style: one.style,
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
          items.push({ text: texts[i], mediaRef: one.mediaRef, galleryNote: one.galleryNote, url: one.url, file: one.file });
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
        { text, style, width, description: String(body?.description ?? '').trim() },
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
        if (!STYLES.includes(String(patch.defaultStyle))) throw Error('样式只能是 band / bubble / plain / top');
        next.defaultStyle = String(patch.defaultStyle);
      }
      if (patch?.defaultWidth !== undefined) {
        const n = Number(patch.defaultWidth);
        if (!Number.isFinite(n) || n < 256 || n > 1600) throw Error('默认宽度要在 256–1600 之间');
        next.defaultWidth = Math.round(n);
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
      for (const [dir, pattern] of [[OUT_DIR, /^meme-.*\.(png|jpg|jpeg|webp)$/i], [TMP_DIR, /^meme-.*\.img$/i]] as const) {
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

  ctx.logger.info('表情包工坊已加载', { python: pythonPath(), out: OUT_DIR, settings: PAGE });
}
