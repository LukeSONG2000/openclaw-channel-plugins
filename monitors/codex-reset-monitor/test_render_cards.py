import ast
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageFont

import render_cards as cards


NOW = "2026-10-19T02:33:00Z"
FORECAST = {"probability_24h": .71, "probability_48h": .81, "status": "已预告",
            "summary": "今天还没有确认重置。Tibo 已预告未来会有一次全局重置。",
            "updated_at": NOW, "last_reset_at": "2026-10-17T21:12:21Z"}
ANNOUNCEMENT = {"summary": "Direct usage reset", "body": "Tibo: Done",
                "published_at": "2026-10-17T21:12:21Z", "kind": "reset"}


class RenderCardsTests(unittest.TestCase):
    def test_beijing_and_aware_timestamp(self):
        self.assertEqual(cards.format_beijing(ANNOUNCEMENT["published_at"]), "2026年10月18日 05:12 北京时间")
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
            self.assertEqual(cards.format_beijing(timestamp), "2026年10月19日 11:08 北京时间")
            for renderer, data in ((cards.render_forecast_card, forecast),
                                    (cards.render_announcement_card,
                                     dict(ANNOUNCEMENT, published_at=timestamp))):
                meta = renderer(data, target, now="2026-10-19T03:10:00.1Z")
                self.assertTrue(target.is_file())
                self.assertEqual(meta["width"], 1600)

    def test_wrap_preserves_long_mixed_text(self):
        font = ImageFont.truetype(cards.find_font(), 30)
        text = "完整中文内容 Mixed words " + "A" * 200 + "\n第二段" * 5
        lines = cards.wrap_text(text, font, 380)
        self.assertEqual("".join(lines), text.replace("\n", ""))
        self.assertTrue(all(font.getlength(line) <= 380 for line in lines))

    def test_cjk_glyphs_and_font_collection(self):
        font = cards.load_font(cards.find_font(), 30)
        missing = bytes(font.getmask("\U0010ffff"))
        for char in "北京时间不可用最近一次全局重置储备增益信号预告":
            self.assertNotEqual(bytes(font.getmask(char)), missing, char)
        if "NotoSansCJK" in cards.find_font():
            self.assertIn("CJK SC", font.getname()[0])

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
        for text in ("0%", "71%", "100%", "不可用"):
            font = cards.fit_font(text, cards.find_font(), 116, 250, 128)
            box = font.getbbox(text)
            self.assertLessEqual(box[2] - box[0], 250)
            self.assertLessEqual(box[3] - box[1], 128)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "prob.png"
            for value in (0, .71, 1, None):
                cards.render_forecast_card(dict(FORECAST, probability_24h=value), target, now=NOW)
                with Image.open(target) as image:
                    # A clear internal moat must surround all probability text.
                    for y in range(132, 255):
                        self.assertEqual(image.getpixel((90, y)), (255, 220, 77))
                        self.assertEqual(image.getpixel((355, y)), (255, 220, 77))

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


if __name__ == "__main__":
    unittest.main()
