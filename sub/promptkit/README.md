# 提示词小抄（promptkit）· 画室子插件

画室的提示词子插件，放在 `plugins/studio/sub/promptkit`。它做四件事：

- 按分类查词；
- 按分类随机挑词；
- 按配方层拼一段随机描述；
- 给画画的出图流程提供「自动补词」和「共用负面提示词」。

词库引擎常驻父插件 `studio/lib/words.ts`，由父级 `ctx.provide('promptkit')` 暴露；本子插件只负责工具、设置页和导入接口。画画子插件与设置页共享同一份引擎。

## 安装与入口

1. 确认 `plugins/studio/plugin.yaml` 的 `sub` 包含 `promptkit`。
2. 把本目录放在 `plugins/studio/sub/promptkit`。
3. 重启 WhaleLife；日志应出现：
   - `画室已加载`
   - `[画画] 提示词小抄已接入`
   - `提示词小抄已加载 {"settings":"/plugins/studio/promptkit/settings"}`
4. 从「画室设置」页顶部导航的 **提示词小抄** 进入设置；也可以直接打开 `/plugins/studio/promptkit/settings`。

本子插件不再注册独立的插件设置入口，设置入口统一挂在画室设置里；画画、拍视频、提示词小抄三个设置页共用画室子插件导航。

## 词库

- 用户词库：`data/prompts.json`（优先）；
- 随包示例：`assets/prompts.sample.json`（CC0-1.0，11 个分类、通用词）；
- 两份都没有时返回空词库，页面给导入说明，不报 500。

用户词库坏了会自动回退到示例，并在页面和工具结果里标 `broken` / `notice`。用户词库属于本地数据，不进发布包。

## 工具

| 工具 | 作用 |
| --- | --- |
| `prompt_categories` | 看当前启用的分类和词条数量 |
| `prompt_search` | 按关键词找词，匹配词条的所有文本字段 |
| `prompt_pick` | 按分类随机挑几个词，默认返回主字段 |
| `prompt_recipe` | 按配置的配方层各取一个词，拼接成一段描述 |

负面分类不出现在分类列表、随机挑词和配方里，统一放在设置页的「共用负面提示词」里维护。

## 服务契约

父插件注册的服务：

```ts
type PromptkitService = {
  enrich(input: { text: string; kind?: string; signal?: AbortSignal }): Promise<{
    text: string;
    added: Array<{ cat: string; word: string; why: string }>;
    skipped: string;
  }>;
  recipe(input: { extra?: string; lang?: string; layers?: string[] }): Promise<{
    status: string;
    text: string;
    layers: Array<{ category: string; words: string[] }>;
  }>;
  negativePrompt(): Promise<string>;
};
```

画画子插件在 `plugin.yaml` 里声明 `optionalDepends: [promptkit]`，并用 `ctx.optional('promptkit', …)` 绑定。服务由父级提供，所以同一父级下的子插件都能解析；停用画室时一起释放。

`kind` 只用于匹配配置里的动作白名单，默认 `*` 表示全部接受；引擎不认识具体动作名。

## 配置

配置保存在子插件自己的 `data/config.json`，设置页改的就是这份文件。`assets/config.example.json` 是一份完整示例。所有字段都有默认值，缺项不会报错。

| 字段 | 作用 |
| --- | --- |
| `lang` | 默认返回语言：`primary` / `secondary` / `both`；旧值 `en` / `zh` 会映射到主/副字段 |
| `pickCount` | 默认挑词数量，1–8 |
| `disabledCategories` | 不参与查词/挑词/配方的分类 id |
| `recipeLayers` | 配方层；留空时按启用分类兜底 |
| `recipeMaxLayers` | 配方最多生成多少层，1–20 |
| `autoEnrich` | 自动补词总开关，默认关 |
| `enrichKinds` | 动作白名单；`["*"]` 表示所有 `kind` 都补 |
| `enrichLayers` | 自动补词从哪些分类补；留空则不补 |
| `enrichCount` | 每次最多补几个，1–5 |
| `allowNsfw` | 是否允许查词工具使用成人分类，默认 `false` |
| `negativePrompt` | 共用负面提示词，上限 4000 字符 |
| `fields.primary` | 词条主字段，默认 `en`；自动补词优先用它 |
| `fields.secondary` | 词条副字段，默认 `zh`；正文命中副字段时补主字段 |
| `semantics.negative` | 负面分类 id，默认 `negative`；留空表示没有负面分类 |
| `semantics.quality` | 质量分类 id，默认 `quality` |
| `semantics.nsfwPrefix` | 成人分类 id 前缀，默认 `nsfw`；分类对象上的 `nsfw` / `adult` / `role: nsfw` 优先 |
| `qualityAllowlist` | 质量分类里只允许这些词参与自动补词；留空表示不额外收窄 |
| `blockedPatterns` | 自动补词的安全词正则数组；留空表示不额外过滤 |

### 字段名不固定

词条结构是：

```json
{
  "categories": [
    { "id": "lighting", "name": "光影", "role": "quality" }
  ],
  "tags": [
    { "cat": "lighting", "zh": "逆光", "en": "backlight" }
  ]
}
```

字段名可以不是 `zh` / `en`。把 `fields` 设成 `{ "primary": "prompt", "secondary": "cn" }` 就能用。分类可以带 `role`（`negative` / `quality` / `nsfw`）或布尔 `nsfw` / `adult`。

## 自动补词

调用方把正文交给 `enrich()` 后：

1. 先把正文里出现的副字段换成词库主字段；
2. 再从 `enrichLayers` 勾选的分类里挑词，正文里已经有的词跳过；
3. 成人分类、负面分类、命中 `blockedPatterns` 的词永远不补；
4. 质量分类如果配置了 `qualityAllowlist`，只允许白名单里的词。

自动补词默认关闭，补了什么会通过 `added` 返回。

## 成人分类

分类对象上带 `nsfw: true`、`adult: true` 或 `role: "nsfw"`，或者 id 命中 `semantics.nsfwPrefix`，就算成人分类。

- 默认关闭：四个查词工具里看不到，按分类查/挑会明确说「开关没开」；
- 打开时，设置页先弹一次确认框，服务端还要求请求带 `acknowledgeNsfw: true`；
- 打开后页面顶部常驻警告，关掉即消失；
- 开关只影响查词。自动补词无论开关开没开，都不会用成人分类。

## 脚本

- **重建**：`node scripts/build-data.mjs --source <词库.json> [--out data/prompts.json] [--only a,b] [--exclude c]`
- **校验**：`node scripts/check-data.mjs [文件] [--nsfw-prefix adult] [--negative bad]`
- **自测**：`node scripts/selftest.mjs`（不需要宿主，使用临时合成词库）

## 许可

插件代码为 AGPL-3.0-only，完整条款见 `LICENSE`。

随包示例词库 `assets/prompts.sample.json` 为本项目自撰，CC0-1.0，可自由复制、修改、再分发。用户导入的词库版权归其来源方，不进仓库、不再分发。
