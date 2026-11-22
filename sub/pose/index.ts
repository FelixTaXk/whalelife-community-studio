/*! 画室 · 姿势子插件：一份中文人体姿势参考库，只服务 AI 生图。
 *
 * 不读日程、不按时间配姿势、不往日程或人格上下文里注入任何东西；
 * 生图时由调用方（人格 / draw）自己决定要不要取一组参考。
 *
 * 目录优先读 data/catalog.json（用户导入的库），其次 assets/catalog.json（随包快照）。
 * 图片先读本地库 libraryRoot，读不到就 302 到云端图源；没有图也不影响出图。
 *
 * 隐藏分级：private 只对成年人格 + 高级开关；couple 再叠加双人开关，默认整类不可见。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Context } from 'whalelife';
import { loadCatalog } from './lib/catalog.ts';
import { registerTools } from './lib/tools.ts';
import { registerWeb } from './lib/web.ts';
import { posePick, poseRef, stats } from './lib/service.ts';

const VERSION = '0.2.22';

type PoseService = {
  /** 指定 id / 组 key / 关键词取一组参考；不传就按关键词挑。 */
  resolve(input?: { id?: string; keyword?: string; view?: string; depth?: boolean; personaId?: string }): Promise<any>;
  /** 图库检索，给别的插件查词用。 */
  search(input?: { system?: string; category?: string; keyword?: string; view?: string; count?: number; personaId?: string }): Promise<any>;
};

export async function apply(ctx: Context) {
  const catalog = loadCatalog();

  registerTools(ctx);
  registerWeb(ctx, catalog, { version: VERSION });

  const service: PoseService = {
    resolve: async (input) => poseRef(ctx as any, input ?? {}),
    search: async (input) => {
      return posePick(ctx as any, {
        system: input?.system,
        category: input?.category,
        keyword: input?.keyword,
        view: input?.view,
        count: input?.count,
        personaId: input?.personaId,
      });
    },
  };
  (ctx as any).provide?.('pose', service);

  const info = await stats(ctx as any, { hidePrivate: true, hideCouple: true }).catch(() => null);
  ctx.logger.info('姿势子插件已启用', {
    version: VERSION,
    poses: info?.poses ?? catalog.items.filter((item) => item.tier === 'general').length,
    groups: info?.groups ?? new Set(catalog.items.filter((item) => item.tier === 'general').map((item) => item.group)).size,
    tiers: info?.tiers ?? { general: catalog.items.filter((item) => item.tier === 'general').length },
    catalog: catalog.overridden ? 'data/catalog.json' : 'assets/catalog.json',
    assetMode: info?.assetMode ?? 'remote',
    schedule: false,
  });
}
