# -*- coding: utf-8 -*-
"""给一张图加字幕 / 气泡 / 描边，做成表情包。

脚本化调用：stdin 收 JSON，stdout 回 JSON。
用法：
    echo {"input":"...","output":"...","text":"就这？","style":"band"} | python render_meme.py
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_PATH = None


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
        return ImageFont.truetype(path, size)
    except Exception as e:
        raise SystemExit("字体加载失败：" + path + "（" + str(e) + "）")


def measure(draw, text, f):
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0], box[3] - box[1]


def wrap(draw, text, f, max_width):
    """按像素宽度折行；已经有 \n 的先按 \n 分段。"""
    paragraphs = [p for p in str(text).split("\n")]
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


def fit(draw, text, max_width, start=46, minimum=26):
    size = start
    while size > minimum:
        f = font(size)
        lines = wrap(draw, text, f, max_width)
        width = max(measure(draw, line, f)[0] for line in lines)
        if width <= max_width:
            return f, lines
        size -= 2
    return font(minimum), wrap(draw, text, font(minimum), max_width)


def resize_width(img, width):
    if img.width == width:
        return img.copy()
    height = max(1, round(img.height * width / img.width))
    return img.resize((width, height), Image.LANCZOS)


def render(req):
    src = req.get("input")
    out = req.get("output")
    text = str(req.get("text") or "").strip()
    style = str(req.get("style") or "band")
    width = int(req.get("width") or 512)
    if not src or not os.path.exists(src):
        raise SystemExit("input missing")
    if not text:
        raise SystemExit("text empty")
    if width < 256 or width > 1600:
        width = 512
    font_path = resolve_font(req.get("font") or "")

    img = Image.open(src)
    img.seek(0)
    img = img.convert("RGBA")
    base = resize_width(img, width)
    W, H = base.size

    if style == "band" or style == "top":
        probe = ImageDraw.Draw(Image.new("RGB", (W, 64)))
        f, lines = fit(probe, text, W - 40, 44, 24)
        lh = int(f.size * 1.35)
        band = 24 + lh * len(lines)
        canvas = Image.new("RGB", (W, H + band), (255, 255, 255))
        if style == "band":
            canvas.paste(base.convert("RGB"), (0, 0))
            origin_y = H
        else:
            canvas.paste(base.convert("RGB"), (0, band))
            origin_y = 0
        d = ImageDraw.Draw(canvas)
        y = origin_y + 12
        for line in lines:
            w, _ = measure(d, line, f)
            d.text(((W - w) // 2, y), line, font=f, fill=(24, 24, 24))
            y += lh

    elif style == "bubble":
        probe = ImageDraw.Draw(Image.new("RGB", (W, 64)))
        f, lines = fit(probe, text, int(W * 0.78), 40, 22)
        lh = int(f.size * 1.35)
        pad_x, pad_y = 22, 16
        text_w = max(measure(probe, line, f)[0] for line in lines)
        box_w = min(W - 16, text_w + pad_x * 2)
        box_h = lh * len(lines) + pad_y * 2
        canvas = base.convert("RGBA")
        d = ImageDraw.Draw(canvas)
        left = (W - box_w) // 2
        top = H - box_h - 26
        d.rounded_rectangle(
            [left, top, left + box_w, top + box_h],
            radius=18,
            fill=(255, 255, 255, 255),
            outline=(20, 20, 20, 255),
            width=4,
        )
        # 尾巴画在气泡之后，顶边和气泡底边重合，不再多出一条横线
        cx = W // 2
        d.polygon(
            [(cx - 15, top + box_h + 1), (cx + 15, top + box_h + 1), (cx, top + box_h + 18)],
            fill=(255, 255, 255, 255),
            outline=(20, 20, 20, 255),
            width=4,
        )
        y = top + pad_y
        for line in lines:
            w, _ = measure(d, line, f)
            d.text(((W - w) // 2, y), line, font=f, fill=(18, 18, 18, 255))
            y += lh

    else:  # plain：只描边，不挡画面
        probe = ImageDraw.Draw(Image.new("RGB", (W, 64)))
        f, lines = fit(probe, text, W - 48, 52, 28)
        lh = int(f.size * 1.3)
        canvas = base.convert("RGBA")
        d = ImageDraw.Draw(canvas)
        y = H - lh * len(lines) - 18
        for line in lines:
            w, _ = measure(d, line, f)
            d.text(
                ((W - w) // 2, y), line, font=f, fill=(255, 255, 255, 255),
                stroke_width=max(4, f.size // 7), stroke_fill=(0, 0, 0, 255),
            )
            y += lh

    folder = os.path.dirname(out)
    if folder:
        os.makedirs(folder, exist_ok=True)
    canvas.convert("RGB").save(out, "PNG", optimize=True)
    return {
        "ok": True,
        "path": out,
        "width": canvas.width,
        "height": canvas.height,
        "bytes": os.path.getsize(out),
        "style": style,
        "font": font_path,
    }


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        result = render(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except SystemExit as e:
        sys.stdout.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
