# 姿势 · 画室子插件

把 [ai-pose-gallery-zh](https://github.com/anhao/ai-pose-gallery-zh) 的中文姿势参考库接进画室，给生图提供英文提示词片段和参考图路径。**不绑日程、不读时间、不注入人格上下文**：要不要用、用哪一组，由人格或 `draw` 在生图那一刻自己决定。

## 装了什么

- **随包目录** `assets/catalog.json`：1439 张、288 组，每组五视角（正面 / 斜侧 / 侧面 / 背面 / 俯视 / 仰视）。
  - 全身单人・标准系 365 张 · general
  - 上半身单人 400 张：可爱系 125 张 general，性感・大胆系 / 挤胸・强调事业线系 275 张 private
  - 全身单人・性感系 399 张 · private
  - 双人缠绵 275 张 · couple（55 组）
  - 合计 general 490 张、private 674 张、couple 275 张
  - **private（高级参考）默认整类隐藏**：页面、图库、统计、缩略图接口都不出现。需要时在设置页连点版本号 7 次打开高级参考，且只对满 18 岁的人格生效；未成年人格即使打开开关也不显示。
  - **couple（双人参考）默认整类隐藏**，且在高级参考之上再加一层：高级没开时双人开关不生效；双人组只在图库 / `pose_pick` / `pose_ref` / `draw` 里显式取用，不会自动进入任何画面。
- **图片**：先读本地库 `libraryRoot`（默认留空 = 插件自带 `library/`，通常没有图），读不到 302 到 `https://ai-pose-gallery.anhao.app/` 的同名路径。白模和深度图（`thumbs/depth/*.webp`、`img/depth/*.webp`）都支持。
- **无状态**：不写 `state.json`，不记“今天用哪组”。每次取用都是当次的显式选择。
- **设置页**：`/plugins/studio/pose/settings`，可搜索图库（点卡片复制英文提示词）+ 图源与分级配置。

## 工具

| 工具 | 用途 |
| --- | --- |
| `pose_pick` | 按场景 / 体系 / 分类 / 关键词挑候选，带英文提示词；不给条件就随机一组 |
| `pose_ref` | 取一组姿势的参考图与提示词（按 id / 组 key / 关键词） |

画画的 `draw` 工具可选参数：`pose`（id / 组名 / 关键词，不填就完全不管姿势）、`pose_view`、`pose_depth`。填了会读画室 `integrations.pose` 指向的 `studio/sub/pose/data`，把英文片段接进 prompt，并在 notes 里给出参考图地址。

## 生图时怎么用

没有日程联动，也没有“当前姿势”。调用方在生图前决定：

1. 场景明确（卧室、教室、画室、街拍……）→ `pose_pick` 带 `scene` / `category` / `keyword` 挑几组候选。
2. 已经看中某组 → 直接把组 key 或姿势 id 传给 `draw` 的 `pose`。
3. 不需要参考 → 什么都不传，`draw` 不会改动 prompt。

`pose_pick` 会按场景词、体系、分类、关键词打分排序；命中不到就退回通用组。private / couple 的可见性完全由高级开关 + 双人开关 + 人格年龄决定，和日程无关。

## 配置（`data/config.json`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `advanced` | false | 高级参考（private）总开关，默认隐藏；设置页版本号连点 7 次才会出现开关 |
| `couple` | false | 双人参考（couple）开关，位于高级参考之上；高级没开时不生效，默认关 |
| `libraryRoot` | 空 | 本地姿势库根目录（含 `thumbs/`、`img/`） |
| `assetBaseUrl` | `https://ai-pose-gallery.anhao.app/` | 本地没图时的云端前缀；留空 = 只用本地 |
| `adultThreshold` | 18 | 成年年龄线，最低 18 |
| `unknownPersona` | minor | 读不到年龄时按未成年 |
| `personaPolicy` | {} | 单个人格强制未成年 / 成年（读到未满 18 时“成年”不生效） |
| `preferDepth` | false | 页面优先显示深度图 |
| `viewPreference` | auto | 默认视角，auto = 优先正面 |

## 维护

```powershell
# 用本机 ComfyUI 姿势库重新生成随包目录（写 assets/catalog.json）
node scripts/import-pose.mjs "D:/ComfyUI/custom_nodes/comfyui-pose-gallery/library"

# 导入用户自己的库（写 data/catalog.json，并在设置里把 libraryRoot 切过去）
node scripts/import-pose.mjs "<库根目录>" "plugins/studio/sub/pose/data/catalog.json"
```

导入器只读 `data/pose-zh.json` + 相对路径，不复制图片；库更新后用同一条命令重建索引即可。

## 来源与许可

- 姿势库元数据与图片：ギア（@giaaibusi）原始站点，中文整理 [anhao/ai-pose-gallery-zh](https://github.com/anhao/ai-pose-gallery-zh)；本插件只镜像中文索引，不打包图片，图片版权归原作者。
- 本插件代码沿用画室（studio）的 AGPL-3.0-only 与附加条款。
- 仅供个人学习、人体动态研究与合法创作参考；不要用于违法、侵害他人权益或未授权换脸的用途。
