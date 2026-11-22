// 提示词小抄自测：不需要宿主，也不需要任何本机词库。
// 用法：node scripts/selftest.mjs
//
// 全部使用临时目录里的合成词库；唯一写盘的就是导入测试，落在系统临时目录，跑完即删。
// 覆盖：引擎读取、成人门控与确认、负面分类隔离、自动补词、设置页、接口、导入、回退。
// 全过退出码 0，有失败退出码 1。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const tmp = mkdtempSync(join(tmpdir(), 'promptkit-selftest-'));
const dataFile = join(tmp, 'prompts.json');
const sampleFile = join(tmp, 'prompts.sample.json');
const brokenFile = join(tmp, 'broken.json');
const importedFile = join(tmp, 'imported.json');

const sampleData = {
  version: 1,
  license: 'CC0-1.0',
  categories: [
    { id: 'quality', name: '质量', role: 'quality' },
    { id: 'scene', name: '场景' },
  ],
  tags: [
    { cat: 'quality', en: 'masterpiece', zh: '杰作' },
    { cat: 'scene', en: 'backlight', zh: '逆光' },
  ],
};
const fullData = {
  version: 1,
  categories: [
    { id: 'quality', name: '质量', role: 'quality' },
    { id: 'scene', name: '场景' },
    { id: 'adult', name: '成人', nsfw: true },
    { id: 'bad', name: '负面', role: 'negative' },
  ],
  tags: [
    { cat: 'quality', en: 'masterpiece', zh: '杰作' },
    { cat: 'quality', en: 'anime style', zh: '动画风' },
    { cat: 'scene', en: 'backlight', zh: '逆光' },
    { cat: 'scene', en: 'window', zh: '窗' },
    { cat: 'adult', en: 'adult word', zh: '成人词' },
    { cat: 'bad', en: 'low quality', zh: '低质量' },
  ],
};
writeFileSync(sampleFile, JSON.stringify(sampleData, null, 2), 'utf8');
writeFileSync(dataFile, JSON.stringify(fullData, null, 2), 'utf8');
writeFileSync(brokenFile, '{ not json', 'utf8');

process.env.PROMPTKIT_DATA_FILE = dataFile;
process.env.PROMPTKIT_SAMPLE_FILE = sampleFile;

const { createWordEngine } = await import(pathToFileURL(join(PKG, '..', '..', 'lib', 'words.ts')).href);
const { apply } = await import(pathToFileURL(join(PKG, 'index.ts')).href);

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails++;
};

const cfgFile = join(PKG, 'data', 'config.json');
const baseConfig = {
  lang: 'primary',
  pickCount: 3,
  disabledCategories: [],
  recipeLayers: ['quality', 'scene'],
  recipeMaxLayers: 6,
  autoEnrich: true,
  enrichKinds: ['*'],
  enrichLayers: ['quality', 'scene'],
  enrichCount: 3,
  allowNsfw: false,
  negativePrompt: '',
  fields: { primary: 'en', secondary: 'zh' },
  semantics: { negative: 'bad', quality: 'quality', nsfwPrefix: 'adult' },
  qualityAllowlist: ['masterpiece'],
  blockedPatterns: [],
};
let cfg = structuredClone(baseConfig);

const tools = new Map();
const pages = new Map();
const apis = new Map();
const services = new Map();
const ctx = {
  apiVersion: '1.0.0',
  signal: new AbortController().signal,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  config: { read: async () => structuredClone(cfg), save: async (_name, value) => ((cfg = structuredClone(value)), value) },
  get: (name) => services.get(name),
  provide: (name, value) => services.set(name, value),
  effect: () => () => {},
  optional: () => () => {},
  tools: { register: (tool) => tools.set(tool.name, tool) },
  web: { page: (path, handler) => pages.set(path, handler), api: (path, handler) => apis.set(path, handler) },
};
const parentEngine = createWordEngine({ file: dataFile, sample: sampleFile, readConfig: async () => structuredClone(cfg) });
services.set('promptkit', parentEngine);
await apply(ctx);
const engine = services.get('promptkit');
ok('子插件复用父级词库服务', engine === parentEngine && typeof engine.search === 'function');

const makeRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(key, value) {
    this.headers[key] = value;
  },
  end(body) {
    this.body = String(body ?? '');
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
    /* 非 JSON */
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
ok('引擎能读到词库', lib.tags === 6 && lib.categories === 4, `${lib.tags} 条 / ${lib.categories} 类`);
ok('成人分类数量按标记统计', lib.nsfwCategories === 1 && lib.nsfwTags === 1, `${lib.nsfwTags} 条`);

// ---------- 2. 关闭态 ----------
const catsOff = await engine.categories();
ok('关闭态：成人分类不可见', !catsOff.some((c) => c.id === 'adult'), `${catsOff.length} 类可见`);
const denied = await engine.search({ query: 'adult', category: 'adult' });
ok('关闭态：查成人分类明确说开关没开', denied.status === 'error' && denied.error.includes('成人'));
const deniedPick = await engine.pick({ category: 'adult' });
ok('关闭态：挑成人分类被拒', deniedPick.status === 'error' && deniedPick.error.includes('成人'));

// ---------- 3. 打开开关要确认 ----------
const noAck = await call('/plugins/studio/promptkit/config', { allowNsfw: true });
ok('未确认开启：400 + requireAck', noAck.res.statusCode === 400 && noAck.json?.requireAck === true);
ok('未确认开启：返回责任警告', String(noAck.json?.error ?? '').includes('18'));
const acked = await call('/plugins/studio/promptkit/config', { allowNsfw: true, acknowledgeNsfw: true });
ok('确认后可开启', acked.res.statusCode === 200 && cfg.allowNsfw === true);
const catsOn = await engine.categories();
ok('开启后：成人分类可见', catsOn.some((c) => c.id === 'adult'), `${catsOn.length} 类可见`);

// ---------- 4. 自动补词 ----------
const enriched = await engine.enrich({ text: '逆光，窗', kind: 'anything' });
ok('补词：副字段换主字段', enriched.text.includes('backlight') && enriched.text.includes('window'), enriched.text);
ok('补词：质量分类按白名单收窄', enriched.text.includes('masterpiece') && !enriched.text.includes('anime style'), enriched.text);
ok('补词：不出现成人分类', enriched.added.every((item) => item.cat !== 'adult'), JSON.stringify(enriched.added));
ok('补词：动作白名单 * 对任意 kind 生效', enriched.added.length > 0);

// ---------- 5. 负面词单独管 ----------
const pickNeg = await engine.pick({ category: 'bad' });
ok('pick：拒绝负面分类并指向共用负面', pickNeg.status === 'error' && pickNeg.error.includes('负面'));
const recipe = await engine.recipe({});
ok('recipe：不出现负面分类', recipe.layers.every((layer) => layer.category !== 'bad'));
const recipePatch = await call('/plugins/studio/promptkit/config', { recipeLayers: ['bad', 'quality'] });
ok('服务端：剔除配方层里的负面分类', recipePatch.json?.ok === true && !cfg.recipeLayers.includes('bad'), JSON.stringify(cfg.recipeLayers));
const catsAll = await engine.categories();
ok('分类列表里没有负面分类', !catsAll.some((c) => c.id === 'bad'), `${catsAll.length} 类`);

// ---------- 6. 共用负面 ----------
ok('默认没有共用负面', (await engine.negativePrompt()) === '');
const negSaved = await call('/plugins/studio/promptkit/config', { negativePrompt: '  low quality, blurry  ' });
ok('共用负面能保存（自动去空格）', negSaved.json?.ok === true && (await engine.negativePrompt()) === 'low quality, blurry');
const negTooLong = await call('/plugins/studio/promptkit/config', { negativePrompt: 'x'.repeat(4001) });
ok('共用负面超长会被拒', negTooLong.res.statusCode === 400 && String(negTooLong.json?.error ?? '').includes('4000'));
await call('/plugins/studio/promptkit/config', { negativePrompt: '' });

// ---------- 7. 服务端过滤补词层与自定义语义 ----------
const layerPatch = await call('/plugins/studio/promptkit/config', { enrichLayers: ['quality', 'bad', 'adult'] });
ok('服务端：剔除补词层里的负面/成人分类', layerPatch.json?.ok === true && cfg.enrichLayers.length === 1 && cfg.enrichLayers[0] === 'quality', JSON.stringify(cfg.enrichLayers));
const custom = await call('/plugins/studio/promptkit/config', {
  fields: { primary: 'prompt', secondary: 'cn' },
  semantics: { negative: 'bad', quality: 'quality', nsfwPrefix: 'adult' },
});
ok('服务端：字段与语义可改', custom.json?.ok === true && cfg.fields.primary === 'prompt' && cfg.fields.secondary === 'cn');

// ---------- 8. 页面 ----------
cfg.allowNsfw = false;
let html = await page();
ok('页面：有动作白名单输入', html.includes('id="enrichKinds"'));
ok('页面：无跨设置跳转', !html.includes('/plugins/studio/settings') && !html.includes('/plugins/studio/image/settings'));
ok('页面：有字段与语义设置', html.includes('id="fieldPrimary"') && html.includes('id="semNegative"'));
ok('页面：有 NSFW 开关', html.includes('id="allowNsfw"'));
ok('页面：关闭态警告隐藏', html.includes('id="nsfwWarn" hidden'));
ok('页面：关闭态成人分类隐藏', (html.match(/hidden><input type="checkbox" name="cat" value="adult"/g) || []).length === 1);
let scriptOk = true;
try {
  new Function(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')));
} catch {
  scriptOk = false;
}
ok('页面：内联脚本语法可解析', scriptOk);
cfg.allowNsfw = true;
html = await page();
ok('页面：开启后显示警告横幅', html.includes('id="nsfwWarn">🔞'));
ok('页面：开启后成人分类不再隐藏', !/hidden><input type="checkbox" name="cat" value="adult"/.test(html));

// ---------- 9. 工具结果 ----------
const catsResult = await tools.get('prompt_categories').run();
ok('工具：结果带 library 信息', Boolean(catsResult.library) && typeof catsResult.library.tags === 'number', `tags=${catsResult.library?.tags}`);

// ---------- 10. 导入与回退 ----------
const imp = createWordEngine({ file: importedFile, sample: sampleFile, readConfig: async () => ({ fields: { primary: 'prompt', secondary: 'cn' }, semantics: { negative: 'bad', quality: 'quality', nsfwPrefix: 'adult' } }) });
const imported = await imp.importLibrary(JSON.stringify({
  cats: [{ id: 'c', name: 'C' }],
  tags: [{ cat: 'c', prompt: 'foo', cn: '福' }],
}));
ok('导入：上游 cats 字段可用', imported.tags === 1 && imported.categories === 1, `${imported.tags} 条`);
const written = JSON.parse(readFileSync(importedFile, 'utf8'));
ok('导入：落盘用 categories 字段', Array.isArray(written.categories) && written.categories[0].id === 'c');
ok('导入：自定义词条字段原样保留', written.tags[0].prompt === 'foo' && written.tags[0].cn === '福');
const customSearch = await imp.search({ query: '福' });
ok('导入：自定义字段能查', customSearch.status === 'ok' && customSearch.tags[0]?.text === 'foo', JSON.stringify(customSearch.tags?.[0]));

const empty = createWordEngine({ file: join(tmp, 'none.json'), sample: sampleFile, readConfig: async () => ({}) });
const emptyLib = await empty.library();
ok('空词库：回退示例', emptyLib.sample === true && emptyLib.tags === 2, `${emptyLib.tags} 条`);

writeFileSync(join(tmp, 'broken.json'), '{ not json', 'utf8');
const broken = createWordEngine({ file: brokenFile, sample: sampleFile, readConfig: async () => ({}) });
const brokenLib = await broken.library();
ok('坏词库：回退示例并标记 broken', brokenLib.sample === true && brokenLib.broken === true, `${brokenLib.tags} 条`);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails ? `FAILED ${fails} 项` : 'ALL PASS'}`);
process.exit(fails ? 1 : 0);

