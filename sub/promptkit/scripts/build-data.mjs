// 从鱼仔的 PromptForge 词库生成迟宝可用的子集。
// 用法：node scripts/build-data.mjs
// 输入：D:/dafeiyu/fish-extra/lib/forge-data.json（只读，不改源文件）
// 输出：data/prompts.json
//
// 过滤原则：
// 1) 丢掉 NSFW 四类、人物基础 / 身材 / 面部（迟宝外貌由人设和定妆照固定，不靠词库换）
// 2) 逐条黑名单过滤，中文按子串、英文按单词边界，避免把色情或未成年相关词带进来
// 3) 不导出 presets / chars / models，只保留分类和词条

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.FORGE_SRC || 'D:/dafeiyu/fish-extra/lib/forge-data.json';
const OUT = join(HERE, '..', 'data', 'prompts.json');

const DROP_CATS = new Set([
  'base', 'body', 'face',
  'nsfwbody', 'nsfwcloth', 'nsfwact', 'nsfwplay',
  'monster',
]);

const ZH_BLOCK = [
  '裸', '内衣', '胸罩', '内裤', '丁字', '乳', '臀部', '翘臀', '大腿', '腿缝',
  '私处', '下体', '性器', '性爱', '做爱', '情色', '色情', '色气', '情趣',
  '暴露', '走光', '湿身', '汗珠', '呻吟', '喘息', '微喘', '媚', '沉醉',
  '羞耻', '口交', '插入', '射精', '精液', '潮红', '泛红',
  '床', '被褥', '浴缸', '淋浴', '浴室', '温泉', '睡裙', '吊带', '蕾丝',
  '丝袜', '过膝袜', '女仆', '制服诱惑', '泳装', '比基尼', '泳衣', '足交',
  '抹胸', '露脐', '露肩', '躺', '仰卧', '俯卧', '四肢着地', '翘腿', '卧室',
  '床上', '枕', '被窝', '棉被', '侧卧', '趴着', '俯身',
];

const EN_BLOCK = [
  'nude', 'naked', 'topless', 'bottomless', 'lingerie', 'underwear', 'bra',
  'panties', 'panty', 'thong', 'garter', 'thighhighs', 'thigh-highs',
  'sex', 'sexual', 'erotic', 'nsfw', 'bondage', 'bdsm', 'hentai', 'loli',
  'child', 'underage', 'teen', 'bed', 'bedsheet', 'bathtub', 'shower',
  'onsen', 'cleavage', 'nipple', 'breasts', 'breast', 'ass', 'thigh',
  'thighs', 'crotch', 'cum', 'moan', 'panting', 'aroused', 'seductive',
  'sittingonlap', 'onallfours', 'lying', 'lying on side', 'sleeping on side',
  'on stomach', 'spread legs',
];

const EN_RE = new RegExp(
  '\\b(' + EN_BLOCK.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|') + ')\\b',
  'i',
);

function blocked(tag) {
  const zh = String(tag.zh ?? '');
  const en = String(tag.en ?? '');
  if (ZH_BLOCK.some((w) => zh.includes(w))) return true;
  if (EN_RE.test(en)) return true;
  // 中文没字、英文也没有的残条不要
  if (!zh.trim() && !en.trim()) return true;
  return false;
}

const src = JSON.parse(readFileSync(SRC, 'utf8'));
const tags = (src.tags ?? []).filter(
  (t) => !DROP_CATS.has(String(t.cat ?? '')) && !blocked(t),
);

const counts = new Map();
for (const t of tags) counts.set(t.cat, (counts.get(t.cat) ?? 0) + 1);

const categories = (src.cats ?? [])
  .filter((c) => !DROP_CATS.has(String(c.id ?? '')) && counts.get(c.id))
  .map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? '', count: counts.get(c.id) }));

const out = {
  version: 1,
  source: 'PromptForge (D:/dafeiyu/fish-extra/lib/forge-data.json)',
  note: '仅保留非成人分类；已按黑名单过滤色情与未成年相关词条',
  builtAt: new Date().toISOString(),
  categories,
  tags: tags.map((t) => ({ en: t.en ?? '', zh: t.zh ?? '', cat: t.cat })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 0), 'utf8');

console.log(
  `categories=${categories.length} tags=${tags.length} bytes=${Buffer.byteLength(JSON.stringify(out))}`,
);
