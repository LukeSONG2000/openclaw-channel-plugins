#!/usr/bin/env python3
"""Render normalized API data, offline, with Pillow >= 9.2 and a CJK font.

Public API: render_forecast_card / render_announcement_card -> PNG metadata.
No requests, browser, or model calls. Probabilities are fractions in [0, 1] or None.
Announcement summary is required; text and body are deliberately never used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps, __version__ as PILLOW_VERSION


BEIJING = timezone(timedelta(hours=8), "UTC+08:00")
WIDTH = 800
BODY_SIZE = 40
SMALL_SIZE = 32
NUMBER_SIZE = 128
AVATAR_PATH = Path(__file__).resolve().parent / "assets" / "tibo-avatar.jpg"
INK = "#28221c"
MUTED = "#655c50"
PAPER = "#fffdf7"
BACK = "#fff4dc"
YELLOW = "#ffdc4d"
BLUE = "#a3dcff"
ORANGE = "#ff5d2c"
FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
)
NUMBER_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
)


@lru_cache(maxsize=16)
def font_index(font_path):
    if str(font_path).lower().endswith(".ttc"):
        for index in range(10):
            try:
                family = ImageFont.truetype(str(font_path), 24, index=index).getname()[0]
                if "CJK SC" in family:
                    return index
            except OSError:
                break
    return 0


def load_font(font_path, size):
    return ImageFont.truetype(str(font_path), size, index=font_index(str(font_path)))


def find_font(font_path=None):
    explicit = font_path or os.environ.get("CODEX_CARD_FONT")
    candidates = [str(explicit)] if explicit else FONT_CANDIDATES
    for candidate in candidates:
        if Path(candidate).is_file():
            load_font(candidate, 24)
            return candidate
    raise RuntimeError("CJK font missing; install fonts-noto-cjk or set CODEX_CARD_FONT")


def find_number_font(fallback):
    for candidate in NUMBER_FONT_CANDIDATES:
        if Path(candidate).is_file():
            try:
                load_font(candidate, 24)
                return candidate
            except OSError:
                continue
    return fallback


def parse_time(value):
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str):
        # Python 3.9 accepts only 3 or 6 fractional digits; normalize to microseconds.
        value = re.sub(r"\.(\d+)(?=[+-]|Z|$)",
                       lambda match: "." + (match.group(1) + "000000")[:6], value.strip())
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError("expected a timezone-aware ISO8601 timestamp")
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("timestamps must include a timezone")
    return result.astimezone(BEIJING)


def format_beijing(value):
    return parse_time(value).strftime("%Y年%m月%d日 %H:%M %Z")


def date_lines(value):
    return parse_time(value).strftime("%Y年%m月%d日\n%H:%M %Z")


def relative_time(value, now=None):
    current = parse_time(now) if now is not None else datetime.now(BEIJING)
    seconds = int((current - parse_time(value)).total_seconds())
    magnitude = abs(seconds)
    if magnitude < 60:
        return "刚刚" if seconds >= 0 else "即将"
    for unit, size in (("天", 86400), ("小时", 3600), ("分钟", 60)):
        if magnitude >= size:
            return "{}{}{}".format(magnitude // size, unit, "前" if seconds >= 0 else "后")


def required_text(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("{} must be nonempty text".format(key))
    return value


def wrap_text(text, font, width):
    """Keep words where possible, splitting oversized tokens and CJK by glyph."""
    lines = []
    for paragraph in text.replace("\r\n", "\n").replace("\r", "\n").expandtabs(4).split("\n"):
        line = ""
        for token in re.findall(r"[A-Za-z0-9_]+|[^A-Za-z0-9_]", paragraph):
            if line and font.getlength(line + token) > width:
                lines.append(line)
                line = ""
            for char in token:
                if line and font.getlength(line + char) > width:
                    lines.append(line)
                    line = ""
                line += char
        lines.append(line)
    return lines


def text_block(draw, text, font, xy, width, fill=INK, gap=12):
    lines = wrap_text(text, font, width)
    step = sum(font.getmetrics()) + gap
    for index, line in enumerate(lines):
        draw.text((xy[0], xy[1] + index * step), line, font=font, fill=fill, anchor="lt")
    return xy[1] + len(lines) * step


def block_height(text, font, width, gap=12):
    return len(wrap_text(text, font, width)) * (sum(font.getmetrics()) + gap)


def fit_font(text, font_path, max_size, width, height):
    for size in range(max_size, 0, -1):
        font = load_font(font_path, size)
        box = font.getbbox(text)
        if box[2] - box[0] <= width and box[3] - box[1] <= height:
            return font
    raise ValueError("text cannot fit in probability block")


def paper_shape(draw, box, fill, *, outline=None, tail=False):
    left, top, right, bottom = box
    draw.rounded_rectangle(box, radius=20, fill=fill, outline=outline, width=3)
    if tail:
        upper, middle, lower = top + 48, top + 68, top + 88
        # Erase the left stroke inside the tail, then outline only the two slopes.
        draw.polygon(((left + 4, upper - 2), (left - 20, middle),
                      (left + 4, lower + 2)), fill=fill)
        if outline:
            draw.line(((left, upper), (left - 20, middle), (left, lower)),
                      fill=outline, width=3)


def card_canvas(height, dotted=False, left=18, tail=False):
    canvas = Image.new("RGB", (WIDTH, height), BACK)
    draw = ImageDraw.Draw(canvas)
    paper_shape(draw, (left + 8, 28, WIDTH - 14, height - 14), INK, tail=tail)
    paper_shape(draw, (left, 20, WIDTH - 22, height - 22), PAPER, outline=INK, tail=tail)
    if dotted:
        for y in range(42, height - 40, 32):
            for x in range(left + 18, WIDTH - 44, 32):
                draw.ellipse((x, y, x + 5, y + 5), fill="#e8e5df")
    return canvas, draw


def draw_avatar(canvas):
    size, x, y = 96, 18, 40
    with Image.open(AVATAR_PATH) as source:
        avatar = ImageOps.fit(source.convert("RGB"), (size, size), method=Image.Resampling.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4))
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((x + 3, y + 4, x + size + 3, y + size + 4), fill=INK)
    canvas.paste(avatar, (x, y), mask)
    draw.ellipse((x, y, x + size - 1, y + size - 1), outline=INK, width=3)


def save_card(canvas, output_path):
    target = Path(output_path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".card-", suffix=".png", dir=str(target.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            canvas.save(stream, format="PNG", optimize=True)
        os.replace(temporary, str(target))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"path": str(target), "width": canvas.width, "height": canvas.height,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}


def render_forecast_card(data, output_path, *, now=None, font_path=None):
    font_file = find_font(font_path)
    body = load_font(font_file, BODY_SIZE)
    small = load_font(font_file, SMALL_SIZE)
    status_font = load_font(font_file, 48)
    number_file = find_number_font(font_file)
    probabilities = []
    for key in ("probability_24h", "probability_48h"):
        value = data.get(key)
        if value is None:
            probabilities.append("不可用")
            continue
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or not 0 <= value <= 1):
            raise ValueError("{} must be a finite fraction in [0, 1]".format(key))
        probabilities.append("{}%".format(int(value * 100 + 0.5)))
    status = required_text(data, "status")
    summary = required_text(data, "summary")
    updated = "更新于\n" + date_lines(data["updated_at"])
    last = data.get("last_reset_at")
    reset = ("最近一次全局重置 · " + relative_time(last, now) + "\n" + date_lines(last)
             if last is not None else "最近一次全局重置\n暂无记录")
    x, available = 50, WIDTH - 100
    status_y = 344
    summary_y = status_y + block_height(status, status_font, available) + 18
    updated_y = summary_y + block_height(summary, body, available) + 26
    reset_y = updated_y + block_height(updated, small, available, gap=8) + 26
    height = reset_y + block_height(reset, small, available, gap=8) + 50
    canvas, draw = card_canvas(height, dotted=True)
    for index, (label, value, color) in enumerate(zip(
            ("未来 24 小时", "未来 48 小时"), probabilities, (YELLOW, BLUE))):
        panel_width = (available - 24) // 2
        px = x + index * (panel_width + 24)
        draw.text((px, 62), label, font=small, fill=MUTED, anchor="lt")
        draw.rounded_rectangle((px, 122, px + panel_width, 304), radius=16, fill=color)
        if value == "不可用":
            number = load_font(font_file, BODY_SIZE)
            draw.text((px + panel_width / 2, 213), value, font=number, fill=INK, anchor="mm")
        else:
            # Keep the digits large even at 100%; only the unit uses a smaller face.
            digits, unit = value[:-1], "%"
            number = fit_font(digits, number_file, NUMBER_SIZE, panel_width - 76, 152)
            percent = load_font(number_file, 48)
            run_width = number.getlength(digits) + 8 + percent.getlength(unit)
            start = px + (panel_width - run_width) / 2
            draw.text((start, 262), digits, font=number, fill=INK, anchor="ls")
            draw.text((start + number.getlength(digits) + 8, 262), unit,
                      font=percent, fill=INK, anchor="ls")
    text_block(draw, status, status_font, (x, status_y), available, ORANGE)
    text_block(draw, summary, body, (x, summary_y), available, MUTED)
    draw.line((x, updated_y - 16, WIDTH - x, updated_y - 16), fill="#c9bda8", width=2)
    text_block(draw, updated, small, (x, updated_y), available, MUTED, gap=8)
    text_block(draw, reset, small, (x, reset_y), available, MUTED, gap=8)
    return save_card(canvas, output_path)


def render_announcement_card(data, output_path, *, now=None, font_path=None):
    font_file = find_font(font_path)
    body = load_font(font_file, BODY_SIZE)
    small = load_font(font_file, SMALL_SIZE)
    title = load_font(font_file, 48)
    # Website event summaries are authoritative, not the sometimes unrelated body.
    text = required_text(data, "summary")
    published = data["published_at"]
    kind = required_text(data, "kind")
    kind = {"reset_preview": "预告", "reset": "重置", "banked": "储备",
            "boost": "增益", "signal": "信号"}.get(kind, kind)
    age = relative_time(published, now)
    left, inset, right = 146, 178, WIDTH - 50
    x, y = inset, 128
    elements = []
    row_height = sum(small.getmetrics()) + 24
    for label, color in ((age, YELLOW), (kind, BLUE)):
        for line in wrap_text(label, small, right - inset - 32):
            width = int(math.ceil(small.getlength(line))) + 32
            if x + width > right:
                x, y = inset, y + row_height + 14
            elements.append((line, color, x, y, width))
            x += width + 18
    body_y = y + row_height + 30
    date_y = body_y + block_height(text, body, right - inset) + 28
    date = date_lines(published)
    height = date_y + block_height(date, small, right - inset, gap=8) + 50
    canvas, draw = card_canvas(height, left=left, tail=True)
    draw_avatar(canvas)
    draw.text((inset, 60), "Tibo", font=title, fill=ORANGE, anchor="lt")
    for label, color, x, y, width in elements:
        draw.rounded_rectangle((x, y, x + width, y + row_height), radius=16,
                               fill=color, outline=INK, width=2)
        draw.text((x + 16, y + 12), label, font=small, fill=INK, anchor="lt")
    text_block(draw, text, body, (inset, body_y), right - inset)
    draw.line((inset, date_y - 16, right, date_y - 16), fill="#c9bda8", width=2)
    text_block(draw, date, small, (inset, date_y), right - inset, MUTED, gap=8)
    return save_card(canvas, output_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-deps", action="store_true")
    parser.add_argument("--kind", choices=("forecast", "announcement"))
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--font")
    parser.add_argument("--now")
    args = parser.parse_args()
    if args.check_deps:
        print(json.dumps({"python": sys.version.split()[0], "pillow": PILLOW_VERSION,
                          "font": find_font(args.font), "browserRequired": False}))
        return
    if not (args.kind and args.input and args.output):
        parser.error("--kind, --input and --output are required")
    data = json.loads(args.input.read_text(encoding="utf-8"))
    renderer = render_forecast_card if args.kind == "forecast" else render_announcement_card
    print(json.dumps(renderer(data, args.output, now=args.now, font_path=args.font), ensure_ascii=False))


if __name__ == "__main__":
    main()
