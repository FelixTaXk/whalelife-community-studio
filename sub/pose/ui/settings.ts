/*! 姿势 · 设置页：图库浏览 + 图源/分级设置。不展示日程，也不提供“换今天姿势”。 */

import type { PoseConfig } from '../lib/config.ts';

export type PosePersona = { id: string; name: string; age: number | null; adult: boolean; threshold: number; source: string };

export type PosePageData = {
  version: string;
  config: PoseConfig;
  stats: any;
  personas: PosePersona[];
  /** 当前预览人格。 */
  persona: { id: string; name: string; age: number | null; adult: boolean } | null;
  /** 高级参考当前是否真的生效（配置开 + 人格成年）。 */
  advanced: boolean;
  /** 双人参考当前是否真的生效（高级生效 + 双人开关开）。 */
  couple: boolean;
};

const esc = (value: any) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch]);

const CSS = `
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}body{margin:0;padding:30px 26px 40px}main{max-width:1000px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:10px}
h1{font-size:26px;letter-spacing:-.4px;margin:0 0 4px;font-weight:650}p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
h2{font-size:15px;margin:0 0 8px}h3{font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600}
p.hint{margin:4px 0 10px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 16px;align-items:start}
.grid .wide{grid-column:1/-1}
label.f{display:flex;flex-direction:column;gap:5px;font-size:13px;min-width:0}label.f span{color:var(--muted)}label.f i{color:var(--muted);font-size:12px;font-style:normal}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%;height:40px;min-width:0;line-height:1.5}
input[type=number]{font-variant-numeric:tabular-nums}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:8px 13px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
#msg{min-height:22px;margin-top:10px;font-size:13px;color:var(--accent)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;color:var(--muted);background:var(--soft)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px;margin-top:12px}
.pcard{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--paper);cursor:pointer;transition:transform .12s ease,border-color .12s ease;padding:0;text-align:left;color:inherit;font:inherit}
.pcard:hover{border-color:var(--accent);transform:translateY(-1px)}
.pcard .thumb{width:100%;aspect-ratio:3/4;background:#f2f2f2;display:flex;align-items:center;justify-content:center;overflow:hidden}
.pcard .thumb img{width:100%;height:100%;object-fit:contain}
.pcard .cap{padding:7px 9px 9px}
.pcard .nm{font-size:12.5px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pcard .sub2{font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
@media(max-width:760px){.grid,.filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

export function poseSettingsPage(data: PosePageData): string {
  const { config, stats, personas, advanced, couple, persona } = data;
  const preferDepth = config.preferDepth === true;
  const personaRows = (personas ?? []).map((p) => {
    const policy: string = config.personaPolicy?.[p.id] ?? 'auto';
    const age = p.age === null ? '年龄未标注' : `${p.age} 岁`;
    const state = p.adult ? '成年' : '未成年 · 只能用标准/日常';
    return `<label class="f"><span>${esc(p.name)}（${esc(p.id)}）</span>
      <i>${esc(age)} · ${esc(state)}</i>
      <select name="policy_${esc(p.id)}">
        <option value="auto"${policy === 'auto' ? ' selected' : ''}>按年龄自动</option>
        <option value="minor"${policy === 'minor' ? ' selected' : ''}>强制未成年</option>
        <option value="adult"${policy === 'adult' ? ' selected' : ''}>成年（年龄未满时不生效）</option>
      </select>
    </label>`;
  }).join('');

  const systemOptions = Object.keys(stats.systems ?? {}).map((key) => `<option value="${esc(key)}">${esc(key)}</option>`).join('');
  const categoryOptions = Object.keys(stats.categories ?? {}).map((key) => `<option value="${esc(key)}">${esc(key)}</option>`).join('');
  const tierStats = Object.entries(stats.tiers ?? {}).map(([key, value]) => `<span class="pill">${esc(key)} ${value}</span>`).join(' ');
  const systemStats = Object.entries(stats.systems ?? {}).map(([key, value]) => `<span class="pill">${esc(key)} ${value}</span>`).join(' ');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="initial-scale=1">
<title>画室 · 姿势</title><style>${CSS}</style></head><body><main>
<header>
  <div>
    <h1>姿势</h1>
    <p class="sub">画室的子插件 · 姿势库${stats.catalogOverridden ? '（自定义目录）' : '（随包目录）'} · ${stats.assetMode === 'remote' ? '云端图源' : '本地图库'} · 不绑定日程 · v<span id="ver">${esc(data.version)}</span>${advanced ? ' · 高级已开' : ''}${couple ? ' · 双人已开' : ''}</p>
  </div>
  <div class="row" style="margin:0"><span class="pill">${stats.poses} 张 · ${stats.groups} 组</span><span class="pill">${esc(persona?.name ?? '默认人格')} ${persona?.adult ? '成年' : '未成年'}</span></div>
</header>

<div id="msg"></div>

<section class="card">
  <h2>姿势库</h2>
  <p class="hint">这里只做参考库：生图时由你或当前人格决定要不要用、用哪一组；不会自动塞进任何画面，也不和日程挂钩。点卡片复制英文提示词，再把 id 填进 draw 的 pose 参数。</p>
  <div class="filters">
    <label class="f"><span>体系</span><select id="fSystem"><option value="">全部</option>${systemOptions}</select></label>
    <label class="f"><span>分类</span><select id="fCategory"><option value="">全部</option>${categoryOptions}</select></label>
    <label class="f"><span>视角</span><select id="fView"><option value="auto">正面（每组一张）</option><option value="front">正面</option><option value="diag">斜侧</option><option value="side">侧面</option><option value="back">背面</option><option value="high">俯视</option><option value="low">仰视</option></select></label>
    <label class="f"><span>搜索</span><input id="fKeyword" type="search" placeholder="回头 / 抱膝 / 坐姿"></label>
  </div>
  <div class="row"><span class="pill" id="gCount">—</span><span class="hint" style="margin:0">${couple ? '高级 + 双人参考已开：仅对成年人格生效' : advanced ? '高级参考已开：仅对成年人格生效' : '只列当前人格可用的参考'}</span></div>
  <div class="gallery" id="gallery"></div>
  <div class="row"><button type="button" id="more">加载更多</button></div>
</section>

<section class="card">
  <h2>设置</h2>
  <form id="form">
    <div class="grid">
      <label class="f"><span>重新导入的源目录</span><input type="text" name="importRoot" value="${esc(config.importRoot)}" placeholder="留空 = 用下面的库"><i>要含 data/pose-zh.json、thumbs/、img/。</i></label>
      <label class="f wide"><span>本地姿势库根目录</span><input type="text" name="libraryRoot" value="${esc(config.libraryRoot)}" placeholder="留空 = 插件内置 library/（通常没有图）"><i>只用来找图，不会复制图片。</i></label>
      <label class="f wide"><span>云端图源前缀</span><input type="text" name="assetBaseUrl" value="${esc(config.assetBaseUrl)}" placeholder="https://..."><i>本地缺图时 302 过去；留空 = 只用本地。</i></label>
      <label class="f"><span>成年年龄线</span><input type="number" name="adultThreshold" min="18" max="30" value="${config.adultThreshold}"><i>最低 18。</i></label>
      <label class="f"><span>读不到年龄时</span><select name="unknownPersona"><option value="minor"${config.unknownPersona === 'minor' ? ' selected' : ''}>按未成年</option><option value="adult"${config.unknownPersona === 'adult' ? ' selected' : ''}>按成年</option></select></label>
      <label class="f"><span>默认视角</span><select name="viewPreference"><option value="auto"${config.viewPreference === 'auto' ? ' selected' : ''}>自动（优先正面）</option><option value="front"${config.viewPreference === 'front' ? ' selected' : ''}>正面</option><option value="diag"${config.viewPreference === 'diag' ? ' selected' : ''}>斜侧</option><option value="side"${config.viewPreference === 'side' ? ' selected' : ''}>侧面</option><option value="back"${config.viewPreference === 'back' ? ' selected' : ''}>背面</option><option value="high"${config.viewPreference === 'high' ? ' selected' : ''}>俯视</option><option value="low"${config.viewPreference === 'low' ? ' selected' : ''}>仰视</option></select></label>
      <label class="f"><span>页面优先显示深度图</span><select name="preferDepth"><option value="1"${preferDepth ? ' selected' : ''}>开</option><option value="0"${preferDepth ? '' : ' selected'}>关</option></select></label>
    </div>
    ${personaRows ? `<h3>人格分级</h3><div class="grid">${personaRows}</div>` : ''}
    <div class="row">
      <button type="submit" class="primary">保存设置</button>
      <button type="button" id="import">重新导入姿势库</button>
    </div>
  </form>
</section>

<section class="card">
  <h2>库状态</h2>
  <p class="hint">目录：${esc(stats.catalogFile || '—')}；来源 ${esc(stats.source?.repo ?? '—')}；快照 ${esc(stats.generatedAt || '—')}</p>
  <div class="tags">${tierStats}</div>
  <div class="tags" style="margin-top:6px">${systemStats}</div>
</section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const msg = (html) => { $('#msg').innerHTML = '<div class="alert">' + html + '</div>'; setTimeout(() => { $('#msg').innerHTML = ''; }, 3600); };
const PERSONA = ${JSON.stringify(persona?.id ?? '')};
async function post(body) {
  const res = await fetch('/plugins/studio/pose/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, personaId: body.personaId || PERSONA }) });
  return res.json();
}
function card(item) {
  let thumb = item.thumb || item.depthThumb;
  if (thumb && PERSONA && !thumb.includes('persona=')) thumb += '&persona=' + encodeURIComponent(PERSONA);
  return '<button type="button" class="pcard" data-copy="' + encodeURIComponent(item.en || '') + '" data-id="' + item.id + '">' +
    '<div class="thumb"><img src="' + thumb + '" alt="" loading="lazy" onerror="this.remove()"></div>' +
    '<div class="cap"><div class="nm">' + item.name + '</div>' +
    '<div class="sub2">' + item.category + ' · ' + item.view + ' · ' + item.tier + '</div></div></button>';
}
let offset = 0, total = 0;
async function load(reset) {
  if (reset) { offset = 0; $('#gallery').innerHTML = ''; }
  const r = await post({ action: 'list', system: $('#fSystem').value, category: $('#fCategory').value, view: $('#fView').value, keyword: $('#fKeyword').value, offset, limit: 36 });
  if (!r.ok) throw new Error(r.error || '读取失败');
  const result = r.result;
  total = result.total;
  offset += result.items.length;
  $('#gallery').insertAdjacentHTML('beforeend', result.items.map(card).join(''));
  $('#gCount').textContent = '已列 ' + Math.min(offset, total) + ' / ' + total;
  $('#more').style.display = offset >= total ? 'none' : '';
}
$('#gallery').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = decodeURIComponent(btn.dataset.copy || '');
  try { await navigator.clipboard.writeText(text); msg('已复制：' + text + ' · id ' + btn.dataset.id); }
  catch { msg('英文：' + text + ' · id ' + btn.dataset.id); }
});
$('#more').addEventListener('click', () => load(false).catch((err) => msg(String(err.message || err))));
['#fSystem', '#fCategory', '#fView'].forEach((sel) => $(sel).addEventListener('change', () => load(true).catch((err) => msg(String(err.message || err)))));
let timer = 0;
$('#fKeyword').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(true).catch((err) => msg(String(err.message || err))), 260); });
load(true).catch((err) => msg(String(err.message || err)));
let taps = 0, tapTimer = 0;
const advancedOn = ${config.advanced ? 'true' : 'false'};
const coupleOn = ${config.couple ? 'true' : 'false'};
const adultThreshold = ${Number(config.adultThreshold) || 18};
function revealAdvanced() {
  if ($('#advancedCard')) return;
  const html = '<div id="advancedCard"><h3>高级参考</h3>' +
    '<p class="hint">默认不展示，只在生图时显式取用，不会自动进入任何画面。打开后也只对满 ' + adultThreshold + ' 岁的人格生效；未成年的任何设置都不生效。</p>' +
    '<label class="f"><span>启用高级参考</span><select name="advanced">' +
    '<option value="0"' + (advancedOn ? '' : ' selected') + '>关（默认）</option>' +
    '<option value="1"' + (advancedOn ? ' selected' : '') + '>开</option>' +
    '</select><i>改完点上面的保存设置。</i></label>' +
    '<label class="f"><span>双人参考</span><select name="couple">' +
    '<option value="0"' + (coupleOn ? '' : ' selected') + '>关（默认）</option>' +
    '<option value="1"' + (coupleOn ? ' selected' : '') + '>开</option>' +
    '</select><i>在高级参考之上再加一层：高级没开时这一项不生效；只对成年人格生效。</i></label></div>';
  $('#form').insertAdjacentHTML('beforeend', html);
  $('#advancedCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#ver')?.addEventListener('click', () => {
  clearTimeout(tapTimer);
  taps += 1;
  tapTimer = setTimeout(() => { taps = 0; }, 2500);
  if (taps >= 7) { taps = 0; revealAdvanced(); }
});
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const personaPolicy = {};
  for (const [key, value] of f.entries()) if (key.startsWith('policy_') && value !== 'auto') personaPolicy[key.slice(7)] = value;
  try {
    const card = $('#advancedCard');
    const r = await post({ action: 'save', config: {
      viewPreference: String(f.get('viewPreference') || 'auto'),
      libraryRoot: String(f.get('libraryRoot') || ''),
      assetBaseUrl: String(f.get('assetBaseUrl') || ''),
      importRoot: String(f.get('importRoot') || ''),
      adultThreshold: Number(f.get('adultThreshold')),
      unknownPersona: String(f.get('unknownPersona') || 'minor'),
      preferDepth: f.get('preferDepth') === '1',
      personaPolicy,
      ...(card ? { advanced: f.get('advanced') === '1', couple: f.get('couple') === '1' } : {}),
    } });
    if (!r.ok) throw new Error(r.error || '保存失败');
    msg('设置已保存');
  } catch (err) { msg(String(err.message || err)); }
});
$('#import').addEventListener('click', async (e) => {
  e.target.disabled = true;
  msg('正在扫描姿势库，可能要十几秒…');
  try {
    const r = await post({ action: 'import', root: $('#form').elements.importRoot.value || $('#form').elements.libraryRoot.value });
    if (!r.ok) throw new Error((r.result && r.result.stderr) || r.error || '导入失败');
    msg('导入完成：' + JSON.stringify(r.result && r.result.kept ? { kept: r.result.kept, groups: r.result.groups } : r.result));
    setTimeout(() => location.reload(), 900);
  } catch (err) { msg(String(err.message || err)); e.target.disabled = false; }
});
</script></body></html>`;
}
