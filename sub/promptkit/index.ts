/*! 提示词小抄（promptkit）· 画室的子插件。
 *
 * 词库与补词逻辑常驻父插件（studio/lib/words.ts，经 ctx.provide('promptkit') 暴露）：
 * 这里只负责四个查词工具和设置页，配置写在自己的 data/config.json。
 * 画画子插件通过同一个服务在出图前自动补词。
 *
 * 词库是可选的：随包带一份示例词库（prompts.sample.json，CC0-1.0，可自由再分发），
 * 用户也可以导入自己的 data/prompts.json；两份都没有时页面给导入说明，不报 500。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'whalelife';
import { WORD_DEFAULT, WORD_KINDS, WORD_LANGS, type WordConfig, type WordEngine } from '../../lib/words.ts';

const PAGE = '/plugins/studio/promptkit/settings';
const API_CONFIG = '/plugins/studio/promptkit/config';
const API_RELOAD = '/plugins/studio/promptkit/reload';
const API_IMPORT = '/plugins/studio/promptkit/import';
const API_RESET = '/plugins/studio/promptkit/reset-library';
const API_SAMPLE = '/plugins/studio/promptkit/sample';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_FILE = join(HERE, 'assets', 'prompts.sample.json');
/** 旧版本把示例放在 data/ 下；官方包里 data 会被跳过，这里只做向后兼容 */
const SAMPLE_LEGACY = join(HERE, 'data', 'prompts.sample.json');

type LibraryInfo = {
  path: string;
  exists: boolean;
  sample: boolean;
  bytes: number;
  builtAt: string;
  categories: number;
  tags: number;
  broken: boolean;
};

type PageData = {
  config: WordConfig;
  stats: {
    categories: number;
    enabledCategories: number;
    tags: number;
    enabledTags: number;
    builtAt: string;
    autoEnrich: boolean;
    enrichKinds: string[];
    enrichLayers: string[];
    enrichCount: number;
  };
  categories: Array<{ id: string; name: string; count: number }>;
  builtAt: string;
  library: LibraryInfo;
};

const NO_LIBRARY_HINT =
  '词库还没准备好：打开「提示词小抄」设置页导入自己的词库，或直接用随包示例词库（assets/prompts.sample.json）。';

const KIND_LABEL: Record<string, string> = {
  draw: '画图 draw',
  selfie: '自拍 selfie',
  snapshot: '随手拍 snapshot',
  paint: '画一幅 paint',
};

function esc(text: any) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch],
  );
}

function json(res: any, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readBody(req: any, signal: AbortSignal, limit = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw Error(size > 1024 * 1024 ? '词库文件太大，上限 8MB' : '提交的内容太大');
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

function renderPage(data: PageData, notice = '') {
  const cfg = data.config;
  const s = data.stats;
  const lib = data.library;
  const libState = !lib || !lib.exists ? 'none' : lib.sample ? 'sample' : 'own';
  const libPath = lib?.path || 'data/prompts.json';
  const libSize = lib?.bytes ? `${(lib.bytes / 1024).toFixed(lib.bytes > 1024 * 1024 ? 0 : 1)} KB` : '—';
  const banner =
    libState === 'own'
      ? `<div class="banner ok">正在用你自己的词库：<code>${esc(libPath)}</code> · ${lib.tags} 条词 · ${libSize}</div>`
      : libState === 'sample'
        ? `<div class="banner info">现在用的是<b>随包示例词库</b>（${lib.tags} 条词，CC0-1.0，可自由再分发）。导入自己的词库会覆盖它，随时能再切回来。</div>`
        : `<div class="banner warn">还没找到词库。在下面「词库」卡片里导入一份，或确认安装包带了 <code>sub/promptkit/assets/prompts.sample.json</code>。四个查词工具和自动补词会先空着，画图本身不受影响。</div>`;
  const brokenHtml =
    lib?.broken && libState === 'sample'
      ? `<div class="banner warn">你自己的 <code>${esc(join(HERE, 'data', 'prompts.json'))}</code> 读不出来（不是合法 JSON 或没有可用词条），已经先回退到示例词库；重新导入一份就能覆盖。</div>`
      : '';
  const noticeHtml = notice ? `<div class="banner warn">${esc(notice)}</div>` : '';
  const off = new Set(cfg.disabledCategories);
  const layerSet = new Set(cfg.recipeLayers);
  const enrichSet = new Set(cfg.enrichLayers);
  const catRows = data.categories
    .map(
      (c) =>
        `<label class="check"><input type="checkbox" name="cat" value="${esc(c.id)}"${
          off.has(c.id) ? '' : ' checked'
        }><span>${esc(c.name)}<em>${c.count} 条</em></span></label>`,
    )
    .join('');
  const layerRows = data.categories
    .map(
      (c) =>
        `<label class="check"><input type="checkbox" name="layer" value="${esc(c.id)}"${
          layerSet.has(c.id) ? ' checked' : ''
        }><span>${esc(c.name)}<em>${esc(c.id)}</em></span></label>`,
    )
    .join('');
  const kindRows = WORD_KINDS.map(
    (kind) =>
      `<label class="check"><input type="checkbox" name="ekind" value="${kind}"${
        cfg.enrichKinds.includes(kind) ? ' checked' : ''
      }><span>${KIND_LABEL[kind]}<em>${kind}</em></span></label>`,
  ).join('');
  const enrichRows = data.categories
    .map(
      (c) =>
        `<label class="check${c.id === 'negative' ? ' disabled' : ''}"><input type="checkbox" name="elayer" value="${esc(
          c.id,
        )}"${enrichSet.has(c.id) ? ' checked' : ''}${c.id === 'negative' ? ' disabled' : ''}><span>${esc(
          c.name,
        )}<em>${esc(c.id)}</em></span></label>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>提示词小抄 · WhaleLife</title>
<style>
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}
body{margin:0;padding:32px 28px 36px}
main{max-width:880px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}
h1{font-size:27px;letter-spacing:-.5px;margin:0 0 4px;font-weight:650}
p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:18px 0}
h2{font-size:16px;margin:0 0 6px}
p.hint{margin:0 0 14px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px}
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%}
label.check{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:9px;color:var(--ink);cursor:pointer}
label.check input{width:auto}
label.check em{display:block;font-style:normal;font-size:12px;color:var(--muted)}
label.check.disabled{opacity:.45;cursor:not-allowed}
label.toggle{display:flex;align-items:center;gap:10px;padding:9px 0;color:var(--ink);cursor:pointer}
label.toggle input{width:auto}
.checks{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}
h3{font-size:13px;margin:18px 0 8px;color:var(--muted);font-weight:600}
.row{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}
button{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:500;width:130px}
#msg{min-height:22px;margin-top:12px;font-size:13px;color:var(--accent)}
#msg.bad{color:#b23c3c}
#libMsg{min-height:22px;margin-top:12px;font-size:13px;color:var(--accent)}
#libMsg.bad{color:#b23c3c}
.banner{padding:10px 14px;border:1px solid var(--line);border-radius:10px;margin:0 0 6px;font-size:13px;background:var(--paper)}
.banner code{font-size:12px}
.banner.ok{border-color:#b6dcd6;background:#eef8f6}
.banner.info{border-color:#cfdcea;background:#f1f6fb}
.banner.warn{border-color:#e8cfa2;background:#fdf7ea;color:#7a5a1e}
a.linkbtn{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);text-decoration:none}
@media(max-width:640px){.grid,.checks{grid-template-columns:1fr}}
</style></head><body><main>
<header><div><h1>提示词小抄</h1><p class="sub">${s.categories} 个分类 · ${s.tags} 条词 · 当前启用 ${s.enabledCategories} 个分类 / ${s.enabledTags} 条</p></div></header>
${banner}${brokenHtml}${noticeHtml}

<section class="card">
  <h2>词库</h2>
  <p class="hint">四个查词工具（<code>prompt_categories / prompt_search / prompt_pick / prompt_recipe</code>）和出图前的「自动补词」都读这份词库；不装词库也能画图、拍视频，只是没有这些现成的词。随包的示例词库是自撰的通用词（CC0-1.0，可自由再分发），够跑通流程；换成自己的词库直接覆盖即可，原始私有词库不用进仓库。</p>
  <table>
    <tr><th>当前来源</th><td>${libState === 'own' ? '你自己的词库' : libState === 'sample' ? '随包示例词库' : '还没有词库'}</td></tr>
    <tr><th>文件</th><td><code>${esc(libPath)}</code></td></tr>
    <tr><th>构建时间</th><td>${esc(lib?.builtAt || '未知')} · ${libSize}</td></tr>
    <tr><th>词条</th><td>${lib?.tags ?? 0} 条 · ${lib?.categories ?? 0} 个分类</td></tr>
  </table>
  <h3>导入自己的词库</h3>
  <p class="hint">选一个 JSON 文件（上限 8MB），导入后写到 <code>sub/promptkit/data/prompts.json</code>，立即生效。也可以直接把这个文件放进该目录，再点「重新载入数据」。</p>
  <div class="row" style="margin-top:8px">
    <input type="file" id="libFile" accept=".json,application/json" style="max-width:340px">
    <button class="primary" id="libImport">导入词库</button>
    <a class="linkbtn" href="${API_SAMPLE}" download="prompts.sample.json">下载示例词库</a>
    <button id="libReset">恢复示例词库</button>
  </div>
  <p class="hint" style="margin-top:12px">格式：<code>{"categories":[{"id":"lighting","name":"光影"}],"tags":[{"cat":"lighting","zh":"逆光","en":"backlight"}]}</code>。词库是从外部数据生成的，可以用 <code>node sub/promptkit/scripts/build-data.mjs</code> 按自己的源数据重建；随包示例词库不含成人内容。</p>
  <div id="libMsg"></div>
</section>

<section class="card">
  <h2>默认偏好</h2>
  <p class="hint">模型没指定参数时用这里的默认值，不影响手动传参。</p>
  <div class="grid">
    <label>默认语言
      <select id="lang">
        <option value="en"${cfg.lang === 'en' ? ' selected' : ''}>英文（画图模型最跟得住）</option>
        <option value="zh"${cfg.lang === 'zh' ? ' selected' : ''}>中文</option>
        <option value="both"${cfg.lang === 'both' ? ' selected' : ''}>中英都给</option>
      </select>
    </label>
    <label>默认挑词数量
      <input id="pickCount" type="number" min="1" max="8" step="1" value="${cfg.pickCount}">
    </label>
  </div>
</section>

<section class="card">
  <h2>生图自动补词</h2>
  <p class="hint">画室出图前先把正文里的中文词补成词库英文，再从勾选的层挑词接在后面；正文里已经有的词跳过。质量层只取「杰作 / 最佳质量 / 高分辨率」这类质量词，画风与分级词不会自动加。补完的词会写进出图结果的 notes。</p>
  <label class="toggle"><input type="checkbox" id="autoEnrich"${cfg.autoEnrich ? ' checked' : ''}><span>启用自动补词</span></label>
  <div class="grid" style="margin-top:10px">
    <label>每次最多补几个
      <input id="enrichCount" type="number" min="1" max="5" step="1" value="${cfg.enrichCount}">
    </label>
  </div>
  <h3>给哪些动作补</h3>
  <p class="hint">默认四个动作都补，但只补「质量与风格」里的质量词（杰作/最佳质量/高分辨率等）；自拍/随手拍/画一幅的构图和镜头不会被改。想要更多细节可以把光影、场景等层勾上，也可以单独关掉某个动作。</p>
  <div class="checks">${kindRows}</div>
  <h3>从哪些层补</h3>
  <p class="hint">负面词不参与自动补词；“负面”那一类已禁用选择。</p>
  <div class="checks">${enrichRows}</div>
</section>

<section class="card">
  <h2>启用的分类</h2>
  <p class="hint">取消勾选的分类不再出现在 <code>prompt_categories / prompt_search / prompt_pick</code> 里；数据文件不动，随时能勾回来。</p>
  <div class="checks">${catRows}</div>
</section>

<section class="card">
  <h2>随机配方用的层</h2>
  <p class="hint"><code>prompt_recipe</code> 只从勾选的层里各取一个词。场景和道具建议留给调用方，避免“室内 + 暴风雪”这种打架组合。</p>
  <div class="checks">${layerRows}</div>
</section>

<section class="card">
  <h2>数据</h2>
  <table>
    <tr><th>词库文件</th><td><code>${esc(libPath)}</code>${libState === 'sample' ? '（随包示例）' : ''}</td></tr>
    <tr><th>构建时间</th><td>${esc(s.builtAt || '未知')}</td></tr>
    <tr><th>词条</th><td>${s.tags} 条（启用 ${s.enabledTags} 条）</td></tr>
    <tr><th>来源</th><td>随包示例词库为自撰通用词（CC0-1.0）；自己的词库可以用 <code>node sub/promptkit/scripts/build-data.mjs</code> 重建</td></tr>
    <tr><th>自动补词</th><td>${s.autoEnrich ? '开' : '关'} · ${s.enrichKinds.join('、') || '无动作'} · ${s.enrichLayers.join('、') || '无层'} · 最多 ${s.enrichCount} 个</td></tr>
  </table>
  <div class="row">
    <button id="reload">重新载入数据</button>
    <button id="reset">恢复默认设置</button>
    <button class="primary" id="save">保存设置</button>
  </div>
  <div id="msg"></div>
</section>
<script>
const $ = (s) => document.querySelector(s);
const msg = (t, bad) => { const el = $('#msg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; };
const libMsg = (t, bad) => { const el = $('#libMsg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; };
const cats = () => Array.from(document.querySelectorAll('input[name=cat]'));
const layers = () => Array.from(document.querySelectorAll('input[name=layer]'));
const ekinds = () => Array.from(document.querySelectorAll('input[name=ekind]'));
const elayers = () => Array.from(document.querySelectorAll('input[name=elayer]'));
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
$('#save').onclick = async () => {
  try {
    const body = {
      lang: $('#lang').value,
      pickCount: Number($('#pickCount').value),
      disabledCategories: cats().filter((x) => !x.checked).map((x) => x.value),
      recipeLayers: layers().filter((x) => x.checked).map((x) => x.value),
      autoEnrich: $('#autoEnrich').checked,
      enrichKinds: ekinds().filter((x) => x.checked).map((x) => x.value),
      enrichLayers: elayers().filter((x) => x.checked && !x.disabled).map((x) => x.value),
      enrichCount: Number($('#enrichCount').value),
    };
    const data = await post('${API_CONFIG}', body);
    msg('已保存：启用 ' + data.stats.enabledCategories + ' 个分类 / ' + data.stats.enabledTags + ' 条词；自动补词 ' + (data.stats.autoEnrich ? '开' : '关'));
  } catch (e) { msg('保存失败：' + e.message, true); }
};
$('#reload').onclick = async () => {
  try {
    const data = await post('${API_RELOAD}');
    msg('已重新载入：' + data.stats.tags + ' 条词，' + data.stats.categories + ' 个分类');
  } catch (e) { msg('载入失败：' + e.message, true); }
};
$('#libImport').onclick = async () => {
  const file = $('#libFile').files && $('#libFile').files[0];
  if (!file) { libMsg('先在右边选一个 JSON 词库文件', true); return; }
  if (file.size > 8 * 1024 * 1024) { libMsg('文件太大，上限 8MB', true); return; }
  let text = '';
  try { text = await file.text(); } catch (e) { libMsg('读不了这个文件：' + e.message, true); return; }
  $('#libImport').disabled = true;
  try {
    const data = await post('${API_IMPORT}', { content: text });
    libMsg('已导入：' + data.library.tags + ' 条词 / ' + data.library.categories + ' 个分类');
    setTimeout(() => location.reload(), 500);
  } catch (e) { libMsg('导入失败：' + e.message, true); $('#libImport').disabled = false; }
};
$('#libReset').onclick = async () => {
  try {
    const data = await post('${API_RESET}');
    libMsg('已切回示例词库：' + data.library.tags + ' 条词');
    setTimeout(() => location.reload(), 400);
  } catch (e) { libMsg('操作失败：' + e.message, true); }
};
$('#reset').onclick = () => {
  $('#lang').value = '${WORD_DEFAULT.lang}';
  $('#pickCount').value = '${WORD_DEFAULT.pickCount}';
  $('#autoEnrich').checked = ${WORD_DEFAULT.autoEnrich ? 'true' : 'false'};
  $('#enrichCount').value = '${WORD_DEFAULT.enrichCount}';
  cats().forEach((x) => { x.checked = !${JSON.stringify(WORD_DEFAULT.disabledCategories)}.includes(x.value); });
  layers().forEach((x) => { x.checked = ${JSON.stringify(WORD_DEFAULT.recipeLayers)}.includes(x.value); });
  ekinds().forEach((x) => { x.checked = ${JSON.stringify(WORD_DEFAULT.enrichKinds)}.includes(x.value); });
  elayers().forEach((x) => { if (x.disabled) return; x.checked = ${JSON.stringify(WORD_DEFAULT.enrichLayers)}.includes(x.value); });
  msg('已恢复成默认（还没保存）');
};
</script>
</main></body></html>`;
}

function fallbackPageData(path: string): PageData {
  const cfg = WORD_DEFAULT;
  return {
    config: cfg,
    stats: {
      categories: 0,
      enabledCategories: 0,
      tags: 0,
      enabledTags: 0,
      builtAt: '',
      autoEnrich: cfg.autoEnrich,
      enrichKinds: cfg.enrichKinds.slice(),
      enrichLayers: cfg.enrichLayers.slice(),
      enrichCount: cfg.enrichCount,
    },
    categories: [],
    builtAt: '',
    library: { path, exists: false, sample: false, bytes: 0, builtAt: '', categories: 0, tags: 0, broken: false },
  };
}

export function apply(ctx: Context) {
  const engine = () => ctx.get('promptkit') as unknown as WordEngine | undefined;

  /** 页面用：服务没注册或词库读崩都抛，由调用方降级渲染。 */
  const loadPage = async (): Promise<PageData> => {
    const eng = engine();
    if (!eng) throw Error('词库服务没注册');
    return (await eng.pageData()) as PageData;
  };

  /** 工具用：没有词库就不硬跑，返回能照着做的说明。 */
  const guard = async (): Promise<{ status: 'error'; error: string } | null> => {
    const eng = engine();
    if (!eng) return { status: 'error', error: NO_LIBRARY_HINT };
    try {
      const lib = await eng.library();
      // 自己的词库坏了但示例能顶上时照样可用，页面横幅会提醒；两条路都没有才报错。
      if (!lib.tags) return { status: 'error', error: NO_LIBRARY_HINT };
    } catch {
      return { status: 'error', error: NO_LIBRARY_HINT };
    }
    return null;
  };

  ctx.tools.register({
    name: 'prompt_categories',
    description: '列出提示词小抄里当前启用的分类和词条数量。想按分类挑词先看这个。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const bad = await guard();
      if (bad) return bad;
      const list = await engine()!.categories();
      return { status: 'ok', total: list.reduce((sum, c) => sum + c.count, 0), categories: list };
    },
  });

  ctx.tools.register({
    name: 'prompt_search',
    description:
      '在提示词小抄里按关键词找词（中英都行）。找到的 en 值可以直接拼进 selfie 的 scene/mood 或 draw 的 prompt。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '关键词，例如 窗、笑、傍晚、window' },
        category: { type: 'string', description: '限定分类 id，可省略' },
        limit: { type: 'integer', description: '返回条数，默认 8，最多 20' },
        lang: { type: 'string', enum: WORD_LANGS, description: '省略时用设置里的默认语言' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args: any) {
      const bad = await guard();
      if (bad) return bad;
      return engine()!.search(args);
    },
  });

  ctx.tools.register({
    name: 'prompt_pick',
    description:
      '按分类随机挑几个词，用来给自拍/随手拍/画图加姿势、表情、构图、光影、场景、道具。' +
      '挑出来的 en 直接填进 selfie 的 scene/mood/outfit 或 draw 的 prompt；只补画面细节，不改她本人的长相和年龄设定。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '分类 id（prompt_categories 里的），省略则在启用的分类里随机' },
        count: { type: 'integer', description: '挑几个，省略用设置里的默认值，最多 8' },
        lang: { type: 'string', enum: WORD_LANGS, description: '省略时用设置里的默认语言' },
      },
      additionalProperties: false,
    },
    async run(args: any) {
      const bad = await guard();
      if (bad) return bad;
      return engine()!.pick(args);
    },
  });

  ctx.tools.register({
    name: 'prompt_recipe',
    description:
      '按设置里的配方层（默认 构图/光影/姿势/表情/风格 各一）拼一段随机画面描述。' +
      '场景和道具留给调用方指定，避免拼出"室内 + 暴风雪"这种打架的组合；不合场景的词自己删掉。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        lang: { type: 'string', enum: WORD_LANGS, description: '省略时用设置里的默认语言' },
        extra: { type: 'string', description: '额外要加进画面的词句，可省略' },
      },
      additionalProperties: false,
    },
    async run(args: any) {
      const bad = await guard();
      if (bad) return bad;
      return engine()!.recipe(args);
    },
  });

  ctx.web.page(PAGE, async (_req: any, res: any) => {
    let data: PageData;
    let notice = '';
    try {
      data = await loadPage();
    } catch (error: any) {
      // 词库缺失、引擎没注册、词库 JSON 坏了，都不该把设置页打成 500：降级渲染并给出导入入口。
      notice = `设置页数据没读到：${String(error?.message ?? error).slice(0, 200)}。下面的「词库」卡片可以导入一份 JSON 再试。`;
      ctx.logger.warn('提示词小抄设置页降级渲染', { error: String(error?.message ?? error) });
      data = fallbackPageData(join(HERE, 'data', 'prompts.json'));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderPage(data, notice));
  }, { title: '提示词小抄设置', settings: true, navigation: true });

  ctx.web.api(API_IMPORT, async (req: any, res: any, { signal }: any) => {
    try {
      const eng = engine();
      if (!eng) throw Error(NO_LIBRARY_HINT);
      const body = await readBody(req, signal, 8 * 1024 * 1024);
      const content = typeof body?.content === 'string' ? body.content : '';
      if (!content.trim()) throw Error('没有收到词库内容：请求体要是 {"content":"<JSON 文本>"}');
      const library = await eng.importLibrary(content);
      const data = (await eng.pageData()) as PageData;
      json(res, 200, { ok: true, library, stats: data.stats, categories: data.categories });
    } catch (error: any) {
      json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_RESET, async (_req: any, res: any) => {
    try {
      const eng = engine();
      if (!eng) throw Error(NO_LIBRARY_HINT);
      const library = await eng.resetLibrary();
      const data = (await eng.pageData()) as PageData;
      json(res, 200, { ok: true, library, stats: data.stats });
    } catch (error: any) {
      json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_SAMPLE, async (_req: any, res: any) => {
    try {
      const file = [SAMPLE_FILE, SAMPLE_LEGACY].find((path) => existsSync(path));
      if (!file) throw Error('missing');
      const raw = readFileSync(file, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="prompts.sample.json"');
      res.setHeader('Cache-Control', 'no-store');
      res.end(raw);
    } catch {
      json(res, 404, { ok: false, error: '安装包里没有示例词库（sub/promptkit/assets/prompts.sample.json）' });
    }
  });

  ctx.web.api(API_CONFIG, async (req: any, res: any, { signal }: any) => {
    try {
      const eng = engine();
      if (!eng) throw Error(NO_LIBRARY_HINT);
      const patch = await readBody(req, signal);
      const current = (await eng.pageData()) as PageData;
      const known = new Set(current.categories.map((c) => c.id));
      const next: WordConfig = { ...current.config };
      if (patch?.lang !== undefined) {
        if (!WORD_LANGS.includes(patch.lang)) throw Error('语言只能是 zh / en / both');
        next.lang = patch.lang;
      }
      if (patch?.pickCount !== undefined) {
        const n = Number(patch.pickCount);
        if (!Number.isFinite(n) || n < 1 || n > 8) throw Error('默认挑词数量要在 1–8 之间');
        next.pickCount = Math.round(n);
      }
      if (patch?.disabledCategories !== undefined) {
        if (!Array.isArray(patch.disabledCategories)) throw Error('disabledCategories 要给数组');
        next.disabledCategories = patch.disabledCategories.map(String).filter((id: string) => known.has(id));
      }
      if (patch?.recipeLayers !== undefined) {
        if (!Array.isArray(patch.recipeLayers)) throw Error('recipeLayers 要给数组');
        next.recipeLayers = patch.recipeLayers.map(String).filter((id: string) => known.has(id));
      }
      if (patch?.autoEnrich !== undefined) {
        if (typeof patch.autoEnrich !== 'boolean') throw Error('autoEnrich 只能是 true / false');
        next.autoEnrich = patch.autoEnrich;
      }
      if (patch?.enrichKinds !== undefined) {
        if (!Array.isArray(patch.enrichKinds)) throw Error('enrichKinds 要给数组');
        next.enrichKinds = patch.enrichKinds.map(String).filter((id: string) => (WORD_KINDS as readonly string[]).includes(id));
      }
      if (patch?.enrichLayers !== undefined) {
        if (!Array.isArray(patch.enrichLayers)) throw Error('enrichLayers 要给数组');
        next.enrichLayers = patch.enrichLayers.map(String).filter((id: string) => known.has(id) && id !== 'negative');
      }
      if (patch?.enrichCount !== undefined) {
        const n = Number(patch.enrichCount);
        if (!Number.isFinite(n) || n < 1 || n > 5) throw Error('自动补词数量要在 1–5 之间');
        next.enrichCount = Math.round(n);
      }
      await ctx.config.save('config.json', next);
      await eng.reload();
      const data = (await eng.pageData()) as PageData;
      json(res, 200, { ok: true, config: next, stats: data.stats, library: data.library });
    } catch (error: any) {
      json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_RELOAD, async (_req: any, res: any) => {
    try {
      const eng = engine();
      if (!eng) throw Error(NO_LIBRARY_HINT);
      await eng.reload();
      const data = (await eng.pageData()) as PageData;
      json(res, 200, { ok: true, stats: data.stats, library: data.library });
    } catch (error: any) {
      json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.logger.info('提示词小抄已加载', {
    settings: PAGE,
    note: '词库可选：自己的 data/prompts.json 优先，其次随包示例词库；画画子插件在出图前调用补词',
  });
}
