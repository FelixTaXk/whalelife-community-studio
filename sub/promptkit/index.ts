/*! 提示词小抄（promptkit）· 画室的子插件。
 *
 * 词库与补词逻辑常驻父插件（studio/lib/words.ts，经 ctx.provide('promptkit') 暴露）：
 * 这里只负责四个查词工具和设置页，配置写在自己的 data/config.json。
 * 画画子插件通过同一个服务在出图前自动补词。
 *
 * 词库来自鱼仔 PromptForge 的非成人子集，只在本机使用。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from 'whalelife';
import { WORD_DEFAULT, WORD_KINDS, WORD_LANGS, type WordConfig, type WordEngine } from '../../lib/words.ts';

const PAGE = '/plugins/studio/promptkit/settings';
const API_CONFIG = '/plugins/studio/promptkit/config';
const API_RELOAD = '/plugins/studio/promptkit/reload';

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
};

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

async function readBody(req: any, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024) throw Error('提交的内容太大');
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

function renderPage(data: PageData) {
  const cfg = data.config;
  const s = data.stats;
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
@media(max-width:640px){.grid,.checks{grid-template-columns:1fr}}
</style></head><body><main>
<header><div><h1>提示词小抄</h1><p class="sub">${s.categories} 个分类 · ${s.tags} 条词 · 当前启用 ${s.enabledCategories} 个分类 / ${s.enabledTags} 条</p></div></header>

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
    <tr><th>词库文件</th><td><code>data/prompts.json</code></td></tr>
    <tr><th>构建时间</th><td>${esc(s.builtAt || '未知')}</td></tr>
    <tr><th>词条</th><td>${s.tags} 条（启用 ${s.enabledTags} 条）</td></tr>
    <tr><th>来源</th><td>鱼仔 PromptForge 非成人子集，重建用 <code>node scripts/build-data.mjs</code></td></tr>
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

export function apply(ctx: Context) {
  const engine = () => ctx.get('promptkit') as unknown as WordEngine;

  ctx.tools.register({
    name: 'prompt_categories',
    description: '列出提示词小抄里当前启用的分类和词条数量。想按分类挑词先看这个。',
    danger: 'safe',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const list = await engine().categories();
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
      return engine().search(args);
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
      return engine().pick(args);
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
      return engine().recipe(args);
    },
  });

  ctx.web.page(PAGE, async (_req: any, res: any) => {
    const data = (await engine().pageData()) as PageData;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderPage(data));
  }, { title: '提示词小抄设置', settings: true, navigation: true });

  ctx.web.api(API_CONFIG, async (req: any, res: any, { signal }: any) => {
    try {
      const patch = await readBody(req, signal);
      const current = (await engine().pageData()) as PageData;
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
      await engine().reload();
      const data = (await engine().pageData()) as PageData;
      json(res, 200, { ok: true, config: next, stats: data.stats });
    } catch (error: any) {
      json(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.web.api(API_RELOAD, async (_req: any, res: any) => {
    try {
      await engine().reload();
      const data = (await engine().pageData()) as PageData;
      json(res, 200, { ok: true, stats: data.stats });
    } catch (error: any) {
      json(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  ctx.logger.info('提示词小抄已加载', {
    settings: PAGE,
    note: '词库引擎由父插件 studio 提供，画画子插件在出图前调用',
  });
}
