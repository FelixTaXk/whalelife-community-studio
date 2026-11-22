/*! 姿势 · 目录读取、分组、图片路径与远端图源。 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLibraryRoot } from './paths.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const USER_CATALOG = resolve(DIR, '..', 'data', 'catalog.json');
const BUILTIN_CATALOG = resolve(DIR, '..', 'assets', 'catalog.json');

export type PoseTier = 'general' | 'private' | 'couple';
export type PoseViewSlug = 'front' | 'diag' | 'side' | 'back' | 'high' | 'low';
export type AssetSize = 'thumb' | 'image' | 'depthThumb' | 'depth';

export type Pose = {
  id: string;
  group: string;
  system: string;
  code: string;
  category: string;
  name: string;
  view: string;
  viewSlug: string;
  tier: PoseTier;
  couple?: boolean;
  scenes: string[];
  en: string;
  zh: string;
  thumb: string;
  image: string;
  depthThumb: string;
  depth: string;
  source?: string;
};

export type Catalog = {
  items: Pose[];
  byId: Map<string, Pose>;
  groups: Map<string, Pose[]>;
  report: any;
  source: any;
  generatedAt?: string;
  loadedAt: string;
  file: string;
  overridden: boolean;
};

let cache: Catalog | null = null;

function readCatalogFile(): { file: string; body: any; overridden: boolean } {
  // 用户自己导入的库优先；随包目录兜底。
  for (const file of [USER_CATALOG, BUILTIN_CATALOG]) {
    if (!existsSync(file)) continue;
    try {
      return { file, body: JSON.parse(readFileSync(file, 'utf8')), overridden: file === USER_CATALOG };
    } catch {
      continue;
    }
  }
  return { file: '', body: { items: [], report: { error: '还没有姿势目录，先跑 scripts/import-pose.mjs' } }, overridden: false };
}

export function loadCatalog(force = false): Catalog {
  if (cache && !force) return cache;
  const { file, body, overridden } = readCatalogFile();
  const items: Pose[] = Array.isArray(body.items) ? body.items : [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const groups = new Map<string, Pose[]>();
  for (const item of items) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  cache = {
    items,
    byId,
    groups,
    report: body.report ?? {},
    source: body.source ?? {},
    generatedAt: String(body.generatedAt ?? ''),
    loadedAt: new Date().toISOString(),
    file,
    overridden,
  };
  return cache;
}

export function reloadCatalog(): Catalog {
  return loadCatalog(true);
}

export function libraryRoot(config: any): string {
  return resolveLibraryRoot(config);
}

function relOf(item: Pose, size: AssetSize): string {
  switch (size) {
    case 'image': return item.image;
    case 'depthThumb': return item.depthThumb;
    case 'depth': return item.depth;
    default: return item.thumb;
  }
}

/** 本地库里的图片绝对路径；路径必须留在库根目录之内。 */
export function assetPath(root: string, item: Pose, size: AssetSize): string | null {
  const rel = relOf(item, size);
  if (!rel) return null;
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root))) return null;
  return existsSync(full) ? full : null;
}

/** 云端图源：默认接 ai-pose-gallery.anhao.app，同一套相对路径。 */
export function remoteAssetUrl(config: any, item: Pose, size: AssetSize): string | null {
  const base = String(config?.assetBaseUrl ?? '').trim();
  if (!base) return null;
  const rel = relOf(item, size);
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  try {
    const root = base.endsWith('/') ? base : base + '/';
    return new URL(rel.replace(/^\/+/, ''), root).toString();
  } catch {
    return null;
  }
}

export function assetUrl(id: string, size: AssetSize = 'thumb', personaId?: string) {
  const persona = personaId ? `&persona=${encodeURIComponent(personaId)}` : '';
  return `/plugins/studio/pose/thumb?id=${encodeURIComponent(id)}&size=${size}${persona}`;
}

/** 同一组姿势里挑一个指定视角；没有就用正面，再没有取第一个。 */
export function viewOf(group: Pose[], slug?: string): Pose | null {
  if (!group.length) return null;
  if (slug && slug !== 'auto') {
    const hit = group.find((item) => item.viewSlug === slug);
    if (hit) return hit;
  }
  return group.find((item) => item.viewSlug === 'front') ?? group[0];
}

/** 给页面/工具用的公开字段。 */
export function poseView(item: Pose | null) {
  if (!item) return null;
  return {
    id: item.id,
    group: item.group,
    system: item.system,
    code: item.code,
    category: item.category,
    name: item.name,
    view: item.view,
    viewSlug: item.viewSlug,
    tier: item.tier,
    couple: item.couple === true,
    scenes: item.scenes,
    en: item.en,
    zh: item.zh,
    thumb: assetUrl(item.id, 'thumb'),
    image: assetUrl(item.id, 'image'),
    depthThumb: assetUrl(item.id, 'depthThumb'),
    depth: assetUrl(item.id, 'depth'),
  };
}
