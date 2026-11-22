# -*- coding: utf-8 -*-
"""给一张图加字幕 / 气泡 / 描边，做成表情包。

脚本化调用：stdin 收 JSON，stdout 回 JSON。
用法：
    echo {"input":"...","output":"...","text":"就这？","style":"band"} | python render_meme.py

本脚本只依赖 Pillow，所有路径都由调用方传入，不假设任何本机目录。
"""
import json
import math
import os
import sys

from PIL import Image, ImageColor, ImageDraw, ImageFont

FONT_PATH = None
FORMATS = ("png", "webp", "gif")
ANIMATIONS = ("none", "pop", "shake", "zoom")

# Node 侧固定用 UTF-8 写 stdin；Windows 控制台默认代码页会把中文读成乱码。
for _stream, _encoding in ((sys.stdin, "utf-8"), (sys.stdout, "utf-8")):
    try:
        _stream.reconfigure(encoding=_encoding)
    except Exception:
        pass


def number(value, fallback, minimum, maximum):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return max(minimum, min(maximum, n))


def integer(value, fallback, minimum, maximum):
    return int(round(number(value, fallback, minimum, maximum)))


def color(value, fallback):
    try:
        raw = str(value or "").strip()
        if not raw:
            return fallback
        rgba = ImageColor.getcolor(raw, "RGBA")
        return rgba
    except Exception:
        return fallback


def font_candidates(explicit=""):
    """字体解析顺序：设置里指定的文件 → 当前系统常见中文字体。"""
    explicit = os.path.expanduser(str(explicit or "").strip())
    if explicit:
        return [explicit]

    candidates = []
    windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot") or ""
    if windir:
        fonts = os.path.join(windir, "Fonts")
        candidates += [
            os.path.join(fonts, "msyhbd.ttc"),
            os.path.join(fonts, "msyh.ttc"),
            os.path.join(fonts, "simhei.ttf"),
            os.path.join(fonts, "simsun.ttc"),
        ]

    if sys.platform == "darwin":
        candidates += [
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
            "/System/Library/Fonts/Supplemental/Songti.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
        ]
    elif sys.platform.startswith("linux"):
        candidates += [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
            "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/truetype/arphic/uming.ttc",
        ]
    return list(dict.fromkeys(candidates))


def resolve_font(explicit=""):
    """按候选链挑一个能打开的中文字体；找不到就明确报错，不退到无中文的默认字体。"""
    global FONT_PATH
    if FONT_PATH:
        return FONT_PATH
    tried = []
    for path in font_candidates(explicit):
        tried.append(path)
        if not os.path.exists(path) or os.path.getsize(path) <= 1024:
            continue
        try:
            ImageFont.truetype(path, 20)
            FONT_PATH = path
            return FONT_PATH
        except Exception:
            continue
    if explicit:
        raise SystemExit("字体文件打不开：" + explicit)
    raise SystemExit(
        "找不到可用的中文字体。请在插件设置页填字体文件路径（.ttf/.ttc/.otf）；已尝试："
        + "、".join(tried[:4])
    )


def font(size):
    path = resolve_font()
    try:
        return ImageFont.truetype(path, max(8, int(size)))
    except Exception as e:
        raise SystemExit("字体加载失败：" + path + "（" + str(e) + "）")


def measure(draw, text, f):
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0], box[3] - box[1]


def wrap(draw, text, f, max_width):
    """按像素宽度折行；已经有 \n 的先按 \n 分段。"""
    paragraphs = str(text).split("\n")
    lines = []
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        cur = ""
        for ch in p:
            trial = cur + ch
            w, _ = measure(draw, trial, f)
            if w <= max_width or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    return lines or [str(text)]


def truncate_line(draw, text, f, max_width):
    suffix = "…"
    if measure(draw, text, f)[0] <= max_width:
        return text
    while text and measure(draw, text + suffix, f)[0] > max_width:
        text = text[:-1]
    return (text + suffix) if text else suffix


def fit(draw, text, max_width, start=46, minimum=18, max_lines=4):
    size = max(minimum, int(start))
    while size > minimum:
        f = font(size)
        lines = wrap(draw, text, f, max_width)
        if len(lines) <= max_lines:
            width = max(measure(draw, line, f)[0] for line in lines)
            if width <= max_width:
                return f, lines
        size -= 2
    f = font(minimum)
    lines = wrap(draw, text, f, max_width)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = truncate_line(draw, lines[-1], f, max_width)
    return f, lines


def resize_width(img, width):
    if img.width == width:
        return img.copy()
    height = max(1, round(img.height * width / img.width))
    return img.resize((width, height), Image.LANCZOS)


def average_luminance(img, box):
    """取一块区域的平均亮度，用来决定字幕贴在顶部还是底部、字色要不要翻白。"""
    try:
        crop = img.convert("RGB").crop(box)
        if crop.width < 1 or crop.height < 1:
            return 128
        small = crop.resize((max(1, min(64, crop.width)), max(1, min(64, crop.height))), Image.LANCZOS)
        pixels = list(small.getdata())
        if not pixels:
            return 128
        return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels) / len(pixels)
    except Exception:
        return 128


def auto_style(img, text, base):
    """自动版式：先看上下半区亮度，再按画幅决定；不假设人脸位置。"""
    W, H = img.size
    top = average_luminance(img, (0, 0, W, max(1, int(H * 0.28))))
    bottom = average_luminance(img, (0, int(H * 0.72), W, H))
    if top + 32 < bottom and len(text) <= 12:
        return "top"
    if W / max(1, H) > 1.8 and len(text) <= 10:
        return "band"
    return "band"


def text_color_for(lum, transparent=False):
    if lum >= 165:
        return (17, 17, 17, 255) if not transparent else (17, 17, 17, 255)
    return (255, 255, 255, 255) if not transparent else (255, 255, 255, 255)


def draw_text_line(draw, xy, text, f, fill, stroke_width=0, stroke_fill=None, shadow=False):
    x, y = xy
    if shadow:
        draw.text((x + 2, y + 2), text, font=f, fill=(0, 0, 0, 90))
    if stroke_width > 0:
        draw.text(xy, text, font=f, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill or fill)
    else:
        draw.text(xy, text, font=f, fill=fill)


def align_x(align, left, width, text_width):
    if align == "left":
        return left
    if align == "right":
        return left + width - text_width
    return left + (width - text_width) / 2


def make_still(req):
    src = req.get("input")
    text = str(req.get("text") or "").strip()
    if not src or not os.path.exists(src):
        raise SystemExit("input missing")
    if not text:
        raise SystemExit("text empty")
    width = integer(req.get("width"), 512, 128, 1600)
    req_style = str(req.get("style") or "band").lower()
    if req_style not in ("band", "bubble", "plain", "top", "auto"):
        req_style = "band"
    layout = req.get("layout") if isinstance(req.get("layout"), dict) else {}
    font_path = resolve_font(req.get("font") or "")

    img = Image.open(src)
    img.seek(0)
    img = img.convert("RGBA")
    base = resize_width(img, width)
    W, H = base.size
    if req_style == "auto":
        req_style = auto_style(img, text, base)

    margin = integer(layout.get("margin"), 18, 0, 160)
    padding = integer(layout.get("padding"), 20, 0, 96)
    line_height = number(layout.get("lineHeight"), 1.35, 0.9, 2.2)
    align = str(layout.get("align") or "center").lower()
    if align not in ("left", "center", "right"):
        align = "center"
    max_lines = integer(layout.get("maxLines"), 4, 1, 6)
    offset_x = number(layout.get("offsetX"), 0, -240, 240)
    offset_y = number(layout.get("offsetY"), 0, -240, 240)
    stroke_width = integer(layout.get("strokeWidth"), 0, 0, 16)
    shadow = bool(layout.get("shadow", False))
    auto_contrast = bool(layout.get("autoContrast", True))
    requested_size = integer(layout.get("fontSize"), 0, 0, 200)

    # 颜色：显式颜色优先；band / top / bubble 的文字落在实色块上，按块的颜色选字色。
    area = (0, max(0, H - int(H * 0.35)), W, H) if req_style == "band" else (0, 0, W, max(1, int(H * 0.35)))
    area_lum = average_luminance(base, area)
    default_band = color("#ffffff", (255, 255, 255, 255))
    band_color = color(layout.get("bandColor"), default_band)

    def rgba_lum(rgba):
        return 0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]

    if req_style in ("band", "top", "bubble"):
        area_lum = rgba_lum(band_color)
    default_text = text_color_for(area_lum) if auto_contrast else (17, 17, 17, 255)
    text_color = color(layout.get("textColor"), default_text)
    stroke_color = color(layout.get("strokeColor"), (0, 0, 0, 255) if area_lum >= 165 else (255, 255, 255, 255))

    result_style = req_style
    frame_count = 1

    if req_style in ("band", "top"):
        max_text_width = max(32, W - margin * 2 - padding * 2)
        probe = ImageDraw.Draw(Image.new("RGB", (W, 64)))
        start = requested_size or 44
        f, lines = fit(probe, text, max_text_width, start, max(18, min(24, start // 2)), max_lines)
        lh = max(1, int(f.size * line_height))
        text_h = lh * len(lines)
        band_h = max(1, text_h + padding * 2)
        canvas = Image.new("RGBA", (W, H + band_h), (255, 255, 255, 255))
        if req_style == "band":
            canvas.paste(base, (0, 0), base)
            origin_y = H
        else:
            canvas.paste(base, (0, band_h), base)
            origin_y = 0
        d = ImageDraw.Draw(canvas)
        d.rectangle([0, origin_y, W, origin_y + band_h], fill=band_color)
        y = origin_y + padding + offset_y
        for line in lines:
            tw, _ = measure(d, line, f)
            x = align_x(align, margin + padding, max_text_width, tw) + offset_x
            draw_text_line(d, (x, y), line, f, text_color, stroke_width, stroke_color, shadow)
            y += lh
        return canvas, result_style, f, font_path, 1

    if req_style == "bubble":
        max_text_width = max(32, int(W * 0.78) - padding * 2)
        probe = ImageDraw.Draw(Image.new("RGB", (W, 64)))
        start = requested_size or 40
        f, lines = fit(probe, text, max_text_width, start, max(18, min(24, start // 2)), max_lines)
        lh = max(1, int(f.size * line_height))
        text_w = max(measure(probe, line, f)[0] for line in lines)
        box_w = min(W - margin * 2, text_w + padding * 2)
        box_h = lh * len(lines) + padding * 2
        canvas = base.copy()
        d = ImageDraw.Draw(canvas)
        left = (W - box_w) / 2 + offset_x
        left = max(margin, min(W - margin - box_w, left))
        top = H - box_h - margin + offset_y
        top = max(margin, min(H - margin - box_h, top))
        d.rounded_rectangle(
            [left, top, left + box_w, top + box_h],
            radius=min(18, box_h // 3),
            fill=band_color,
            outline=stroke_color,
            width=max(2, stroke_width or 4),
        )
        # 尾巴画在气泡之后，顶边和气泡底边重合，不再多出一条横线
        cx = left + box_w / 2
        d.polygon(
            [(cx - 15, top + box_h + 1), (cx + 15, top + box_h + 1), (cx, top + box_h + 18)],
            fill=band_color,
            outline=stroke_color,
            width=max(2, stroke_width or 4),
        )
        y = top + padding
        for line in lines:
            tw, _ = measure(d, line, f)
            x = align_x(align, left + padding, box_w - padding * 2, tw)
            draw_text_line(d, (x, y), line, f, text_color, 0, None, shadow)
            y += lh
        return canvas, result_style, f, font_path, 1

    # plain：只描边/阴影，不挡画面
    max_text_width = max(32, W - margin * 2)
    probe = ImageDraw.Draw(Image.new("RGB", (W, 64)))
    start = requested_size or 52
    f, lines = fit(probe, text, max_text_width, start, max(20, min(28, start // 2)), max_lines)
    lh = max(1, int(f.size * line_height))
    canvas = base.copy()
    d = ImageDraw.Draw(canvas)
    y = H - lh * len(lines) - margin + offset_y
    y = max(margin, min(H - margin - lh * len(lines), y))
    for line in lines:
        tw, _ = measure(d, line, f)
        x = align_x(align, margin, max_text_width, tw) + offset_x
        draw_text_line(
            d, (x, y), line, f, text_color,
            stroke_width or max(3, f.size // 8), stroke_color, shadow,
        )
        y += lh
    return canvas, result_style, f, font_path, 1


def resize_center(img, scale):
    W, H = img.size
    nw, nh = max(1, round(W * scale)), max(1, round(H * scale))
    resized = img.resize((nw, nh), Image.LANCZOS)
    if nw >= W and nh >= H:
        left = (nw - W) // 2
        top = (nh - H) // 2
        return resized.crop((left, top, left + W, top + H))
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas.paste(resized, ((W - nw) // 2, (H - nh) // 2), resized)
    return canvas


def animation_frames(canvas, animation, duration, fps):
    """把静态成品做成轻微动效；只做三种短循环，不引入时间轴。"""
    frames = max(4, min(40, int(round(duration * fps))))
    still = canvas.convert("RGBA")
    original = still.copy()
    result = []
    for i in range(frames):
        t = i / max(1, frames - 1)
        if animation == "pop":
            # 先小后回弹，再稳住；整张图一起弹，字幕和画面不会脱节
            if t < 0.55:
                s = 0.72 + 0.31 * (t / 0.55)
            elif t < 0.75:
                s = 1.03 - 0.04 * ((t - 0.55) / 0.20)
            else:
                s = 1.0
            frame = Image.new("RGBA", still.size, (0, 0, 0, 0))
            nw, nh = max(1, round(still.width * s)), max(1, round(still.height * s))
            resized = still.resize((nw, nh), Image.LANCZOS)
            frame.paste(resized, ((still.width - nw) // 2, (still.height - nh) // 2), resized)
        elif animation == "shake":
            dx = round(math.sin(t * math.pi * 6) * 3)
            dy = round(math.cos(t * math.pi * 5) * 2)
            frame = Image.new("RGBA", still.size, (0, 0, 0, 0))
            frame.paste(original, (dx, dy), original)
        else:  # zoom
            s = 1.0 + 0.045 * (0.5 - 0.5 * math.cos(t * math.pi * 2))
            frame = resize_center(original, s)
        result.append(frame.convert("RGB"))
    return result


def save_output(canvas, req, format_name, animation):
    out = req.get("output")
    if not out:
        raise SystemExit("output missing")
    folder = os.path.dirname(out)
    if folder:
        os.makedirs(folder, exist_ok=True)
    quality = integer(req.get("quality"), 88, 1, 100)
    if animation != "none":
        duration = number(req.get("duration"), 1.6, 0.6, 4.0)
        fps = integer(req.get("fps"), 12, 4, 24)
        frames = animation_frames(canvas, animation, duration, fps)
        frames[0].save(
            out,
            "GIF",
            save_all=True,
            append_images=frames[1:],
            duration=max(40, int(1000 / fps)),
            loop=0,
            optimize=True,
            disposal=2,
        )
        return "gif", len(frames)
    if format_name == "webp":
        canvas.convert("RGB").save(out, "WEBP", quality=quality, method=6)
        return "webp", 1
    canvas.save(out, "PNG", optimize=True)
    return "png", 1


def render(req):
    text = str(req.get("text") or "").strip()
    if not text:
        raise SystemExit("text empty")
    canvas, style, used_font, font_path, _ = make_still(req)
    format_name = str(req.get("format") or "png").lower()
    if format_name not in FORMATS:
        format_name = "png"
    animation = str(req.get("animation") or "none").lower()
    if animation not in ANIMATIONS:
        animation = "none"
    if animation != "none":
        format_name = "gif"
    saved_format, frame_count = save_output(canvas, req, format_name, animation)
    out = req.get("output")
    return {
        "ok": True,
        "path": out,
        "width": canvas.width,
        "height": canvas.height,
        "bytes": os.path.getsize(out),
        "style": style,
        "font": font_path,
        "format": saved_format,
        "animation": animation,
        "frames": frame_count,
        "fontSize": used_font.size,
    }


if __name__ == "__main__":
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        result = render(payload)
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    except SystemExit as e:
        sys.stdout.buffer.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode("utf-8"))
    except Exception as e:  # noqa: BLE001
        sys.stdout.buffer.write(
            json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False).encode("utf-8")
        )
