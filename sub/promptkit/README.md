# 提示词小抄（promptkit）

画室的子插件（`plugins/studio/sub/promptkit`）。词库来自鱼仔 PromptForge 的**非成人子集**，
给生图链路补细节：姿势、表情、构图、镜头、光影、场景、天气、道具、风格。

不做的事：不换她的脸、不改年龄、不碰服装程度分级；NSFW 四类（身体/服装/姿势/道具）和人物基础/身材/面部整类已在构建时剔除。

## 工具

| 工具 | 作用 |
| --- | --- |
| `prompt_categories` | 看有哪些分类、各多少条 |
| `prompt_search` | 按关键词找词（中英都行） |
| `prompt_pick` | 按分类随机挑几个词，默认给英文 |
| `prompt_recipe` | 按固定配方（构图/光影/姿势/表情/风格）拼一段随机描述，场景和道具自己补 |

## 接进了生图流程

`draw` / `draw_batch` 出图前会自动调用本插件的 `enrich()`：

1. 先把 prompt 里已经写的中文词补成词库英文（例如「校服」→ `school uniform`、「阳台」→ `balcony`）；
2. 再从设置里勾选的层补词，正文里已经有的词跳过；
3. 补了什么会写进出图结果的 `notes`，例如 `小抄补词：8k, intricate details`。

默认 `draw` / `draw_batch` / `selfie` / `snapshot` / `paint` 都补，而且只补「质量与风格」里的质量词
（杰作/最佳质量/高分辨率等），画风词（anime / watercolor）和分级词（explicit / sensitive）不会自动加；
自拍/随手拍/画一幅固定的构图、镜头不动。想要更多细节可以把光影、场景等层勾上，也可以单独关掉某个动作。

图省事也可以不开自动：手动把 `prompt_pick` / `prompt_recipe` 的 `text` 填进
`selfie.scene`、`selfie.mood`、`selfie.outfit` 或 `draw.prompt`。

## 结构

- 词库引擎：`plugins/studio/lib/words.ts`，由父插件 `ctx.provide('promptkit', …)` 暴露；
- 本插件：只注册工具和设置页，配置写在自己的 `data/config.json`；
- 画画子插件：在 `optionalDepends` 里声明 `promptkit`，用 `ctx.optional('promptkit', …)` 拿到服务。

父级只读本插件的 `data/prompts.json` 和 `data/config.json`，不写。

## 数据与重建

- 数据文件：`data/prompts.json`（分类 17 个、词条约 1900，启用约 1790）
- 来源：`D:\dafeiyu\fish-extra\lib\forge-data.json`（只读，不改源文件）
- 重建：`node scripts/build-data.mjs`

过滤规则在 `scripts/build-data.mjs` 顶部：

- 整类剔除：`base` / `body` / `face` / `nsfwbody` / `nsfwcloth` / `nsfwact` / `nsfwplay` / `monster`
- 词条黑名单：中文按子串（裸、内衣、胸、大腿、床、浴室、蕾丝、泳装……），英文按单词边界（nude、lingerie、sex、bed、shower……）

改完重跑脚本，在设置页点「重新载入数据」即可，不用重启。

## 设置页

控制台 → 画室 → 提示词小抄，或直接打开 `/plugins/studio/promptkit/settings`：

- **默认语言 / 默认挑词数量**：工具没传 `lang` / `count` 时用
- **生图自动补词**：总开关、每次最多补几个（1–5）
- **给哪些动作补**：draw / selfie / snapshot / paint，默认四个都开
- **从哪些层补**：默认只有「质量与风格」；「负面」禁用
- **启用的分类**：取消勾选的分类不再出现在工具里（数据不删，随时勾回）
- **随机配方用的层**：`prompt_recipe` 只从勾选的层各取一个词
- **重新载入数据 / 恢复默认 / 保存设置**

`data/config.json` 结构：

```json
{
  "lang": "en",
  "pickCount": 3,
  "disabledCategories": ["negative"],
  "recipeLayers": ["composition", "lighting", "pose", "expression", "style"],
  "autoEnrich": true,
  "enrichKinds": ["draw", "selfie", "snapshot", "paint"],
  "enrichLayers": ["style"],
  "enrichCount": 2
}
```

## 许可

词库来源为鱼仔项目的私有数据，未随本项目再分发第三方素材；只在本机使用。
