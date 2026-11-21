/*! 画室 · 自拍/随手拍的场景与穿搭解析。
 *
 * 优先级：用户显式参数 > 日程/衣柜 > 默认。
 * 日程、衣柜是可选插件：读不到就跳过，不抛错、不阻断出图。
 * 只读它们的 data 文件，不改、不写。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = join(HERE, '..', '..', '..', '..');

const rootOf = (root?: string) => (root && root.trim() ? root : PLUGINS_ROOT);

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
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

export function readSchedule(now = new Date(), root?: string): ScheduleMoment | null {
  const date = dateKey(now);
  const plan = readJson(join(rootOf(root), 'schedule', 'data', 'days', `${date}.json`));
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

export function readWardrobeOutfit(date: string, itemId?: string, root?: string): { id: string; en: string; name: string; tier: string } | null {
  const state = readJson(join(rootOf(root), 'schedule', 'sub', 'wardrobe', 'data', 'state.json'));
  const day = state?.personas?.whale?.days?.[date];
  if (!day) return null;
  const id = text(itemId && day.blocks?.[itemId] ? day.blocks[itemId] : day.base, 40);
  if (!id) return null;
  const catalog = readJson(join(rootOf(root), 'schedule', 'sub', 'wardrobe', 'data', 'catalog.json'));
  const item = Array.isArray(catalog?.items) ? catalog.items.find((entry: any) => entry?.id === id) : null;
  if (!item) return null;
  return {
    id,
    en: text(item.en, 300),
    name: text(item.name, 200),
    tier: text(item.tier || item.rating, 40),
  };
}

const placeEn = (place: string, title: string) => {
  const value = `${place} ${title}`;
  if (/学校|教室|上课/.test(value)) return 'at school';
  if (/家|房间|卧室|客厅|厨房|阳台/.test(value)) return 'at home';
  if (/路|街|公交|地铁|车站/.test(value)) return 'on the way';
  if (/公园|操场|户外|出去|走走|散步/.test(value)) return 'outside';
  if (/店|超市|商场|图书/.test(value)) return 'in a shop';
  if (/修照片|修图|自由|在家/.test(value)) return 'at home';
  return place ? `at ${place}` : '';
};

const activityEn = (title: string) => {
  if (!title) return '';
  if (/起床|醒来/.test(title)) return 'just woke up, still in bed';
  if (/洗漱|洗澡|浴室/.test(title)) return 'in the bathroom';
  if (/准备睡|睡前|睡觉/.test(title)) return 'getting ready for bed';
  if (/睡/.test(title)) return 'sleeping';
  if (/早餐|午餐|晚餐|吃|面|饭/.test(title)) return 'having a meal';
  if (/画|速写|水彩/.test(title)) return 'drawing at her desk';
  if (/修照片|修图|剪辑/.test(title)) return 'editing photos on her laptop';
  if (/作业|学习|复习|看书|读/.test(title)) return 'studying at her desk';
  if (/上课|课/.test(title)) return 'in class';
  if (/跑步|运动|锻炼/.test(title)) return 'after a run, a little out of breath';
  if (/回家|放学/.test(title)) return 'just got home';
  if (/散步|逛|走走|出去/.test(title)) return 'walking outside';
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
  if (/雨/.test(weather)) return 'rainy, the ground still wet';
  if (/雪/.test(weather)) return 'snowing';
  if (/晴/.test(weather)) return 'clear light';
  if (/阴|多云/.test(weather)) return 'soft gray light';
  if (/风/.test(weather)) return 'a little windy';
  return '';
};

const homeDetails = [
  'steam from a cup on the desk',
  'a half-finished sketch and scattered pencils',
  'laundry drying on the balcony',
  'light falling across the floor',
  'a chair by the window, nobody sitting in it',
];
const schoolDetails = [
  'chalk dust floating in the sunlight',
  'a row of empty desks by the window',
  'the stairwell, half the lights dead',
  'a notebook left open on a desk',
];
const streetDetails = [
  'a wet bicycle seat after the rain',
  'a puddle reflecting the sky',
  'traffic lights just coming on',
  'the curb, leaves stuck to the ground',
];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

const detailFor = (place: string) => {
  const value = place || '';
  if (/学校|教室/.test(value)) return pick(schoolDetails);
  if (/路|街|公交|地铁|出去|走走|散步/.test(value)) return pick(streetDetails);
  return pick(homeDetails);
};

export function resolveSelfieContext(args: any = {}, now = new Date(), root?: string): ShotContext {
  const notes: string[] = [];
  const schedule = readSchedule(now, root);
  const explicitScene = text(args?.scene);
  const explicitOutfit = text(args?.outfit);
  const explicitMood = text(args?.mood);
  let scene = explicitScene;
  let outfit = explicitOutfit;
  let mood = explicitMood;

  if (!scene) {
    if (schedule) {
      const where = placeEn(schedule.place, schedule.title) || 'at home';
      const doing = activityEn(schedule.title);
      const weather = weatherEn(schedule.weather);
      scene = [where, doing, weather, timeEn(now)].filter(Boolean).join(', ');
      notes.push(`场景自动填：${schedule.start}–${schedule.end} ${schedule.title}${schedule.place ? ' @' + schedule.place : ''}`);
    } else {
      scene = ['in her room by the window', timeEn(now)].filter(Boolean).join(', ');
      notes.push('场景自动填：默认窗边（日程未启用）');
    }
  }

  if (!outfit && schedule) {
    const found = readWardrobeOutfit(schedule.date, schedule.id, root);
    if (found) {
      outfit = found.en || found.name;
      notes.push(`穿搭自动填：${found.id} ${found.name}`);
    } else {
      notes.push('穿搭默认：校服（衣柜没有这一段的记录）');
    }
  } else if (!outfit) {
    notes.push('穿搭默认：校服（衣柜未启用）');
  }

  if (!mood) {
    if (weatherEn(schedule?.weather ?? '')) {
      mood = weatherEn(schedule!.weather);
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

export function resolveSnapshotContext(args: any = {}, now = new Date(), root?: string): ShotContext {
  const notes: string[] = [];
  const schedule = readSchedule(now, root);
  const explicitScene = text(args?.scene);
  let scene = explicitScene;
  if (!scene) {
    if (schedule) {
      const where = placeEn(schedule.place, schedule.title) || 'at home';
      const weather = weatherEn(schedule.weather);
      scene = [where, detailFor(`${schedule.place} ${schedule.title}`), weather, timeEn(now)].filter(Boolean).join(', ');
      notes.push(`场景自动填：${schedule.start}–${schedule.end} ${schedule.title}${schedule.place ? ' @' + schedule.place : ''}`);
    } else {
      const hour = now.getHours();
      const where = hour >= 22 || hour < 7 ? 'at home, a corner of her room' : hour >= 8 && hour < 17 ? 'on the way, a street corner' : 'at home, by the window';
      scene = [where, pick(where.includes('street') || where.includes('outside') ? streetDetails : homeDetails), timeEn(now)].join(', ');
      notes.push('场景自动填：默认（日程未启用）');
    }
  }
  return { scene, schedule: schedule ?? undefined, notes };
}

export const RANDOM_SUBJECTS = [
  'a glass of water on a windowsill, afternoon light',
  'the stairwell after rain, half the lights dead',
  'her desk with scattered pencils and a half-finished sketch',
  'a cat sleeping on a chair by the window',
  'the street outside the window at dusk',
  'a bowl of noodles on the kitchen table, steam rising',
  'the balcony with laundry drying in the wind',
  'a bicycle seat wet from the rain, leaves on the ground',
  'the corner of a classroom, chalk dust in the sun',
  'a stack of books and a small vase of flowers',
];

export const RANDOM_STYLES = ['watercolor', 'sketch', 'illustration'] as const;

export function randomSubject() {
  return pick(RANDOM_SUBJECTS);
}

export function randomPaintingStyle() {
  return pick([...RANDOM_STYLES]);
}
