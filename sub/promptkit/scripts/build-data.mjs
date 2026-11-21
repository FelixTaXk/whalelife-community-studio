// 从鱼仔的 PromptForge 词库生成画室可用的 data/prompts.json。
// 用法：
//   node scripts/build-data.mjs          # 安全子集：去掉 NSFW 四类、人物基础 / 身材 / 面部 / 怪物，再按黑名单过滤
//   node scripts/build-data.mjs --full   # 全量：保留全部 25 个分类与 2742 条词（含 NSFW 四类，由插件开关单独控制）
// 输入：D:/dafeiyu/fish-extra/lib/forge-data.json（只读，不改源文件；可用环境变量 FORGE_SRC 覆盖）
// 输出：data/prompts.json（引擎认的格式：categories + tags）
//
// 说明：
// 1) 全量模式不做任何删减，NSFW 四类照样写进文件；是否能用由插件的「NSFW 分类」开关决定，
//    默认关闭时这四个分类不会出现在查词工具和自动补词里。
// 2) 安全子集模式的过滤规则：整类剔除见 DROP_CATS，词条级黑名单见 ZH_BLOCK / EN_BLOCK。
// 3) 两种模式都不导出 presets / chars / models —— 引擎只读分类和词条，导出等于白占体积。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.FORGE_SRC || 'D:/dafeiyu/fish-extra/lib/forge-data.json';
const OUT = join(HERE, '..', 'data', 'prompts.json');

const FULL = process.argv.includes('--full') || process.env.PROMPTKIT_FULL === '1';

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
// 源数据用 cats，插件引擎认 categories；这里统一成引擎的字段名。
const srcCats = src.categories ?? src.cats ?? [];
const srcTags = src.tags ?? [];

const tags = FULL ? srcTags.filter((t) => String(t.cat ?? '')) : srcTags.filter(
  (t) => !DROP_CATS.has(String(t.cat ?? '')) && !blocked(t),
);

const counts = new Map();
for (const t of tags) counts.set(t.cat, (counts.get(t.cat) ?? 0) + 1);

const categories = srcCats
  .filter((c) => (FULL || !DROP_CATS.has(String(c.id ?? ''))) && counts.get(c.id))
  .map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.icon ?? '',
    count: counts.get(c.id),
  }));

const nsfwTags = tags.filter((t) => /^nsfw/i.test(String(t.cat ?? ''))).length;

const out = {
  version: 1,
  mode: FULL ? 'full' : 'safe',
  source: src.source || 'PromptForge',
  sourceGeneratedAt: src.generatedAt || '',
  note: FULL
    ? 'full：保留全部 25 个分类与全部词条（含 NSFW 四类）；NSFW 是否可用由插件「NSFW 分类」开关决定，默认关闭。'
    : 'safe：仅保留非成人分类；已按黑名单过滤色情与未成年相关词条',
  builtAt: new Date().toISOString(),
  categories,
  tags: tags.map((t) => ({ en: t.en ?? '', zh: t.zh ?? '', cat: t.cat })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out), 'utf8');

console.log(
  `mode=${out.mode} categories=${categories.length} tags=${tags.length} nsfwTags=${nsfwTags} bytes=${Buffer.byteLength(JSON.stringify(out))}`,
);
