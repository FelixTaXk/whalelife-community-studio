#!/usr/bin/env python3
"""画室（studio）：看图与画蒙版的边车脚本。

为什么要有这一层：
  模型看图只能读图上画出来的数字。先把图缩放了再看，它报的就是缩放后的坐标，
  拿去画遮罩必然偏。所以裁剪、缩放、网格刻度全部在这里一次换算好，
  刻度一律标原图像素；画蒙版时再把这些原图坐标原样还原成同尺寸的黑白图。

子命令：
  view   出「带原图像素刻度」的预览图（可选裁剪、放大、十字标记）
  mask   按矩形/多边形在原图尺寸上画蒙版（白=重画，黑=保留）
  probe  读尺寸与色彩模式

最后一行永远是 JSON：成功 {"ok": true, ...}，失败 {"ok": false, "error": "..."}。
只用 Pillow，不联网、不改原图。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"缺少 Pillow：{exc}"}, ensure_ascii=False))
    sys.exit(0)

MAX_OUT_BYTES = 3_500_000
BAND_TOP, BAND_LEFT, BAND_RIGHT, BAND_BOTTOM = 20, 46, 6, 6


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(0)


def clean_path(raw: str) -> str:
    return os.path.abspath(os.path.expanduser((raw or "").strip().strip('"').strip("'")))


def open_image(raw: str) -> Image.Image:
    path = clean_path(raw)
    if not os.path.isfile(path):
        fail(f"文件不存在：{path}")
    try:
        image = Image.open(path)
        image.load()
        return image
    except Exception as exc:
        fail(f"打不开这张图：{exc}")


def flatten(image: Image.Image) -> Image.Image:
    """透明图先铺白底，别让透明区看起来像黑块。"""
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.split()[-1])
        return background
    return image.convert("RGB")


def load_font(size: int):
    for path in (
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


CN_FONTS = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\Deng.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
)


def load_cn_font(size: int, bold: bool = False, custom: str = ""):
    """中文字体优先：模型画不出汉字，字得靠这一手压上去。"""
    candidates = []
    if custom.strip():
        candidates.append(clean_path(custom))
    if bold:
        candidates.append(r"C:\Windows\Fonts\msyhbd.ttc")
    candidates.extend(CN_FONTS)
    for path in candidates:
        try:
            return ImageFont.truetype(path, size), path
        except Exception:
            continue
    fail("找不到可用的中文字体（试过微软雅黑、黑体、等线、宋体）")


def parse_numbers(raw: str) -> list[float]:
    return [float(v) for v in raw.replace("，", ",").split(",")]


def parse_box(raw: str) -> tuple[int, int, int, int]:
    parts = parse_numbers(raw)
    if len(parts) != 4:
        fail(f"矩形要写成 x,y,w,h，收到：{raw!r}")
    x, y, w, h = [int(round(v)) for v in parts]
    if w <= 0 or h <= 0:
        fail(f"矩形宽高必须为正：{raw!r}")
    return x, y, w, h


def parse_polygon(raw: str) -> list[tuple[int, int]]:
    points = []
    for pair in raw.replace("；", ";").replace("，", ",").split(";"):
        pair = pair.strip()
        if not pair:
            continue
        values = parse_numbers(pair)
        if len(values) != 2:
            fail(f"多边形每个点写成 x,y，用分号隔开；这一段落不对：{pair!r}")
        points.append((int(round(values[0])), int(round(values[1]))))
    if len(points) < 3:
        fail("多边形至少要三个点")
    return points


def pick_grid(span: int, want: int) -> int:
    """自动挑间距，让一个方向上大约出现 4–10 条线。"""
    if want > 0:
        return want
    for step in (10, 20, 25, 50, 100, 200, 250, 500, 1000):
        if 3 <= span / step <= 10:
            return step
    return max(1, span // 6)


def clamp_crop(raw: str, width: int, height: int):
    parts = parse_numbers(raw)
    if len(parts) != 4:
        fail(f"crop 要写成 x,y,w,h，收到：{raw!r}")
    x, y, w, h = [int(round(v)) for v in parts]
    clamped = False
    if x < 0:
        w += x
        x = 0
        clamped = True
    if y < 0:
        h += y
        y = 0
        clamped = True
    if x >= width or y >= height:
        fail(f"crop 起点在图像外：x={x} y={y}，原图 {width}x{height}")
    if x + w > width:
        w = width - x
        clamped = True
    if y + h > height:
        h = height - y
        clamped = True
    if w < 1 or h < 1:
        fail(f"crop 尺寸不合法：{w}x{h}")
    return x, y, w, h, clamped


def cmd_probe(args) -> None:
    image = open_image(args.path)
    print(json.dumps({
        "ok": True,
        "path": clean_path(args.path),
        "width": image.size[0],
        "height": image.size[1],
        "mode": image.mode,
        "format": image.format,
    }, ensure_ascii=False))


def cmd_view(args) -> None:
    image = open_image(args.path)
    source_width, source_height = image.size
    image = flatten(image)

    if args.crop.strip():
        cx, cy, cw, ch, clamped = clamp_crop(args.crop, source_width, source_height)
    else:
        cx, cy, cw, ch, clamped = 0, 0, source_width, source_height, False

    view = image.crop((cx, cy, cx + cw, cy + ch))
    max_width = max(256, min(2048, args.max_width))
    if args.scale and args.scale > 0:
        scale = max(0.1, min(12.0, args.scale))
    else:
        scale = min(1.0, max_width / float(cw))
    out_w = max(1, int(round(cw * scale)))
    out_h = max(1, int(round(ch * scale)))
    if (out_w, out_h) != (cw, ch):
        view = view.resize((out_w, out_h), Image.NEAREST if scale >= 2 else Image.LANCZOS)

    canvas = Image.new("RGB", (out_w + BAND_LEFT + BAND_RIGHT, out_h + BAND_TOP + BAND_BOTTOM), (24, 26, 30))
    canvas.paste(view, (BAND_LEFT, BAND_TOP))

    font = load_font(13)
    draw = ImageDraw.Draw(canvas)
    step = pick_grid(max(cw, ch), args.grid)
    x_ticks: list[int] = []
    y_ticks: list[int] = []

    if step > 0:
        gx = (cx // step) * step
        while gx <= cx + cw:
            if gx >= cx:
                px = BAND_LEFT + int(round((gx - cx) * scale))
                if 0 <= px < out_w + BAND_LEFT:
                    draw.line([(px, BAND_TOP), (px, BAND_TOP + out_h)], fill=(255, 0, 200), width=1)
                    if px >= BAND_LEFT:
                        draw.text((px + 2, 3), str(gx), font=font, fill=(255, 120, 220))
                        x_ticks.append(gx)
            gx += step
        gy = (cy // step) * step
        while gy <= cy + ch:
            if gy >= cy:
                py = BAND_TOP + int(round((gy - cy) * scale))
                if 0 <= py < out_h + BAND_TOP:
                    draw.line([(BAND_LEFT, py), (BAND_LEFT + out_w, py)], fill=(0, 190, 255), width=1)
                    if py >= BAND_TOP:
                        draw.text((2, py - 7), str(gy), font=font, fill=(120, 220, 255))
                        y_ticks.append(gy)
            gy += step

    marks = []
    for pair in (args.marks or "").replace("；", ";").replace("，", ",").split(";"):
        pair = pair.strip()
        if not pair:
            continue
        values = parse_numbers(pair)
        if len(values) != 2:
            fail(f"标记点写成 x,y；这一段落不对：{pair!r}")
        mx, my = int(round(values[0])), int(round(values[1]))
        px = BAND_LEFT + int(round((mx - cx) * scale))
        py = BAND_TOP + int(round((my - cy) * scale))
        if BAND_LEFT <= px <= BAND_LEFT + out_w and BAND_TOP <= py <= BAND_TOP + out_h:
            length = 26
            draw.line([(px - length, py), (px + length, py)], fill=(120, 255, 120), width=2)
            draw.line([(px, py - length), (px, py + length)], fill=(120, 255, 120), width=2)
            draw.text((px + 4, py + 4), f"{mx},{my}", font=font, fill=(160, 255, 160))
            marks.append([mx, my])

    out_path = clean_path(args.out) if args.out.strip() else os.path.join(
        clean_path(args.out_dir) if args.out_dir.strip() else os.path.dirname(clean_path(args.path)),
        f"_view_{datetime.now().strftime('%H%M%S')}.png",
    )
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    canvas.save(out_path, "PNG", optimize=True)
    size = os.path.getsize(out_path)
    compressed = False
    if size > MAX_OUT_BYTES:
        canvas.convert("P", palette=Image.ADAPTIVE, colors=256).save(out_path, "PNG", optimize=True)
        size = os.path.getsize(out_path)
        compressed = True
        if size > 4 * 1024 * 1024:
            fail(f"图太大，压到 256 色还有 {size / 1024 / 1024:.1f} MB；缩小范围再看")

    print(json.dumps({
        "ok": True,
        "path": out_path,
        "src": {"width": source_width, "height": source_height},
        "crop": {"x": cx, "y": cy, "w": cw, "h": ch, "clamped": clamped},
        "scale": round(scale, 3),
        "out": {"width": canvas.width, "height": canvas.height, "bytes": size},
        "grid": {"step": step if step > 0 else 0, "x": x_ticks, "y": y_ticks},
        "marks": marks,
        "compressed": compressed,
    }, ensure_ascii=False))


def cmd_mask(args) -> None:
    image = open_image(args.source)
    width, height = image.size

    canvas = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(canvas)

    for raw in (args.boxes or "").replace("；", ";").split(";"):
        raw = raw.strip()
        if not raw:
            continue
        x, y, w, h = parse_box(raw)
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(width, x + w), min(height, y + h)
        if x1 <= x0 or y1 <= y0:
            fail(f"矩形完全在图外：{raw}（原图 {width}x{height}）")
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=255)

    if (args.poly or "").strip():
        points = parse_polygon(args.poly)
        draw.polygon(points, fill=255)

    if not (args.boxes or "").strip() and not (args.poly or "").strip():
        fail("boxes 和 poly 至少给一个")

    if args.feather and args.feather > 0:
        canvas = canvas.filter(ImageFilter.GaussianBlur(radius=float(args.feather)))

    if args.invert:
        canvas = canvas.point(lambda value: 255 - value)

    out_path = clean_path(args.out) if args.out.strip() else os.path.join(
        clean_path(args.out_dir) if args.out_dir.strip() else os.path.dirname(clean_path(args.source)),
        f"_mask_{datetime.now().strftime('%H%M%S')}.png",
    )
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    canvas.save(out_path, "PNG", optimize=True)
    white = int(canvas.histogram()[255])
    print(json.dumps({
        "ok": True,
        "path": out_path,
        "source": clean_path(args.source),
        "width": width,
        "height": height,
        "white_pixels": white,
        "coverage": round(white / float(width * height), 4),
        "feather": args.feather or 0,
        "inverted": bool(args.invert),
        "bytes": os.path.getsize(out_path),
    }, ensure_ascii=False))


def cmd_text(args) -> None:
    """在图上压中文字：表情包那种白条黑字，或者带描边的大字。"""
    image = flatten(open_image(args.path))
    width, height = image.size
    raw_text = (args.text or "").replace("\\n", "\n").strip()
    if not raw_text:
        fail("text 是空的")

    scale = max(16, min(200, args.size)) if args.size > 0 else max(18, int(min(width, height) * 0.075))
    font, font_path = load_cn_font(scale, bold=("bd" in args.weight), custom=args.font)
    max_w = max(40, int(width * (args.max_width if args.max_width > 0 else 0.88)))

    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    lines: list[str] = []
    current = ""
    for ch in raw_text:
        if ch == "\n":
            lines.append(current)
            current = ""
            continue
        trial = current + ch
        if probe.textlength(trial, font=font) <= max_w:
            current = trial
        else:
            if current:
                lines.append(current)
            current = ch
    if current:
        lines.append(current)
    if not lines:
        fail("text 里没有可画的字")

    line_h = int(round(scale * 1.32))
    block_h = line_h * len(lines)
    color = args.color or "#111111"

    canvas = image
    if args.style == "meme":
        pad = max(8, int(scale * 0.5))
        bar_h = block_h + pad * 2
        band = Image.new("RGB", (width, bar_h), args.band_color or "#FFFFFF")
        canvas = Image.new("RGB", (width, height + bar_h))
        if args.position == "top":
            canvas.paste(band, (0, 0))
            canvas.paste(image, (0, bar_h))
            base_y = pad
        else:
            canvas.paste(image, (0, 0))
            canvas.paste(band, (0, height))
            base_y = height + pad
        draw = ImageDraw.Draw(canvas)
        for index, line in enumerate(lines):
            line_w = probe.textlength(line, font=font)
            draw.text(((width - line_w) / 2, base_y + index * line_h), line, font=font, fill=color)
    else:
        draw = ImageDraw.Draw(canvas)
        stroke = args.stroke if args.stroke >= 0 else max(2, scale // 12)
        margin = int(scale * 0.6)
        if args.position == "top":
            base_y = margin
        elif args.position == "center":
            base_y = max(0, (height - block_h) // 2)
        else:
            base_y = max(0, height - block_h - margin)
        for index, line in enumerate(lines):
            line_w = probe.textlength(line, font=font)
            draw.text(
                ((width - line_w) / 2, base_y + index * line_h),
                line,
                font=font,
                fill=color,
                stroke_width=stroke,
                stroke_fill=args.stroke_color or "#FFFFFF",
            )

    out_path = clean_path(args.out) if args.out.strip() else os.path.join(
        clean_path(args.out_dir) if args.out_dir.strip() else os.path.dirname(clean_path(args.path)),
        f"text_{datetime.now().strftime('%H%M%S')}.png",
    )
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    canvas.save(out_path, "PNG", optimize=True)
    size_bytes = os.path.getsize(out_path)
    if size_bytes > MAX_OUT_BYTES:
        canvas.convert("P", palette=Image.ADAPTIVE, colors=256).save(out_path, "PNG", optimize=True)
        size_bytes = os.path.getsize(out_path)

    print(json.dumps({
        "ok": True,
        "path": out_path,
        "font": font_path,
        "style": args.style,
        "position": args.position,
        "size": scale,
        "lines": lines,
        "out": {"width": canvas.width, "height": canvas.height, "bytes": size_bytes},
    }, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    probe = sub.add_parser("probe")
    probe.add_argument("--path", required=True)

    view = sub.add_parser("view")
    view.add_argument("--path", required=True)
    view.add_argument("--crop", default="")
    view.add_argument("--scale", type=float, default=0.0)
    view.add_argument("--max-width", dest="max_width", type=int, default=1024)
    view.add_argument("--grid", type=int, default=0)
    view.add_argument("--marks", default="")
    view.add_argument("--out", default="")
    view.add_argument("--out-dir", dest="out_dir", default="")

    mask = sub.add_parser("mask")
    mask.add_argument("--source", required=True)
    mask.add_argument("--boxes", default="")
    mask.add_argument("--poly", default="")
    mask.add_argument("--feather", type=int, default=0)
    mask.add_argument("--invert", action="store_true")
    mask.add_argument("--out", default="")
    mask.add_argument("--out-dir", dest="out_dir", default="")

    text = sub.add_parser("text")
    text.add_argument("--path", required=True)
    text.add_argument("--text", required=True)
    text.add_argument("--position", default="bottom", choices=["bottom", "top", "center"])
    text.add_argument("--style", default="meme", choices=["meme", "big"])
    text.add_argument("--size", type=int, default=0)
    text.add_argument("--color", default="#111111")
    text.add_argument("--band-color", dest="band_color", default="#FFFFFF")
    text.add_argument("--stroke", type=int, default=-1)
    text.add_argument("--stroke-color", dest="stroke_color", default="#FFFFFF")
    text.add_argument("--weight", default="regular")
    text.add_argument("--font", default="")
    text.add_argument("--max-width", dest="max_width", type=float, default=0.88)
    text.add_argument("--out", default="")
    text.add_argument("--out-dir", dest="out_dir", default="")

    args = parser.parse_args()
    {"probe": cmd_probe, "view": cmd_view, "mask": cmd_mask, "text": cmd_text}[args.cmd](args)


if __name__ == "__main__":
    main()
