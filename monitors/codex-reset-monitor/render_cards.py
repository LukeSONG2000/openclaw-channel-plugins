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

from PIL import Image, ImageDraw, ImageFont, __version__ as PILLOW_VERSION


BEIJING = timezone(timedelta(hours=8), "北京时间")
WIDTH = 1600
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
    return parse_time(value).strftime("%Y年%m月%d日 %H:%M 北京时间")


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


def card_canvas(height, dotted=False, left=26):
    canvas = Image.new("RGB", (WIDTH, height), BACK)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((left + 10, 32, WIDTH - 20, height - 16), radius=28, fill=INK)
    draw.rounded_rectangle((left, 22, WIDTH - 30, height - 28), radius=28, fill=PAPER, outline=INK, width=4)
    if dotted:
        for y in range(42, height - 40, 32):
            for x in range(left + 18, WIDTH - 44, 32):
                draw.ellipse((x, y, x + 5, y + 5), fill="#e8e5df")
    return canvas, draw


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
    body = load_font(font_file, 30)
    small = load_font(font_file, 26)
    status_font = load_font(font_file, 44)
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
    updated = "更新于 " + format_beijing(data["updated_at"])
    last = data.get("last_reset_at")
    reset = ("最近一次全局重置  ·  " + relative_time(last, now) + "  ·  " + format_beijing(last)
             if last is not None else "最近一次全局重置  ·  暂无记录")
    x, available = 80, WIDTH - 160
    status_y = 315
    summary_y = status_y + block_height(status, status_font, available) + 24
    updated_y = summary_y + block_height(summary, body, available) + 22
    reset_y = updated_y + block_height(updated, small, available) + 34
    height = reset_y + block_height(reset, small, available) + 68
    canvas, draw = card_canvas(height, dotted=True)
    for index, (label, value, color) in enumerate(zip(
            ("未来 24 小时", "未来 48 小时"), probabilities, (YELLOW, BLUE))):
        px = x + index * 320
        draw.text((px, 66), label, font=small, fill=MUTED, anchor="lt")
        draw.rounded_rectangle((px, 112, px + 286, 276), radius=19, fill=color)
        number = fit_font(value, font_file if value == "不可用" else number_file,
                          116, 250, 128)
        bounds = draw.textbbox((0, 0), value, font=number)
        draw.text((px + (286 - (bounds[2] - bounds[0])) / 2 - bounds[0],
                   112 + (164 - (bounds[3] - bounds[1])) / 2 - bounds[1]), value, font=number, fill=INK)
    text_block(draw, status, status_font, (x, status_y), available, ORANGE)
    text_block(draw, summary, body, (x, summary_y), available, MUTED)
    text_block(draw, updated, small, (x, updated_y), available, MUTED)
    text_block(draw, reset, small, (x, reset_y), available, "#887b68")
    return save_card(canvas, output_path)


def render_announcement_card(data, output_path, *, now=None, font_path=None):
    font_file = find_font(font_path)
    body = load_font(font_file, 32)
    small = load_font(font_file, 25)
    badge_font = load_font(font_file, 27)
    # Website event summaries are authoritative, not the sometimes unrelated body.
    text = required_text(data, "summary")
    published = data["published_at"]
    kind = required_text(data, "kind")
    kind = {"reset_preview": "预告", "reset": "重置", "banked": "储备",
            "boost": "增益", "signal": "信号"}.get(kind, kind)
    age = relative_time(published, now)
    header = [("Tibo", small, None), (age, badge_font, YELLOW),
              (format_beijing(published), small, None), (kind, small, BLUE)]
    x, y, right = 90, 62, WIDTH - 88
    elements = []
    row_height = 54
    for label, font, color in header:
        for line in wrap_text(label, font, right - 90 - 32):
            width = int(math.ceil(font.getlength(line))) + (32 if color else 4)
            if x + width > right:
                x, y = 90, y + row_height + 16
            elements.append((line, font, color, x, y, width))
            x += width + 24
    body_y = y + row_height + 30
    height = body_y + block_height(text, body, right - 90, gap=14) + 66
    canvas, draw = card_canvas(height, left=38)
    draw.polygon(((39, 78), (22, 96), (39, 114)), fill=PAPER)
    draw.line(((39, 78), (22, 96), (39, 114)), fill=INK, width=4)
    for label, font, color, x, y, width in elements:
        if color:
            draw.rounded_rectangle((x, y, x + width, y + 52), radius=26, fill=color, outline=INK, width=3)
        draw.text((x + (16 if color else 0), y + 12), label, font=font,
                  fill=INK if color else MUTED, anchor="lt")
    text_block(draw, text, body, (90, body_y), right - 90, gap=14)
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
