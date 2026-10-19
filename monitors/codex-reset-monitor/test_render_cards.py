import ast
import hashlib
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont

import render_cards as cards


NOW = "2026-10-19T02:33:00Z"
FORECAST = {"probability_24h": .71, "probability_48h": .81, "status": "已预告",
            "summary": "今天还没有确认重置。Tibo 已预告未来会有一次全局重置。",
            "updated_at": NOW, "last_reset_at": "2026-10-17T21:12:21Z"}
ANNOUNCEMENT = {"summary": "Direct usage reset", "body": "Tibo: Done",
                "published_at": "2026-10-17T21:12:21Z", "kind": "reset"}


class RenderCardsTests(unittest.TestCase):
    def test_beijing_and_aware_timestamp(self):
        self.assertEqual(cards.format_beijing(ANNOUNCEMENT["published_at"]), "2026年10月18日 05:12 UTC+08:00")
        self.assertEqual(cards.relative_time(ANNOUNCEMENT["published_at"], NOW), "1天前")
        self.assertEqual(cards.relative_time(NOW, "2026-10-19T02:30:00Z"), "3分钟后")
        with self.assertRaises(ValueError):
            cards.parse_time("2026-10-19T02:33:00")
        self.assertEqual(cards.parse_time("2026-10-19T02:33:00.123456789Z").microsecond, 123456)

    def test_fractional_seconds_require_explicit_timezone(self):
        for fraction in ("1", "68", "123", "1234", "12345", "123456", "1234567",
                         "123456789", "123456789012"):
            expected = int((fraction + "000000")[:6])
            for suffix, hour in (("Z", 11), ("+08:00", 3), ("-04:00", 15)):
                with self.subTest(fraction=fraction, suffix=suffix):
                    parsed = cards.parse_time("2026-10-19T03:08:02." + fraction + suffix)
                    self.assertEqual(parsed.microsecond, expected)
                    self.assertEqual(parsed.hour, hour)
                    self.assertEqual(parsed.tzinfo, cards.BEIJING)
            with self.subTest(fraction=fraction, suffix="missing"):
                with self.assertRaises(ValueError):
                    cards.parse_time("2026-10-19T03:08:02." + fraction)

    def test_render_live_two_digit_fraction_on_both_cards(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "live.png"
            timestamp = "2026-10-19T03:08:02.68Z"
            forecast = dict(FORECAST, updated_at=timestamp,
                            last_reset_at="2026-10-17T21:12:21.12345Z")
            self.assertEqual(cards.format_beijing(timestamp), "2026年10月19日 11:08 UTC+08:00")
            for renderer, data in ((cards.render_forecast_card, forecast),
                                    (cards.render_announcement_card,
                                     dict(ANNOUNCEMENT, published_at=timestamp))):
                meta = renderer(data, target, now="2026-10-19T03:10:00.1Z")
                self.assertTrue(target.is_file())
                self.assertEqual(meta["width"], 800)

    def test_wrap_preserves_long_mixed_text(self):
        font = ImageFont.truetype(cards.find_font(), 30)
        text = "完整中文内容 Mixed words " + "A" * 200 + "\n第二段" * 5
        lines = cards.wrap_text(text, font, 380)
        self.assertEqual("".join(lines), text.replace("\n", ""))
        self.assertTrue(all(font.getlength(line) <= 380 for line in lines))

    def test_cjk_glyphs_and_font_collection(self):
        font = cards.load_font(cards.find_font(), 30)
        missing = bytes(font.getmask("\U0010ffff"))
        for char in "UTC+08:00不可用最近一次全局重置储备增益信号预告":
            self.assertNotEqual(bytes(font.getmask(char)), missing, char)
        if "NotoSansCJK" in cards.find_font():
            self.assertIn("CJK SC", font.getname()[0])

    def test_visible_timezone_labels_change_without_changing_utc8_instants(self):
        parsed = cards.parse_time(ANNOUNCEMENT["published_at"])
        self.assertEqual(parsed.utcoffset(), timedelta(hours=8))
        self.assertEqual(parsed.isoformat(), "2026-10-18T05:12:21+08:00")
        self.assertEqual(parsed.tzname(), "UTC+08:00")
        labels = []
        original = ImageDraw.ImageDraw.text
        def record(draw, xy, text, *args, **kwargs):
            labels.append(text)
            return original(draw, xy, text, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory, patch.object(ImageDraw.ImageDraw, "text", new=record):
            target = Path(directory) / "timezone.png"
            cards.render_forecast_card(FORECAST, target, now=NOW)
            cards.render_announcement_card(ANNOUNCEMENT, target, now=NOW)
        self.assertEqual(sum("UTC+08:00" in label for label in labels), 3)
        self.assertFalse(any("北京时间" in label for label in labels))

    def test_all_kinds_preserve_summary_and_ignore_event_id(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "event.png"
            for kind in ("reset", "reset_preview", "banked", "boost", "signal"):
                data = dict(ANNOUNCEMENT, kind=kind, id="non-numeric-history-id")
                meta = cards.render_announcement_card(data, target, now=NOW)
                self.assertGreater(meta["height"], 200)
                self.assertEqual(meta["sha256"], cards.render_announcement_card(
                    dict(data, id="other"), target, now=NOW)["sha256"])

    def test_probability_measure_and_pixels(self):
        for text in ("0", "71", "100"):
            font = cards.fit_font(text, cards.find_number_font(cards.find_font()),
                                  cards.NUMBER_SIZE, 262, 152)
            box = font.getbbox(text)
            self.assertGreaterEqual(font.size * 320 / cards.WIDTH, 50)
            self.assertLessEqual(box[2] - box[0], 262)
            self.assertLessEqual(box[3] - box[1], 152)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "prob.png"
            for value in (0, .71, 1, None):
                cards.render_forecast_card(dict(FORECAST, probability_24h=value), target, now=NOW)
                with Image.open(target) as image:
                    # A clear internal moat must surround all probability text.
                    for y in range(146, 280):
                        self.assertEqual(image.getpixel((56, y)), (255, 220, 77))
                        self.assertEqual(image.getpixel((382, y)), (255, 220, 77))

    def test_render_metadata_long_text_and_determinism(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "forecast.png"
            meta = cards.render_forecast_card(FORECAST, target, now=NOW)
            self.assertEqual(meta["path"], str(target.resolve()))
            with Image.open(target) as image:
                self.assertEqual(image.size, (meta["width"], meta["height"]))
                self.assertEqual(image.getpixel((100, 130)), (255, 220, 77))
                self.assertEqual(image.getpixel((420, 130)), (163, 220, 255))
            self.assertEqual(meta["sha256"], cards.render_forecast_card(FORECAST, target, now=NOW)["sha256"])
            short = cards.render_announcement_card(ANNOUNCEMENT, target, now=NOW)
            changed_body = dict(ANNOUNCEMENT, body="Unrelated API body must never appear")
            self.assertEqual(short["sha256"], cards.render_announcement_card(changed_body, target, now=NOW)["sha256"])
            long = cards.render_announcement_card(dict(ANNOUNCEMENT, summary=("Long English announcement 完整中文\n" * 90)), target, now=NOW)
            self.assertGreater(long["height"], short["height"] + 3000)

    def test_invalid_data_fails_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "out.png"
            for value in (True, -1, 71, float("nan"), float("inf"), "0.7"):
                with self.assertRaises(ValueError):
                    cards.render_forecast_card(dict(FORECAST, probability_24h=value), target)
            with self.assertRaises(ValueError):
                cards.render_announcement_card(dict(ANNOUNCEMENT, summary="", text="wrong fallback"), target)
            self.assertFalse(target.exists())

    def test_missing_summary_rejects_text_and_body_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "announcement.png"
            data = {key: value for key, value in ANNOUNCEMENT.items() if key != "summary"}
            data["text"] = "must not fall back to normalized text"
            with self.assertRaisesRegex(ValueError, "summary must be nonempty text"):
                cards.render_announcement_card(data, target, now=NOW)
            self.assertFalse(target.exists())

    def test_source_parses_with_python39_grammar(self):
        ast.parse(Path(cards.__file__).read_text(), feature_version=(3, 9))

    def record_render(self, renderer, data, target):
        records = []
        original = ImageDraw.ImageDraw.text

        def record(draw, xy, text, *args, **kwargs):
            font = kwargs["font"]
            box = draw.textbbox(xy, text, font=font, anchor=kwargs.get("anchor"))
            records.append(dict(text=text, box=box, size=font.size))
            return original(draw, xy, text, *args, **kwargs)

        with patch.object(ImageDraw.ImageDraw, "text", new=record):
            meta = renderer(data, target, now=NOW)
        return meta, records

    def assert_readable_and_separate(self, meta, records):
        self.assertEqual(set(meta), {"path", "width", "height", "sha256"})
        self.assertEqual(meta["width"], 800)
        for index, record in enumerate(records):
            left, top, right, bottom = record["box"]
            self.assertGreaterEqual(record["size"] * 320 / meta["width"], 12)
            self.assertGreaterEqual(left, 40, record)
            self.assertGreaterEqual(top, 40, record)
            self.assertLessEqual(right, meta["width"] - 40, record)
            self.assertLessEqual(bottom, meta["height"] - 40, record)
            if not record["text"].strip():
                continue
            for previous in records[:index]:
                if not previous["text"].strip():
                    continue
                a, b, c, d = previous["box"]
                self.assertFalse(left < c and right > a and top < d and bottom > b,
                                 (previous, record))

    def test_mobile_type_bounds_and_no_overlap_for_extreme_content(self):
        samples = (
            "A" * 400 + " end",
            "完整中文公告不可截断" * 50,
            "\n".join(["First paragraph with ordinary English words.", "", "第二段 保留原文", "Final line."]),
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "extreme.png"
            for text in samples:
                for renderer, data in (
                        (cards.render_announcement_card, dict(ANNOUNCEMENT, summary=text)),
                        (cards.render_forecast_card, dict(FORECAST, summary=text,
                                                         probability_24h=1, probability_48h=None))):
                    with self.subTest(renderer=renderer.__name__, sample=text[:20]):
                        meta, records = self.record_render(renderer, data, target)
                        self.assert_readable_and_separate(meta, records)
                        body = [row for row in records if row["size"] == cards.BODY_SIZE
                                and row["text"] != "不可用"]
                        self.assertEqual("".join(row["text"] for row in body), text.replace("\n", ""))
                        self.assertTrue(all(row["size"] * 320 / cards.WIDTH >= 15 for row in body))

    def test_long_status_and_unknown_kind_grow_without_small_text(self):
        with tempfile.TemporaryDirectory() as directory:
            for renderer, data in (
                    (cards.render_forecast_card, dict(FORECAST, status="尚未确认的超长状态" * 12)),
                    (cards.render_announcement_card, dict(ANNOUNCEMENT, kind="Unbroken" * 25))):
                meta, records = self.record_render(renderer, data, Path(directory) / "header.png")
                self.assert_readable_and_separate(meta, records)

    def test_dates_always_split_date_and_utc8_time_without_shrinking(self):
        self.assertEqual(cards.date_lines(NOW), "2026年10月19日\n10:33 UTC+08:00")
        with tempfile.TemporaryDirectory() as directory:
            for renderer, data, count in ((cards.render_forecast_card, FORECAST, 2),
                                          (cards.render_announcement_card, ANNOUNCEMENT, 1)):
                meta, records = self.record_render(renderer, data, Path(directory) / "dates.png")
                self.assert_readable_and_separate(meta, records)
                dates = [r for r in records if "年" in r["text"] and "月" in r["text"]]
                times = [r for r in records if "UTC+08:00" in r["text"]]
                self.assertEqual(len(dates), count)
                self.assertEqual(len(times), count)
                self.assertTrue(all(r["size"] == cards.SMALL_SIZE for r in dates + times))
                self.assertTrue(all("UTC" not in r["text"] for r in dates))
                self.assertTrue(all("年" not in r["text"] for r in times))
                labels = "".join(r["text"] for r in records)
                for forbidden in ("查看", "原始公告", "https://", "信息来源"):
                    self.assertNotIn(forbidden, labels)

    def test_zero_hundred_and_missing_probabilities_render_full_size(self):
        with tempfile.TemporaryDirectory() as directory:
            for first, second in ((0, 0), (1, 1), (None, None), (None, 1)):
                data = dict(FORECAST, probability_24h=first, probability_48h=second, last_reset_at=None)
                meta, records = self.record_render(cards.render_forecast_card, data,
                                                   Path(directory) / "probabilities.png")
                self.assert_readable_and_separate(meta, records)
                labels = [r["text"] for r in records]
                self.assertEqual(labels.count("不可用"), (first is None) + (second is None))
                self.assertEqual(labels.count("%"), (first is not None) + (second is not None))
                self.assertIn("暂无记录", labels)
                for record in records:
                    if record["text"] in ("100", "0"):
                        self.assertGreaterEqual(record["size"] * 320 / cards.WIDTH, 50)
                    if record["text"] in ("100", "0", "%", "不可用"):
                        left, top, right, bottom = record["box"]
                        panel_left = 50 if left < 400 else 412
                        self.assertGreaterEqual(left, panel_left + 10)
                        self.assertLessEqual(right, panel_left + 338 - 10)
                        self.assertGreaterEqual(top, 132)
                        self.assertLessEqual(bottom, 294)

    def test_real_bundled_avatar_and_missing_asset_fail_closed(self):
        self.assertEqual(hashlib.sha256(cards.AVATAR_PATH.read_bytes()).hexdigest(),
                         "ac835db154ed10e731f63e7ea242409a7bd8603b817b8ad08ee9ef13796ab174")
        with Image.open(cards.AVATAR_PATH) as avatar:
            self.assertEqual(avatar.format, "JPEG")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "avatar.png"
            cards.render_announcement_card(ANNOUNCEMENT, target, now=NOW)
            with Image.open(target) as image:
                self.assertGreater(len(image.crop((22, 44, 108, 130)).getcolors(10000)), 100)
            missing = Path(directory) / "missing.jpg"
            with patch.object(cards, "AVATAR_PATH", missing), self.assertRaises(FileNotFoundError):
                cards.render_announcement_card(ANNOUNCEMENT, Path(directory) / "missing.png", now=NOW)
            self.assertFalse((Path(directory) / "missing.png").exists())

    def test_bubble_tail_has_no_vertical_seam_and_shadow_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "tail.png"
            cards.render_announcement_card(ANNOUNCEMENT, target, now=NOW)
            with Image.open(target) as image:
                paper = (255, 253, 247)
                ink = (40, 34, 28)
                for y in range(74, 103):
                    for x in range(145, 151):
                        self.assertEqual(image.getpixel((x, y)), paper, (x, y))
                self.assertEqual(image.getpixel((126, 88)), ink)
                self.assertEqual(image.getpixel((134, 96)), ink)
                self.assertEqual(image.getpixel((128, 80)), (255, 244, 220))


if __name__ == "__main__":
    unittest.main()
