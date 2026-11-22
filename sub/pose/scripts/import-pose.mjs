/*! 画室 · 姿势：把 ai-pose-gallery-zh 的姿势库整理成插件目录。
 *
 * 用法：
 *   node scripts/import-pose.mjs [姿势库根目录] [输出文件]
 *   POSE_LIBRARY=D:/ComfyUI/custom_nodes/comfyui-pose-gallery/library node scripts/import-pose.mjs
 *
 * 姿势库根目录要含 data/pose-zh.json、thumbs/、img/。
 * 默认输出 assets/catalog.json（随包分发）；传 --user 或第二个参数时写 data/catalog.json（用户自己的库）。
 *
 * 分级：标准系 / 上半身 → general；性感系 → private；双人缠绵整系 → couple（private 之上再加一层双人开关）。
 * 所有 private / couple 参考默认整类隐藏，页面不出现，图片接口直接 404。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DEFAULT = resolve(HERE, '..', 'assets', 'catalog.json');
const USER_OUTPUT = resolve(HERE, '..', 'data', 'catalog.json');
const SOURCE_DEFAULT =
  process.env.POSE_LIBRARY ||
  'D:/ComfyUI/custom_nodes/comfyui-pose-gallery/library';

const VIEW_SLUG = {
  正面: 'front',
  斜侧: 'diag',
  侧面: 'side',
  背面: 'back',
  俯视: 'high',
  仰视: 'low',
};

const VIEW_EN = {
  正面: 'front view',
  斜侧: 'three-quarter view',
  侧面: 'side view',
  背面: 'viewed from behind',
  俯视: 'high angle',
  仰视: 'low angle',
};

/** 分类 → 英文动作 + 可用场景。tier 由体系决定，这里只管动作和场景。 */
const CATEGORY_MAP = {
  站姿: { en: 'standing', scenes: ['daily', 'outer', 'school', 'party', 'dress', 'active', 'swim', 'camera', 'art'] },
  坐姿: { en: 'seated', scenes: ['school', 'meal', 'cozy', 'home', 'art', 'camera', 'daily'] },
  趴卧: { en: 'lying prone', scenes: ['home', 'sleep', 'cozy', 'camera'] },
  跪立: { en: 'kneeling upright', scenes: ['home', 'cozy', 'art', 'camera'] },
  '跪立・四肢着地': { en: 'on all fours', scenes: ['home', 'cozy', 'art', 'active', 'camera'] },
  '侧坐・女孩坐': { en: 'sitting sideways with legs folded', scenes: ['home', 'cozy', 'daily', 'camera'] },
  蹲姿: { en: 'squatting', scenes: ['outer', 'active', 'daily', 'swim', 'camera'] },
  前倾: { en: 'leaning forward', scenes: ['art', 'camera', 'active', 'daily'] },
  '后仰・挺背': { en: 'leaning back with an arched spine', scenes: ['art', 'camera', 'dress', 'party'] },
  扭身: { en: 'twisting the torso', scenes: ['art', 'camera', 'dress', 'party'] },
  可爱系: { en: 'cute playful upper-body gesture', scenes: ['daily', 'home', 'cozy', 'camera'] },
  '性感・大胆系': { en: 'bold alluring upper-body pose', scenes: ['home', 'party', 'camera'] },
  '挤胸・强调事业线系': { en: 'upper-body pose with chest emphasized', scenes: ['home', 'party', 'camera'] },
  特殊: { en: 'special pose', scenes: ['art', 'daily', 'camera'] },
  // 双人缠绵整系：只作双人参考，不参与按日程自动配姿势。
  '正常位（传教士）': { en: 'two people, intimate couple pose', scenes: [] },
  背向坐位: { en: 'two people, intimate couple pose', scenes: [] },
  后入位: { en: 'two people, intimate couple pose', scenes: [] },
  骑乘位: { en: 'two people, intimate couple pose', scenes: [] },
  贴脸系: { en: 'two people, close intimate pose', scenes: [] },
  立位: { en: 'two people, standing close', scenes: [] },
  立位贴身: { en: 'two people, standing close, bodies touching', scenes: [] },
  侧卧位: { en: 'two people, lying on their sides', scenes: [] },
  面对面坐位: { en: 'two people, seated facing each other', scenes: [] },
  坐位: { en: 'two people, seated close', scenes: [] },
  贴身: { en: 'two people, close embrace', scenes: [] },
  坐位贴身: { en: 'two people, seated close, bodies touching', scenes: [] },
};

const TIER_BY_SYSTEM = {
  '全身单人・标准系': 'general',
  '上半身单人': 'general',
  '全身单人・性感系': 'private',
  双人缠绵: 'couple',
};

/** 上半身里的这两类也是性感向，和全身性感系一起归 private。 */
const SEXY_CATEGORIES = new Set(['性感・大胆系', '挤胸・强调事业线系']);

const BODY_EN = {
  '全身单人・标准系': 'full body',
  '全身单人・性感系': 'full body',
  上半身单人: 'upper body',
  双人缠绵: 'two people',
};

/** 双人缠绵作为独立 tier，比 private 再高一层：要高级开关 + 双人开关同时打开。 */
const EXCLUDED_SYSTEMS = new Set([]);

function die(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2).filter((item) => item !== '--user');
const sourceRoot = resolve(args[0] || SOURCE_DEFAULT);
const output = args[1] ? resolve(args[1]) : process.argv.includes('--user') ? USER_OUTPUT : OUTPUT_DEFAULT;
const dataFile = join(sourceRoot, 'data', 'pose-zh.json');

if (!existsSync(dataFile)) die(`姿势库缺 data/pose-zh.json：${sourceRoot}`);
if (!existsSync(join(sourceRoot, 'thumbs'))) die(`姿势库缺 thumbs/：${sourceRoot}`);

const raw = JSON.parse(readFileSync(dataFile, 'utf8'));
if (!Array.isArray(raw)) die('pose-zh.json 不是数组');

const items = [];
const dropped = {};
const categories = {};
const systems = {};
const groups = new Set();

for (const entry of raw) {
  const system = String(entry?.体系 ?? '').trim();
  const category = String(entry?.分类 ?? '').trim();
  const name = String(entry?.姿势名称 ?? '').trim();
  const view = String(entry?.角度 ?? '').trim();
  const code = String(entry?.姿势编号 ?? '').trim();
  const id = String(entry?.id ?? '').trim();
  if (!id || !system || !code) continue;
  if (EXCLUDED_SYSTEMS.has(system)) {
    dropped[system] = (dropped[system] ?? 0) + 1;
    continue;
  }
  const couple = system === '双人缠绵';
  const meta = CATEGORY_MAP[category] ?? (couple ? { en: 'two people, lying close', scenes: [] } : null);
  if (!meta) {
    dropped[`分类:${category}`] = (dropped[`分类:${category}`] ?? 0) + 1;
    continue;
  }
  const slug = VIEW_SLUG[view];
  if (!slug) {
    dropped[`角度:${view}`] = (dropped[`角度:${view}`] ?? 0) + 1;
    continue;
  }
  const tier = couple ? 'couple' : (SEXY_CATEGORIES.has(category) ? 'private' : (TIER_BY_SYSTEM[system] ?? 'general'));
  const thumb = String(entry.缩略图 ?? `thumbs/${id}.jpg`).replace(/\\/g, '/');
  const image = String(entry.原图 ?? `img/${id}.png`).replace(/\\/g, '/');
  const depthThumb = `thumbs/depth/${id}.webp`;
  const depth = `img/depth/${id}.webp`;
  const group = `${system}|${code}`;
  groups.add(group);
  systems[system] = (systems[system] ?? 0) + 1;
  categories[category] = (categories[category] ?? 0) + 1;
  const en = [BODY_EN[system] ?? '', meta.en, VIEW_EN[view]].filter(Boolean).join(', ');
  items.push({
    id,
    group,
    system,
    code,
    category,
    name,
    view,
    viewSlug: slug,
    tier,
    couple,
    scenes: meta.scenes.slice(),
    en,
    zh: [name, category, view, system].filter(Boolean).join('·'),
    thumb,
    image,
    depthThumb,
    depth,
  });
}

const order = ['front', 'diag', 'side', 'back', 'high', 'low'];
items.sort((a, b) => a.system.localeCompare(b.system) || a.code.localeCompare(b.code) || order.indexOf(a.viewSlug) - order.indexOf(b.viewSlug));

const tiers = {};
for (const item of items) tiers[item.tier] = (tiers[item.tier] ?? 0) + 1;

const catalog = {
  format: 1,
  generatedAt: new Date().toISOString(),
  source: {
    repo: 'https://github.com/anhao/ai-pose-gallery-zh',
    mirror: 'https://ai-pose-gallery.anhao.app/',
    library: sourceRoot.replace(/\\/g, '/'),
    poseData: dataFile.replace(/\\/g, '/'),
    snapshotBytes: statSync(dataFile).size,
    snapshotSha256: createHash('sha256').update(readFileSync(dataFile)).digest('hex'),
    sfwOnly: false,
    excludedSystems: [...EXCLUDED_SYSTEMS],
  },
  report: {
    kept: items.length,
    groups: groups.size,
    dropped,
    tiers,
    systems,
    categories,
    views: VIEW_SLUG,
  },
  items,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(catalog), 'utf8');
console.log(
  JSON.stringify({
    ok: true,
    output,
    kept: items.length,
    groups: groups.size,
    tiers,
    dropped,
    bytes: statSync(output).size,
  }),
);
