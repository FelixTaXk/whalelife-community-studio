# 画室（studio）

给 WhaleLife 用的本地/在线出图与拍视频插件。父插件统一管后端、工作流、模型和设置页，两个子插件分别提供「画画」和「拍视频」工具。

支持的后端：ComfyUI 直连、SD-WebUI / Forge、OpenAI 兼容接口、Gemini、通义万相。默认走 ComfyUI；线上后端只要填地址和 Key 也能直接用。

## 四个出图场景

| 场景 | 工具 | 行为 |
| --- | --- | --- |
| 自拍 | `selfie` | 写实照片；外貌、默认穿搭、道具来自配置里的 `persona`；可选接日程和衣柜自动补场景/穿搭；用户显式传的 `scene` / `outfit` / `mood` 优先 |
| 自画像 | `self_portrait` | 非写实画风（水彩/速写/插画）；只用 `persona` 的外观和画者说明，**不接**日程和衣柜 |
| 随便画 | `paint` | 纯绘画；没给 `subject` 就随机主体 + 随机画风；不会自动塞人物 |
| 随手拍 | `snapshot` | 写实照片；拍没人入镜的角落、光、天气；可选接日程的地点/天气/时段；不接衣柜 |

除此之外还有通用 `draw`：完全按 prompt 出图，不套人设，也不会自动补日程/衣柜。批量、查任务、看图、画蒙版、在工作流上压中文分别用 `draw_batch` / `draw_task` / `image_view` / `image_mask` / `image_text`。

## 安装

1. 把整个插件目录放到 WhaleLife 的 `plugins/` 下，目录名建议 `studio`。
2. 重启 WhaleLife，宿主会加载父插件和 `sub/image`、`sub/video`、`sub/promptkit`。
3. 打开「画室」设置页，至少确认 ComfyUI 地址；用本地模型时再配工作流目录和模型目录。
4. 需要本机装 ComfyUI 时，打开设置页右上角的「本机部署与模型推荐」。

> 画室不下载模型权重，只给推荐组合、放置目录和下载线索。权重来源和许可请自行确认。

## 配置

配置保存在插件 `data/config.json`，设置页改的就是这份文件。仓库里的 `config.example.json` 是一份最小示例。

常用字段：

| 字段 | 作用 |
| --- | --- |
| `defaultBackend` | 默认后端：`comfy` / `sdwebui` / `openai` / `gemini` / `dashscope` |
| `comfyRoot` | ComfyUI 安装根目录；留空按 `COMFY_ROOT` 或用户目录下的 `ComfyUI` 探测 |
| `python` | 看图/画蒙版用的 Python；留空自动找 ComfyUI 的 venv |
| `faceRef` | 定妆照/参考图路径；自拍、自画像时用来锁同一张脸 |
| `faceLora` | 角色 LoRA 文件名；没有参考图时用它锁脸 |
| `faceLoraStrength` | LoRA 强度，默认 0.85 |
| `persona.*` | 人设外观、默认穿搭、标志性道具、默认场景、画者说明、随机主体池、随机画风池 |
| `integrations.schedule` | 是否读日程，以及 `days` 目录 |
| `integrations.wardrobe` | 是否读衣柜、`data` 目录和 `personaId` |
| `backends.comfy.*` | ComfyUI 地址、默认工作流、工作流目录、画布目录、模型目录、超时 |
| `video.*` | 视频后端、默认工作流、宽高、帧数、超时 |

### 人设（`persona`）

`persona` 只影响自拍和自画像。全部留空时用通用人物和通用场景，不会绑定某个具体角色。

- `appearance`：年龄、性别、身高、发型、脸型等。建议用英文短句，模型跟得更稳。
- `defaultOutfit`：没接衣柜、也没显式传 `outfit` 时穿这套。
- `prop`：每张都带的标志性道具，例如 `an old film camera around the neck`；留空就不加。
- `selfieFallbackScene` / `snapshotFallbackScene`：日程读不到时的默认场景。
- `painterStyle`：画画和自画像时追加的画者说明；留空用通用业余画者文案。
- `paintFallbackSubject`：`paint` 没给主体时画什么。
- `randomSubjects`：`paint` 没给主体时随机挑的主体池。
- `paintStyles`：随机画风池，取值 `watercolor` / `sketch` / `illustration`。

### 日程与衣柜（可选）

默认关闭。开启后：

- `selfie` 会根据当前日程的地点、活动、天气、时段补 `scene`，并按当前日程段的 `id` 去衣柜取穿搭。
- `snapshot` 只补地点、天气、时段和场景细节，不接衣柜，也不会把人写进画面。

路径可以写绝对路径，也可以写相对 `plugins/` 根目录的路径。读不到文件就跳过，不会阻断出图。`wardrobe.personaId` 是衣柜 `state.json` 里的 persona key；留空取第一个。

## 命令与工具

出图：

- `draw`：通用出图；可传 `prompt` / `negative` / `size` / `model` / `workflow` / `image` / `mask` 等。
- `draw_batch`：同一组参数批量出图。
- `draw_task`：按任务号查进度和结果。
- `selfie` / `self_portrait` / `snapshot` / `paint`：四个场景。
- `image_view`：看图，可返回尺寸、格式和缩放后的预览。
- `image_mask`：给重绘生成蒙版。
- `image_text`：在已有图上压中文；固定字体、精确排版或字很小的时候用。
- `image_workflows`：列出当前能用工作流。

视频：

- `make_video`：用 ComfyUI 的视频工作流出视频。
- `video_task`：查视频任务。
- `video_workflows`：列出视频工作流。

父插件诊断：

- `studio_status`：后端状态和路径。
- `studio_workflow` / `studio_models`：列出工作流、扫模型。
- `studio_build`：按模型家族现场拼一份工作流。
- `studio_env` / `studio_recommend` / `studio_deploy`：本机体检、推荐组合、部署或启动 ComfyUI。

## 工作流

工作流可以放两处：

1. 插件自己的 `data/workflows`（API 格式 JSON）。
2. ComfyUI 的 `user/default/workflows`（画布格式 JSON，读取时会自动转 API）。

槽位按节点标题和输入名推断：`prompt`、`negative`、`width`、`height`、`seed`、`steps`、`cfg`、`sampler`、`scheduler`、`image`、`mask`、`lora_1_name` / `lora_1_strength` 等。推断结果会缓存在 `data/mappings`，工作流改了会自动重算。

只给 `model` 不给 `workflow` 时，插件会按模型家族现场拼一份工作流再跑；拼不出来再退回目录里第一个可用工作流。

## 图上的中文

一句七八个字、高对比、背景干净时，直接把中文写进 prompt，用中文引号括住，并说明「字很大、占画面宽度一半」，多数模型能写对。

需要固定字体、精确位置、字很小或一大段文字时，改用 `image_text`，不要硬让模型写。

## 发图

出图/出视频成功后，返回值里的 `galleryId` 是图库 ID，按 `sendHint` 发出去。只把本地路径报给用户，聊天里是看不到图的。发出去时不必逐项描述画面内容。

## 常见问题

**ComfyUI 连不上**：确认地址和端口（默认 `http://127.0.0.1:8188`），以及 ComfyUI 是否带 `--enable-cors-header` 或同源访问。设置页的「测试」会给出版本和设备。

**工作流槽位认错**：在 `image_workflows` 里看槽位。多数情况改节点标题或输入名就能对上；也可以在设置页指定默认工作流。

**模型扫不到**：先确认 `comfyRoot` 或 `backends.comfy.modelsDir`。模型目录为空时插件不会猜具体权重文件名。

**自拍每次脸不一样**：填 `faceRef`（一张正面、光线均匀的图）或 `faceLora`。两者都没有时，只能靠 `persona.appearance` 的文字描述，稳定性有限。

**自拍带出全身/广角**：自拍的负面词已经排除 `full body` / `full-length portrait` / `wide shot`；如果参考图本身是全身，仍可能带到身体，换一张胸像参考图更稳。

**视频帧数不对**：不同视频工作流有自己的约束（常见 `4n+1`，如 97、121）。以工作流要求为准，设置页只是默认值。

## 许可

AGPL-3.0-only，附加条款见 `LICENSE-ADDITIONAL`。
