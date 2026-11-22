/*! 画室 · 自拍/随手拍的场景与穿搭解析。
 *
 * 所有外部数据都是可选的：
 *   - 日程：integration.schedule.dataDir 指向一个放着 YYYY-MM-DD.json 的目录
 *   - 衣柜：integration.wardrobe.dataDir 指向含 state.json / catalog.json 的目录
 * 路径可写绝对路径，也可写相对插件根目录的路径。读不到就跳过，不阻断出图。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = join(HERE, '..', '..', '..', '..');

const rootOf = (root?: string) => (root && root.trim() ? root : PLUGINS_ROOT);
const dataDirOf = (root: string | undefined, dir: string) => {
  const value = String(dir ?? '').trim();
  if (!value) return '';
  return isAbsolute(value) ? value : join(rootOf(root), value);
};

type PlanItem = { id?: string; start?: string; end?: string; title?: string; place?: string; kind?: string; status?: string };

export type ScheduleMoment = {
  date: string;
  id: string;
  title: string;
  place: string;
  start: string;
  end: string;
  kind: string;
  weather: string;
  moment: 'now' | 'next';
};

export type ShotContext = {
  scene?: string;
  outfit?: string;
  outfitId?: string;
  mood?: string;
  schedule?: ScheduleMoment;
  notes: string[];
};

export type ScheduleSource = { enabled: boolean; dataDir: string };
export type WardrobeSource = { enabled: boolean; dataDir: string; personaId: string };

/** 姿势子插件：dataDir 指向含 config.json 的目录，catalog.json 在同一目录或上级 assets/ 里。 */
export type PoseSource = { enabled: boolean; dataDir: string; personaId: string; allowPrivate?: boolean };

export type PoseItem = { id: string; group: string; name: string; view: string; tier: string; couple?: boolean; en: string; image: string; depth: string };

export type SceneOptions = {
  root?: string;
  schedule?: ScheduleSource;
  wardrobe?: WardrobeSource;
  pose?: PoseSource;
  sceneDetails?: string[];
  defaultOutfit?: string;
  selfieFallbackScene?: string;
  snapshotFallbackScene?: string;
  randomSubjects?: string[];
  paintStyles?: string[];
};

const text = (value: any, max = 300) => String(value ?? '').trim().slice(0, max);

const dateKey = (now: Date) => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const minuteOfDay = (now: Date) => now.getHours() * 60 + now.getMinutes();

const hhmm = (value?: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === 24 && minute === 0) return 24 * 60;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
};

const readJson = (path: string) => {
  try {
    if (!path || !existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

export function readSchedule(now = new Date(), options: SceneOptions = {}): ScheduleMoment | null {
  const source = options.schedule;
  if (!source?.enabled) return null;
  const date = dateKey(now);
  const dir = dataDirOf(options.root, source.dataDir);
  const plan = readJson(join(dir, `${date}.json`));
  const items: PlanItem[] = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) return null;
  const minute = minuteOfDay(now);
  const live = items
    .filter((item) => item && item.status !== 'skipped' && item.status !== 'done')
    .map((item) => ({ item, start: hhmm(item.start), end: hhmm(item.end) }))
    .filter((entry): entry is { item: PlanItem; start: number; end: number } => entry.start !== null && entry.end !== null)
    .sort((a, b) => a.start - b.start);
  const active = live.find((entry) => entry.start <= minute && entry.end > minute) ?? null;
  if (!active) return null;
  return {
    date,
    id: text(active.item.id, 40),
    title: text(active.item.title, 60),
    place: text(active.item.place, 40),
    start: text(active.item.start, 10),
    end: text(active.item.end, 10),
    kind: text(active.item.kind, 20),
    weather: text(plan?.weather?.text, 40),
    moment: 'now',
  };
}

export function readWardrobeOutfit(
  date: string,
  itemId?: string,
  options: SceneOptions = {},
): { id: string; en: string; name: string; tier: string } | null {
  const source = options.wardrobe;
  if (!source?.enabled) return null;
  const dir = dataDirOf(options.root, source.dataDir);
  const state = readJson(join(dir, 'state.json'));
  const personas = state?.personas && typeof state.personas === 'object' ? state.personas : {};
  const preferred = source.personaId ? personas[source.personaId] : null;
  const fallback = Object.values(personas)[0] as any;
  const persona = preferred || fallback;
  const day = persona?.days?.[date];
  if (!day) return null;
  const id = text(itemId && day.blocks?.[itemId] ? day.blocks[itemId] : day.base, 40);
  if (!id) return null;
  const catalog = readJson(join(dir, 'catalog.json'));
  const item = Array.isArray(catalog?.items) ? catalog.items.find((entry: any) => entry?.id === id) : null;
  if (!item) return null;
  return {
    id,
    en: text(item.en, 300),
    name: text(item.name, 200),
    tier: text(item.tier || item.rating, 40),
  };
}

const poseCatalogs = new Map<string, { mtime: number; items: any[] }>();

/** 姿势目录：data/catalog.json（用户导入）优先，其次 ../assets/catalog.json（随包）。 */
function poseCatalogOf(dir: string): any[] {
  for (const file of [join(dir, 'catalog.json'), join(dir, '..', 'assets', 'catalog.json')]) {
    if (!existsSync(file)) continue;
    try {
      const mtime = statSync(file).mtimeMs;
      const cached = poseCatalogs.get(file);
      if (cached && cached.mtime === mtime) return cached.items;
      const body = JSON.parse(readFileSync(file, 'utf8'));
      const items = Array.isArray(body?.items) ? body.items : [];
      poseCatalogs.set(file, { mtime, items });
      return items;
    } catch {
      continue;
    }
  }
  return [];
}

function poseAdvancedOf(dir: string): boolean {
  try {
    const config = readJson(join(dir, 'config.json'));
    return config?.advanced === true;
  } catch {
    return false;
  }
}

/** 双人开关：必须在 private 闸门（高级 + 成年 + allowPrivate）之上再开。 */
function poseCoupleAllowed(dir: string, personaId?: string): boolean {
  if (!posePrivateAllowed(dir, personaId)) return false;
  try {
    const config = readJson(join(dir, 'config.json'));
    return config?.couple === true;
  } catch {
    return false;
  }
}
function posePrivateAllowed(dir: string, personaId?: string): boolean {
  if (!poseAdvancedOf(dir)) return false;
  let config: any = {};
  try {
    config = readJson(join(dir, 'config.json')) ?? {};
  } catch {
    return false;
  }
  const thresholdRaw = Number(config.adultThreshold);
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(18, thresholdRaw) : 18;
  const id = text(personaId, 120);
  const policy = id && config.personaPolicy ? config.personaPolicy[id] : undefined;
  if (policy === 'minor') return false;
  const host = readJson(join(PLUGINS_ROOT, '..', 'config', 'config.json'));
  const file = text(host?.personas?.[id]?.file, 400);
  let age: number | null = null;
  if (file) {
    const path = isAbsolute(file) ? file : join(PLUGINS_ROOT, '..', file);
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8').slice(0, 6000);
        const ages = [...raw.matchAll(/(\d{1,3})\s*岁/g)]
          .map((m) => Number(m[1]))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 120);
        if (ages.length) age = Math.min(...ages);
      } catch {
        age = null;
      }
    }
  }
  if (policy === 'adult') return age === null || age >= threshold;
  if (age !== null) return age >= threshold;
  return config.unknownPersona === 'adult';
}

function poseItemOf(item: any, allowPrivate: boolean, allowCouple: boolean): PoseItem | null {
  if (!item) return null;
  const tier = text(item.tier, 20);
  // 默认不放 private（性感系）；couple（双人）还要在高级之上再开双人开关。
  if (tier === 'private' && !allowPrivate) return null;
  if (tier === 'couple' && !(allowPrivate && allowCouple)) return null;
  return {
    id: text(item.id, 60),
    group: text(item.group, 120),
    name: text(item.name, 200),
    view: text(item.view, 20),
    tier,
    couple: item.couple === true,
    en: text(item.en, 300),
    image: text(item.image, 300),
    depth: text(item.depth, 300),
  };
}

/** pose 参数：完整 id / 组 key / 姿势名或分类关键词。只查姿势库，不读日程状态。 */
export function findPoseItem(input: string, _date?: string, _blockId?: string, options: SceneOptions = {}): PoseItem | null {
  const source = options.pose;
  if (!source?.enabled) return null;
  const value = text(input, 120);
  if (!value) return null;
  const dir = dataDirOf(options.root, source.dataDir);
  const allowPrivate = source.allowPrivate === true && posePrivateAllowed(dir, source.personaId);
  const allowCouple = source.allowPrivate === true && poseCoupleAllowed(dir, source.personaId);
  const items = poseCatalogOf(dir);
  const exact = items.find((entry: any) => entry?.id === value);
  if (exact) return poseItemOf(exact, allowPrivate, allowCouple);
  const group = items.find((entry: any) => entry?.group === value && entry?.viewSlug === 'front') ?? items.find((entry: any) => entry?.group === value);
  if (group) return poseItemOf(group, allowPrivate, allowCouple);
  const needle = value.toLowerCase();
  const hit = items.find((entry: any) => `${entry?.name ?? ''} ${entry?.category ?? ''}`.toLowerCase().includes(needle));
  return poseItemOf(hit, allowPrivate, allowCouple);
}

const placeEn = (place: string, title: string) => {
  const value = `${place} ${title}`;
  if (/学校|教室|上课|school|class/.test(value)) return 'at school';
  if (/家|房间|卧室|客厅|厨房|阳台|home|room|bedroom|kitchen|balcony/.test(value)) return 'at home';
  if (/路|街|公交|地铁|车站|street|road|station|subway/.test(value)) return 'on the way';
  if (/公园|操场|户外|出去|走走|散步|park|outside|walk/.test(value)) return 'outside';
  if (/店|超市|商场|图书|shop|store|market|bookstore/.test(value)) return 'in a shop';
  return place ? `at ${place}` : '';
};

const activityEn = (title: string) => {
  if (!title) return '';
  if (/起床|醒来|wake/.test(title)) return 'just woke up, still in bed';
  if (/洗漱|洗澡|浴室|bath|shower/.test(title)) return 'in the bathroom';
  if (/准备睡|睡前|睡觉|bedtime|sleep/.test(title)) return 'getting ready for bed';
  if (/早餐|午餐|晚餐|吃|面|饭|breakfast|lunch|dinner|meal/.test(title)) return 'having a meal';
  if (/画|速写|水彩|draw|sketch|paint/.test(title)) return 'drawing at a desk';
  if (/修照片|修图|剪辑|edit|photo/.test(title)) return 'editing photos on a laptop';
  if (/作业|学习|复习|看书|读|study|homework|read/.test(title)) return 'studying at a desk';
  if (/上课|课|class|lesson/.test(title)) return 'in class';
  if (/跑步|运动|锻炼|run|workout|exercise/.test(title)) return 'after a run, a little out of breath';
  if (/回家|放学|home/.test(title)) return 'just got home';
  if (/散步|逛|走走|出去|walk|stroll/.test(title)) return 'walking outside';
  return '';
};

const timeEn = (now: Date) => {
  const hour = now.getHours();
  if (hour < 6) return 'late at night';
  if (hour < 9) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'dusk';
  if (hour < 23) return 'evening';
  return 'late at night';
};

const weatherEn = (weather: string) => {
  if (!weather) return '';
  if (/雨|rain/.test(weather)) return 'rainy, the ground still wet';
  if (/雪|snow/.test(weather)) return 'snowing';
  if (/晴|clear|sunny/.test(weather)) return 'clear light';
  if (/阴|多云|cloud|overcast/.test(weather)) return 'soft gray light';
  if (/风|wind/.test(weather)) return 'a little windy';
  return '';
};

const DEFAULT_SAFE_DETAILS = [
  'steam from a cup on the desk',
  'light falling across the floor',
  'a chair by the window, nobody sitting in it',
  'a wet bicycle seat after the rain',
  'traffic lights just coming on',
];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

const detailFor = (details: string[]) => pick(details.length ? details : DEFAULT_SAFE_DETAILS);

const fallbackScene = (value: string | undefined, fallback: string) => text(value) || fallback;

export function resolveSelfieContext(args: any = {}, now = new Date(), options: SceneOptions = {}): ShotContext {
  const notes: string[] = [];
  const schedule = readSchedule(now, options);
  const explicitScene = text(args?.scene);
  const explicitOutfit = text(args?.outfit, 300);
  const explicitMood = text(args?.mood);
  const genericOutfit = text(options.defaultOutfit, 300);
  let scene = explicitScene;
  let outfit = explicitOutfit;
  let mood = explicitMood;

  if (!scene) {
    if (schedule) {
      const where = placeEn(schedule.place, schedule.title) || text(schedule.place) || '';
      const doing = activityEn(schedule.title) || (where ? '' : schedule.title);
      const weather = weatherEn(schedule.weather) || text(schedule.weather, 40);
      scene = [where, doing, weather, timeEn(now)].filter(Boolean).join(', ');
      notes.push(`场景自动填：${schedule.start}–${schedule.end} ${schedule.title}${schedule.place ? ' @' + schedule.place : ''}`);
    } else {
      scene = [fallbackScene(options.selfieFallbackScene, 'by the window'), timeEn(now)].filter(Boolean).join(', ');
      notes.push('场景自动填：默认（日程未启用或没有当前段）');
    }
  }

  if (!outfit && schedule) {
    const found = readWardrobeOutfit(schedule.date, schedule.id, options);
    if (found) {
      outfit = found.en || found.name;
      notes.push(`穿搭自动填：${found.id} ${found.name}`);
    } else if (genericOutfit) {
      outfit = genericOutfit;
      notes.push('穿搭默认：人设配置');
    }
  } else if (!outfit && genericOutfit) {
    outfit = genericOutfit;
    notes.push('穿搭默认：人设配置');
  }

  if (!mood) {
    const weather = weatherEn(schedule?.weather ?? '') || text(schedule?.weather, 40);
    if (weather) {
      mood = weather;
      notes.push('神态自动填：按天气');
    } else if (now.getHours() < 5) {
      mood = 'awake too late, a little tired';
      notes.push('神态自动填：凌晨还没睡');
    } else if (now.getHours() < 9) {
      mood = 'still a little sleepy';
      notes.push('神态自动填：早上刚起');
    } else if (now.getHours() >= 22) {
      mood = 'tired but calm';
      notes.push('神态自动填：夜里');
    }
  }

  return { scene, outfit, mood, schedule: schedule ?? undefined, notes };
}

export function resolveSnapshotContext(args: any = {}, now = new Date(), options: SceneOptions = {}): ShotContext {
  const notes: string[] = [];
  const schedule = readSchedule(now, options);
  const explicitScene = text(args?.scene);
  let scene = explicitScene;
  if (!scene) {
    if (schedule) {
      const where = placeEn(schedule.place, schedule.title) || text(schedule.place) || '';
      const weather = weatherEn(schedule.weather) || text(schedule.weather, 40);
      const detail = detailFor(options.sceneDetails ?? []);
      scene = [where, detail, weather, timeEn(now)].filter(Boolean).join(', ');
      notes.push(`场景自动填：${schedule.start}–${schedule.end} ${schedule.title}${schedule.place ? ' @' + schedule.place : ''}`);
    } else {
      scene = [fallbackScene(options.snapshotFallbackScene, 'a quiet corner by the window'), detailFor(options.sceneDetails ?? []), timeEn(now)]
        .filter(Boolean)
        .join(', ');
      notes.push('场景自动填：默认（日程未启用或没有当前段）');
    }
  }
  return { scene, schedule: schedule ?? undefined, notes };
}

export const DEFAULT_RANDOM_SUBJECTS = [
  'a glass of water on a windowsill, afternoon light',
  'the stairwell after rain, half the lights dead',
  'a desk with scattered pencils and a half-finished sketch',
  'a cat sleeping on a chair by the window',
  'the street outside the window at dusk',
  'a bowl of noodles on the kitchen table, steam rising',
  'the balcony with laundry drying in the wind',
  'a bicycle seat wet from the rain, leaves on the ground',
  'the corner of a classroom, chalk dust in the sun',
  'a stack of books and a small vase of flowers',
];

export const RANDOM_STYLES = ['watercolor', 'sketch', 'illustration'] as const;

export function randomSubject(subjects?: string[]) {
  const pool = Array.isArray(subjects) && subjects.length ? subjects : DEFAULT_RANDOM_SUBJECTS;
  return pick(pool);
}

export function randomPaintingStyle(styles?: string[]) {
  const pool = Array.isArray(styles) && styles.length ? styles : RANDOM_STYLES.slice();
  return pick(pool);
}
