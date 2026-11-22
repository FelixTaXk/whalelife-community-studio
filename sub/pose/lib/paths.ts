/*! 姿势 · 路径解析：内置/自定义姿势库、插件目录、显示路径。 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
/** lib -> pose */
export const PLUGIN_ROOT = resolve(DIR, '..');
/** pose -> sub -> studio */
export const STUDIO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
/** pose -> sub -> studio -> plugins */
export const PLUGINS_ROOT = resolve(PLUGIN_ROOT, '..', '..', '..');
/** 插件自带的姿势库根目录（默认留空，图片走远端）。 */
export const BUNDLED_LIBRARY = join(PLUGIN_ROOT, 'library');
export const LIBRARY_ENV = 'POSE_LIBRARY';

function fromEnv(): string {
  const value = String(process.env[LIBRARY_ENV] ?? '').trim();
  if (!value) return '';
  return isAbsolute(value) ? resolve(value) : resolve(PLUGIN_ROOT, value);
}

/** 用户填的库路径：绝对路径直接用，相对路径按插件目录解析。 */
export function resolveUserPath(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return isAbsolute(value) ? resolve(value) : resolve(PLUGIN_ROOT, value);
}

/** 配置里的 libraryRoot：留空 = 插件内置 library/（通常只有索引）。 */
export function resolveLibraryRoot(config: any): string {
  const env = fromEnv();
  if (env) return env;
  const raw = String(config?.libraryRoot ?? '').trim();
  if (!raw) return BUNDLED_LIBRARY;
  return resolveUserPath(raw);
}

/** 页面/工具里的短路径：在插件内显示相对路径，别把本机盘符带到界面。 */
export function displayPath(target: string): string {
  const rel = relative(PLUGIN_ROOT, resolve(target)).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : resolve(target);
}

/** 库里是否真的有一份 pose-zh.json（用来判断本地库能不能直接读图）。 */
export function libraryReady(config: any): boolean {
  const root = resolveLibraryRoot(config);
  return existsSync(join(root, 'data', 'pose-zh.json'));
}

export const SCHEDULE_DAYS = join(PLUGINS_ROOT, 'schedule', 'data', 'days');
