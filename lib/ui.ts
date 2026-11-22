/*! 画室（studio）总设置：只管「用哪套生图工具」——本地 ComfyUI / SD-WebUI，或网络生图服务。
 *
 * 人设、日程衣柜、参考图、视频参数都不在这里，分别去「画画 / 拍视频」设置页。
 * 本地部署不预填默认目录；检测到插件内已有安装就直接读取，没有才给一键部署。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { StudioConfig } from './config.ts';

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

type NetworkTool = { name: string; label: string; note: string; fields: Array<{ key: string; label: string; hint?: string; password?: boolean }> };

const NETWORK: NetworkTool[] = [
  {
    name: 'openai',
    label: 'OpenAI 兼容',
    note: '任何 /v1/images 形状的服务：官方、中转站、硅基流动。',
    fields: [
      { key: 'baseUrl', label: '接口地址', hint: '例如 https://api.openai.com/v1' },
      { key: 'apiKey', label: 'API Key', password: true },
      { key: 'model', label: '模型' },
      { key: 'size', label: '默认尺寸', hint: '例如 1024x1024' },
    ],
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    note: '原生 generateContent；尺寸由模型决定。',
    fields: [
      { key: 'baseUrl', label: '接口地址' },
      { key: 'apiKey', label: 'API Key', password: true },
      { key: 'model', label: '模型', hint: '例如 gemini-2.5-flash-image' },
    ],
  },
  {
    name: 'dashscope',
    label: '通义万相',
    note: '异步任务接口：提交后轮询，结果给 URL 再取回。',
    fields: [
      { key: 'baseUrl', label: '接口地址' },
      { key: 'apiKey', label: 'API Key', password: true },
      { key: 'model', label: '模型' },
      { key: 'size', label: '默认尺寸', hint: '宽*高，例如 1280*720' },
    ],
  },
];

function textField(attr: string, key: string, label: string, value: any, hint = '', placeholder = ''): string {
  return `<label class="f"><span>${esc(label)}${hint ? `<i>${esc(hint)}</i>` : ''}</span><input type="text" data-${esc(attr)}="${esc(key)}" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`;
}

function modelSelect(id: string, label: string, value: string, groups: Array<{ label: string; items: string[] }>): string {
  const current = String(value || '');
  const all = groups.flatMap((group) => group.items);
  const currentOption = current
    ? `<option value="${esc(current)}" selected>${esc(current)}${all.includes(current) ? '' : '（当前配置）'}</option>`
    : '';
  const options = groups.map((group) => {
    const items = current ? group.items.filter((item) => item !== current) : group.items;
    if (!items.length) return '';
    return `<optgroup label="${esc(group.label)}">${items.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('')}</optgroup>`;
  }).join('');
  return `<label class="f"><span>${esc(label)}<i>本机已部署 + 模型推荐</i></span><select data-model="${esc(id)}"><option value=""${current ? '' : ' selected'}>留空：用当前加载 / 工作流里的模型</option>${currentOption}${options}</select></label>`;
}

function localCard(input: {
  id: string;
  label: string;
  note: string;
  installed: boolean;
  root: string;
  installRoot: string;
  url: string;
  online: boolean;
  models: string[];
  recommended: string[];
  currentModel: string;
  deployed: any;
  selected: boolean;
}): string {
  const { id, label, note, installed, root, installRoot, url, online, models, recommended, currentModel, deployed, selected } = input;
  const active = root && deployed?.root === root && deployed?.state && deployed.state !== 'idle';
  const status = online ? '<span class="pill ok">在线</span>' : installed ? '<span class="pill warn">已安装 · 未启动</span>' : '<span class="pill">未检测到</span>';
  return `<section class="card tool${selected ? ' selected' : ''}" data-tool-card="${esc(id)}">
  <header>
    <div class="title"><h2>${esc(label)}</h2><span class="pill ghost">${esc(id)}</span>${status}</div>
    <label class="pick"><input type="radio" name="tool" value="${esc(id)}"${selected ? ' checked' : ''}><span>用这个</span></label>
  </header>
  <p class="note">${esc(note)}</p>
  <div class="grid">
    ${textField('root', id, '安装目录', root, installed ? '已检测到，模型从服务 / 配置读取' : '不预填；一键部署会装到插件内 local 目录', installed ? '' : installRoot)}
    ${textField('url', id, '服务地址', url, '部署完成后自动写入；已有实例可填', id === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860')}
    ${modelSelect(id, '默认模型', currentModel, [
      { label: '本机已部署', items: models.slice(0, 80) },
      { label: '模型推荐', items: recommended.filter((item) => item && !models.includes(item)).slice(0, 20) },
    ])}
  </div>
  <p class="note mono">部署位置：${esc(installRoot)}${installed && root ? ` · 当前安装：${esc(root)}` : ''}</p>
  ${deployed?.root === root && deployed?.message ? `<p class="note">${esc(deployed.state)} · ${esc(deployed.message)}</p>` : ''}
  <div class="row">
    ${installed
      ? `<button type="button" class="primary" data-start="${esc(id)}">启动</button>`
      : `<button type="button" class="primary" data-deploy="${esc(id)}">一键部署到插件内</button>`}
    ${installed && !online ? `<button type="button" data-start="${esc(id)}">再启动一次</button>` : ''}
  </div>
</section>`;
}

export function renderSettings(input: {
  cfg: StudioConfig;
  publicCfg: any;
  workflows: string[];
  checks: Record<string, any>;
  localTools?: Array<{ id: string; name: string; installed: boolean; root: string; installRoot: string; url: string }>;
  inventory?: any;
  rec?: any;
  deployed?: any;
}): string {
  const { cfg, publicCfg, checks, inventory, rec, deployed } = input;
  const tools = input.localTools || [];
  const comfyNames = [
    ...(inventory?.checkpoints || []), ...(inventory?.unets || []),
    ...(inventory?.vaes || []), ...(inventory?.clips || []),
  ].map((item: any) => String(item?.name || '')).filter(Boolean);
  const recNames = (rec?.items || []).map((item: any) => String(item?.localModel || '')).filter(Boolean);
  const sdRecNames = (rec?.items || []).filter((item: any) => item?.family === 'sd15' || item?.family === 'sdxl')
    .map((item: any) => String(item?.localModel || '')).filter(Boolean);
  const localMode = cfg.mode !== 'network';
  const activeTool = cfg.defaultBackend === 'sdwebui' ? 'sdwebui' : 'comfyui';
  const activeNetwork = ['openai', 'gemini', 'dashscope'].includes(cfg.defaultBackend) ? cfg.defaultBackend : 'openai';

  const cards = tools.map((tool) => localCard({
    id: tool.id,
    label: tool.name,
    note: tool.id === 'comfyui'
      ? 'ComfyUI 直连；插件里的 API 工作流都在 data/workflows。模型清单只从运行中的 /object_info 网络读取，不扫本地目录。'
      : 'SD-WebUI / Forge；启动必须带 --api。模型清单从 /sdapi/v1/sd-models 网络读取。',
    installed: tool.installed,
    root: tool.root,
    installRoot: tool.installRoot,
    url: tool.url,
    online: checks[tool.id === 'comfyui' ? 'comfy' : 'sdwebui']?.online === true,
    models: tool.id === 'comfyui' ? comfyNames : (checks.sdwebui?.models || []),
    recommended: tool.id === 'sdwebui' ? sdRecNames : recNames,
    currentModel: String(cfg.backends[tool.id]?.model || ''),
    deployed,
    selected: localMode && activeTool === tool.id,
  })).join('');

  const networkCards = NETWORK.map((item) => {
    const shown = publicCfg.backends[item.name] || {};
    const status = checks[item.name];
    const dot = status?.online === true ? 'on' : status?.online === false ? 'off' : 'idle';
    const detail = status?.reason || (status?.online === true ? '可以连上' : '未检测');
    return `<section class="card tool" data-net-card="${esc(item.name)}">
  <header>
    <div class="title"><h2>${esc(item.label)}</h2><span class="pill ghost">${esc(item.name)}</span><span class="dot ${dot}"></span><small>${esc(detail)}</small></div>
    <label class="pick"><input type="radio" name="network" value="${esc(item.name)}"${activeNetwork === item.name ? ' checked' : ''}><span>用这个</span></label>
  </header>
  <p class="note">${esc(item.note)}</p>
  <div class="grid">${item.fields.map((field) => {
    const value = field.password ? '' : shown[field.key];
    const placeholder = field.password ? (shown.apiKeySet ? '已填写，留空保持原值' : '未填写') : '';
    return `<label class="f"><span>${esc(field.label)}${field.hint ? `<i>${esc(field.hint)}</i>` : ''}</span><input type="${field.password ? 'password' : 'text'}" data-net="${esc(item.name)}" data-k="${esc(field.key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`;
  }).join('')}</div>
</section>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>画室 · 生图工具</title>
<style>
:root{color-scheme:light dark;font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;--warn:#a66a12;--bad:#b23a30;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad;--warn:#d0a052;--bad:#e0766c}}
*{box-sizing:border-box}body{margin:0;padding:12px 26px 44px}main{max-width:980px;margin:0 auto}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
header.top>.actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;margin-left:auto}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.4px}p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:14px 0}
section.tool.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
section>header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}h2{font-size:15px;margin:0}small{color:var(--muted);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#c9c9c9}.dot.on{background:#2fa84f}.dot.off{background:#c0392b}.dot.idle{background:#d9a72b}
.pill{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.pill.ok{color:#1f7a3a;border-color:#9fd3ae}.pill.warn{color:var(--warn);border-color:#e0c08a}.pill.ghost{font-family:ui-monospace,Consolas,monospace}
.seg{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 2px}.seg label{cursor:pointer}
.seg input{position:absolute;opacity:0}.seg span{display:inline-block;padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--paper);font-size:13px}
.seg input:checked+span{background:var(--accent);border-color:var(--accent);color:#fff}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%;height:40px;min-width:0;box-sizing:border-box;line-height:1.5;vertical-align:middle}
textarea{resize:vertical;min-height:44px;height:auto;line-height:1.5}input[type=checkbox],input[type=radio]{width:auto;height:auto}
select{cursor:pointer}
input[type=number]{font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px;margin-top:12px;align-items:start}
.f{display:grid;gap:5px;font-size:12px;color:var(--muted);min-width:0}.f>span{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.f i{font-style:normal;color:#94807a;font-size:11px}
.note{font-size:12.5px;color:var(--muted);line-height:1.6;margin:8px 0 0}.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
button{font:inherit;font-size:13px;font-weight:500;line-height:1;height:34px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .16s,border-color .16s,color .16s,transform .12s,box-shadow .16s}
button:hover{border-color:var(--accent);color:var(--accent);background:var(--soft)}
button:active{transform:translateY(1px)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 2px 6px rgba(18,110,104,.18)}
button.primary:hover{background:#0f5f5a;border-color:#0f5f5a;color:#fff;box-shadow:0 3px 9px rgba(18,110,104,.24)}
button.ghost{background:transparent;border-color:transparent;color:var(--muted)}
button.ghost:hover{background:var(--paper);border-color:var(--line);color:var(--accent)}
.actions svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.8;fill:none;flex:0 0 auto}
.pick{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:14px 0 0;white-space:pre-wrap;font-size:12px;min-height:18px;color:var(--muted)}
.hide{display:none}
@media (max-width:820px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.grid{grid-template-columns:1fr}body{padding:18px 14px 30px}}
</style></head><body><main>
<header class="top">
  <div><h1>画室</h1><p class="sub">先选生图工具：本机 ComfyUI / SD-WebUI，或网络接口；装工具、选模型去 <a href="/plugins/studio/setup">本机部署</a>。人设、衣柜在「画画」，视频在「拍视频」。</p></div>
  <div class="actions">
    <button type="button" class="ghost" id="refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7"/><path d="M20 4v7h-7"/></svg>刷新</button>
    <button type="button" class="primary" id="save"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>保存</button>
  </div>
</header>

<section class="card">
  <header><div class="title"><h2>基础设置</h2><span class="pill">本地 / 网络</span></div></header>
  <div class="seg">
    <label><input type="radio" name="mode" value="local"${localMode ? ' checked' : ''}><span>本地工具</span></label>
    <label><input type="radio" name="mode" value="network"${localMode ? '' : ' checked'}><span>网络工具</span></label>
  </div>
  <p class="note">本地模式只跑 ComfyUI / SD-WebUI；网络模式走 OpenAI 兼容、Gemini、通义万相。本地部署不预填默认配置，插件内没有安装时才提供一键部署。</p>
</section>

<div id="localPanel" class="${localMode ? '' : 'hide'}">
  <section class="card"><header><div class="title"><h2>本地生图工具</h2><span class="pill ghost">插件内 local / 显式配置</span></div></header>
    <p class="note">检测只认插件内 <code>local/comfyui</code>、<code>local/sd-webui</code> 和配置里显式填写的目录；不扫描用户目录，也不猜默认安装位置。模型清单通过网络接口查询。</p>
  </section>
  ${cards}
</div>

<div id="networkPanel" class="${localMode ? 'hide' : ''}">
  <section class="card"><header><div class="title"><h2>网络生图工具</h2><span class="pill ghost">API</span></div></header>
    <p class="note">选一个网络服务填地址、密钥和模型；密钥留空表示保持原值。</p>
  </section>
  ${networkCards}
</div>

<pre id="out">本地工具会在插件内 <code>local</code> 目录部署；网络工具保存后立即生效。人设与视频参数已移到对应子插件设置页。</pre>
</main>
<script>
const out=document.getElementById('out');
const show=(value)=>out.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
const mode=()=>document.querySelector('input[name=mode]:checked').value;
const tool=()=>document.querySelector('input[name=tool]:checked')?.value||'comfyui';
const net=()=>document.querySelector('input[name=network]:checked')?.value||'openai';
const sync=()=>{
  document.getElementById('localPanel').classList.toggle('hide',mode()!=='local');
  document.getElementById('networkPanel').classList.toggle('hide',mode()!=='network');
  document.querySelectorAll('[data-tool-card]').forEach(card=>card.classList.toggle('selected',mode()==='local'&&card.dataset.toolCard===tool()));
};
document.querySelectorAll('input[name=mode],input[name=tool],input[name=network]').forEach(el=>el.onchange=sync);
sync();
const collect=()=>{
  const body={mode:mode(),backends:{}};
  if(mode()==='local'){
    const id=tool();
    const backendId=id==='comfyui'?'comfy':'sdwebui';
    body.defaultBackend=backendId;
    body[backendId==='comfy'?'comfyRoot':'sdRoot']="";
    document.querySelectorAll('[data-root="'+id+'"]').forEach(el=>body[backendId==='comfy'?'comfyRoot':'sdRoot']=el.value.trim());
    body.backends[backendId]={enabled:true};
    document.querySelectorAll('[data-url="'+id+'"]').forEach(el=>body.backends[backendId].baseUrl=el.value.trim());
    document.querySelectorAll('[data-model="'+id+'"]').forEach(el=>body.backends[backendId].model=el.value.trim());
    ['comfy','sdwebui'].filter(name=>name!==backendId).forEach(name=>body.backends[name]={enabled:false});
    ['openai','gemini','dashscope'].forEach(name=>body.backends[name]={enabled:false});
  }else{
    const id=net();
    body.defaultBackend=id;
    body.backends[id]={enabled:true};
    document.querySelectorAll('[data-net="'+id+'"]').forEach(el=>{
      if(el.type==='password'){if(el.value.trim())body.backends[id][el.dataset.k]=el.value.trim();}
      else body.backends[id][el.dataset.k]=el.value.trim();
    });
    ['comfy','sdwebui'].forEach(name=>body.backends[name]={enabled:false});
    ['openai','gemini','dashscope'].filter(name=>name!==id).forEach(name=>body.backends[name]={enabled:false});
  }
  return body;
};
document.getElementById('save').onclick=async()=>{
  show('保存中…');
  const res=await fetch('/plugins/studio/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(collect())});
  const json=await res.json().catch(()=>({ok:false,error:'返回不是 JSON'}));
  show(json.ok?'已保存。':'没存上：'+(json.error||''));
};
document.getElementById('refresh').onclick=()=>location.reload();
const poll=async()=>{
  for(let i=0;i<40;i+=1){
    const res=await fetch('/plugins/studio/setup/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const json=await res.json().catch(()=>({}));
    const state=json.state||{};
    show([state.state,state.step,state.message].filter(Boolean).join(' · ')+'\\n'+(state.logTail||''));
    if(state.state==='running'||state.state==='failed')return;
    await new Promise(r=>setTimeout(r,3000));
  }
};
document.querySelectorAll('[data-deploy],[data-start]').forEach(btn=>{
  btn.onclick=async()=>{
    const id=btn.dataset.deploy||btn.dataset.start;
    const action=btn.dataset.start?'start':'install';
    const root=document.querySelector('[data-root="'+id+'"]')?.value.trim()||'';
    btn.disabled=true;
    try{
      show('提交部署…');
      const res=await fetch('/plugins/studio/setup/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,tool:id,root})});
      const json=await res.json().catch(()=>({ok:false,error:'返回不是 JSON'}));
      if(!json.ok){show('没开始：'+(json.error||''));return;}
      await poll();
    }finally{btn.disabled=false;}
  };
});
</script></body></html>`;
}
