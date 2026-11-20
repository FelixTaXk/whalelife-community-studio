#!/usr/bin/env python3
"""画室（studio）小工具：把 ComfyUI「画布格式」的工作流转成「API 格式」。

为什么需要：插件只认 API 格式（画布格式里没有 class_type、连线形状也不同）。
ComfyUI 界面上「导出 → API」当然更快；这个脚本只是方便一次转一批。

限制（故意做得保守）：只认下面 WIDGETS / LINKS 表里列过的节点类型。
遇到不认识的节点会直接报错，让你去 ComfyUI 里手动导出 API —— 猜着转比转错更糟。

用法：
  python canvas2api.py --dir <画布工作流目录> [--out <输出目录>] [--only 名字]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# 每个节点类型：widgets_values 里每一段对应哪个 inputs 字段；None 表示跳过（比如 control_after_generate）
WIDGETS: dict[str, list[str | None]] = {
    "UNETLoader": ["unet_name", "weight_dtype"],
    "CLIPLoader": ["clip_name", "type", "device"],
    "DualCLIPLoader": ["clip_name1", "clip_name2", "type", "device"],
    "VAELoader": ["vae_name"],
    "CheckpointLoaderSimple": ["ckpt_name"],
    "LoraLoader": ["lora_name", "strength_model", "strength_clip"],
    "LoraLoaderModelOnly": ["lora_name", "strength_model"],
    "CLIPSetLastLayer": ["stop_at_clip_layer"],
    "CLIPTextEncode": ["text"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    "EmptySD3LatentImage": ["width", "height", "batch_size"],
    "EmptyFlux2LatentImage": ["width", "height", "batch_size"],
    "KSampler": ["seed", None, "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    "KSamplerAdvanced": ["add_noise", "noise_seed", None, "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
    "VAEDecode": [],
    "VAEEncode": [],
    "VAEEncodeForInpaint": ["grow_mask_by"],
    "SaveImage": ["filename_prefix"],
    "PreviewImage": [],
    "LoadImage": ["image", None],
    "LoadImageMask": ["image", "channel"],
    "UpscaleModelLoader": ["model_name"],
    "ImageUpscaleWithModel": [],
}

# 每个节点类型：入线顺序 → inputs 字段名（canvas 的 target_slot 是这个列表的下标）
LINKS: dict[str, list[str]] = {
    "CLIPTextEncode": ["clip"],
    "KSampler": ["model", "positive", "negative", "latent_image"],
    "KSamplerAdvanced": ["model", "positive", "negative", "latent_image"],
    "VAEDecode": ["samples", "vae"],
    "VAEEncode": ["pixels", "vae"],
    "VAEEncodeForInpaint": ["pixels", "vae", "mask"],
    "SaveImage": ["images"],
    "PreviewImage": ["images"],
    "LoraLoader": ["model", "clip"],
    "CLIPSetLastLayer": ["clip"],
    "ImageUpscaleWithModel": ["upscale_model", "image"],
}

# 纯注释节点，不参与执行
SKIP = {"Note", "MarkdownNote", "PrimitiveNode", "Reroute"}


def convert(canvas: dict) -> dict:
    nodes = canvas.get("nodes")
    if not isinstance(nodes, list):
        raise SystemExit("这不是画布格式（没有 nodes 数组）；它可能已经是 API 格式了。")
    links = canvas.get("links") or []
    by_id = {int(node["id"]): node for node in nodes if "id" in node}

    # link_id -> (origin_id, origin_slot)
    origin: dict[int, tuple[int, int]] = {}
    for item in links:
        if isinstance(item, list) and len(item) >= 5:
            link_id, origin_id, origin_slot = int(item[0]), int(item[1]), int(item[2])
            origin[link_id] = (origin_id, origin_slot)

    # target: (target_id, target_slot) -> link_id
    into: dict[tuple[int, int], int] = {}
    for item in links:
        if isinstance(item, list) and len(item) >= 5:
            into[(int(item[3]), int(item[4]))] = int(item[0])

    out: dict[str, dict] = {}
    for node in nodes:
        node_type = node.get("type")
        if node_type in SKIP:
            continue
        if node_type not in WIDGETS:
            raise SystemExit(f"不认识节点类型 {node_type!r}（id={node.get('id')}）。请在 ComfyUI 里用「导出 → API 格式」手动导出。")
        node_id = int(node["id"])
        inputs: dict = {}

        values = node.get("widgets_values")
        if isinstance(values, list):
            for index, field in enumerate(WIDGETS[node_type]):
                if field is None or index >= len(values):
                    continue
                inputs[field] = values[index]
        elif isinstance(values, dict):
            inputs.update(values)

        for slot, field in enumerate(LINKS.get(node_type, [])):
            link_id = into.get((node_id, slot))
            if link_id is None:
                continue
            source = origin.get(link_id)
            if source is None:
                raise SystemExit(f"节点 {node_id} 的连线 {link_id} 找不到起点")
            inputs[field] = [str(source[0]), source[1]]

        out[str(node_id)] = {"class_type": node_type, "inputs": inputs}

    if not out:
        raise SystemExit("转换后一个节点都没有")
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="画布工作流所在目录")
    parser.add_argument("--out", default="", help="输出目录，默认同目录")
    parser.add_argument("--only", default="", help="只转名字里含这段文字的文件")
    args = parser.parse_args()

    source_dir = os.path.abspath(args.dir)
    out_dir = os.path.abspath(args.out or source_dir)
    os.makedirs(out_dir, exist_ok=True)

    done, failed = [], []
    for name in sorted(os.listdir(source_dir)):
        if not name.lower().endswith(".json"):
            continue
        if name.endswith(".api.json"):
            continue
        if args.only and args.only not in name:
            continue
        path = os.path.join(source_dir, name)
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                canvas = json.load(handle)
            if "nodes" not in canvas:
                continue
            api = convert(canvas)
            target = os.path.join(out_dir, name[:-5] + ".api.json")
            with open(target, "w", encoding="utf-8") as handle:
                json.dump(api, handle, ensure_ascii=False, indent=2)
            done.append(os.path.basename(target))
        except SystemExit as exc:
            failed.append(f"{name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{name}: {type(exc).__name__}: {exc}")

    print(json.dumps({"ok": not failed, "written": done, "failed": failed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
