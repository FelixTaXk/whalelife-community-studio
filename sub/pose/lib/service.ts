/*! 姿势 · 业务层：只要姿势库本身，不读日程、不往日程里写东西。
 *
 * 用途：给 AI 生图（draw）提供可选的人体姿势参考；用不用、用哪一组由调用方自己决定。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assetPath, assetUrl, loadCatalog, poseView, remoteAssetUrl, viewOf, type Catalog, type Pose } from './catalog.ts';
import { normalizeConfig, readConfig, type PoseConfig } from './config.ts';
import { audienceFor } from './policy.ts';
import { groupsOf, itemAllowed, pickMany } from './picker.ts';
import { displayPath, libraryReady, PLUGIN_ROOT, resolveLibraryRoot, resolveUserPath } from './paths.ts';

function assetOf(root: string, config: PoseConfig, item: Pose | null, size: 'image' | 'depth') {
  if (!item) return { path: '', url: '' };
  const local = assetPath(root, item, size);
  const remote = remoteAssetUrl(config, item, size);
  return { path: local ?? '', url: local ? '' : (remote ?? '') };
}

/** 设置页的图库列表：默认每个姿势组只出正面，选了视角才按视角列。 */
export async function gallery(ctx: any, opts: { system?: string; category?: string; view?: string; keyword?: string; tier?: string; limit?: number; offset?: number; personaId?: string }) {
  const catalog = loadCatalog();
  const config = await readConfig(ctx);
  const audience = await audienceFor(ctx, opts.personaId);
  const advanced = config.advanced === true && audience.adult;
  const couple = advanced && config.couple === true;
  const view = String(opts.view ?? '').trim();
  const keyword = String(opts.keyword ?? '').trim().toLowerCase();
  let list = catalog.items.filter((item) => {
    // 默认整类不可见；private 要高级开关，couple 还要在此基础上再开双人开关。
    if (item.tier === 'private' && !advanced) return false;
    if (item.tier === 'couple' && !couple) return false;
    if (opts.system && item.system !== opts.system) return false;
    if (opts.category && item.category !== opts.category) return false;
    if (opts.tier && item.tier !== opts.tier) return false;
    if (view && view !== 'auto' && item.viewSlug !== view) return false;
    if (!view || view === 'auto') {
      // 组内只保留正面；没有正面就保留第一个
      const group = catalog.groups.get(item.group) ?? [];
      const front = group.find((entry) => entry.viewSlug === 'front') ?? group[0];
      if (front?.id !== item.id) return false;
    }
    if (keyword && !`${item.name} ${item.category} ${item.system} ${item.en} ${item.id}`.toLowerCase().includes(keyword)) return false;
    return true;
  });

  const total = list.length;
  const limit = Math.min(96, Math.max(12, Number(opts.limit) || 36));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const pageItems = list.slice(offset, offset + limit);
  return {
    total,
    offset,
    limit,
    items: pageItems.map((item) => ({
      ...poseView(item),
      thumb: assetUrl(item.id, 'thumb', audience.id),
      image: assetUrl(item.id, 'image', audience.id),
      depthThumb: assetUrl(item.id, 'depthThumb', audience.id),
      depth: assetUrl(item.id, 'depth', audience.id),
    })),
    persona: { id: audience.id, name: audience.name, age: audience.age, adult: audience.adult },
  };
}

/** 生图前挑几组候选：返回英文提示词片段，供画室 draw 的 pose 参数用。 */
export async function posePick(ctx: any, opts: { scene?: string; system?: string; category?: string; keyword?: string; count?: number; view?: string; personaId?: string }) {
  const catalog = loadCatalog();
  const config = await readConfig(ctx);
  const audience = await audienceFor(ctx, opts.personaId);
  const advanced = config.advanced === true && audience.adult;
  const couple = advanced && config.couple === true;
  const scene = opts.scene || 'daily';
  const count = Math.min(12, Math.max(1, Number(opts.count) || 5));
  const view = opts.view || config.viewPreference;
  let pool = catalog.items;
  if (opts.system) pool = pool.filter((item) => item.system === opts.system);
  if (opts.category) pool = pool.filter((item) => item.category === opts.category);
  const visibleTotal = catalog.items.filter((item) => itemAllowed(item, scene, audience.adult, advanced, couple)).length;
  const available = pool.filter((item) => itemAllowed(item, scene, audience.adult, advanced, couple)).length;
  const picked = pickMany(pool, { scene, adult: audience.adult, advanced, couple, keyword: opts.keyword, view }, count);
  const note = !audience.adult
    ? `当前人格${audience.age !== null ? ` ${audience.age} 岁` : ''}未满 ${audience.threshold} 岁，只用标准/日常姿势。`
    : !advanced
      ? '高级参考没开，只列标准/日常姿势。'
      : !couple
        ? '双人参考没开，双人姿势组不会出现。'
        : '';
  return {
    scene,
    view,
    keyword: opts.keyword ?? '',
    persona: { id: audience.id, name: audience.name, age: audience.age, adult: audience.adult },
    count: picked.length,
    library: visibleTotal,
    available,
    note,
    items: picked.map((entry) => ({ ...poseView(entry.item), score: Math.round(entry.score) })),
  };
}

/** 给画室出图用的完整姿势信息：中文名、英文提示词片段、本地路径/远端地址。 */
export async function poseRef(ctx: any, opts: { id?: string; keyword?: string; view?: string; depth?: boolean; personaId?: string }) {
  const config = await readConfig(ctx);
  const catalog = loadCatalog();
  const audience = await audienceFor(ctx, opts.personaId);
  const advanced = config.advanced === true && audience.adult;
  const couple = advanced && config.couple === true;
  const root = resolveLibraryRoot(config);
  let pose: Pose | null = null;
  const id = String(opts.id ?? '').trim();

  if (id) {
    const hit = catalog.byId.get(id);
    if (hit) pose = hit;
    else {
      // 也接受组 key 或姿势名/分类关键词
      const groups = groupsOf(catalog.items);
      const group = groups.find((entry) => entry.key === id || entry.item.name === id)
        ?? groups.find((entry) => entry.item.name.includes(id) || entry.item.category.includes(id));
      pose = group ? viewOf(group.items, opts.view ?? config.viewPreference) : null;
    }
    if (!pose) return { found: false, reason: `姿势库里没有 ${id}。` };
  } else {
    const hits = pickMany(catalog.items, {
      scene: 'camera',
      adult: audience.adult,
      advanced,
      couple,
      keyword: opts.keyword,
      view: opts.view ?? config.viewPreference,
    }, 1);
    pose = hits[0]?.item ?? null;
    if (!pose) return { found: false, reason: '姿势库里没有符合条件的参考。' };
  }

  if (!itemAllowed(pose, 'camera', audience.adult, advanced, couple)) {
    return { found: false, reason: '这组参考当前不可用。' };
  }

  const size: 'image' | 'depth' = opts.depth === true ? 'depth' : 'image';
  const asset = assetOf(root, config, pose, size);
  return {
    found: true,
    id: pose.id,
    group: pose.group,
    name: pose.name,
    view: pose.view,
    tier: pose.tier,
    en: pose.en,
    zh: pose.zh,
    prompt: `${pose.zh} → ${pose.en}`,
    imagePath: asset.path,
    imageUrl: asset.url || assetUrl(pose.id, size, audience.id),
    thumb: assetUrl(pose.id, config.preferDepth ? 'depthThumb' : 'thumb', audience.id),
    localLibrary: displayPath(root),
    persona: { id: audience.id, name: audience.name, age: audience.age, adult: audience.adult },
  };
}

export async function stats(ctx: any, opts: { hidePrivate?: boolean; hideCouple?: boolean } = {}) {
  const catalog = loadCatalog();
  const config = await readConfig(ctx);
  const root = resolveLibraryRoot(config);
  const hidePrivate = opts.hidePrivate === true;
  const hideCouple = opts.hideCouple === true;
  const systems: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  let poses = 0;
  const visibleGroups = new Set<string>();
  for (const item of catalog.items) {
    if (hidePrivate && item.tier === 'private') continue;
    if (hideCouple && item.tier === 'couple') continue;
    poses += 1;
    visibleGroups.add(item.group);
    systems[item.system] = (systems[item.system] ?? 0) + 1;
    categories[item.category] = (categories[item.category] ?? 0) + 1;
    tiers[item.tier] = (tiers[item.tier] ?? 0) + 1;
  }
  const filtered = hidePrivate || hideCouple;
  return {
    poses,
    totalPoses: filtered ? poses : catalog.items.length,
    groups: filtered ? visibleGroups.size : catalog.groups.size,
    privateHidden: hidePrivate,
    coupleHidden: hideCouple,
    systems,
    categories,
    tiers,
    // 只要有整类被隐藏，就不把隐藏的数量/分类带出去。
    report: filtered
      ? { kept: poses, groups: visibleGroups.size, sfwOnly: true }
      : catalog.report,
    generatedAt: catalog.generatedAt,
    // 有整类隐藏时，来源信息也只给仓库和镜像，不把被隐藏的分级带出去。
    source: filtered
      ? { repo: catalog.source?.repo, mirror: catalog.source?.mirror }
      : catalog.source,
    catalogFile: displayPath(catalog.file),
    catalogOverridden: catalog.overridden,
    config,
    libraryPath: displayPath(root),
    libraryBundled: root === resolveLibraryRoot({ libraryRoot: '' }),
    libraryReady: libraryReady(config),
    assetBaseUrl: config.assetBaseUrl,
    assetMode: !libraryReady(config) || !existsSync(join(root, 'thumbs')) ? 'remote' : 'local',
  };
}

export async function saveConfig(ctx: any, patch: any) {
  const current = await readConfig(ctx);
  const next = normalizeConfig({ ...current, ...patch });
  const saved = await ctx.config.save('config.json', next);
  return saved ?? next;
}

export async function importLibrary(ctx: any, root?: string) {
  const config = await readConfig(ctx);
  const { spawn } = await import('node:child_process');
  const script = resolve(PLUGIN_ROOT, 'scripts', 'import-pose.mjs');
  const target = resolveUserPath(root) || resolveUserPath(config.importRoot) || resolveLibraryRoot(config);
  const output = join(PLUGIN_ROOT, 'data', 'catalog.json');
  const env = { POSE_LIBRARY: target };

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [script, target, output], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }));
    child.on('error', (error) => done({ code: 1, stdout, stderr: String(error) }));
  });

  if (result.code !== 0) throw Error(result.stderr || result.stdout || '导入失败');
  try {
    const body = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop() as string);
    return { ...body, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch {
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
}
