/*! 画室（studio）· 工具参数到归一化出图请求。
 *
 * 画画子插件和父级公开服务共用这一份，避免两边各写一套参数映射。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { GenRequest } from './types.ts';
import { parseSize } from './util.ts';

export function requestOf(args: any): GenRequest {
  const size = parseSize(args?.size);
  return {
    prompt: String(args?.prompt ?? '').trim(),
    negative: args?.negative ? String(args.negative) : undefined,
    width: Number(args?.width) || size?.width,
    height: Number(args?.height) || size?.height,
    n: args?.n ? Number(args.n) : undefined,
    seed: args?.seed === undefined || args?.seed === null ? undefined : Number(args.seed),
    steps: args?.steps ? Number(args.steps) : undefined,
    cfg: args?.cfg ? Number(args.cfg) : undefined,
    sampler: args?.sampler ? String(args.sampler) : undefined,
    scheduler: args?.scheduler ? String(args.scheduler) : undefined,
    model: args?.model ? String(args.model) : undefined,
    image: args?.image ? String(args.image) : args?.reference ? String(args.reference) : undefined,
    refs: Array.isArray(args?.refs) ? args.refs.map((item: any) => String(item)) : undefined,
    mask: args?.mask ? String(args.mask) : undefined,
    strength: args?.strength !== undefined ? Number(args.strength) : undefined,
    workflow: args?.workflow ? String(args.workflow) : undefined,
    extra: {
      ...(args?.extra && typeof args.extra === 'object' ? args.extra : {}),
      ...(args?.image_strength !== undefined ? { image_strength: args.image_strength } : {}),
      ...(args?.edit_format ? { edit_format: String(args.edit_format) } : {}),
    },
  };
}
