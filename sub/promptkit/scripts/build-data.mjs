// 把一份外部词库整理成提示词小抄认的 JSON 格式。
//
// 用法：
//   node scripts/build-data.mjs --source <词库.json> [--out data/prompts.json]
//                               [--only 分类1,分类2] [--exclude 分类3]
//
// 说明：
// 1) 源数据可以是本插件的 {categories,tags}，也可以是常见上游的 {cats,tags}。
// 2) 词条里除 cat / category / id 之外的字符串字段都会原样保留，字段名由插件配置决定，
//    不要求必须叫 zh / en。
// 3) 不内置任何删类或词条黑名单；要筛分类请用 --only / --exclude。
// 4) 只读源文件。输出默认写到插件自己的 data/prompts.json；data/ 不会进发布包。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');

function usage(message = '') {
  if (message) console.error(`\n${message}`);
  console.error(`
用法：
  node scripts/build-data.mjs --source <词库.json> [--out data/prompts.json]
                              [--only 分类1,分类2] [--exclude 分类3]

  --source    必填。源词库路径，支持 {categories,tags} 或 {cats,tags}。
  --out       可选。输出路径，默认 data/prompts.json。
  --only      可选。只保留这些分类 id，逗号分隔。
  --exclude   可选。排除这些分类 id，逗号分隔。
`);
  process.exit(1);
}

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) usage(`${name} 后面要跟一个值`);
  return value;
}

function listArg(name) {
  return String(argValue(name, ''))
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

let source = argValue('--source', '');
if (!source) {
  const positional = process.argv.slice(2).find((item) => !item.startsWith('--') && !process.argv[process.argv.indexOf(item) - 1]?.startsWith('--'));
  source = positional || '';
}
if (!source) usage('缺少 --source <词库.json>');
source = resolve(source);
if (!existsSync(source)) usage(`源文件不存在：${source}`);

const out = resolve(argValue('--out', join(PKG, 'data', 'prompts.json')));
const only = listArg('--only');
const exclude = listArg('--exclude');

const raw = JSON.parse(readFileSync(source, 'utf8'));
const sourceCategories = Array.isArray(raw.categories) ? raw.categories : Array.isArray(raw.cats) ? raw.cats : [];
const sourceTags = Array.isArray(raw.tags) ? raw.tags : [];
if (!sourceCategories.length) usage('源数据顶层没有 categories 数组（也没有 cats）');
if (!sourceTags.length) usage('源数据顶层没有 tags 数组，或 tags 是空的');

const selected = new Set(
  sourceCategories
    .filter((category) => category && typeof category.id === 'string' && category.id)
    .map((category) => String(category.id))
    .filter((id) => (only.length ? only.includes(id) : true))
    .filter((id) => (exclude.length ? !exclude.includes(id) : true)),
);
if (!selected.size) usage('筛选后没有剩下任何分类');

const tagFields = (tag) => {
  const values = {};
  for (const [key, value] of Object.entries(tag ?? {})) {
    if (key === 'cat' || key === 'category' || key === 'id') continue;
    if (typeof value === 'string' && value.trim()) values[key] = value.trim();
  }
  return values;
};

const tags = [];
for (const tag of sourceTags) {
  const cat = String(tag?.cat ?? tag?.category ?? '');
  if (!selected.has(cat)) continue;
  const values = tagFields(tag);
  if (!Object.keys(values).length) continue;
  tags.push({ cat, ...values });
}

const counts = new Map();
for (const tag of tags) counts.set(tag.cat, (counts.get(tag.cat) ?? 0) + 1);

const categories = sourceCategories
  .filter((category) => category && selected.has(String(category.id ?? '')) && counts.get(String(category.id)))
  .map((category) => {
    const item = {
      id: String(category.id),
      name: String(category.name ?? category.id),
    };
    for (const key of ['icon', 'role', 'nsfw', 'adult']) {
      if (category[key] !== undefined) item[key] = category[key];
    }
    item.count = counts.get(String(category.id));
    return item;
  });

const clean = {
  version: raw.version ?? 1,
  license: String(raw.license ?? ''),
  source: String(raw.source ?? ''),
  note: String(raw.note ?? ''),
  builtAt: new Date().toISOString(),
  categories,
  tags,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(clean, null, 2), 'utf8');

console.log(`source=${source}`);
console.log(`out=${out}`);
console.log(`categories=${categories.length} tags=${tags.length} bytes=${statSync(out).size}`);
