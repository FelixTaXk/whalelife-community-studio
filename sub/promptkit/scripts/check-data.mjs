// 校验词库文件：格式对不对、有多少分类 / 词条、其中有多少 NSFW。
// 用法：
//   node scripts/check-data.mjs                 # 默认看 data/prompts.json，没有就看随包示例
//   node scripts/check-data.mjs 某个文件.json    # 也可以直接传路径
//
// 只读不写。格式不对时退出码为 1，并直接说哪里不对 —— 最常见的情况是
// 把 PromptForge 源数据（字段叫 cats）当成插件格式（字段叫 categories）。
// 插件两种写法都认，但源数据还带着 presets / chars，建议用 build-data.mjs 生成一份干净的去用。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OWN = join(HERE, '..', 'data', 'prompts.json');
const DEFAULT_SAMPLE = join(HERE, '..', 'assets', 'prompts.sample.json');

const isNsfw = (id) => /^nsfw/i.test(String(id ?? ''));

function fail(message, hint = '') {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

let file = process.argv[2];
if (!file) file = existsSync(DEFAULT_OWN) ? DEFAULT_OWN : existsSync(DEFAULT_SAMPLE) ? DEFAULT_SAMPLE : '';
if (!file) fail('找不到词库文件', '先跑 node scripts/build-data.mjs --full，或用设置页导入一份');
file = resolve(file);
if (!existsSync(file)) fail(`文件不存在：${file}`);
const size = statSync(file).size;
if (!size) fail(`文件是空的：${file}`);

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  fail(`不是合法的 JSON：${error.message}`, '常见原因：复制时被截断，或者存成了 GBK 编码');
}

const usingCats = !Array.isArray(raw.categories) && Array.isArray(raw.cats);
const cats = Array.isArray(raw.categories) ? raw.categories : usingCats ? raw.cats : null;
if (!cats) {
  fail('顶层没有 categories 数组（也没有 cats）', '插件读不到分类就整份词库都用不了');
}
const tags = raw.tags;
if (!Array.isArray(tags) || !tags.length) fail('顶层没有 tags 数组，或者 tags 是空的');

const ids = new Set(
  cats.filter((c) => c && typeof c.id === 'string' && c.id).map((c) => String(c.id)),
);
if (!ids.size) fail('categories 里没有带 id 的分类');

const valid = [];
let orphan = 0;
for (const tag of tags) {
  if (!tag || typeof tag !== 'object') continue;
  const cat = String(tag.cat ?? '');
  const zh = String(tag.zh ?? '').trim();
  const en = String(tag.en ?? '').trim();
  if (!ids.has(cat)) {
    orphan++;
    continue;
  }
  if (!zh && !en) continue;
  valid.push({ cat, zh, en });
}
if (!valid.length) fail('tags 里的词条一个也对不上 categories，插件同样用不了');

const byCat = new Map();
for (const tag of valid) byCat.set(tag.cat, (byCat.get(tag.cat) ?? 0) + 1);
const nsfwCats = [...ids].filter(isNsfw);
const nsfwTags = valid.filter((t) => isNsfw(t.cat)).length;

console.log(`文件：${file}`);
console.log(`大小：${(size / 1024).toFixed(1)} KB${usingCats ? '（PromptForge 源数据：用 cats 字段，插件也认）' : ''}`);
console.log(`分类：${ids.size} 个 · 词条：${valid.length} 条`);
if (nsfwCats.length) {
  console.log(`NSFW：${nsfwCats.length} 个分类 / ${nsfwTags} 条词（id：${nsfwCats.join(', ')}）—— 默认隐藏，要在设置页开开关`);
} else {
  console.log('NSFW：没有成人分类');
}
console.log('');
for (const id of ids) {
  const name = String(cats.find((c) => String(c.id) === id)?.name ?? id);
  console.log(`  ${isNsfw(id) ? '🔞' : ' ·'} ${id.padEnd(14)} ${name.padEnd(12)} ${byCat.get(id) ?? 0} 条`);
}
if (orphan) console.log(`\n注意：有 ${orphan} 条词的 cat 对不上任何分类，插件会忽略它们。`);
if (raw.note) console.log(`\n来源说明：${raw.note}`);
console.log('\n✓ 格式没问题，插件能读。');
