/*! 画室（studio）类型定义。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

/** 归一化出图请求：所有后端都吃这一份，各自挑自己支持的字段。 */
export type GenRequest = {
  prompt: string;
  negative?: string;
  width?: number;
  height?: number;
  n?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  /** 底模 / checkpoint / 线上模型名 */
  model?: string;
  /** 只给家族（moss/qwen/flux/sdxl/sd15）时，插件自己挑该家族的底模 */
  family?: string;
  loras?: Array<{ name: string; strength?: number }>;
  /** 本地图片路径：图生图、参考图、首帧 */
  image?: string;
  /** 额外的参考图（锁脸用，MOSS-Image Edit 最多 4 张） */
  refs?: string[];
  /** 本地蒙版路径：白=重画（必须与原图同尺寸） */
  mask?: string;
  /** 重绘强度 0–1 */
  strength?: number;
  /** 仅 ComfyUI：指定 API 格式工作流文件名 */
  workflow?: string;
  extra?: Record<string, any>;
};

export type GenFile = {
  path: string;
  bytes: number;
  width?: number;
  height?: number;
  kind: 'image' | 'video';
};

export type GenOk = {
  ok: true;
  backend: string;
  files: GenFile[];
  seed?: number;
  width?: number;
  height?: number;
  notes?: string[];
  meta?: Record<string, any>;
};

export type GenFail = { ok: false; error: string; backend?: string };
export type GenResult = GenOk | GenFail;

export type BackendCaps = {
  txt2img: boolean;
  img2img: boolean;
  mask: boolean;
  negative: boolean;
  size: boolean;
  model: boolean;
  loras: boolean;
  batch: boolean;
  /** 支持后台任务式（提交后另查） */
  async: boolean;
  local: boolean;
};
