/*! 姿势工具：只给生图挑参考，不读日程、不写日程。 */

import type { Context } from 'whalelife';
import { posePick, poseRef } from './service.ts';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function registerTools(ctx: Context) {
  ctx.tools.register({
    name: 'pose_pick',
    description:
      '从姿势库里挑几组人体姿势参考，给画室 draw 用。要不要用、用哪一组由你按当前画面自己决定；不调用就完全不干预出图。' +
      '返回每组的中文名、视角、英文提示词片段和 id；把 id 填进 draw 的 pose 参数即可。',
    schema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '画面场景，用于排序：daily / home / camera / art / party / dress 等，默认 daily' },
        system: { type: 'string', description: '全身单人・标准系 / 上半身单人' },
        category: { type: 'string', description: '分类，比如 站姿、坐姿、趴卧、跪立、蹲姿、可爱系' },
        keyword: { type: 'string', description: '关键词，比如 回头、抱膝、侧顶' },
        view: { type: 'string', description: 'front / diag / side / back / high / low，默认按设置' },
        count: { type: 'integer', description: '要几组，1–12，默认 5' },
      },
      required: [],
    },
    danger: 'safe',
    origin: { platform: '姿势', action: '挑姿势参考' },
    run: async (args: any, session: any) => {
      try {
        const result = await posePick(ctx, {
          scene: args?.scene,
          system: args?.system,
          category: args?.category,
          keyword: args?.keyword,
          count: args?.count,
          view: args?.view,
          personaId: session?.personaId,
        });
        const lines = [
          `姿势库 ${result.library} 张可选（当前条件 ${result.available} 张）${result.note ? ` · ${result.note}` : ''}`,
          '用哪组由你决定；要采用就把 id 填进 draw 的 pose。',
        ];
        for (const item of result.items) {
          lines.push(`- ${item.id} 「${item.name}」${item.view} · ${item.category} · ${item.en}`);
        }
        return lines.join('\n');
      } catch (error) {
        return `姿势挑不出来：${errorText(error)}`;
      }
    },
  });

  ctx.tools.register({
    name: 'pose_ref',
    description: '取一组姿势的参考图、中文说明和英文提示词片段；不传 id 时按关键词挑一组。只作生图参考，不绑定日程。',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '姿势 id 或组 key，例如 full_single_P001_front' },
        keyword: { type: 'string', description: '不给 id 时按关键词挑一组，比如 回头、抱膝' },
        view: { type: 'string', description: 'front / diag / side / back / high / low' },
        depth: { type: 'boolean', description: 'true 取深度图参考路径（配 ControlNet Depth）' },
      },
      required: [],
    },
    danger: 'safe',
    origin: { platform: '姿势', action: '取姿势参考' },
    run: async (args: any, session: any) => {
      try {
        const result = await poseRef(ctx, {
          id: args?.id,
          keyword: args?.keyword,
          view: args?.view,
          depth: args?.depth === true,
          personaId: session?.personaId,
        });
        if (!result.found) return result.reason;
        return [
          `「${result.name}」${result.view} · ${result.tier}`,
          `英文：${result.en}`,
          `中文：${result.zh}`,
          result.imagePath ? `本地图：${result.imagePath}` : `图：${result.imageUrl}`,
          `缩略图：${result.thumb}`,
        ].join('\n');
      } catch (error) {
        return `姿势取不到：${errorText(error)}`;
      }
    },
  });
}
