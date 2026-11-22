// 校验词库文件：格式对不对、有多少分类 / 词条、其中有多少成人分类。
//
// 用法：
//   node scripts/check-data.mjs                    # 默认看 data/prompts.json，没有就看随包示例
//   node scripts/check-data.mjs 某个文件.json       # 也可以直接传路径
//   node scripts/check-data.mjs 某个文件.json --nsfw-prefix adult
//   node scripts/check-data.mjs 某个文件.json --negative bad
//
// 只读不写。格式不对时退出码为 1。
// 词条字段名不限定：除 cat / category / id 之外的字符串字段都算有效文本。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OWN = join(HERE, '..', 'data', 'prompts.json');
const DEFAULT_SAMPLE = join(HERE, '..', 'assets', 'prompts.sample.json');

const argValue = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
};

const nsfwPrefix = argValue('--nsfw-prefix', 'nsfw').trim().toLowerCase();
const negativeId = argValue('--negative', 'negative').trim();

function fail(message, hint = '') {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

const positional = process.argv.slice(2).find((item, index, all) => !item.startsWith('--') && !String(all[index - 1] ?? '').startsWith('--'));
let file = positional || '';
if (!file) file = existsSync(DEFAULT_OWN) ? DEFAULT_OWN : existsSync(DEFAULT_SAMPLE) ? DEFAULT_SAMPLE : '';
if (!file) fail('找不到词库文件', '用设置页导入一份，或先跑 node scripts/build-data.mjs --source <词库.json>');
file = resolve(file);
if (!existsSync(file)) fail(`文件不存在：${file}`);
const size = statSync(file).size;
if (!size) fail(`文件是空的：${file}`);

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  fail(`不是合法的 JSON：${error.message}`, '常见原因：复制时被截断，或者存成了非 UTF-8 编码');
}

const usingCats = !Array.isArray(raw.categories) && Array.isArray(raw.cats);
const cats = Array.isArray(raw.categories) ? raw.categories : usingCats ? raw.cats : null;
if (!cats) fail('顶层没有 categories 数组（也没有 cats）', '插件读不到分类就整份词库都用不了');
const tags = raw.tags;
if (!Array.isArray(tags) || !tags.length) fail('顶层没有 tags 数组，或者 tags 是空的');

const categories = cats
  .filter((c) => c && typeof c.id === 'string' && c.id)
  .map((c) => ({
    id: String(c.id),
    name: String(c.name ?? c.id),
    role: typeof c.role === 'string' ? c.role : '',
    nsfw: c.nsfw === true || c.adult === true || String(c.role ?? '').toLowerCase() === 'nsfw',
    negative: String(c.role ?? '').toLowerCase() === 'negative' || String(c.id) === negativeId,
  }));
if (!categories.length) fail('categories 里没有带 id 的分类');

const ids = new Set(categories.map((c) => c.id));
const byId = new Map(categories.map((c) => [c.id, c]));
const isNsfw = (id) => {
  const category = byId.get(id);
  if (category?.nsfw) return true;
  return Boolean(nsfwPrefix) && id.toLowerCase().startsWith(nsfwPrefix);
};

const valid = [];
let orphan = 0;
for (const tag of tags) {
  if (!tag || typeof tag !== 'object') continue;
  const cat = String(tag.cat ?? tag.category ?? '');
  if (!ids.has(cat)) {
    orphan++;
    continue;
  }
  const values = Object.entries(tag).filter(
    ([key, value]) => key !== 'cat' && key !== 'category' && key !== 'id' && typeof value === 'string' && value.trim(),
  );
  if (!values.length) continue;
  valid.push({ cat, values });
}
if (!valid.length) fail('tags 里的词条一个也对不上 categories，插件同样用不了');

const byCat = new Map();
for (const tag of valid) byCat.set(tag.cat, (byCat.get(tag.cat) ?? 0) + 1);
const nsfwCats = [...ids].filter(isNsfw);
const nsfwTags = valid.filter((tag) => isNsfw(tag.cat)).length;

console.log(`文件：${file}`);
console.log(`大小：${(size / 1024).toFixed(1)} KB${usingCats ? '（使用了 cats 字段，插件也认）' : ''}`);
console.log(`分类：${ids.size} 个 · 词条：${valid.length} 条`);
if (nsfwCats.length) {
  console.log(`成人分类：${nsfwCats.length} 个 / ${nsfwTags} 条词（id：${nsfwCats.join(', ')}）—— 默认隐藏，要在设置页开开关`);
} else {
  console.log('成人分类：没有');
}
console.log('');
for (const id of ids) {
  const category = byId.get(id);
  const flag = category.negative ? '负面' : isNsfw(id) ? '成人' : ' · ';
  console.log(`  [${flag}] ${id.padEnd(16)} ${category.name.padEnd(12)} ${byCat.get(id) ?? 0} 条`);
}
if (orphan) console.log(`\n注意：有 ${orphan} 条词的 cat 对不上任何分类，插件会忽略它们。`);
if (raw.note) console.log(`\n来源说明：${raw.note}`);
console.log('\n✓ 格式没问题，插件能读。');
