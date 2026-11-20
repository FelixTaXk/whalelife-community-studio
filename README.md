# 画室（studio）

一个插件，两个干活的入口：**画画**（出图 / 改图 / 看图 / 画蒙版）和**拍视频**（图生视频）。
底下挂五种后端，本地和网络共用同一套话术调用：`comfy`（ComfyUI 直连）、`sdwebui`（A1111 / Forge / SD.Next）、
`openai`（任何 OpenAI 兼容中转）、`gemini`、`dashscope`（通义万相）。**不再连 8190 小桥**，所有逻辑都在插件里。

它取代了 `plugins/comfy`（视频工坊）和 `plugins/photo`（拍照·画画）。那两个已停用并从 `plugins/` 移走
（连同数据放在 `D:\AI\whalelife\.artifacts\retired-plugins\2026-11-19\`），停用记录在 `config/plugins.json`。

工具名：

- 父级：`studio_status`（体检）/ `studio_workflow`（查槽位）/ `studio_models`（本地模型清单）/ `studio_build`（按模型拼工作流）
- 画画：`draw` / `draw_batch` / `draw_task` / `image_view` / `image_mask` / `image_workflows`
- 拍视频：`make_video` / `video_task` / `video_workflows`

子插件：

- `sub/image`：上面那组画画工具
- `sub/video`：上面那组视频工具
- `sub/promptkit`（提示词小抄）：`prompt_categories` / `prompt_search` / `prompt_pick` / `prompt_recipe`，加上设置页 `/plugins/studio/promptkit/settings`

`promptkit` 的词库引擎放在父级（`lib/words.ts`），由 `ctx.provide('promptkit', …)` 同时给两个子插件用：
词库和补词配置归小抄自己（`sub/promptkit/data/`），画画在出图前调用 `enrich()`，
默认给 `draw` / `selfie` / `snapshot` / `paint` 补 2 个质量词，补了什么会写进结果的 `notes`。

## 给其他插件用

`ctx.provide('studio', service)`。消费者在 manifest 声明 `optionalDepends: [studio]`，用 `ctx.optional('studio', …)` 接入；
不需要画室时保持未启用也能正常跑。

| 方法 | 作用 |
| --- | --- |
| `config()` / `save(patch)` / `paths()` | 读配置、存配置、拿输出目录等工作路径 |
| `workflows({kind})` / `models({refresh})` | 列工作流、列本地模型 |
| `health(name?)` | 不传 name 查 `defaultBackend`：`online=true` 能连、`false` 连不上、`null` 配置了但没法便宜地探（如通义异步接口）；带 `reason` / `version` / `device` |
| `generate(input, signal?)` | 直接出一张图：参数与 `draw` 一致（prompt / negative / width / height / model / workflow / image / mask / strength…），返回 `GenResult`（`ok` / `files` / `seed` / `notes`） |
| `promptkit`（另一个服务） | `stats()` / `categories()` / `search()` / `pick()` / `recipe()` / `enrich({text, kind})`：查词、挑词、拼配方、出图前自动补词 |

`generate` 和 `draw` 走同一条后端链路，但不入图库、不发消息、不建任务记录；调用方拿 `files[].path` 自己处理。

## 一条命令就能出图

```
draw("1girl, silver hair, red eyes, black coat")                                  # 用设置页的默认工作流
draw("1girl, silver hair, red eyes", model="moss_image_sft_int8_convrot.safetensors")  # 按模型现拼
```

第二种是重点：**只给模型名，插件现场拼一份完整工作流**（UNETLoader → CLIPLoader → VAELoader → 加速 LoRA → KSampler → VAE 解码 → 存图），
跑完会告诉你这份工作流是怎么拼的（家族、步数、CFG、采样器、用了哪些文件）。

## 按模型自动拼工作流

`lib/models.ts` 先读 ComfyUI 的 `/object_info`（这是它自己认的模型清单，最权威），再用文件系统补体积；
ComfyUI 没开时退回扫 `models/` 目录。`lib/graph.ts` 按家族拼图：

| 家族 | 认法 | 拼法 | 默认参数 |
|---|---|---|---|
| MOSS | unet 名带 `moss` | UNETLoader + CLIPLoader(`moss_image`) + VAELoader + `MOSS_8_step_lora` | 768×1024 / 8 步 / cfg 2.5 / er_sde / simple |
| Qwen-Image 2.1 | unet 名带 `qwen_image` | UNETLoader + CLIPLoader(`qwen_image`) + VAELoader + 6 步加速 LoRA | 768×1024 / 6 步 / cfg 1.0 / euler / simple |
| Flux | unet/vae 名带 `flux` | UNETLoader + DualCLIPLoader(clip_l + t5xxl) + VAELoader | 1024×1024 / 20 步 / cfg 3.5 |
| SDXL | checkpoint 名带 sdxl / 体积 ≥5 GB | CheckpointLoaderSimple 单节点 | 832×1216 / 28 步 / cfg 6.5 / dpmpp_2m / karras |
| SD1.5 | checkpoint 名带 sd15 / majicmix / guofeng… | CheckpointLoaderSimple 单节点 | 512×768 / 28 步 / cfg 7 / dpmpp_2m / karras |

配套件是按「同一家族里找」挑的，不是写死的：

- MOSS 的文本编码器配 `qwen3.5_*`、VAE 配 `flux2-vae_*`（跟本机跑通的 MOSS 工作流一致，实测出图字节级一致）
- Qwen 的文本编码器配 `qwen3vl_8b_*`，会主动排除 MiniMax H3 那套（它体积更大、方言不同）
- Qwen 的加速 LoRA 只认 `p_q_image_2.1_*` 这类 2.1 专用件，**不会**把 `Qwen-Image-Edit-*` 的 4 步 LoRA 套到文生图上（那是改图模型的）
- checkpoint 名字认不出家族时按体积判断（≥5 GB 当 SDXL），并在 `notes` 里说明是猜的

缺件不返回半份：没文本编码器就报「没找到 X 配的文本编码器（现有：…），可以显式传 clip」。

想先看拼出来什么再跑：

```
studio_models()                                      # 看有什么模型（带体积、家族、clipTypes）
studio_build(model="...", prompt="...")              # 只看：家族、用了哪些文件、节点数、槽位
studio_build(model="...", save_as="我的底模")         # 存成 data/workflows/我的底模.json
```

## 工作流：API 格式和画布格式都能用

ComfyUI 界面「另存为」出来的是**画布格式**（`nodes` / `links`），`/prompt` 要 **API 格式**。两种都收：

- `data/workflows/` 放 API 格式，直接跑。
- ComfyUI 自己存的画布格式（默认 `D:\ComfyUI\user\default\workflows`，可在设置页指定）读进来在内存里转 API，
  节点定义直接问 `/object_info`，所以自定义节点也能转；转不动会报卡在哪个节点类型和 id。

```
image_workflows()        # 只列能出图的（带槽位、格式、可用性）
video_workflows()        # 只列能出视频的
studio_workflow("xxx")   # 看某一份的槽位
draw(..., workflow="MOSS_普通生图.json")   # 指定某一份
```

同一份既有 API 版又有画布版时合并成一条，API 版优先。

### 槽位是怎么认出来的

从输出节点往上找采样器，再顺着 `positive` / `negative` 找文本编码器。几个刻意决定，都是踩坑后定的：

- **正面提示词默认 `replace`**：上游那套默认 `append`，会把模板尾巴悄悄留在后面。
- **负面提示词 `append`**，但按逗号 tag 去重。
- **认不出提示词入口直接报错**：Flux `CLIPTextEncodeFlux`、Qwen-Edit 的 `prompt` 字段上游会「校验通过但填不进去」，这里当场说清楚。
- **图生图走真上传**：`LoadImage.image` 要服务端文件名，走 `POST /upload/image`（multipart），不是塞本地路径字符串。
- **`extra` 是逃生口**：已识别的任何槽位（LoRA 名、强度、帧数）都能直接填。

## 内置工作流清单（2026-11-19 重建）

旧的五份（MOSS_普通生图 / MOSS图鉴重绘 / Qwen_普通生图 / 观澜_角色LoRA / 鱼仔_角色LoRA）
和 ComfyUI 画布里的观澜、鱼仔那两份，全部归档到 `.artifacts/retired-workflows/2026-11-19/`。
现在 `data/workflows` 里是七份干净的、每一份都真跑出过片子的：

| 文件 | 模型 | 尺寸 | 步数 | 说明 |
|---|---|---|---|---|
| `MOSS_标准生图.api.json` | moss + 8 步加速 | 768×1024 | 8 | **默认**。纯提示词出图，不带任何角色 LoRA |
| `MOSS_竖版自拍.api.json` | moss + 8 步加速 | 512×896 | 8 | 手机自拍比例，`selfie` 用这个尺寸 |
| `MOSS_锁脸编辑.api.json` | moss + 8 步加速 + 官方 edit LoRA | 512×896 | 8 | 带 `LoadImage` 槽（`image_1`），填参考图锁脸；不用角色 LoRA |
| `SD15_写实人像.api.json` | `majicmixRealistic_v7` | 512×768 | 28 | dpmpp_2m/karras、cfg 7，写实随手拍 |
| `SD15_国风.api.json` | `GuoFeng3.4` | 512×768 | 28 | 国风/水墨感画面 |
| `MiniMaxH3_文生视频.api.json` | `minimax_h3_fl2va` + 官方 4 步 turbo | 864×480 | 4 | 纯文生视频，自带立体声，`length` 按 17k+5 对齐（124≈5 秒） |
| `MiniMaxH3_首帧转视频.api.json` | 同上 | 864×480 | 4 | 多一个 `LoadImage`（`image_1`）当首帧，`make_video(image=…)` 用它 |

几点说明：

- **不带任何定制化 LoRA**：观澜/鱼仔那类角色 LoRA 不再烤进工作流。要用 LoRA 就在调用里传 `loras`
  （每个工作流都把 `lora_1_name` / `lora_1_strength` 认成了槽），或者填设置页的「她的角色 LoRA」。
- **Qwen 系列没有**：本机 `qwen_image_2.1_turbo_int8_convrot` / `qwen3vl_8b_int8_convrot` 加载就报
  JSONDecodeError，出了也用不了，所以不放进清单里。
- **加速 LoRA 留着**（`MOSS_8_step_lora`、`minimax_h3_fl2v_turbo_4step`）：这是模型自带的步数压缩器，
  不是定制角色，去掉它就得跑 20–30 步，慢且没必要。
- 视频默认走 `MiniMaxH3_文生视频.api.json`；要「她本人出现在视频里」，先 `selfie` 出图再把那张当
  `image` 传 `make_video`（用首帧那套）。
- 槽位识别这轮补了 `SamplerCustomAdvanced` / `BasicGuider`：视频工作流的提示词藏在 guider 后面，
  `steps` 在 `BasicScheduler`、`seed` 在 `RandomNoise`、`sampler` 在 `KSamplerSelect`，现在都能认。
### 图上的中文（实测边界）

MOSS 能把中文写对，前提是「字少、字大、对比强、背景干净」：

| 写法 | 结果 |
|---|---|
| `招牌上用红色黑体写着"热牛奶"`，并说明字占画面一半 | 三个字完全正确 |
| `黑板上用白色粉笔写着"距高考还有300天"` | 整句、连笔都对 |
| 一张图里塞好几处小字（价签、海报、墙上小牌子） | 主标题对，小字全糊成伪字 |

所以提示词规则是：中文字用中文引号括住、一句七八个字以内、明确说「字很大」。
要固定字体（黑体/宋体）、要精确位置、或者字很小一段很长，就用 `image_text` 压上去——
那条是 Pillow 排版，字体和位置都是可控的。
## 看图与蒙版

模型看图只能读到图上画出来的数字，缩了再看坐标必然偏。`imgtool.py` 把裁剪、缩放、网格一次换算完，
**刻度永远标原图像素**；`image_mask` 用同一套原图坐标生成同尺寸黑白图（白=重画）：

```
image_view("D:\...\out\xxx.png", crop="100,80,300,360")
image_mask(source="D:\...\out\xxx.png", boxes="120,80,240,300")
```

只用 Pillow，不联网、不改原图。

## 任务表

宿主一次调用默认 10 分钟上限，视频十分钟起。`make_video`、`draw_batch` 走落盘任务表：立刻给任务号，
之后 `video_task` / `draw_task` 查。任务 JSON 落在 `sub/*/data/tasks`，并发 1，保留 200 条；宿主重启时跑着的标成「中断」。
参数错误（首帧不存在、工作流输出的是图片）在**排队前**就返回。

## 视频

`make_video` 只走 ComfyUI 的视频工作流，**不按模型拼**。视频工作流里的节点（sigma shift、私有采样器）太多，
硬拼容易跑到一半炸；用你在 ComfyUI 里跑通的那份更稳。现在本机三份 MiniMax-H3 画布还不能自动转：

- `MiniMax-H3_图生视频.json` 含「组件节点」（UUID 类型），`/object_info` 没定义
- 另外两份能转，但采样器是 MiniMax 私有的，槽位认不出

所以在 `video_workflows()` 目前是空的，`make_video` 会直接告诉你「还没有可用视频工作流」。
补的办法：在 ComfyUI 里救通之后「导出 → API」放进 `data/workflows`，或在画布目录里留一份能自动转的。

## 配置

`data/config.json`（从 `config.example.json` 抄一份改），或设置页 `/plugins/studio/settings`：

| 后端 | baseUrl | 说明 |
|---|---|---|
| `comfy` | `http://127.0.0.1:8188` | 默认后端；`workflowsDir` / `canvasDir` / `modelsDir`，留空自动探测 |
| `sdwebui` | `http://127.0.0.1:7860` | 启动要带 `--api`；`model` 填 checkpoint 名 |
| `openai` | `https://api.openai.com/v1` | 尺寸自动吸到模型允许的档位 |
| `gemini` | `https://generativelanguage.googleapis.com` | 原生 `generateContent`，不吃尺寸 |
| `dashscope` | `https://dashscope.aliyuncs.com` | 异步任务 + 轮询，尺寸写 `1024*1024` |

密钥只存 `data/config.json`，设置页回显只显示「已填/未填」，留空保存表示保持原值。

`workflowsDir` 留空时按插件 `data/workflows` 解析（默认值是相对 data 目录的 `workflows`）；放到别处就填绝对路径。

## 常见报错对照

| 看到什么 | 实际原因 |
|---|---|
| `后端没在跑（连接被拒绝）` | ComfyUI 8188 / SD-WebUI 7860 没起 |
| `没找到 moss 配的文本编码器（现有：…）` | 模型没放齐：补一个，或显式传 `clip` |
| `认不出 X 属于哪个家族` | 名字里没有家族线索：传 `family`，或换个认得出的模型 |
| `工作流没有填写项：positive_prompt` | 认不出提示词入口：换一份，或手动补 |
| `输出的是图片，不是视频` | 拿生图工作流当视频工作流了 |
| `还没有可用视频工作流` | 见上面「视频」一节 |
| `Python：没找到（看图/画蒙版不可用）` | 填 `python`，或用 ComfyUI 的 venv，或设 `STUDIO_PYTHON` |

## 让她自己拍、自己画（怎么被触发）

工具名就是她的动作，不用绕。人格（`memory/personas/whale.md`）里已经写了「直接出，别先解释」，
自主性的动机文案里也有「画一张、拍一张」——所以她既能被一句话触发，也能自己想起来。

| 她说听到的 | 调哪个 | 说明 |
|---|---|---|
| 发个自拍 / 看看你 / 你在干嘛 / 今天穿什么 | `selfie` | 外貌固定（黑长直、校服、旧胶片机、十七岁），只换场景、心情、衣服；默认竖版 512×896 |
| 拍个风景 / 拍张照 / 外面什么样 | `snapshot` | 没人入镜的角落、光、东西；默认 1024×768，胶片味 |
| 随便画一幅 / 画个我 / 画今天看到的 | `paint` | 水彩 + 速写，故意留手绘的不完美（水色不匀、铅笔底稿、纸纹） |
| 拍个视频 / 录一段 / 发个动态 | `make_video` | 需要现成视频工作流；要她本人出镜先 `selfie` 出首帧再传 `image` |
| 只想出一张图、自己写提示词 | `draw` | 通用入口，什么都能画 |
| 做成表情包 / 图上写句话 | `image_text` | 压字（要卡字体、卡位置、字小时用；大字模型自己就写对） |

场景词**用英文更跟得住**（这是实测：`balcony at dusk` 这种会照着走，纯中文常被模型忽略），
所以 `scene` / `mood` / `subject` 的说明里都提示了英文示例，中文也收（MOSS 本身吃中文，
本机两份中文角色工作流都是纯中文提示词，能跑）。

### 怎么让她每张都是同一张脸（参考图，不用训 LoRA）

结论先给：**用参考图，不要为她的脸训角色 LoRA。**

本机 `loras` 里已经有 `moss_image_edit_lora_rank_64_bf16`（MOSS-Image 官方的 edit LoRA，297MB），
配合 ComfyUI 的 `TextEncodeMOSSImageEdit` 节点，把一张定妆照当参考图喂进去就能锁脸：

```
UNETLoader(moss) → CLIPLoader(qwen3.5, type=moss_image) → VAELoader(flux2-vae_small)
  → LoraLoader(MOSS_8_step) → LoraLoader(moss_image_edit)
LoadImage(定妆照) → TextEncodeMOSSImageEdit(clip=edit lora 的 clip, vae=flux2 vae,
                    edit_format=Moss-Image-Edit, images.image_0=LoadImage)
  → KSampler(8 步 / cfg 2.5 / er_sde / simple) → VAEDecode → SaveImage
```

### 角色 LoRA：观澜那份也能用（实测结论）

设置页另外两个字段：**她的角色 LoRA**（`faceLora`）和**LoRA 强度**（`faceLoraStrength`，默认 0.85）。
接上之后拼图链路变成「加速 LoRA → 角色 LoRA → 采样」，参考图路径里是「加速 → edit → 角色 → 采样」。

实测三组（本机 `KOOK-MOSS-SFT-guanlan.safetensors`）：

| 配置 | 结果 |
|---|---|
| 只接 LoRA（0.85 / 0.75） | 两次出的脸是同一个（锁得住），但构图一动就容易崩：一次手里成了鞋、相机重影 |
| 只给参考图（纯 MOSS 出的自拍当定妆照） | 脸一点不差、画面干净，但服装会被参考图带跑 |
| **参考图 + 两个 LoRA（当前配置）** | 脸是她、场景换成夜里的公交站、画面干净——最稳 |

所以推荐的做法不是二选一，而是：**用 LoRA 出一张唯一正脸的定妆照存成本地文件，
之后靠参考图锁脸，LoRA 挂在旁边补身份**。现在已经这么做：
`data/face.png`（观澜 LoRA 0.85 出的正脸）+ `data/config.json` 里的 `faceLora` 一起生效。

`data/config.json` 现状：

```json
{ "faceRef": "data/face.png", "faceLora": "KOOK-MOSS-SFT-guanlan.safetensors", "faceLoraStrength": 0.85 }
```

用法：

- 设置页「她的定妆照」填一张本地图片路径（`faceRef`）。之后 `selfie` 会自动拿它当参考图，
  `draw` 只在显式给 `reference` 时才用（免得画别人也套她的脸）。
- 只想用 LoRA（没有定妆照）：留空 `faceRef`，`selfie` 会走「按 moss 家族现拼 + 角色 LoRA」。
- 单次也可以传 `reference`（本地路径）。
- 服装会被参考图带跑（白 T 恤那条提示词没换成便装），要换装就在提示词里说清楚，
  或者把 `image_strength` 降到 0.6–0.8。

为什么不是 LoRA：角色 LoRA 要专门训练（本机 `观澜`/`鱼仔` 那两份是别人训好的角色），
而参考图 + 免费 edit LoRA 零成本、随时换，锁的是脸和气质。

代码位置：`lib/graph.ts` 的 `buildMossEditWorkflow`；`lib/providers.ts` 的 `autoEdit` 分支
（给了参考图又没指定工作流时自动走这条，参考图先上传到 ComfyUI input）。

### 生图时工作流到底谁选

四条优先级，从上到下：

1. 调用里显式给了 `workflow` → 用那一份（她能在 `image_workflows` 里看到全部可选）；
2. 给了 `reference` / `image`（参考图）且没给 `workflow` → 现拼 MOSS-Image Edit（锁脸）；
3. 给了 `model`（本地模型文件）且没给 `workflow` → 现场按家族拼一份；
4. 什么都没给 → 用设置页的默认工作流（现在是 `MOSS_普通生图.api.json`，768×1024、8 步）。

也就是说：**默认走现成工作流，她需要时能指定；给模型才现拼，给参考图才走编辑。**


### 拍完之后怎么到她手里

图片在三处：本地文件、图库里（`galleryId`）、图库网页 `imageUrl`。工具返回值里带 `sendHint`，照它做：

```
draw/selfie/snapshot/paint → galleryId
qq_list_recipients          → 确认收件人（哥哥 1773020354）
qq_send_gallery             → parts: [{"type":"image","id":galleryId}, {"type":"text","text":"刚到阳台拍的"}]
```

- **QQ 私聊能看到图**：`qq_send_gallery` 从图库读原图后真发出去，带逐条平台回执。
- **Web 聊天看不到图**：宿主 Web 每轮只投递 `text`（`OutgoingMessage` 没有媒体字段，前端也只转义纯文本），
  所以她最多给你一条 `/plugins/gallery/image?id=…` 的链接和本地路径。要网页里直接看图，得改主干（本轮没动）。
- 图库没在跑时 `galleryId` 为 null，`sendHint` 会直接说「还没进图库，只能给路径」——不会假装发得出去。
- **发图不写图解**：图发出去就完事，别再把校服、光、相机、镜头报一遍（人格第十节「拍完画完怎么说」里也写了这条）。
  要配字最多一句图里看不出来的：手上还有颜料没洗、楼道灯又坏了、拍的时候怕被人看见。没话说就只发图。

### 主动这一侧靠什么

- 人格里的「想到什么就画一张、拍一张，想给他看不用先问」是许可；
- 自主性插件（`plugins/autonomy`，已启用，45 分钟一次、概率 0.3，动机文案已含「画一张、拍一张」）负责给她醒来的机会；
- 工具说明里写了「也可以不等人开口就自己拍一张发过去」，所以自主轮次里她能直接动手。

三者缺一：只有人格没工具，她只能说「我想画」；只有工具没人格，她不会自己想起来。

## 已知限制

- **Qwen-Image 2.1 在本机跑不动（实测）**：`qwen_image_2.1_turbo_int8_convrot` 和 `qwen3vl_8b_int8_convrot`
  这两份文件，本机 ComfyUI v0.43.0 读它们的量化元数据时报 `json.decoder.JSONDecodeError: Expecting value`。
  插件能把工作流按 Qwen 家族拼对（配对逻辑已核对无误），但 ComfyUI 加载这一层就失败了 —— 报错会明确说
  「多半是模型文件的量化元数据读不出来 … 换一个底模/编码器再试」，并列出这次用的三个文件。
  要跑 Qwen，得换成非 convrot 量化的权重，或升级 ComfyUI / 装对应的量化加载节点。
- 实测能直接出图的：MOSS（`moss_image_sft_int8_convrot`，19 秒 512×640）、SD1.5 checkpoint（`GuoFeng3.4`，8 秒 512×768）、`majicmixRealistic_v7` 拼图 7 节点正常。
- 视频工作流不自动拼（理由见上）；本机目前没有可用的一份，`video_workflows` 为空。
- `sdwebui` 的 LoRA 槽未做（可用 `extra` 传）。
- 网络三家真实出图没验过（没有 key），协议层已用本地假服务跑通。
- `Qwen_普通生图` 画布最后一根线断了（SaveImage 没接图），插件会明说「输出节点没接上任何东西」。

## 手动安装

1. 下载本仓库（`git clone` 或 Code → Download ZIP）。
2. 把仓库内容放进 WhaleLife 本体的 `plugins/studio/` 目录；**目录名必须是 `studio`**（manifest 要求 id 与目录同名）。
3. 重启本体，或到控制台「插件管理」里重载该插件。
4. 在「插件管理」确认状态为「运行中」；首次使用请打开插件设置页完成必要配置。

本插件不包含任何运行时数据（`data/` 已被忽略），升级时直接覆盖源码即可保留你自己的配置。
