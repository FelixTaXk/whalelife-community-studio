// 提示词小抄自测：不需要宿主，直接跑引擎 + 设置页 + 接口。
// 用法：node sub/promptkit/scripts/selftest.mjs
//
// 只用内存里的假 ctx，不读写用户的 data/config.json；唯一写盘的是「导入」那一项，
// 落在系统临时目录里，跑完即删。全过退出码 0，有失败退出码 1。
//
// 覆盖的关键约定：
// 1) 全量词库能读（25 类 / 2742 条），NSFW 有数量统计
// 2) NSFW 开关默认关：分类不可见、按分类查/挑会明确说「开关没开」
// 3) 打开开关：先确认（acknowledgeNsfw），否则 400；确认后可保存
// 4) 自动补词无论开关状态都不使用成人分类
// 5) 负面分类只给 search 用，不进 pick / recipe
// 6) 页面：开关、上锁、警告横幅、确认框都在
// 7) 用示例词库（或自己的词库坏了）时，工具结果会带 notice 说明，不再静默

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const LIB = join(PKG, 'data', 'prompts.json');
const SAMPLE = join(PKG, 'assets', 'prompts.sample.json');
const FORGE = process.env.FORGE_SRC || 'D:/dafeiyu/fish-extra/lib/forge-data.json';

const { createWordEngine } = await import('../../../lib/words.ts');
const { apply } = await import('../index.ts');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails++;
};

// ---------- 假 ctx ----------
const cfgFile = join(PKG, 'data', 'config.json');
let cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
const tools = new Map();
const pages = new Map();
const apis = new Map();
// 服务由本插件自己 provide（引擎归小抄所有），这里按宿主的方式收着。
const services = new Map();
const ctx = {
  apiVersion: '1.0.0',
  signal: new AbortController().signal,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  config: { read: async () => cfg, save: async (_n, v) => ((cfg = v), v) },
  get: (n) => services.get(n),
  provide: (name, value) => services.set(name, value),
  effect: () => () => {},
  optional: () => () => {},
  tools: { register: (t) => tools.set(t.name, t) },
  web: { page: (p, h) => pages.set(p, h), api: (p, h) => apis.set(p, h) },
};
apply(ctx);
const engine = services.get('promptkit');
ok('小抄自己注册 promptkit 服务', Boolean(engine) && typeof engine.search === 'function');

// ---------- 假 req / res ----------
const makeRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(k, v) {
    this.headers[k] = v;
  },
  end(b) {
    this.body = String(b ?? '');
  },
});
const makeReq = (payload) => {
  const text = payload === undefined ? '' : JSON.stringify(payload);
  return (async function* () {
    if (text) yield Buffer.from(text);
  })();
};
const call = async (path, payload) => {
  const res = makeRes();
  await apis.get(path)(makeReq(payload), res, { signal: { throwIfAborted() {} } });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 非 JSON（页面）时留给调用方 */
  }
  return { res, json };
};
const page = async () => {
  const res = makeRes();
  await pages.get('/plugins/studio/promptkit/settings')((async function* () {})(), res, {
    signal: { throwIfAborted() {} },
  });
  return res.body;
};

// ---------- 1. 词库 ----------
const lib = await engine.library();
const full = lib.tags > 1000;
ok('引擎能读到词库', lib.tags > 0, `${lib.tags} 条 / ${lib.categories} 类`);
if (full) {
  ok('全量词库读取正确', lib.tags === 2742 && lib.categories === 25, `${lib.tags} / ${lib.categories}`);
  ok('NSFW 数量统计正确', lib.nsfwTags === 475 && lib.nsfwCategories === 4, `${lib.nsfwTags} 条`);
} else {
  console.log('SKIP  全量词库断言（当前只有示例词库）');
}

// ---------- 2. 关闭态 ----------
cfg = { ...cfg, allowNsfw: false };
const catsOff = await engine.categories();
ok('关闭态：成人分类不可见', !catsOff.some((c) => /^nsfw/.test(c.id)), `${catsOff.length} 类可见`);
const denied = await engine.search({ query: 'x', category: 'nsfwbody' });
ok('关闭态：查成人分类明确说开关没开', denied.status === 'error' && denied.error.includes('NSFW'));
const deniedPick = await engine.pick({ category: 'nsfwbody' });
ok('关闭态：挑成人分类被拒', deniedPick.status === 'error' && deniedPick.error.includes('NSFW'));

// ---------- 3. 打开开关要确认 ----------
const noAck = await call('/plugins/studio/promptkit/config', { allowNsfw: true });
ok('未确认开启：400 + requireAck', noAck.res.statusCode === 400 && noAck.json?.requireAck === true);
ok('未确认开启：返回年轻/责任警告', String(noAck.json?.error ?? '').includes('18'));
const acked = await call('/plugins/studio/promptkit/config', { allowNsfw: true, acknowledgeNsfw: true });
ok('确认后可开启', acked.res.statusCode === 200 && cfg.allowNsfw === true);
const catsOn = await engine.categories();
ok('开启后：成人分类可见', catsOn.some((c) => c.id === 'nsfwbody'), `${catsOn.length} 类可见`);

// ---------- 4. 自动补词永不用成人分类 ----------
const enriched = await engine.enrich({ text: '窗边，逆光', kind: 'draw' });
ok('补词：不出现成人分类', enriched.added.every((a) => !/^nsfw/.test(a.cat)), JSON.stringify(enriched.added.map((a) => a.cat)));
const libTags = JSON.parse(readFileSync(full ? LIB : SAMPLE, 'utf8')).tags;
const nsfwEn = libTags.filter((t) => /^nsfw/.test(t.cat)).map((t) => String(t.en ?? '')).filter(Boolean);
ok('补词：正文里不含成人词条', !nsfwEn.some((w) => w && enriched.text.includes(w)));

// ---------- 5. 负面分类只给 search ----------
const pickNeg = await engine.pick({ category: 'negative' });
ok('pick：明确拒绝负面分类', pickNeg.status === 'error' && pickNeg.error.includes('prompt_search'));
const recipeNeg = await engine.recipe({});
ok('recipe：不出现负面分类', recipeNeg.layers.every((l) => l.category !== 'negative'));
const recipePatch = await call('/plugins/studio/promptkit/config', { recipeLayers: ['negative', 'style'] });
ok('服务端：剔除配方层里的负面分类', recipePatch.json?.ok === true && !cfg.recipeLayers.includes('negative'), JSON.stringify(cfg.recipeLayers));

// ---------- 6. 服务端过滤补词层 ----------
const layerPatch = await call('/plugins/studio/promptkit/config', { enrichLayers: ['style', 'negative', 'nsfwbody'] });
ok('服务端：剔除补词层里的负面/成人分类', layerPatch.json?.ok === true && cfg.enrichLayers.length === 1 && cfg.enrichLayers[0] === 'style', JSON.stringify(cfg.enrichLayers));

// ---------- 7. 页面 ----------
cfg = { ...cfg, allowNsfw: false };
let html = await page();
ok('页面：有 NSFW 开关', html.includes('id="allowNsfw"'));
ok('页面：关闭态警告隐藏', html.includes('id="nsfwWarn" hidden'));
ok('页面：关闭态成人分类整行隐藏', (html.match(/hidden><input type="checkbox" name="cat" value="nsfw/g) || []).length === 4);
ok('页面：关闭态补词提示不提成人分类', !html.includes('负面词和成人分类'));
ok('页面：不显示“正在用你自己的词库”横幅', !html.includes('正在用你自己的词库'));
ok('页面：负面分类在配方层禁用', /name="layer" value="negative"[^>]*disabled/.test(html));
ok('页面：开启要确认', html.includes('window.confirm'));
cfg = { ...cfg, allowNsfw: true };
html = await page();
ok('页面：开启后显示警告横幅', html.includes('id="nsfwWarn">🔞'));
ok('页面：开启后成人分类不再隐藏', !/hidden><input type="checkbox" name="cat" value="nsfw/.test(html));
ok('页面：开启后补词提示提到成人分类', html.includes('负面词和成人分类'));

// ---------- 8. 工具结果说明用哪份词库 ----------
const catsResult = await tools.get('prompt_categories').run();
ok('工具：结果带 library 信息', Boolean(catsResult.library) && typeof catsResult.library.tags === 'number', `tags=${catsResult.library?.tags}`);
if (catsResult.library?.sample || catsResult.library?.broken) {
  ok('工具：回退示例时带 notice', typeof catsResult.notice === 'string' && catsResult.notice.length > 0, catsResult.notice);
} else {
  ok('工具：用自己的词库时不加多余 notice', catsResult.notice === undefined);
}

// ---------- 9. 导入源数据 ----------
const tmp = mkdtempSync(join(tmpdir(), 'promptkit-selftest-'));
try {
  if (existsSync(FORGE)) {
    const imp = createWordEngine({ file: join(tmp, 'prompts.json'), sample: SAMPLE, readConfig: async () => ({}) });
    const imported = await imp.importLibrary(readFileSync(FORGE, 'utf8'));
    ok('导入：PromptForge 源数据（cats）可用', imported.tags === 2742, `${imported.tags} 条`);
    const written = JSON.parse(readFileSync(join(tmp, 'prompts.json'), 'utf8'));
    ok('导入：落盘用 categories 字段', Array.isArray(written.categories) && written.categories.length === 25);
    ok('导入：保留 source', String(written.source ?? '').length > 0);
    ok('导入：保留分类 icon', written.categories.some((c) => c.icon));
  } else {
    console.log('SKIP  导入断言（没找到 FORGE_SRC 源数据）');
  }
  // 空词库 → 回退示例
  const empty = createWordEngine({ file: join(tmp, 'none.json'), sample: SAMPLE, readConfig: async () => ({}) });
  const emptyLib = await empty.library();
  ok('空词库：回退示例', emptyLib.sample === true && emptyLib.tags === 140);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fails ? `FAILED ${fails} 项` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);
