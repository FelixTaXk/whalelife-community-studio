/*! 画室（studio）设置页：一套表单管六种后端，密钥只显示「已填 / 未填」。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { StudioConfig } from './config.ts';

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

type Field = { key: string; label: string; hint?: string; kind?: 'text' | 'number' | 'password' | 'checkbox' | 'select'; options?: string[] };

const BACKENDS: Array<{ name: string; label: string; note: string; fields: Field[] }> = [
  {
    name: 'comfy',
    label: 'ComfyUI 直连（8188）',
    note: '插件目录放 API 格式 json；ComfyUI 自己存的画布格式会按 /object_info 自动转。只给模型名也能现拼一份工作流。',
    fields: [
      { key: 'baseUrl', label: '地址' },
      { key: 'workflow', label: '默认工作流', hint: '留空：先按 model 现拼，再退回目录里第一个' },
      { key: 'workflowsDir', label: '工作流目录', hint: '相对插件 data 或绝对路径' },
      { key: 'canvasDir', label: 'ComfyUI 工作流目录', hint: '留空自动找 user/default/workflows' },
      { key: 'modelsDir', label: 'ComfyUI 模型目录', hint: '留空自动找 D:\\ComfyUI\\models' },
      { key: 'timeoutMs', label: '超时（毫秒）', kind: 'number' },
    ],
  },
  {
    name: 'sdwebui',
    label: 'SD-WebUI / Forge',
    note: '换底模就能跑任意本地 checkpoint；启动要带 --api。',
    fields: [
      { key: 'baseUrl', label: '地址' },
      { key: 'model', label: '底模名', hint: '留空用当前加载的那个' },
      { key: 'timeoutMs', label: '超时（毫秒）', kind: 'number' },
    ],
  },
  {
    name: 'openai',
    label: 'OpenAI 兼容接口',
    note: '任何 /v1/images 形状的服务：官方、中转站、硅基流动都能填这里。',
    fields: [
      { key: 'baseUrl', label: '接口地址', hint: '例如 https://api.openai.com/v1' },
      { key: 'apiKey', label: 'API Key', kind: 'password' },
      { key: 'model', label: '模型' },
      { key: 'size', label: '默认尺寸', hint: '会吸到该模型允许的档位' },
      { key: 'timeoutMs', label: '超时（毫秒）', kind: 'number' },
    ],
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    note: '原生 generateContent；尺寸不受控，由模型决定。',
    fields: [
      { key: 'baseUrl', label: '接口地址' },
      { key: 'apiKey', label: 'API Key', kind: 'password' },
      { key: 'model', label: '模型', hint: '例如 gemini-2.5-flash-image' },
      { key: 'timeoutMs', label: '超时（毫秒）', kind: 'number' },
    ],
  },
  {
    name: 'dashscope',
    label: '通义万相',
    note: '异步任务接口：提交后轮询，结果给 URL 再取回。',
    fields: [
      { key: 'baseUrl', label: '接口地址' },
      { key: 'apiKey', label: 'API Key', kind: 'password' },
      { key: 'model', label: '模型' },
      { key: 'size', label: '默认尺寸', hint: '宽*高，会吸到 1024*1024 / 720*1280 / 1280*720' },
      { key: 'timeoutMs', label: '超时（毫秒）', kind: 'number' },
    ],
  },
];

function fieldInput(name: string, spec: Field, value: any): string {
  const id = `${name}.${spec.key}`;
  const classes = spec.kind === 'password' ? ' class="pw"' : '';
  let control: string;
  if (spec.kind === 'checkbox') {
    control = `<input type="checkbox" id="${esc(id)}" data-k="${esc(spec.key)}"${value ? ' checked' : ''}>`;
  } else if (spec.kind === 'number') {
    control = `<input type="number" step="1" id="${esc(id)}" data-k="${esc(spec.key)}" value="${esc(value)}">`;
  } else if (spec.kind === 'password') {
    control = `<input type="password" id="${esc(id)}" data-k="${esc(spec.key)}" value="" placeholder="${value ? '已填写，留空保持原值' : '未填写'}" autocomplete="off">`;
  } else {
    control = `<input type="text" id="${esc(id)}" data-k="${esc(spec.key)}" value="${esc(value)}">`;
  }
  return `<label class="f"><span>${esc(spec.label)}${spec.hint ? `<i>${esc(spec.hint)}</i>` : ''}</span>${control}</label>`;
}

export function renderSettings(input: {
  cfg: StudioConfig;
  publicCfg: any;
  workflows: string[];
  checks: Record<string, any>;
}): string {
  const { cfg, publicCfg, workflows, checks } = input;
  const sections = BACKENDS.map((item) => {
    const actual = cfg.backends[item.name];
    const shown = publicCfg.backends[item.name];
    const status = checks[item.name];
    const dot = status?.online === true ? 'on' : status?.online === false ? 'off' : 'idle';
    const detail = status?.reason
      ? esc(status.reason)
      : status?.online === true
        ? [status.version ? `v${status.version}` : '', status.device ?? '', status.vramFreeMiB ? `显存空闲 ${status.vramFreeMiB} MiB` : ''].filter(Boolean).join(' · ')
        : status
          ? '已配置'
          : '未检测';
    return `<section class="card" data-backend="${esc(item.name)}">
  <header>
    <h2>${esc(item.label)} <code>${esc(item.name)}</code></h2>
    <div class="right">
      <span class="dot ${dot}"></span><small>${detail}</small>
      <label class="sw"><input type="checkbox" data-en="${esc(item.name)}"${actual.enabled ? ' checked' : ''}><span>启用</span></label>
      <button type="button" class="test" data-test="${esc(item.name)}">测试</button>
    </div>
  </header>
  <p class="note">${esc(item.note)}</p>
  <div class="grid">${item.fields.map((spec) => fieldInput(item.name, spec, shown[spec.key])).join('')}</div>
  ${item.name === 'comfy' ? `<p class="note mono">工作流目录：${workflows.length ? workflows.map(esc).join(' · ') : '（空，放 API 格式 json 进去）'}</p>` : ''}
</section>`;
  }).join('');

  const backendOptions = BACKENDS.map((item) => `<option value="${esc(item.name)}"${cfg.defaultBackend === item.name ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
  const videoOptions = BACKENDS.filter((item) => item.name === 'comfy')
    .map((item) => `<option value="${esc(item.name)}"${cfg.video.backend === item.name ? ' selected' : ''}>${esc(item.label)}</option>`)
    .join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>画室 · WhaleLife</title>
<style>
:root{color-scheme:light dark;font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}body{margin:0;padding:30px 26px 40px}main{max-width:960px;margin:0 auto}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.4px}p.sub{margin:0;color:var(--muted);font-size:13px}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
section.card>header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h2{font-size:15px;margin:0}code{font-size:12px;color:var(--muted)}
.right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}small{color:var(--muted);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#c9c9c9}.dot.on{background:#2fa84f}.dot.off{background:#c0392b}.dot.idle{background:#d9a72b}
input,select{font:inherit;padding:8px 11px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%}
input[type=checkbox]{width:auto}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px;margin-top:12px}
.f{display:grid;gap:5px;font-size:12px;color:var(--muted)}.f>span{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.f i{font-style:normal;color:#94807a;font-size:11px}
.note{font-size:12.5px;color:var(--muted);line-height:1.6;margin:8px 0 0}.mono{font-family:ui-monospace,Consolas,monospace}
button{font:inherit;padding:8px 13px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.sw{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:14px 0 0;white-space:pre-wrap;font-size:12px;min-height:18px;color:var(--muted)}
@media (max-width:820px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.grid{grid-template-columns:1fr}body{padding:18px 14px 26px}}
</style></head><body><main>
<header class="top">
  <div><h1>画室</h1><p class="sub">六种后端 · 子插件分「画画」和「拍视频」</p></div>
  <div class="right"><button type="button" id="refresh">刷新</button><button type="button" class="primary" id="save">保存</button></div>
</header>

<section class="card">
  <h2>通用</h2>
  <div class="grid">
    <label class="f"><span>默认后端</span><select data-g="defaultBackend">${backendOptions}</select></label>
    <label class="f"><span>Python 解释器<i>看图/画蒙版用；留空自动找 ComfyUI 的 venv</i></span><input type="text" data-g="python" value="${esc(cfg.python)}"></label>
    <label class="f"><span>输出目录<i>相对插件 data 或绝对路径</i></span><input type="text" data-g="outputDir" value="${esc(cfg.outputDir)}"></label>
    <label class="f"><span>她的定妆照<i>一张本地图片路径。自拍时当参考图，锁住同一张脸（走 MOSS-Image Edit）</i></span><input type="text" data-g="faceRef" value="${esc(cfg.faceRef ?? '')}"></label>
    <label class="f"><span>她的角色 LoRA<i>文件名，比如 KOOK-MOSS-SFT-guanlan.safetensors。没填定妆照时靠它锁脸</i></span><input type="text" data-g="faceLora" value="${esc(cfg.faceLora ?? '')}"></label>
    <label class="f"><span>LoRA 强度<i>默认 0.85；脸不像就往上调，太像塑料就往下调</i></span><input type="number" step="0.05" min="0" max="1.5" data-g="faceLoraStrength" value="${esc(cfg.faceLoraStrength ?? 0.85)}"></label>
  </div>
</section>

${sections}

<section class="card">
  <h2>拍视频</h2>
  <p class="note">视频走 ComfyUI 的视频工作流（需要 SaveVideo / VHS_VideoCombine）；插件不按模型拼视频工作流。</p>
  <div class="grid">
    <label class="f"><span>后端</span><select data-v="backend">${videoOptions}</select></label>
    <label class="f"><span>工作流<i>comfy 用，留空用目录里第一个视频工作流</i></span><input type="text" data-v="workflow" value="${esc(cfg.video.workflow)}"></label>
    <label class="f"><span>宽</span><input type="number" data-v="width" value="${cfg.video.width}"></label>
    <label class="f"><span>高</span><input type="number" data-v="height" value="${cfg.video.height}"></label>
    <label class="f"><span>帧数<i>MiniMax-H3 常用 97（4n+1）</i></span><input type="number" data-v="length" value="${cfg.video.length}"></label>
    <label class="f"><span>超时（毫秒）</span><input type="number" data-v="timeoutMs" value="${cfg.video.timeoutMs}"></label>
  </div>
</section>

<pre id="out">改完点右上角保存，立即生效。</pre>
</main>
<script>
const out=document.getElementById('out');
const show=(value)=>out.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
const collect=()=>{
  const body={backends:{},video:{}};
  document.querySelectorAll('[data-g]').forEach(el=>{body[el.dataset.g]=el.value});
  document.querySelectorAll('[data-en]').forEach(el=>{body.backends[el.dataset.en]={enabled:el.checked}});
  document.querySelectorAll('[data-k]').forEach(el=>{
    const backend=el.id.split('.')[0];
    body.backends[backend]=body.backends[backend]||{};
    if(el.type==='checkbox') body.backends[backend][el.dataset.k]=el.checked;
    else if(el.type==='number') body.backends[backend][el.dataset.k]=Number(el.value)||undefined;
    else if(el.type==='password'){ if(el.value.trim()) body.backends[backend][el.dataset.k]=el.value.trim(); }
    else body.backends[backend][el.dataset.k]=el.value;
  });
  document.querySelectorAll('[data-v]').forEach(el=>{body.video[el.dataset.v]=el.type==='number'?Number(el.value)||undefined:el.value});
  return body;
};
document.getElementById('save').onclick=async()=>{
  show('保存中…');
  const res=await fetch('/plugins/studio/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(collect())});
  const json=await res.json().catch(()=>({ok:false,error:'返回不是 JSON'}));
  show(json.ok?'已保存。切到别的页面再回来可看到新状态。':'没存上：'+(json.error||''));
};
document.getElementById('refresh').onclick=()=>location.reload();
document.querySelectorAll('.test').forEach(btn=>{
  btn.onclick=async()=>{
    show('测试 '+btn.dataset.test+' …');
    const res=await fetch('/plugins/studio/health?name='+encodeURIComponent(btn.dataset.test));
    show(await res.json().catch(()=>({ok:false})));
  };
});
</script></body></html>`;
}
