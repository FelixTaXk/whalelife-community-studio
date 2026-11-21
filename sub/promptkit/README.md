# 提示词小抄（promptkit）

画室的子插件（`plugins/studio/sub/promptkit`）。给生图链路补细节：姿势、表情、构图、镜头、光影、场景、天气、道具、风格。

词库是**可选**的：随包带一份自撰的示例词库（11 个分类、140 条通用词，CC0-1.0，可自由再分发），装完即用；
想用自己的词库就在设置页导入，或把 `prompts.json` 放进 `data/`。自己词库的原始版权数据只留本地，不进仓库。

词库可以带成人分类（id 以 `nsfw` 开头）。这类分类默认**关闭**，要用得在设置页打开 NSFW 开关并确认一次警告；
自动补词始终不使用成人分类。随包示例词库不含成人内容。

不做的事：不换她的脸、不改年龄、不碰服装程度分级。

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

成人分类和负面词**永远不参与自动补词**：补词是无人值守地往每张图上加词，不该悄悄塞进成人内容。

默认 `draw` / `draw_batch` / `selfie` / `snapshot` / `paint` 都补，而且只补「质量与风格」里的质量词
（杰作/最佳质量/高分辨率等），画风词（anime / watercolor）和分级词（explicit / sensitive）不会自动加；
自拍/随手拍/画一幅固定的构图、镜头不动。想要更多细节可以把光影、场景等层勾上，也可以单独关掉某个动作。

图省事也可以不开自动：手动把 `prompt_pick` / `prompt_recipe` 的 `text` 填进
`selfie.scene`、`selfie.mood`、`selfie.outfit` 或 `draw.prompt`。

## NSFW 开关

词库里的成人分类（`nsfwbody` / `nsfwcloth` / `nsfwact` / `nsfwplay`，合起来 475 条）默认是关着的：

- 关着时，四个查词工具里看不到这些分类，按分类查/挑会直接说「成人分类，开关没开」；
- 打开时，设置页先弹一次确认框，服务端还要求请求带 `acknowledgeNsfw: true` —— 直接调接口也绕不过去；
  打开后页面顶部常驻一条红字警告，关掉即消失；
- 开关只影响**查词**。自动补词无论开关开没开，都不会用成人分类；
- 判断标准是分类 id 以 `nsfw` 开头，所以换词库、加分类都不用改代码。

## 结构

- 词库引擎：`plugins/studio/lib/words.ts`，由父插件**始终** `ctx.provide('promptkit', …)` 暴露（缺词库也注册）；
  引擎负责成人分类的门控（`allowNsfw`）与统计；
- 本插件：注册工具、设置页和导入 API，配置写在自己的 `data/config.json`；
- 画画子插件：在 `optionalDepends` 里声明 `promptkit`，用 `ctx.optional('promptkit', …)` 拿到服务。

词库查找顺序：`data/prompts.json`（用户自己的）→ `assets/prompts.sample.json`（随包示例）→ 空词库。
父级平时只读；只有用户在设置页点「导入词库」时才会写 `data/prompts.json`。

## 数据与重建

- **随包示例**：`assets/prompts.sample.json`，11 个分类、140 条通用词，自撰，CC0-1.0；
- **自己的词库**：`data/prompts.json`（不入 git），可以从自己的源数据重建；
- 重建：
  - `node scripts/build-data.mjs --full` —— 全量，保留 25 个分类、2742 条词（含 NSFW 四类 475 条）；
  - `node scripts/build-data.mjs` —— 安全子集，去掉 NSFW、人物基础/身材/面部/怪物，再按黑名单过滤（17 个分类）；
  - 两者都读 `FORGE_SRC` 指向的源数据（默认 `D:/dafeiyu/fish-extra/lib/forge-data.json`，只读不改源文件）。
- 检查格式：`node scripts/check-data.mjs`（默认看 `data/prompts.json`，也可以传路径）。会报分类数、词条数、
  NSFW 条数；格式不对时直接说哪里不对（例如把源数据的 `cats` 字段名当成了 `categories`）。

引擎两种写法都能读：`categories`（本插件格式）和 `cats`（PromptForge 源数据），
所以把自己的源数据直接丢进 `data/` 也能用，不必先转格式。

`scripts/build-data.mjs` 的过滤规则在文件顶部（整类剔除与词条黑名单），只对安全子集生效；
示例词库是手写的通用词，不含成人内容，也不依赖这个脚本。

## 设置页

控制台 → 画室 → 提示词小抄，或直接打开 `/plugins/studio/promptkit/settings`：

- **词库**：看当前用的是自己的还是随包示例；选 JSON 文件导入（上限 8MB）、下载示例词库、恢复示例词库
- **NSFW 分类**：总开关（默认关）、开着时的红字警告；关着时成人分类在下面几个列表里都上锁
- **默认语言 / 默认挑词数量**：工具没传 `lang` / `count` 时用
- **生图自动补词**：总开关、每次最多补几个（1–5）
- **给哪些动作补**：draw / selfie / snapshot / paint，默认四个都开
- **从哪些层补**：默认只有「质量与风格」；「负面」和成人分类禁用
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
  "enrichCount": 2,
  "allowNsfw": false
}
```

## 许可

随包示例词库 `assets/prompts.sample.json` 为本项目自撰，CC0-1.0，可自由复制、修改、再分发。
用户自己导入的 `data/prompts.json` 版权归其来源方，不进本仓库、不再分发；如果里面含成人内容，
只留本地、只在本人使用的实例里开关，不要把词库或生成结果公开分发。
