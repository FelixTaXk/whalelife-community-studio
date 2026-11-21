/*! 画室 · 本机部署页（体检 / 模型推荐 / 一键部署）。
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { Recommendation, SystemProbe, DeployState } from './setup.ts';

const esc = (value: any) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch]);

const FIT: Record<string, string> = { best: '最合适', ok: '能用', light: '低负载', heavy: '显存不够' };

function probeRows(p: SystemProbe) {
  const gpu = p.gpu.length
    ? p.gpu.map((item) => `${esc(item.name)}${item.vramTotalMiB ? ' · ' + Math.round(item.vramTotalMiB / 1024) + 'G' : ''}${item.driver ? ' · 驱动 ' + esc(item.driver) : ''}`).join('<br>')
    : '没识别到 NVIDIA 显卡';
  const comfy = p.comfy.exists
    ? `<code>${esc(p.comfy.root)}</code>${p.comfy.online ? ` · 在线 ${esc(p.comfy.version)}` : ' · 未运行'}`
    : '没找到（可以用下面的一键部署）';
  return `
    <table>
      <tr><th>系统</th><td>${esc(p.os.platform)} / ${esc(p.os.arch)} / ${esc(p.os.release)}</td></tr>
      <tr><th>CPU</th><td>${esc(p.cpu.name)} · ${p.cpu.cores} 核</td></tr>
      <tr><th>内存</th><td>${p.memory.totalGB}G（空闲 ${p.memory.freeGB}G）</td></tr>
      <tr><th>磁盘</th><td>${p.disk ? `${esc(p.disk.path)} 空闲 ${p.disk.freeGB}G / 共 ${p.disk.totalGB}G` : '读不出来'}</td></tr>
      <tr><th>显卡</th><td>${gpu}</td></tr>
      <tr><th>Python</th><td>${p.python ? `<code>${esc(p.python.path)}</code> · ${esc(p.python.version)}` : '没找到 Python 3'}</td></tr>
      <tr><th>Git</th><td>${p.git ? esc(p.git.version) : '没找到 git'}</td></tr>
      <tr><th>ComfyUI</th><td>${comfy}</td></tr>
    </table>`;
}

function recCards(r: Recommendation) {
  return r.items
    .map((item) => {
      const files = item.files
        .map(
          (file) =>
            `<tr><td><code>${esc(file.dir)}/${esc(file.name)}</code></td><td>${file.sizeGB ? file.sizeGB + 'GB' : '—'}</td><td>${
              file.url ? `<a href="${esc(file.url)}" target="_blank" rel="noreferrer">下载</a>` : esc(file.note || '需自备')
            }</td></tr>`,
        )
        .join('');
      const wf = item.workflow;
      return `<div class="rec">
        <div class="rec-head">
          <b>${esc(item.name)}</b>
          <span class="tag ${item.fit}">${FIT[item.fit] || item.fit}</span>
          <span class="tag ${item.local ? 'local' : ''}">${item.local ? '本机已有' : '需下载/自备'}</span>
        </div>
        <p class="hint">${esc(item.purpose)} · 约 ${item.vramGB}G 显存 · ${esc(wf.width)}×${esc(wf.height)} / ${wf.steps} 步 / cfg ${wf.cfg} / ${esc(wf.sampler)}·${esc(wf.scheduler)}</p>
        <table class="files">${files}</table>
        <p class="hint">${item.notes.map(esc).join('；')}</p>
        <div class="row">
          <button data-build="${esc(item.localModel || '')}" data-family="${esc(item.family)}"${item.localModel ? '' : ' disabled'}>生成这套工作流</button>
          ${item.localModel ? `<span class="hint">用本机 <code>${esc(item.localModel)}</code></span>` : '<span class="hint">本机还没有这份权重，先下载/自备</span>'}
        </div>
      </div>`;
    })
    .join('');
}

export function renderSetup(data: { probe: SystemProbe; rec: Recommendation; state: DeployState & { logTail?: string }; busy: boolean; error?: string }) {
  const p = data.probe;
  const root = data.state.root || p.comfy.root || 'D:\\ComfyUI';
  const busy = data.busy || ['installing', 'starting'].includes(data.state.state);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>画室 · 本机部署</title>
<style>
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}body{margin:0;padding:32px 28px 40px}main{max-width:940px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
h1{font-size:27px;letter-spacing:-.5px;margin:0 0 4px;font-weight:650}p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:18px 0}
h2{font-size:16px;margin:0 0 6px}h3{font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600}
p.hint{margin:4px 0 10px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;width:88px}table.files th,table.files td{border-bottom:1px dashed var(--line)}
.rec{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.rec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tag{font-size:12px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.tag.best{color:#0f6b3f;border-color:#b6dcc6;background:#eef8f1}.tag.ok{color:#12586e;border-color:#bcd9e4;background:#eef6fa}
.tag.heavy{color:#8a3b2e;border-color:#e4c2bb;background:#fbefed}.tag.local{color:#7a5a1e;border-color:#e8cfa2;background:#fdf7ea}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
button{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:not-allowed}
input{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);min-width:280px}
#msg{min-height:22px;margin-top:10px;font-size:13px;color:var(--accent)}#msg.bad{color:#b23c3c}
pre.log{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:220px;overflow:auto;font-size:12px;white-space:pre-wrap}
.banner{padding:10px 14px;border:1px solid var(--line);border-radius:10px;margin:0 0 10px;font-size:13px;background:var(--paper)}
.banner.warn{border-color:#e8cfa2;background:#fdf7ea;color:#7a5a1e}
@media(max-width:640px){th{width:72px}input{min-width:0;width:100%}}
</style></head><body><main>
<header><div><h1>本机部署与模型推荐</h1><p class="sub">先体检，再决定装什么、跑什么；部署只装 ComfyUI 本体和依赖，不下载模型权重。</p></div></header>
${data.error ? `<div class="banner warn">${esc(data.error)}</div>` : ''}

<section class="card">
  <h2>本机体检</h2>
  <p class="hint">读 GPU、显存、内存、磁盘、Python、Git 和已有的 ComfyUI。没装驱动或没装 Python 都会直接标出来。</p>
  ${probeRows(p)}
  <div class="row"><button id="refresh">重新体检</button></div>
</section>

<section class="card">
  <h2>推荐组合</h2>
  <p class="hint"><b>${esc(data.rec.gpu)}</b> · 档位 ${esc(data.rec.tier)} · ${esc(data.rec.summary)}</p>
  <p class="hint">顺序按「本机已有 → 显存合适」排；带下载链接的是公开权重，没链接的需要自备（插件不替你猜来源）。</p>
  ${recCards(data.rec)}
  <p class="hint">${data.rec.next.map(esc).join('<br>')}</p>
</section>

<section class="card">
  <h2>一键部署 / 启动 ComfyUI</h2>
  <p class="hint">用 git + venv 装官方 ComfyUI：克隆 → 建 venv → 按显卡驱动装 torch（CUDA 12.4 / 12.1 / 11.8）→ 装 requirements → 起 8188。首次下载约 2–4G，耗时看网速；日志在 <code>data/logs/deploy.log</code>。</p>
  <div class="row">
    <input id="root" value="${esc(root)}" placeholder="D:\\ComfyUI">
    <button class="primary" id="install"${busy ? ' disabled' : ''}>一键部署</button>
    <button id="start"${busy ? ' disabled' : ''}>只启动</button>
    <button id="status">刷新状态</button>
  </div>
  <p class="hint" id="stateLine">状态：${esc(data.state.state)} · ${esc(data.state.step)} · ${esc(data.state.message)}${data.state.log ? ` · 日志 <code>${esc(data.state.log)}</code>` : ''}</p>
  <pre class="log" id="log">${esc(data.state.logTail || '（还没有日志）')}</pre>
  <div id="msg"></div>
</section>
<script>
const $ = (s) => document.querySelector(s);
const msg = (t, bad) => { const el = $('#msg'); el.textContent = t || ''; el.className = bad ? 'bad' : ''; };
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function showState(state) {
  $('#stateLine').textContent = '状态：' + state.state + ' · ' + state.step + ' · ' + state.message;
  if (state.logTail) $('#log').textContent = state.logTail;
}
$('#refresh').onclick = async () => { try { await post('/plugins/studio/setup/probe'); location.reload(); } catch (e) { msg('体检失败：' + e.message, true); } };
$('#start').onclick = async () => {
  try { $('#start').disabled = true; const data = await post('/plugins/studio/setup/deploy', { root: $('#root').value, mode: 'start' }); showState(data.state); msg('已发起启动'); poll(); }
  catch (e) { $('#start').disabled = false; msg('启动失败：' + e.message, true); }
};
$('#install').onclick = async () => {
  try { $('#install').disabled = true; const data = await post('/plugins/studio/setup/deploy', { root: $('#root').value, mode: 'install' }); showState(data.state); msg('已开始部署，完成后会自动刷新体检'); poll(); }
  catch (e) { $('#install').disabled = false; msg('部署失败：' + e.message, true); }
};
$('#status').onclick = () => post('/plugins/studio/setup/status').then((d) => showState(d.state)).catch((e) => msg(e.message, true));
let timer = null;
function poll() {
  if (timer) clearInterval(timer);
  timer = setInterval(async () => {
    try {
      const d = await post('/plugins/studio/setup/status');
      showState(d.state);
      if (!['installing', 'starting'].includes(d.state.state)) {
        clearInterval(timer); timer = null;
        $('#install').disabled = false; $('#start').disabled = false;
        if (d.state.state === 'running') msg('ComfyUI 已就绪，正在刷新');
      }
    } catch (e) { /* 轮询失败不打扰 */ }
  }, 3000);
}
if (${busy ? 'true' : 'false'}) poll();
document.querySelectorAll('button[data-build]').forEach((btn) => {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const data = await post('/plugins/studio/setup/build', { family: btn.dataset.family, model: btn.dataset.build });
      msg('已生成：' + (data.file || '工作流') + '（存到 data/workflows）', false);
    } catch (e) { msg('生成失败：' + e.message, true); }
    btn.disabled = false;
  };
});
</script>
</main></body></html>`;
}
