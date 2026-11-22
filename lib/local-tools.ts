/*! 画室 · 本地生图工具探测。
 *
 * 只判断「插件内有没有已经部署好的本地工具」，以及配置里有没有显式路径。
 * 不扫描用户目录、不猜默认安装位置；模型清单由网络接口另查。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioConfig } from './config.ts';

export type LocalToolId = 'comfyui' | 'sdwebui';

export type LocalTool = {
  id: LocalToolId;
  name: string;
  installed: boolean;
  root: string;
  /** 插件内固定部署目录 */
  installRoot: string;
};

export function localInstallRoot(pluginRoot: string, id: LocalToolId): string {
  return join(pluginRoot, 'local', id === 'comfyui' ? 'comfyui' : 'sd-webui');
}

function existingRoot(candidates: string[], marker: string): string {
  return candidates.find((root) => Boolean(root) && existsSync(join(root, marker))) || '';
}

/** 探测 WhaleLife 根目录 / 插件内 / 配置里显式给出的本地工具；不扫 home 和其他盘符。 */
export function detectLocalTools(cfg: StudioConfig, pluginRoot: string): LocalTool[] {
  const hostRoot = join(pluginRoot, '..', '..');
  const comfyInstall = localInstallRoot(pluginRoot, 'comfyui');
  const sdInstall = localInstallRoot(pluginRoot, 'sdwebui');
  const comfyRoot = existingRoot([
    String(cfg.comfyRoot || '').trim(),
    comfyInstall,
    join(hostRoot, 'ComfyUI'),
    join(hostRoot, 'comfyui'),
  ], 'main.py');
  const sdRoot = existingRoot([
    String(cfg.sdRoot || '').trim(),
    sdInstall,
    join(pluginRoot, 'local', 'stable-diffusion-webui'),
    join(hostRoot, 'SD-WebUI'),
    join(hostRoot, 'stable-diffusion-webui'),
  ], 'launch.py');
  return [
    { id: 'comfyui', name: 'ComfyUI', installed: Boolean(comfyRoot), root: comfyRoot, installRoot: comfyInstall },
    { id: 'sdwebui', name: 'SD-WebUI', installed: Boolean(sdRoot), root: sdRoot, installRoot: sdInstall },
  ];
}
