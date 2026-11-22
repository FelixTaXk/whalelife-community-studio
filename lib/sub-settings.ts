/*! 画室 · 子插件设置页（画画 / 拍视频）共用样式与渲染。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

const esc = (value: any) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch]);

const BACKENDS: Array<[string, string]> = [
  ['comfy', 'ComfyUI（本机）'],
  ['sdwebui', 'SD-WebUI（A1111 / Forge / SD.Next）'],
  ['openai', 'OpenAI 兼容'],
  ['gemini', 'Gemini'],
  ['dashscope', '通义万相'],
];

type PageShellOptions = {
  title: string;
  subtitle: string;
  active: 'image' | 'video' | 'promptkit';
  body: string;
  status?: string;
};

function shell(data: PageShellOptions) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.title)} · 画室</title>
<style>
:root{color-scheme:light dark;font:15px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;background:var(--soft);color:var(--ink)}
@media (prefers-color-scheme:dark){:root{--ink:#e4ecee;--muted:#9aadb2;--line:#2d3b3f;--paper:#1b2427;--soft:#151b1d;--accent:#5cb5ad}}
*{box-sizing:border-box}body{margin:0;padding:30px 26px 40px}main{max-width:920px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:10px}
h1{font-size:26px;letter-spacing:-.4px;margin:0 0 4px;font-weight:650}p.sub{margin:0;color:var(--muted);font-size:13px}
nav{display:flex;gap:14px;margin:14px 0 6px;font-size:13px}nav a{color:var(--muted);text-decoration:none;padding-bottom:5px;border-bottom:2px solid transparent}
nav a.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
section.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
h2{font-size:15px;margin:0 0 4px}h3{font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600}
p.hint{margin:4px 0 10px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;align-items:start}
.grid .wide{grid-column:1/-1}
label.f{display:flex;flex-direction:column;gap:5px;font-size:13px;min-width:0}label.f span{color:var(--muted)}label.f i{color:var(--muted);font-size:12px;font-style:normal}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);width:100%;height:40px;min-width:0;box-sizing:border-box;line-height:1.5;vertical-align:middle}
textarea{resize:vertical;min-height:62px;height:auto;line-height:1.55}
select{cursor:pointer}
input[type=number]{font-variant-numeric:tabular-nums}
input:disabled{opacity:.6}textarea:disabled{opacity:.6}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:9px 14px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.tiny{padding:6px 10px;font-size:12px}
a.plain{color:var(--accent);text-decoration:none}
#msg{min-height:22px;margin-top:10px;font-size:13px;color:var(--accent)}#msg.bad{color:#b23c3c}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.stat{border:1px solid var(--line);border-radius:10px;padding:9px 12px;min-width:132px;background:var(--soft)}
.stat b{display:block;font-size:17px;margin-top:2px}.stat span{font-size:12px;color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.chip.ok{color:#0f6b3f;border-color:#b6dcc6;background:#eef8f1}.chip.bad{color:#8a3b2e;border-color:#e4c2bb;background:#fbefed}
@media(max-width:680px){.grid{grid-template-columns:1fr}body{padding:18px 14px 26px}}
</style></head><body><main>
<header><div><h1>${esc(data.title)}</h1><p class="sub">${esc(data.subtitle)}</p></div></header>
${data.status || ''}
${data.body}
<div id="msg"></div>
<script>
async function save(patch, btn) {
  const msg = document.querySelector('#msg');
  btn.disabled = true;
  try {
    const res = await fetch(location.pathname + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    msg.className = '';
    msg.textContent = '已保存，立即生效';
  } catch (error) {
    msg.className = 'bad';
    msg.textContent = '保存失败：' + error.message;
  } finally {
    btn.disabled = false;
  }
}
</script>
</main></body></html>`;
}

function backendOptions(current: string) {
  return BACKENDS.map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('');
}

function workflowOptions(workflows: any[], current: string) {
  const usable = workflows.filter((item) => !item.error);
  const lines = ['<option value="">（不指定，按模型现场拼）</option>'];
  for (const item of usable) lines.push(`<option value="${esc(item.name)}"${item.name === current ? ' selected' : ''}>${esc(item.name)}${item.format === 'canvas' ? '（画布）' : ''}</option>`);
  if (current && !usable.some((item) => item.name === current)) lines.push(`<option value="${esc(current)}" selected>${esc(current)}（当前配置）</option>`);
  return lines.join('');
}

function healthChip(health: any) {
  if (!health) return '<span class="chip">没体检</span>';
  if (health.online === true) return `<span class="chip ok">● 已连接${health.version ? ' ' + esc(health.version) : ''}</span>`;
  if (health.online === false) return `<span class="chip bad">● 连不上</span>`;
  return '<span class="chip">● 提交时才知道</span>';
}

export type ImageSettingsInput = {
  cfg: any;
  paths: any;
  workflows: any[];
  models: any;
  health: any;
  llmModels?: Array<{ id: string; name: string; model: string; provider: string; callable: boolean }>;
};

function personaArea(id: string, label: string, value: any, hint: string): string {
  return `<label class="f wide"><span>${esc(label)}<i>${esc(hint)}</i></span><textarea id="${esc(id)}" rows="2">${esc(value)}</textarea></label>`;
}

function personaList(id: string, label: string, value: any, hint: string): string {
  return `<label class="f wide"><span>${esc(label)}<i>${esc(hint)}</i></span><textarea id="${esc(id)}" rows="2">${esc(Array.isArray(value) ? value.join('，') : value)}</textarea></label>`;
}

export function renderImageSettings(data: ImageSettingsInput) {
  const cfg = data.cfg;
  const comfy = cfg.backends.comfy;
  const persona = cfg.persona || {};
  const integrations = cfg.integrations || {};
  const modelNames = [...(data.models?.checkpoints ?? []), ...(data.models?.unets ?? [])].map((item: any) => item.name);
  const counts = {
    checkpoints: data.models?.checkpoints?.length ?? 0,
    unets: data.models?.unets?.length ?? 0,
    vaes: data.models?.vaes?.length ?? 0,
    clips: data.models?.clips?.length ?? 0,
    loras: data.models?.loras?.length ?? 0,
  };
  const chatModels = (data.llmModels || []).filter((item) => item.callable);
  const chatOptions = chatModels.length
    ? chatModels.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.model)}</option>`).join('')
    : '<option value="">（没有可用的对话模型）</option>';
  const body = `
<section class="card">
  <h2>出图默认</h2>
  <p class="hint">这里改全局默认后端、ComfyUI 默认工作流与输出目录。单次 <code>draw</code> 传了参数就以参数为准。</p>
  <div class="grid">
    <label class="f"><span>默认后端</span><select id="defaultBackend">${backendOptions(cfg.defaultBackend)}</select><i>体检<code>draw</code>不指定 backend 时走它</i></label>
    <label class="f"><span>当前后端状态</span><div style="padding-top:6px">${healthChip(data.health)}</div><i>${esc(data.health?.reason || '')}</i></label>
    <label class="f"><span>ComfyUI 默认工作流</span><select id="workflow">${workflowOptions(data.workflows, comfy.workflow)}</select><i>留空时给 model 就按模型家族现场拼</i></label>
    <label class="f"><span>默认尺寸</span><input id="size" value="${esc(comfy.size || '')}" placeholder="832x1216"><i>写 <code>宽x高</code>；单次 draw 的 width/height 优先</i></label>
    <label class="f"><span>默认模型</span><input id="model" list="modelList" value="${esc(comfy.model || '')}" placeholder="网络后端 / SD-WebUI 用"><datalist id="modelList">${modelNames.map((name: string) => `<option value="${esc(name)}">`).join('')}</datalist><i>ComfyUI 出图请优先选工作流；否则 draw 时传 model</i></label>
    <label class="f"><span>输出目录</span><input id="outputDir" value="${esc(cfg.outputDir || '')}" placeholder="data/out"><i>相对插件 data 或绝对路径</i></label>
  </div>
  <div class="row"><button class="primary" id="saveImg">保存出图设置</button><span class="hint">改完重新出图即可，不用重载插件</span></div>
</section>

<section class="card">
  <h2>人设与场景</h2>
  <p class="hint">只影响「自拍 / 自画像 / 随手拍」等有人物的场景。全部留空时用不绑定具体人的通用文案；填了就是你这个角色。</p>
  <div class="grid" style="margin-bottom:12px">
    <label class="f wide"><span>想让她是什么样<i>可选。给 AI 一句方向，留空就按现有字段补全</i></span><textarea id="aiBrief" rows="2" placeholder="例如：17 岁中国女高中生，清冷安静，爱画画，常穿校服"></textarea></label>
    <label class="f"><span>AI 生成模型<i>用本体配置的对话模型</i></span><select id="aiModel">${chatOptions}</select></label>
    <div class="f"><span>一键生成<i>生成后直接填进下面字段，不会自动保存</i></span><div class="row" style="margin:0"><button type="button" class="primary tiny" id="aiPersonaBtn"${chatModels.length ? '' : ' disabled'}>AI 一键生成人设提示词</button></div></div>
  </div>
  <div class="grid">
    ${personaArea('pAppearance', '外观', persona.appearance, '年龄、性别、身高、发型、脸型等')}
    ${personaArea('pOutfit', '默认穿搭', persona.defaultOutfit, '衣柜没给结果时用这套')}
    <label class="f"><span>标志性道具<i>例如画本、吉他；留空就不带</i></span><input id="pProp" value="${esc(persona.prop || '')}"></label>
    ${personaArea('pSelfieScene', '自拍默认场景', persona.selfieFallbackScene, '日程读不到时用这个')}
    ${personaArea('pSnapshotScene', '随手拍默认场景', persona.snapshotFallbackScene, '日程读不到时用这个')}
    ${personaArea('pPainterStyle', '画者说明', persona.painterStyle, '自画像/画画时追加；留空用通用业余画者')}
    ${personaArea('pPaintSubject', '画画固定主体', persona.paintFallbackSubject, '留空随机挑；填了就一直画这个')}
    ${personaList('pRandomSubjects', '随机主体池', persona.randomSubjects, '逗号分隔；画画没给主体时随机挑')}
    ${personaList('pPaintStyles', '随机画风池', persona.paintStyles, '逗号分隔：watercolor / sketch / illustration')}
  </div>
  <div class="row"><button class="primary" id="savePersona">保存人设与场景</button><span class="hint">提示词是英文就继续用英文，模型更稳。</span></div>
</section>

<section class="card">
  <h2>参考图与锁脸</h2>
  <p class="hint">自拍、自画像会优先拿这张参考图做编辑；没有参考图时靠角色 LoRA。路径相对插件根目录或绝对路径。</p>
  <div class="grid">
    <label class="f"><span>定妆照 / 参考图</span><input id="faceRef" value="${esc(cfg.faceRef || '')}" placeholder="data/face.png"></label>
    <label class="f"><span>角色 LoRA</span><input id="faceLora" value="${esc(cfg.faceLora || '')}" placeholder="文件名；没填参考图时靠它锁脸"></label>
    <label class="f"><span>LoRA 强度</span><input id="faceLoraStrength" type="number" step="0.05" min="0" max="1.5" value="${esc(cfg.faceLoraStrength ?? 0.85)}"><i>默认 0.85；脸不像就往上调</i></label>
  </div>
  <div class="row"><button class="primary" id="saveFace">保存参考图与锁脸</button></div>
</section>

<section class="card">
  <h2>日程与衣柜联动</h2>
  <p class="hint">默认关闭。开启后，自拍和随手拍会自动把当天日程、穿搭补进提示词；用户自己写的内容优先。路径相对 plugins 根目录或写绝对路径。</p>
  <div class="grid">
    <label class="f"><span>读日程</span><select id="scheduleEnabled"><option value="1"${integrations.schedule?.enabled ? ' selected' : ''}>开启</option><option value="0"${integrations.schedule?.enabled ? '' : ' selected'}>关闭</option></select><i>schedule 插件的 days 目录</i></label>
    <label class="f"><span>日程目录</span><input id="scheduleDir" value="${esc(integrations.schedule?.dataDir || '')}" placeholder="schedule/data/days"></label>
    <label class="f"><span>读衣柜</span><select id="wardrobeEnabled"><option value="1"${integrations.wardrobe?.enabled ? ' selected' : ''}>开启</option><option value="0"${integrations.wardrobe?.enabled ? '' : ' selected'}>关闭</option></select><i>wardrobe 插件的 data 目录</i></label>
    <label class="f"><span>衣柜目录</span><input id="wardrobeDir" value="${esc(integrations.wardrobe?.dataDir || '')}" placeholder="schedule/sub/wardrobe/data"></label>
    <label class="f"><span>衣柜 personaId</span><input id="wardrobePersona" value="${esc(integrations.wardrobe?.personaId || '')}" placeholder="留空取第一个 persona"></label>
    <label class="f wide"><span>场景细节池<i>逗号分隔；补光、天气、氛围用</i></span><textarea id="sceneDetails" rows="2">${esc(Array.isArray(integrations.sceneDetails) ? integrations.sceneDetails.join('，') : integrations.sceneDetails || '')}</textarea></label>
  </div>
  <div class="row"><button class="primary" id="saveIntegrations">保存日程与衣柜</button></div>
</section>

<section class="card">
  <h2>本机资源</h2>
  <p class="hint">模型清单从运行中的 ComfyUI <code>/object_info</code> 网络读取，不扫本地目录；工作流同时扫插件目录和 ComfyUI 画布目录。</p>
  <div class="stats">
    <div class="stat"><span>checkpoint</span><b>${counts.checkpoints}</b></div>
    <div class="stat"><span>unet</span><b>${counts.unets}</b></div>
    <div class="stat"><span>VAE</span><b>${counts.vaes}</b></div>
    <div class="stat"><span>文本编码器</span><b>${counts.clips}</b></div>
    <div class="stat"><span>LoRA</span><b>${counts.loras}</b></div>
    <div class="stat"><span>可用工作流</span><b>${data.workflows.filter((item) => !item.error).length}</b></div>
  </div>
  <div class="grid" style="margin-top:14px">
    <label class="f"><span>模型目录</span><input value="${esc(data.paths.modelsDir || comfy.modelsDir || '')}" disabled></label>
    <label class="f"><span>画布工作流目录</span><input value="${esc(data.paths.canvasDir || comfy.canvasDir || '')}" disabled></label>
    <label class="f"><span>插件工作流目录</span><input value="${esc(data.paths.workflowsDir || '')}" disabled></label>
    <label class="f"><span>Python（看图 / 画蒙版）</span><input id="python" value="${esc(cfg.python || '')}" placeholder="留空自动找 ComfyUI venv"></label>
  </div>
  <div class="row"><button id="savePath">保存目录与 Python</button></div>
</section>

<script>
const splitList = (value) => String(value || '').split(/[,，\\n]/).map((item) => item.trim()).filter(Boolean);
document.querySelector('#saveImg').onclick = (event) => save({
  defaultBackend: document.querySelector('#defaultBackend').value,
  outputDir: document.querySelector('#outputDir').value,
  backends: { comfy: {
    workflow: document.querySelector('#workflow').value,
    model: document.querySelector('#model').value,
    size: document.querySelector('#size').value,
  } },
}, event.currentTarget);
document.querySelector('#savePersona').onclick = (event) => save({
  persona: {
    appearance: document.querySelector('#pAppearance').value,
    defaultOutfit: document.querySelector('#pOutfit').value,
    prop: document.querySelector('#pProp').value,
    selfieFallbackScene: document.querySelector('#pSelfieScene').value,
    snapshotFallbackScene: document.querySelector('#pSnapshotScene').value,
    painterStyle: document.querySelector('#pPainterStyle').value,
    paintFallbackSubject: document.querySelector('#pPaintSubject').value,
    randomSubjects: splitList(document.querySelector('#pRandomSubjects').value),
    paintStyles: splitList(document.querySelector('#pPaintStyles').value),
  },
}, event.currentTarget);
document.querySelector('#saveFace').onclick = (event) => save({
  faceRef: document.querySelector('#faceRef').value,
  faceLora: document.querySelector('#faceLora').value,
  faceLoraStrength: Number(document.querySelector('#faceLoraStrength').value),
}, event.currentTarget);
document.querySelector('#saveIntegrations').onclick = (event) => save({
  integrations: {
    schedule: { enabled: document.querySelector('#scheduleEnabled').value === '1', dataDir: document.querySelector('#scheduleDir').value },
    wardrobe: { enabled: document.querySelector('#wardrobeEnabled').value === '1', dataDir: document.querySelector('#wardrobeDir').value, personaId: document.querySelector('#wardrobePersona').value },
    sceneDetails: splitList(document.querySelector('#sceneDetails').value),
  },
}, event.currentTarget);
document.querySelector('#savePath').onclick = (event) => save({
  python: document.querySelector('#python').value,
}, event.currentTarget);
const aiBtn = document.querySelector('#aiPersonaBtn');
if (aiBtn) aiBtn.onclick = async () => {
  const msg = document.querySelector('#msg');
  aiBtn.disabled = true;
  msg.className = '';
  msg.textContent = 'AI 正在生成人设提示词…';
  try {
    const res = await fetch(location.pathname + '/ai-persona', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: document.querySelector('#aiModel').value,
        brief: document.querySelector('#aiBrief').value,
        persona: {
          appearance: document.querySelector('#pAppearance').value,
          defaultOutfit: document.querySelector('#pOutfit').value,
          prop: document.querySelector('#pProp').value,
          selfieFallbackScene: document.querySelector('#pSelfieScene').value,
          snapshotFallbackScene: document.querySelector('#pSnapshotScene').value,
          painterStyle: document.querySelector('#pPainterStyle').value,
          paintFallbackSubject: document.querySelector('#pPaintSubject').value,
          randomSubjects: splitList(document.querySelector('#pRandomSubjects').value),
          paintStyles: splitList(document.querySelector('#pPaintStyles').value),
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    const p = data.persona || {};
    const put = (id, value) => { if (value !== undefined && value !== null) document.querySelector(id).value = Array.isArray(value) ? value.join('，') : value; };
    put('#pAppearance', p.appearance); put('#pOutfit', p.defaultOutfit); put('#pProp', p.prop);
    put('#pSelfieScene', p.selfieFallbackScene); put('#pSnapshotScene', p.snapshotFallbackScene);
    put('#pPainterStyle', p.painterStyle); put('#pPaintSubject', p.paintFallbackSubject);
    put('#pRandomSubjects', p.randomSubjects); put('#pPaintStyles', p.paintStyles);
    msg.textContent = '生成完成，检查一下再点「保存人设与场景」';
  } catch (error) {
    msg.className = 'bad';
    msg.textContent = '生成失败：' + error.message;
  } finally {
    aiBtn.disabled = false;
  }
};
</script>`;
  return shell({ title: '画画设置', subtitle: '出图默认、人设、参考图、日程衣柜与本机资源', active: 'image', body, status: '' });
}

export type VideoSettingsInput = {
  cfg: any;
  paths: any;
  workflows: any[];
  health: any;
};

export function renderVideoSettings(data: VideoSettingsInput) {
  const cfg = data.cfg;
  const video = cfg.video;
  const body = `
<section class="card">
  <h2>视频参数</h2>
  <p class="hint">只影响没显式传参的 <code>make_video</code>。视频工作流里的自定义节点多，默认工作流建议用已经跑通过的那份。</p>
  <div class="grid">
    <label class="f"><span>视频后端</span><select id="backend">${backendOptions(video.backend)}</select><i>目前只有 ComfyUI 的工作流能出视频</i></label>
    <label class="f"><span>后端状态</span><div style="padding-top:6px">${healthChip(data.health)}</div><i>${esc(data.health?.reason || '')}</i></label>
    <label class="f"><span>默认工作流</span><select id="workflow">${workflowOptions(data.workflows, video.workflow)}</select><i>只列视频工作流；留空则必须在 make_video 里传 workflow</i></label>
    <label class="f"><span>超时（分钟）</span><input id="timeout" type="number" min="1" max="60" value="${Math.round((Number(video.timeoutMs) || 0) / 60000)}"><i>一条片子几分钟很正常，默认 40 分钟</i></label>
  </div>
  <h3>画面</h3>
  <div class="grid">
    <label class="f"><span>宽</span><input id="width" type="number" min="64" max="2048" step="8" value="${Number(video.width) || 864}"></label>
    <label class="f"><span>高</span><input id="height" type="number" min="64" max="2048" step="8" value="${Number(video.height) || 480}"></label>
    <label class="f"><span>帧数</span><input id="length" type="number" min="1" max="500" value="${Number(video.length) || 124}"><i>帧数按工作流要求填；有的模型要 4n+1（如 97 或 121）</i></label>
  </div>
  <div class="row"><button class="primary" id="saveVideo">保存视频设置</button><span class="hint">宽高和帧数会被写进请求；工作流里写死的值不受影响</span></div>
</section>

<section class="card">
  <h2>可用视频工作流</h2>
  <p class="hint">同时扫插件 <code>${esc(data.paths.workflowsDir || '')}</code> 与 ComfyUI 画布目录。带「画布」的会自动转成 API 再用。</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="color:var(--muted)"><th style="text-align:left;padding:6px 8px">名称</th><th style="text-align:left;padding:6px 8px">格式</th><th style="text-align:left;padding:6px 8px">槽位 / 说明</th></tr>
    ${data.workflows.map((item) => `<tr style="border-top:1px solid var(--line)"><td style="padding:6px 8px"><code>${esc(item.name)}</code></td><td style="padding:6px 8px">${item.format === 'canvas' ? '画布' : 'API'}</td><td style="padding:6px 8px;color:var(--muted)">${item.error ? esc(item.error) : esc(item.slots || '')}</td></tr>`).join('') || '<tr><td colspan="3" style="padding:10px 8px;color:var(--muted)">还没有视频工作流，放到插件 workflows 或 ComfyUI 画布目录后刷新。</td></tr>'}
  </table>
</section>

<script>
document.querySelector('#saveVideo').onclick = (event) => save({
  video: {
    backend: document.querySelector('#backend').value,
    workflow: document.querySelector('#workflow').value,
    width: Number(document.querySelector('#width').value),
    height: Number(document.querySelector('#height').value),
    length: Number(document.querySelector('#length').value),
    timeoutMs: Math.round(Number(document.querySelector('#timeout').value) * 60000),
  },
}, event.currentTarget);
</script>`;
  return shell({ title: '拍视频设置', subtitle: '默认后端、工作流与画面参数；任务进度用 video_task 查', active: 'video', body });
}
