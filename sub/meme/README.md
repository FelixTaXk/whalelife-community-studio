# 表情包工坊（meme）

给一张图配一句短话，做成表情包。除了底部白条 / 气泡 / 描边 / 顶部字幕，还能自动选位置、精确调排版、出 WebP 或 GIF 动效，并把整套图打包成 ZIP。设置页不依赖本地固定路径，Python、字体、允许目录、文案模型都在页面里配置，适合直接给插件商城用户使用。

成品通过图库公开的 `offerMedia` 交成临时引用（`mediaRef`，24 小时有效、绑定当前会话）；收藏进图库由 `gallery_collect` 完成。装了 QQ、且当前工具权限为 full 时，可以按 QQ 号直接发送。

## 安装

本插件是画室（`studio`）的子插件，单独打成 `studio/meme` 发行包；商店里单独安装时会先确认父包，父包未安装就同时安装画室和目标子插件。源码方式把本目录放到 `plugins/studio/sub/meme/`，并在 `plugins/studio/plugin.yaml` 的 `sub` 列表里包含 `meme`。

装好后重启 WhaleLife。渲染需要 Python 3 + Pillow：先看设置页填的解释器，没填就复用画室配置的 Python，最后按 PATH 找带 Pillow 的 `python` / `python3`。字幕需要中文字体，默认按当前系统查找常见中文字体，也可以在设置页指定字体文件。装了图库（`gallery` 0.1.2+）才能按资产 id 取图、把成品交成 `mediaRef`；没装也能上传图片或让画室画图，只是成品只落本地。

## 功能

- **五种版式**：`band` 底部白条、`bubble` 白气泡、`plain` 描边大字、`top` 顶部白条、`auto` 按上下区域亮度自动选顶部或底部。
- **精确排版**：字号、行高、对齐、外边距、内边距、最多行数、水平/垂直偏移、描边、阴影、自动字色和自定义颜色。
- **格式与动效**：PNG / WebP / GIF；动效 `pop` 弹入、`shake` 轻微抖动、`zoom` 缓慢放大，选非 `none` 会自动出 GIF。
- **平台预设**：QQ 512、微信 240、Telegram 512、Discord 320、自定义；宽度范围 128–1600。
- **配文候选**：按语气（阴阳 / 无语 / 可爱 / 职场 / 开心 / 生气 / 累 / 干饭）给短句；配置了文案模型会结合图片生成，没有模型或调用失败就用内置短语库。
- **四风格对比**：同一张图、同一句字，一次出 `band` / `bubble` / `plain` / `top` 四张，点任意一张可切到对应样式。
- **批量套图**：一行一条字幕，最多 24 张；可按一种样式或多种样式批量出图，自动打包 ZIP，包内按 `01-style.ext` 编号并带 `manifest.json`。
- **项目**：把底图、字幕、批量字幕、样式、排版、格式、动效和平台存成项目；之后改一句字就能重出，不用重新画图。
- **模板与词库**：内置 6 套模板、8 种语气词库；可导出 JSON 备份、导入到别的实例。模板只改样式和排版，不执行代码。
- **可选收藏 / QQ**：`studio_meme_make` 可传 `collect=true` 收藏进图库；`send=true` 且给了 `userId`、权限为 full 时直接调 `qq_send_gallery`。没有图库或 QQ 时不会假装成功，结果里会写明原因。

## 工具

| 工具 | 作用 |
| --- | --- |
| `studio_meme_make` | 单张：图 + 字幕 → 一张表情包（返回 `mediaRef` 临时引用）；可选收藏进图库、发 QQ |
| `studio_meme_set` | 一套：同一张原图 + 一组字幕（≤8 条）→ 多张表情包 |
| `studio_meme_batch` | 批量：最多 24 条字幕 / 多种样式 → 一套图 + ZIP 下载 |
| `studio_meme_suggest` | 配文：按语气和方向给短句候选；有模型结合图片，没有就用本地词库 |
| `studio_meme_project` | 项目：`list/save/get/update/delete/render`，保存底图与排版，改字重出 |

通用参数：

- `sourceId`：图库图片 id（画室 `draw` / `selfie` / `snapshot` 返回的 `galleryId` 就是）
- `sourcePath`：本地图片路径；只接受插件输出目录、画室输出目录，或设置页「允许读取的本地目录」里由你明确添加的目录
- `text`：字幕，最多 120 字，短句最好（“就这？”“困成鱼干”“气死我了”）
- `style`：`band`（默认）/ `bubble` / `plain` / `top` / `auto`
- `width`：成品宽度，默认 512，范围 128–1600
- `format`：`png` / `webp` / `gif`
- `animation`：`none` / `pop` / `shake` / `zoom`；非 `none` 强制 GIF
- `platform`：`qq` / `wechat` / `telegram` / `discord` / `custom`
- `layout`：`fontSize`、`lineHeight`、`align`、`margin`、`padding`、`maxLines`、`offsetX`、`offsetY`、`strokeWidth`、`shadow`、`autoContrast`、`textColor`、`bandColor`、`strokeColor`

## 设置页

控制台 → 插件 → 画室 → 表情包工坊，或直接打开 `/plugins/studio/meme/settings`：

1. **参考图**三选一：上传图片（PNG / JPG / WebP / GIF，≤15 MB）；图库资产 ID；让画室 AI 画一张参考图。AI 出图前会先体检画室后端，没配好时按钮禁用并给出设置入口。
2. **字幕 / 样式 / 宽度 / 平台 / 格式 / 动效**：填完点「一键出图」，右侧显示预览、尺寸、样式、格式、字体和图库引用，可下载。
3. **配文候选**：选语气、填方向提示，点「给我配文」，点任意候选直接填入字幕。
4. **精细排版**：展开后调字号、行高、对齐、边距、偏移、描边、阴影和颜色，作用于单张、批量和项目重出。
5. **四风格对比 / 批量套图 / 项目 / 模板与词库**：对应上面的功能。
6. **默认参数**：默认样式、宽度、格式、平台、文案模型和允许读取的本地目录。
7. **Python / 字体**：留空自动探测；保存时校验填写的路径是否存在。
8. **输出统计 / 清空输出**：只清理 `data/out` 里的 `meme-*` 成品、参考图和临时输入，不影响已入库或已发送的图。

设置保存在 `data/config.json`，结构：

```json
{
  "python": "",
  "font": "",
  "allowedDirs": [],
  "defaultStyle": "band",
  "defaultWidth": 512,
  "defaultFormat": "png",
  "defaultPlatform": "custom",
  "captionModel": "",
  "defaultLayout": {
    "fontSize": 0,
    "lineHeight": 1.35,
    "align": "center",
    "margin": 18,
    "padding": 20,
    "maxLines": 4,
    "offsetX": 0,
    "offsetY": 0,
    "strokeWidth": 0,
    "shadow": false,
    "autoContrast": true,
    "textColor": "",
    "bandColor": "",
    "strokeColor": ""
  }
}
```

`allowedDirs` 填绝对路径，按当前系统格式写。`data/` 是运行数据，不会被官方 `.wlpkg.gz` 打包工具收进发行包。

## 页面接口

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/plugins/studio/meme/source` | POST | `{type:"upload",base64}` / `{type:"gallery",galleryId}` / `{type:"ai",prompt,width,height}` → 落一份 `meme-src-*`，返 `sourceFile` / `sourceUrl` |
| `/plugins/studio/meme/oneclick` | POST | 单张渲染；正文可带 `layout/format/animation/platform/fps/duration/quality`，返 `url` / `mediaRef` / 尺寸 / 字体 |
| `/plugins/studio/meme/compare` | POST | 同一图、同一字幕出 `band/bubble/plain/top` 四张，返 `items` |
| `/plugins/studio/meme/batch` | POST | `{sourceFile,texts,styles?,style?,...}` → 最多 24 张并打包 ZIP，返 `items` / `zip` |
| `/plugins/studio/meme/suggest` | POST | `{sourceFile?,tone,hint,count}` → `{source:"model"/"local",captions,note}` |
| `/plugins/studio/meme/projects` | POST | `action=list/save/get/update/delete/render`；保存底图、字幕、排版和批量字幕 |
| `/plugins/studio/meme/project-src` | GET | `?id=<项目 id>` 预览项目底图 |
| `/plugins/studio/meme/presets` | POST | 读取或保存 `{tones,templates}`；只接受固定结构，不执行代码 |
| `/plugins/studio/meme/model-check` | POST | 出图模型体检：`{ok,backend,label,online,message,settingsUrl}` |
| `/plugins/studio/meme/config` | POST | 保存设置 |
| `/plugins/studio/meme/clear-out` | POST | 清理 `meme-*` 成品、参考图和临时输入 |
| `/plugins/studio/meme/out` | GET | `?name=meme-*.png|webp|gif|zip` 预览，`&download=1` 下载；只放 `data/out` 里的 `meme-*` 文件 |

## 实现

- `index.ts`：取图（图库资产 id / 本地白名单 / 上传 / 画室生成）、调 Python、图库 `offerMedia`、收藏与 QQ 发送、项目 / 批量 / 配文 / 模板、设置页。
- `tools/render_meme.py`：Pillow 排版；自动折行与字号；五种版式；WebP / GIF 动效；字体按「设置指定 → 当前系统常见中文字体」解析。
- `tools/zip_files.py`：按调用方传入的绝对文件路径和 zip 内文件名打包，不推导本机目录。
- 临时输入写在 `data/tmp/`，渲染完即删；成品、参考图和 ZIP 在 `data/out/`，项目在 `data/projects/`。
- 默认模板和词库在 `data/presets.json`，首次加载时生成；可在设置页导入 / 导出。

渲染一次约 0.2–0.5 秒（512 宽），不占 GPU；GIF 会按帧数增加时间。
