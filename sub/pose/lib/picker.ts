/*! 选姿势：只从姿势库里挑参考，不绑定日程。分级闸门 + 场景/关键词打分。 */

import type { Pose, PoseTier } from './catalog.ts';
import { viewOf } from './catalog.ts';

export type PickOptions = {
  /** 生图场景（daily / home / camera 等），只影响打分，不代表日程。 */
  scene?: string;
  adult?: boolean;
  /** 高级参考开关：没打开时 private 整类不参与任何挑选。 */
  advanced?: boolean;
  /** 双人开关：只在高级参考打开后才可能生效；关闭时 couple 整类不参与。 */
  couple?: boolean;
  keyword?: string;
  view?: string;
  preferDepth?: boolean;
};

export type PoseGroup = { key: string; items: Pose[]; item: Pose };

function tierOf(item: Pose): PoseTier {
  return item.tier ?? 'general';
}

/** 未成年人格只能看 general；private 要“成年 + 高级开关”，couple 还要再叠加“双人开关”。 */
export function itemAllowed(item: Pose, _scene: string, adult = false, advanced = false, couple = false): boolean {
  const tier = tierOf(item);
  if (tier === 'general') return true;
  if (!adult || !advanced) return false;
  if (tier === 'couple') return couple;
  // private 只由开关和年龄决定；场景只参与打分，不再当准入条件（姿势库不绑日程）。
  return true;
}

export function groupsOf(items: Pose[]): PoseGroup[] {
  const map = new Map<string, Pose[]>();
  for (const item of items) {
    const list = map.get(item.group) ?? [];
    list.push(item);
    map.set(item.group, list);
  }
  const groups: PoseGroup[] = [];
  for (const [key, list] of map) groups.push({ key, items: list, item: list[0] });
  return groups;
}

export function scoreGroup(group: PoseGroup, opts: PickOptions): number {
  const head = group.item;
  if (!itemAllowed(head, opts.scene ?? 'daily', opts.adult === true, opts.advanced === true, opts.couple === true)) return -1e9;

  let score = 0;
  if (opts.scene && head.scenes.includes(opts.scene)) score += 32;
  if (opts.advanced && head.tier === 'private') score += 8;
  if (opts.couple && head.tier === 'couple') score += 6;
  if (head.system.includes('标准系')) score += 6;
  if (head.system === '上半身单人' && opts.scene === 'camera') score += 8;

  if (opts.keyword) {
    const needle = opts.keyword.toLowerCase();
    const hay = `${head.name} ${head.category} ${head.system} ${head.en}`.toLowerCase();
    score += hay.includes(needle) ? 24 : -40;
  }

  return score + Math.random() * 6;
}

export function pickPose(items: Pose[], opts: PickOptions): Pose | null {
  const groups = groupsOf(items);
  let best: PoseGroup | null = null;
  let bestScore = -Infinity;
  for (const group of groups) {
    const score = scoreGroup(group, opts);
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  if (!best) return null;
  return viewOf(best.items, opts.view) ?? best.item;
}

export function pickMany(items: Pose[], opts: PickOptions, count = 5): Array<{ item: Pose; score: number }> {
  const keyword = String(opts.keyword ?? '').trim().toLowerCase();
  const groups = groupsOf(items).filter((group) => {
    if (!keyword) return true;
    const hay = `${group.item.name} ${group.item.category} ${group.item.system} ${group.item.en}`.toLowerCase();
    return hay.includes(keyword);
  });
  return groups
    .map((group) => ({ group, score: scoreGroup(group, { ...opts, keyword: undefined }) }))
    .filter((entry) => entry.score > -1e8)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, count))
    .map((entry) => ({
      item: viewOf(entry.group.items, opts.view) ?? entry.group.item,
      score: entry.score,
    }));
}
