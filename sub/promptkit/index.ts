/*! 提示词小抄（promptkit）· 画室子插件。
 *
 * 词库引擎常驻父插件 studio/lib/words.ts，由父级 ctx.provide('promptkit') 暴露；
 * 这里只负责四个查词工具、一个设置页和导入接口；配置写在自己的 data/config.json。
 *
 * 词库是可选的：随包带一份示例词库（assets/prompts.sample.json，CC0-1.0，可自由再分发），
 * 用户也可以导入自己的 data/prompts.json；两份都没有时页面给导入说明，不报 500。
 *
 * 所有和具体作品/本机绑定的东西都走配置：词条字段名、负面/质量分类、成人前缀、动作白名单、
 * 质量词白名单、安全词正则、配方层。默认值只描述通用约定。
 *
 * NSFW：分类上带 nsfw / adult / role，或 id 命中配置的 nsfwPrefix。默认关闭，关闭时四个查词工具里
 * 看不到这些分类；打开需要用户在设置页确认一次（前端确认 + 服务端 acknowledgeNsfw 双保险），
 * 打开后页面常驻警告。自动补词永远不使用成人分类，不受这个开关影响。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'whalelife';
import {
  WORD_DEFAULT,
  WORD_LANG_MODES,
  type WordConfig,
  type WordEngine,
} from '../../lib/words.ts';

const PLUGIN_ID = 'promptkit';
const BASE = `/plugins/studio/${PLUGIN_ID}`;
const PAGE = `${BASE}/settings`;
const API_CONFIG = `${BASE}/config`;
const API_RELOAD = `${BASE}/reload`;
const API_IMPORT = `${BASE}/import`;
const API_RESET = `${BASE}/reset-library`;
const API_SAMPLE = `${BASE}/sample`;

const HERE = dirname(fileURLToPath(import.meta.url));
/** 默认用插件自己的 data/；测试或嵌入场景可以用环境变量指到别处。 */
const DATA_FILE = process.env.PROMPTKIT_DATA_FILE
  ? resolve(process.env.PROMPTKIT_DATA_FILE)
  : join(HERE, 'data', 'prompts.json');
const SAMPLE_FILE = process.env.PROMPTKIT_SAMPLE_FILE
  ? resolve(process.env.PROMPTKIT_SAMPLE_FILE)
  : join(HERE, 'assets', 'prompts.sample.json');
/** 旧版本把示例放在 data/ 下；官方包里 data 会被跳过，这里只做向后兼容 */
const SAMPLE_LEGACY = join(HERE, 'data', 'prompts.sample.json');

/** 打开 NSFW 开关时要展示的警告；页面横幅、确认框、服务端拒绝都用同一段话。 */
const NSFW_WARNING =
  '已打开成人分类：查词工具会返回成人内容词条。请确认你已满 18 岁，并自行遵守当地法律与发布平台规则；' +
  '不要用于违法、侵害他人或未经同意的内容。';

type LibraryInfo = {
  path: string;
  exists: boolean;
  sample: boolean;
  bytes: number;
  builtAt: string;
  categories: number;
  tags: number;
  nsfwCategories: number;
  nsfwTags: number;
  broken: boolean;
};

type PageData = {
  config: WordConfig;
  stats: {
    categories: number;
    enabledCategories: number;
    tags: number;
    enabledTags: number;
    nsfwCategories: number;
    nsfwTags: number;
    allowNsfw: boolean;
    builtAt: string;
    autoEnrich: boolean;
    enrichKinds: string[];
    enrichLayers: string[];
    enrichCount: number;
  };
  categories: Array<{ id: string; name: string; count: number; nsfw: boolean; negative: boolean; quality: boolean }>;
  builtAt: string;
  library: LibraryInfo;
  negative: { text: string; defaultText: string; count: number };
};

const NO_LIBRARY_HINT =
  '词库还没准备好：打开「提示词小抄」设置页导入自己的词库，或直接用随包示例词库（assets/prompts.sample.json）。';

function esc(text: any) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch],
  );
}

/** 往内联 <script> 里塞字符串：转义 `<`，避免词条里出现 `</script>` 把页面截断。 */
function jsString(value: any) {
  return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
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
  const libSize = lib?.bytes ? `${(lib.bytes / 1024).toFixed(lib.bytes > 1024 * 1024 ? 0 : 1)} KB` : '—';
  const banner =
    libState === 'sample'
      ? `<div class="banner info">现在用的是<b>随包示例词库</b>（${lib.tags} 条词，CC0-1.0，可自由再分发）。导入自己的词库会覆盖它，随时能再切回来。</div>`
      : libState === 'none'
        ? `<div class="banner warn">还没找到词库。在下面「词库」卡片里导入一份，或确认安装包带了 <code>assets/prompts.sample.json</code>。四个查词工具和自动补词会先空着，使用本插件的其他功能不受影响。</div>`
        : '';
  const brokenHtml =
    lib?.broken && libState === 'sample'
      ? `<div class="banner warn">你自己的 <code>${esc(lib.path)}</code> 读不出来（不是合法 JSON 或没有可用词条），已经先回退到示例词库；重新导入一份就能覆盖。</div>`
      : '';
  const noticeHtml = notice ? `<div class="banner warn">${esc(notice)}</div>` : '';
  const off = new Set(cfg.disabledCategories);
  const layerSet = new Set(cfg.recipeLayers);
  const enrichSet = new Set(cfg.enrichLayers);
  const nsfwCats = lib?.nsfwCategories ?? s.nsfwCategories ?? 0;
  const nsfwCount = lib?.nsfwTags ?? s.nsfwTags ?? 0;
  const nsfwHint = (nsfw: boolean) => (nsfw ? ' · 🔞 成人' : '');
  const catRows = data.categories
    .filter((c) => !c.negative)
    .map((c) => {
      const locked = c.nsfw && !cfg.allowNsfw;
      return `<label class="check${locked ? ' locked' : ''}"${locked ? ' hidden' : ''}><input type="checkbox" name="cat" value="${esc(
        c.id,
      )}"${off.has(c.id) ? '' : ' checked'}${locked ? ' disabled' : ''} data-nsfw="${c.nsfw ? '1' : '0'}"><span>${esc(
        c.name,
      )}<em>${c.count} 条${nsfwHint(c.nsfw)}</em></span></label>`;
    })
    .join('');
  const layerRows = data.categories
    .filter((c) => !c.negative)
    .map((c) => {
      const locked = c.nsfw && !cfg.allowNsfw;
      const why = nsfwHint(c.nsfw);
      return `<label class="check${locked ? ' locked' : ''}"${
        locked ? ' hidden' : ''
      }><input type="checkbox" name="layer" value="${esc(c.id)}"${layerSet.has(c.id) ? ' checked' : ''}${
        locked ? ' disabled' : ''
      } data-nsfw="${c.nsfw ? '1' : '0'}"><span>${esc(c.name)}<em>${esc(c.id)}${why}</em></span></label>`;
    })
    .join('');
  const enrichRows = data.categories
    .filter((c) => !c.negative)
    .map((c) => {
      const blocked = c.nsfw;
      const hidden = c.nsfw && !cfg.allowNsfw;
      const why = c.nsfw ? ' · 自动补词不用成人分类' : '';
      return `<label class="check${blocked ? ' disabled' : ''}"${hidden ? ' hidden' : ''}><input type="checkbox" name="elayer" value="${esc(
        c.id,
      )}"${enrichSet.has(c.id) ? ' checked' : ''}${blocked ? ' disabled' : ''} data-nsfw="${
        c.nsfw ? '1' : '0'
      }"><span>${esc(c.name)}<em>${esc(c.id)}${why}</em></span></label>`;
    })
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>提示词小抄 · WhaleLife</title>
<style>
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}
body{margin:0;padding:32px 28px 36px}
main{max-width:880px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}
h1{font-size:27px;letter-spacing:-.5px;margin:0 0 4px;font-weight:650}
p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:18px 0}
h2{font-size:16px;margin:0 0 6px}
p.hint{margin:0 0 14px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px;align-items:start}
label{display:grid;gap:6px;font-size:13px;color:var(--muted);min-width:0}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%;height:40px;min-width:0;box-sizing:border-box;line-height:1.5;vertical-align:middle}
textarea{min-height:92px;height:auto;resize:vertical;line-height:1.55}
input[type=checkbox],input[type=radio]{width:auto;height:auto}
select{cursor:pointer}
input[type=number]{font-variant-numeric:tabular-nums}
label.check{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:9px;color:var(--ink);cursor:pointer}
label.check input{width:auto;height:auto}
label.check em{display:block;font-style:normal;font-size:12px;color:var(--muted)}
label.check.disabled{opacity:.45;cursor:not-allowed}
label.toggle{display:flex;align-items:center;gap:10px;padding:9px 0;color:var(--ink);cursor:pointer}
label.toggle input{width:auto;height:auto}
.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
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
.banner.danger{border-color:#e2b4b4;background:#fdf0f0;color:#8a2b2b;font-weight:500}
label.check.locked{opacity:.5;cursor:not-allowed;border-style:dashed}
label.check[hidden]{display:none}
.adv{margin:28px 0 10px;text-align:center}
.adv a{color:var(--muted);font-size:12px;text-decoration:none;opacity:.45}
.adv a:hover{opacity:1;text-decoration:underline}
.nsfw-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px dashed var(--line);border-radius:10px;margin-top:10px}
.to-top{position:fixed;right:22px;bottom:22px;z-index:20;width:44px;height:44px;padding:0;display:grid;place-items:center;border-radius:50%;border:1px solid var(--line);background:var(--paper);color:var(--ink);box-shadow:0 8px 24px rgba(18,110,104,.16);font-size:20px;line-height:1;opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}
.to-top.show{opacity:1;transform:none;pointer-events:auto}
.to-top:hover{background:var(--soft)}
@media(max-width:640px){.grid,.checks{grid-template-columns:1fr}.to-top{right:14px;bottom:14px}}
</style></head><body><main>
<header><div><h1>提示词小抄设置</h1><p class="sub">${s.categories} 个分类 · ${s.tags} 条词 · 当前启用 ${s.enabledCategories} 个分类 / ${s.enabledTags} 条</p></div></header>
${banner}${brokenHtml}${noticeHtml}

<section class="card">
  <h2>词库</h2>
  <p class="hint">四个查词工具（<code>prompt_categories / prompt_search / prompt_pick / prompt_recipe</code>）和「自动补词」都读这份词库；没有词库也能使用本插件的其他功能，只是没有现成的词。随包的示例词库是自撰的通用词（CC0-1.0，可自由再分发），够跑通流程；换成自己的词库直接覆盖即可，原始私有词库不用进仓库。</p>
  <table>
    <tr><th>当前来源</th><td>${libState === 'own' ? '你自己的词库' : libState === 'sample' ? '随包示例词库' : '还没有词库'}</td></tr>
    <tr><th>文件</th><td><code>${esc(lib.path || 'data/prompts.json')}</code></td></tr>
    <tr><th>构建时间</th><td>${esc(lib?.builtAt || '未知')} · ${libSize}</td></tr>
    <tr><th>词条</th><td>${lib?.tags ?? 0} 条 · ${lib?.categories ?? 0} 个分类</td></tr>
  </table>
  <h3>导入自己的词库</h3>
  <p class="hint">选一个 JSON 文件（上限 8MB），导入后写到 <code>data/prompts.json</code>，立即生效。也可以直接把这个文件放进该目录，再点「重新载入数据」。</p>
  <div class="row" style="margin-top:8px">
    <input type="file" id="libFile" accept=".json,application/json" style="max-width:340px">
    <button class="primary" id="libImport">导入词库</button>
    <button id="libDownload">下载示例词库</button>
    <button id="libReset">恢复示例词库</button>
  </div>
  <p class="hint" style="margin-top:12px">格式：<code>{"categories":[{"id":"lighting","name":"光影"}],"tags":[{"cat":"lighting","zh":"逆光","en":"backlight"}]}</code>。字段名可以换，在「高级设置」里改主/副字段即可；词库可以从外部数据生成，见 <code>scripts/build-data.mjs</code>。随包示例词库不含成人内容。</p>
  <div id="libMsg"></div>
</section>

<section class="card">
  <h2>默认偏好</h2>
  <p class="hint">工具没指定参数时用这里的默认值，不影响手动传参。</p>
  <div class="grid">
    <label>默认语言
      <select id="lang">
        <option value="primary"${cfg.lang === 'primary' ? ' selected' : ''}>主字段（${esc(cfg.fields.primary)}）</option>
        <option value="secondary"${cfg.lang === 'secondary' ? ' selected' : ''}>副字段（${esc(cfg.fields.secondary)}）</option>
        <option value="both"${cfg.lang === 'both' ? ' selected' : ''}>两个都给</option>
      </select>
    </label>
    <label>默认挑词数量
      <input id="pickCount" type="number" min="1" max="8" step="1" value="${cfg.pickCount}">
    </label>
  </div>
</section>

<section class="card">
  <h2>自动补词</h2>
  <p class="hint">调用方在出图/生成前把正文交给本插件：先把正文里的副字段换成词库主字段，再从勾选的层挑词接在后面；正文里已经有的词跳过。补了什么会由调用方写进结果说明。自动补词默认关闭，需要在这里显式打开。</p>
  <label class="toggle"><input type="checkbox" id="autoEnrich"${cfg.autoEnrich ? ' checked' : ''}><span>启用自动补词</span></label>
  <div class="grid" style="margin-top:10px">
    <label>每次最多补几个
      <input id="enrichCount" type="number" min="1" max="5" step="1" value="${cfg.enrichCount}">
    </label>
    <label>动作白名单（逗号分隔，* 表示全部）
      <input id="enrichKinds" value="${esc(cfg.enrichKinds.join(', '))}" placeholder="*">
    </label>
  </div>
  <h3>从哪些层补</h3>
  <p class="hint">按勾选的层补词，正文里已经有的词会跳过。${
    cfg.allowNsfw ? '成人分类不参与自动补词（开关开着也只用于查词）。' : ''
  }</p>
  <div class="checks">${enrichRows}</div>
</section>

<section class="card">
  <h2>共用负面提示词</h2>
  <p class="hint">这里填的文字会作为调用方的<b>共用负面提示词</b>：调用时自己没传 <code>negative</code> 才用它，传了就以传的为准；留空表示不覆盖调用方自带的负面。词库里负面分类的 ${data.negative.count} 条词可以一键填进来，再自己删改。</p>
  <textarea id="negativePrompt" spellcheck="false" placeholder="low quality, blurry, watermark, ...">${esc(
    data.negative.text,
  )}</textarea>
  <div class="row" style="margin-top:12px">
    <button id="negFill">填入词库里的全部负面词</button>
  </div>
  <p class="hint" style="margin-top:10px">改完点页面最下面的「保存设置」才生效。</p>
</section>

<section class="card">
  <h2>启用的分类</h2>
  <p class="hint">取消勾选的分类不再出现在 <code>prompt_categories / prompt_search / prompt_pick</code> 里；数据文件不动，随时能勾回来。</p>
  <div class="checks">${catRows}</div>
</section>

<section class="card">
  <h2>随机配方用的层</h2>
  <p class="hint"><code>prompt_recipe</code> 从勾选的层里各取一个词；不勾任何层时按启用的分类兜底。最多生成 <input id="recipeMaxLayers" type="number" min="1" max="20" step="1" value="${cfg.recipeMaxLayers}" style="width:70px;display:inline-block;padding:4px 6px"> 层。场景和道具建议留给调用方，避免“室内 + 暴风雪”这种打架组合。</p>
  <div class="checks">${layerRows}</div>
</section>

<section class="card" id="advPanel" hidden>
  <h2>高级：字段与分类语义</h2>
  <p class="hint">这些是词库结构和分类含义的约定。换一份字段名或分类 id 不同的词库时改这里，不用改代码。</p>
  <div class="grid">
    <label>词条主字段 <input id="fieldPrimary" value="${esc(cfg.fields.primary)}" placeholder="en"></label>
    <label>词条副字段 <input id="fieldSecondary" value="${esc(cfg.fields.secondary)}" placeholder="zh"></label>
    <label>负面分类 id <input id="semNegative" value="${esc(cfg.semantics.negative)}" placeholder="negative"></label>
    <label>质量分类 id <input id="semQuality" value="${esc(cfg.semantics.quality)}" placeholder="quality"></label>
  </div>
  <label style="margin-top:12px">质量词白名单（逗号或换行分隔，留空=不额外收窄）
    <textarea id="qualityAllowlist" spellcheck="false" placeholder="masterpiece, best quality, highres">${esc(
      cfg.qualityAllowlist.join(', '),
    )}</textarea>
  </label>
  <label style="margin-top:12px">安全词正则（每行一条，留空=不额外过滤）
    <textarea id="blockedPatterns" spellcheck="false" placeholder="\\b(explicit|nsfw|nude)\\b">${esc(
      cfg.blockedPatterns.join('\n'),
    )}</textarea>
  </label>
</section>

<section class="card" id="nsfwCard">
  <h2>NSFW 设置</h2>
  <p class="hint">默认关闭。打开后才会显示成人分类、分类前缀和提示；自动补词永远不用成人分类。</p>
  <label class="toggle"><input type="checkbox" id="allowNsfw"${
    cfg.allowNsfw ? ' checked' : ''
  }><span>允许查词工具使用成人分类</span></label>
  <div id="nsfwDetails"${cfg.allowNsfw ? '' : ' hidden'}>
    <div class="grid" style="margin-top:12px">
      <label>成人分类 id 前缀 <input id="semNsfwPrefix" value="${esc(cfg.semantics.nsfwPrefix)}" placeholder="nsfw"></label>
      <label>词库里带 ${nsfwCats} 个成人分类 / ${nsfwCount} 条词</label>
    </div>
    <p class="hint" style="margin-top:10px">勾选后还要点页面最下面的「保存设置」才生效；关掉同样点保存。自动补词永远不用成人分类。</p>
    <div class="banner danger" id="nsfwWarn"${cfg.allowNsfw ? '' : ' hidden'}>🔞 ${esc(NSFW_WARNING)}</div>
  </div>
</section>

<section class="card">
  <h2>数据</h2>
  <table>
    <tr><th>词库文件</th><td><code>${esc(lib.path || 'data/prompts.json')}</code>${libState === 'sample' ? '（随包示例）' : ''}</td></tr>
    <tr><th>构建时间</th><td>${esc(s.builtAt || '未知')}</td></tr>
    <tr><th>词条</th><td>${s.tags} 条（启用 ${s.enabledTags} 条）</td></tr>
    <tr><th>来源</th><td>随包示例词库为自撰通用词（CC0-1.0）；自己的词库见 <code>scripts/build-data.mjs --source &lt;源词库&gt;</code></td></tr>
    <tr><th>自动补词</th><td>${s.autoEnrich ? '开' : '关'} · ${s.enrichKinds.join('、') || '无动作'} · ${s.enrichLayers.join('、') || '无层'} · 最多 ${s.enrichCount} 个</td></tr>
    <tr><th>共用负面</th><td>${data.negative.text ? `已设置（${data.negative.text.length} 字符）` : '没设置，用调用方自带的负面'}</td></tr>
  </table>
  <div class="row">
    <button id="reload">重新载入数据</button>
    <button id="reset">恢复默认设置</button>
    <button class="primary" id="save">保存设置</button>
  </div>
  <div id="msg"></div>
</section>

<p class="adv"><a href="#" id="advToggle">高级设置</a></p>
<button class="to-top" id="toTop" type="button" aria-label="回到顶部" title="回到顶部">↑</button>
<script>
const $ = (s) => document.querySelector(s);
const msg = (t, bad) => { const el = $('#msg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; };
const libMsg = (t, bad) => { const el = $('#libMsg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; };
const toTop = $('#toTop');
if (toTop) {
  const syncToTop = () => toTop.classList.toggle('show', window.scrollY > 260);
  toTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  window.addEventListener('scroll', syncToTop, { passive: true });
  syncToTop();
}
const cats = () => Array.from(document.querySelectorAll('input[name=cat]'));
const layers = () => Array.from(document.querySelectorAll('input[name=layer]'));
const elayers = () => Array.from(document.querySelectorAll('input[name=elayer]'));
const nsfwBox = $('#allowNsfw');
const nsfwDetails = $('#nsfwDetails');
const nsfwWarn = $('#nsfwWarn');
const negBox = $('#negativePrompt');
const NEG_DEFAULT = ${jsString(data.negative.defaultText)};
const NSFW_TEXT = ${jsString(NSFW_WARNING)};
const NSFW_COUNT = ${nsfwCount};
const DEFAULT = ${jsString(JSON.stringify(WORD_DEFAULT))};
const DEFAULTS = JSON.parse(DEFAULT);
// 总闸关着时，成人分类整行隐藏；保存时跳过它们，保留原来的状态。
function syncNsfw() {
  const on = Boolean(nsfwBox && nsfwBox.checked);
  if (nsfwDetails) nsfwDetails.hidden = !on;
  if (nsfwWarn) nsfwWarn.hidden = !on;
  document.querySelectorAll('input[data-nsfw="1"]').forEach((x) => {
    const label = x.closest('label');
    const isEnrich = x.name === 'elayer';
    if (label) {
      label.hidden = !on;
      label.classList.toggle('locked', !on && !isEnrich);
    }
    if (!isEnrich) x.disabled = !on;
  });
}
if (nsfwBox) {
  nsfwBox.onchange = () => {
    const ok = !nsfwBox.checked || window.confirm('开启后，查词工具会返回成人内容词条（共 ' + NSFW_COUNT + ' 条）。\\n\\n' + NSFW_TEXT + '\\n\\n确定要打开吗？');
    if (!ok) nsfwBox.checked = false;
    syncNsfw();
    msg(nsfwBox.checked ? '已勾选成人分类（还没保存）：点下面的「保存设置」后生效' : '已取消成人分类（还没保存）');
  };
}
syncNsfw();
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
const advToggle = $('#advToggle');
const advPanel = $('#advPanel');
if (advToggle && advPanel) {
  advToggle.onclick = (e) => {
    e.preventDefault();
    advPanel.hidden = !advPanel.hidden;
    if (!advPanel.hidden) advPanel.scrollIntoView({ block: 'nearest' });
  };
}
if ($('#negFill')) {
  $('#negFill').onclick = () => {
    if (!negBox) return;
    negBox.value = NEG_DEFAULT;
    msg('已填入词库里的全部负面词（还没保存）');
  };
}
function splitList(value) {
  return String(value || '').split(/[,，\\n]/).map((s) => s.trim()).filter(Boolean);
}
$('#save').onclick = async () => {
  try {
    const nsfw = Boolean(nsfwBox && nsfwBox.checked);
    const body = {
      lang: $('#lang').value,
      pickCount: Number($('#pickCount').value),
      disabledCategories: cats().filter((x) => !x.disabled && !x.checked).map((x) => x.value),
      recipeLayers: layers().filter((x) => x.checked).map((x) => x.value),
      recipeMaxLayers: Number($('#recipeMaxLayers').value),
      autoEnrich: $('#autoEnrich').checked,
      enrichKinds: splitList($('#enrichKinds').value),
      enrichLayers: elayers().filter((x) => x.checked && !x.disabled).map((x) => x.value),
      enrichCount: Number($('#enrichCount').value),
      negativePrompt: negBox ? negBox.value : '',
      allowNsfw: nsfw,
      acknowledgeNsfw: nsfw,
      fields: { primary: $('#fieldPrimary').value.trim(), secondary: $('#fieldSecondary').value.trim() },
      semantics: {
        negative: $('#semNegative').value.trim(),
        quality: $('#semQuality').value.trim(),
        nsfwPrefix: $('#semNsfwPrefix').value.trim(),
      },
      qualityAllowlist: splitList($('#qualityAllowlist').value),
      blockedPatterns: splitList($('#blockedPatterns').value),
    };
    const data = await post('${API_CONFIG}', body);
    msg('已保存：启用 ' + data.stats.enabledCategories + ' 个分类 / ' + data.stats.enabledTags + ' 条词；自动补词 ' + (data.stats.autoEnrich ? '开' : '关') + '；共用负面 ' + (body.negativePrompt.trim() ? '已设置' : '未设置'));
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
$('#libDownload').onclick = async () => {
  // 宿主的 web.api 只收 POST，直接 <a href> 发 GET 会 404；这里用页面内 POST 再自己存文件。
  try {
    const res = await fetch('${API_SAMPLE}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { throw new Error('返回的不是 JSON'); }
    if (!data || !Array.isArray(data.tags)) throw new Error(data && data.error ? data.error : '内容不对');
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prompts.sample.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    libMsg('已保存 prompts.sample.json（' + data.tags.length + ' 条词）');
  } catch (e) { libMsg('下载失败：' + e.message, true); }
};
$('#libReset').onclick = async () => {
  try {
    const data = await post('${API_RESET}');
    libMsg('已切回示例词库：' + data.library.tags + ' 条词');
    setTimeout(() => location.reload(), 400);
  } catch (e) { libMsg('操作失败：' + e.message, true); }
};
$('#reset').onclick = () => {
  $('#lang').value = DEFAULTS.lang;
  $('#pickCount').value = DEFAULTS.pickCount;
  $('#recipeMaxLayers').value = DEFAULTS.recipeMaxLayers;
  $('#autoEnrich').checked = DEFAULTS.autoEnrich;
  $('#enrichCount').value = DEFAULTS.enrichCount;
  $('#enrichKinds').value = DEFAULTS.enrichKinds.join(', ');
  $('#fieldPrimary').value = DEFAULTS.fields.primary;
  $('#fieldSecondary').value = DEFAULTS.fields.secondary;
  $('#semNegative').value = DEFAULTS.semantics.negative;
  $('#semQuality').value = DEFAULTS.semantics.quality;
  $('#semNsfwPrefix').value = DEFAULTS.semantics.nsfwPrefix;
  $('#qualityAllowlist').value = DEFAULTS.qualityAllowlist.join(', ');
  $('#blockedPatterns').value = DEFAULTS.blockedPatterns.join('\\n');
  if (nsfwBox) nsfwBox.checked = DEFAULTS.allowNsfw;
  if (negBox) negBox.value = DEFAULTS.negativePrompt;
  cats().forEach((x) => { x.checked = !DEFAULTS.disabledCategories.includes(x.value); });
  layers().forEach((x) => { x.checked = DEFAULTS.recipeLayers.includes(x.value); });
  elayers().forEach((x) => { if (!x.disabled) x.checked = DEFAULTS.enrichLayers.includes(x.value); });
  syncNsfw();
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
      nsfwCategories: 0,
      nsfwTags: 0,
      allowNsfw: cfg.allowNsfw,
      builtAt: '',
      autoEnrich: cfg.autoEnrich,
      enrichKinds: cfg.enrichKinds.slice(),
      enrichLayers: cfg.enrichLayers.slice(),
      enrichCount: cfg.enrichCount,
    },
    categories: [],
    builtAt: '',
    negative: { text: '', defaultText: '', count: 0 },
    library: {
      path,
      exists: false,
      sample: false,
      bytes: 0,
      builtAt: '',
      categories: 0,
      tags: 0,
      nsfwCategories: 0,
      nsfwTags: 0,
      broken: false,
    },
  };
}

export function apply(ctx: Context) {
  // 引擎由父插件 studio 在 apply() 里注册；子插件只负责工具与设置页。
  // 这样画画子插件和本设置页共享同一份词库，停用/卸载时由父级统一释放。
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

  /** 工具结果里附带「这次读的是哪份词库」。 */
  const libraryNote = async (): Promise<{ library?: unknown; notice?: string }> => {
    try {
      const lib = await engine()!.library();
      const parts: string[] = [];
      if (lib.broken) {
        parts.push('你自己的 data/prompts.json 读不出来（格式不对或没有可用词条），已回退到随包示例词库');
      } else if (lib.sample) {
        parts.push(`当前用的是随包示例词库（${lib.tags} 条），自己的词库还没导入`);
      }
      return { library: lib, ...(parts.length ? { notice: parts.join('；') } : {}) };
    } catch {
      return {};
    }
  };

  ctx.tools.register({
    name: 'prompt_categories',
    description:
      '列出提示词小抄里当前启用的分类和词条数量。想按分类挑词先看这个。' +
      '成人分类默认隐藏，要在设置页打开开关才会出现。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const bad = await guard();
      if (bad) return bad;
      const list = await engine()!.categories();
      return {
        status: 'ok',
        total: list.reduce((sum, c) => sum + c.count, 0),
        categories: list,
        ...(await libraryNote()),
      };
    },
  });

  ctx.tools.register({
    name: 'prompt_search',
    description:
      '在提示词小抄里按关键词找词，返回可直接拼进生成提示词的文本。' +
      '成人分类默认搜不到，需先在设置页打开开关。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '关键词，例如 窗、笑、傍晚、window' },
        category: { type: 'string', description: '限定分类 id，可省略' },
        limit: { type: 'integer', description: '返回条数，默认 8，最多 20' },
        lang: { type: 'string', enum: WORD_LANG_MODES, description: '省略时用设置里的默认语言' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args: any) {
      const bad = await guard();
      if (bad) return bad;
      const result = await engine()!.search(args);
      return { ...result, ...(await libraryNote()) };
    },
  });

  ctx.tools.register({
    name: 'prompt_pick',
    description:
      '按分类随机挑几个词，用来给生成提示词补姿势、表情、构图、光影、场景、道具等细节。' +
      '只补画面细节，不改人物原本的长相和年龄设定。成人分类默认不参与随机，需先在设置页打开开关。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '分类 id（prompt_categories 里的），省略则在启用的分类里随机' },
        count: { type: 'integer', description: '挑几个，省略用设置里的默认值，最多 8' },
        lang: { type: 'string', enum: WORD_LANG_MODES, description: '省略时用设置里的默认语言' },
      },
      additionalProperties: false,
    },
    async run(args: any) {
      const bad = await guard();
      if (bad) return bad;
      const result = await engine()!.pick(args);
      return { ...result, ...(await libraryNote()) };
    },
  });

  ctx.tools.register({
    name: 'prompt_recipe',
    description:
      '按设置里的配方层各取一个词，拼一段随机画面描述。场景和道具留给调用方指定，避免拼出“室内 + 暴风雪”这种打架的组合；不合场景的词自己删掉。',
    danger: 'safe',
    schema: {
      type: 'object',
      properties: {
        lang: { type: 'string', enum: WORD_LANG_MODES, description: '省略时用设置里的默认语言' },
        extra: { type: 'string', description: '额外要加进画面的词句，可省略' },
        layers: { type: 'array', items: { type: 'string' }, description: '临时指定层，省略用设置里的配方层' },
      },
      additionalProperties: false,
    },
    async run(args: any) {
      const bad = await guard();
      if (bad) return bad;
      const result = await engine()!.recipe(args);
      return { ...result, ...(await libraryNote()) };
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
      data = fallbackPageData(DATA_FILE);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderPage(data, notice));
  }, { title: '提示词小抄设置', settings: true, navigation: false });

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

  ctx.web.api(API_SAMPLE, async (req: any, res: any) => {
    try {
      const file = [SAMPLE_FILE, SAMPLE_LEGACY].find((path) => existsSync(path));
      if (!file) throw Error('missing');
      // 宿主的 web.api 只挂 POST；页面用 POST 取，这里把请求体读掉，避免连接挂着。
      try {
        for await (const _chunk of req) {
          /* 不需要内容 */
        }
      } catch {
        /* 没有请求体也无所谓 */
      }
      const raw = readFileSync(file, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="prompts.sample.json"');
      res.setHeader('Cache-Control', 'no-store');
      res.end(raw);
    } catch {
      json(res, 404, { ok: false, error: '安装包里没有示例词库（assets/prompts.sample.json）' });
    }
  });

  ctx.web.api(API_CONFIG, async (req: any, res: any, { signal }: any) => {
    try {
      const eng = engine();
      if (!eng) throw Error(NO_LIBRARY_HINT);
      const patch = await readBody(req, signal);
      const current = (await eng.pageData()) as PageData;
      const known = new Map(current.categories.map((c) => [c.id, c]));
      const isBadLayer = (id: string) => {
        const category = known.get(id);
        return !category || category.negative || category.nsfw;
      };
      const next: WordConfig = { ...current.config };
      if (patch?.lang !== undefined) {
        if (typeof patch.lang !== 'string' || !patch.lang.trim()) throw Error('lang 要是非空字符串');
        next.lang = patch.lang as WordConfig['lang'];
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
        next.recipeLayers = patch.recipeLayers.map(String).filter((id: string) => known.has(id) && !isBadLayer(id));
      }
      if (patch?.recipeMaxLayers !== undefined) {
        const n = Number(patch.recipeMaxLayers);
        if (!Number.isFinite(n) || n < 1 || n > 20) throw Error('配方层数要在 1–20 之间');
        next.recipeMaxLayers = Math.round(n);
      }
      if (patch?.autoEnrich !== undefined) {
        if (typeof patch.autoEnrich !== 'boolean') throw Error('autoEnrich 只能是 true / false');
        next.autoEnrich = patch.autoEnrich;
      }
      if (patch?.enrichKinds !== undefined) {
        if (!Array.isArray(patch.enrichKinds)) throw Error('enrichKinds 要给数组');
        next.enrichKinds = patch.enrichKinds.map(String).map((s: string) => s.trim()).filter((s: string) => s && s.length <= 40);
      }
      if (patch?.enrichLayers !== undefined) {
        if (!Array.isArray(patch.enrichLayers)) throw Error('enrichLayers 要给数组');
        next.enrichLayers = patch.enrichLayers.map(String).filter((id: string) => known.has(id) && !isBadLayer(id));
      }
      if (patch?.enrichCount !== undefined) {
        const n = Number(patch.enrichCount);
        if (!Number.isFinite(n) || n < 1 || n > 5) throw Error('自动补词数量要在 1–5 之间');
        next.enrichCount = Math.round(n);
      }
      if (patch?.negativePrompt !== undefined) {
        if (typeof patch.negativePrompt !== 'string') throw Error('negativePrompt 要是字符串');
        if (patch.negativePrompt.length > 4000) throw Error('共用负面提示词太长了（上限 4000 字符）');
        next.negativePrompt = patch.negativePrompt.trim();
      }
      if (patch?.fields !== undefined) {
        if (!patch.fields || typeof patch.fields !== 'object') throw Error('fields 要给对象');
        const primary = String(patch.fields.primary ?? '').trim();
        const secondary = String(patch.fields.secondary ?? '').trim();
        if (!primary || !secondary) throw Error('fields.primary 和 fields.secondary 都要非空');
        next.fields = { primary, secondary };
      }
      if (patch?.semantics !== undefined) {
        if (!patch.semantics || typeof patch.semantics !== 'object') throw Error('semantics 要给对象');
        next.semantics = {
          negative: String(patch.semantics.negative ?? '').trim(),
          quality: String(patch.semantics.quality ?? '').trim(),
          nsfwPrefix: String(patch.semantics.nsfwPrefix ?? '').trim(),
        };
      }
      if (patch?.qualityAllowlist !== undefined) {
        if (!Array.isArray(patch.qualityAllowlist)) throw Error('qualityAllowlist 要给数组');
        next.qualityAllowlist = patch.qualityAllowlist.map(String).map((s: string) => s.trim()).filter(Boolean).slice(0, 200);
      }
      if (patch?.blockedPatterns !== undefined) {
        if (!Array.isArray(patch.blockedPatterns)) throw Error('blockedPatterns 要给数组');
        next.blockedPatterns = patch.blockedPatterns.map(String).map((s: string) => s.trim()).filter(Boolean).slice(0, 30);
      }
      if (patch?.allowNsfw !== undefined) {
        if (typeof patch.allowNsfw !== 'boolean') throw Error('allowNsfw 只能是 true / false');
        // 打开是一次需要确认的动作：页面会先弹确认框，这里再校验一次，直接调接口绕不过去。
        if (patch.allowNsfw && current.config.allowNsfw !== true && patch.acknowledgeNsfw !== true) {
          return json(res, 400, { ok: false, error: NSFW_WARNING, requireAck: true });
        }
        next.allowNsfw = patch.allowNsfw;
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
    note: '画室子插件：引擎由父级 studio 提供；用户词库优先，其次随包示例；字段/分类语义/动作白名单可配置；成人分类默认隐藏',
  });
}
