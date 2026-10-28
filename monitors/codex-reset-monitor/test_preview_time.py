import copy
import io
import json
import tempfile
import unittest
import hashlib
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import Mock, patch

import preview_time as p


SOURCE = dict(text="Lands tomorrow before 10am PST.", publishedAt="2026-10-22T06:55:54Z",
              window="tomorrow, before 10am Pacific", context="It's reset day today.")
SEMANTIC = dict(expression="tomorrow before 10am PST", relation="before", day_offset=1,
                local_date=None, local_time="10:00", zone="PST", alternative_zone=None)


class PreviewTimeTests(unittest.TestCase):
    def test_configured_model_reads_only_final_json_and_rejects_partial_final(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "openclaw.json").write_text(json.dumps(dict(
                agents=dict(defaults=dict(model=dict(primary="zai/glm-5.3-flash"))),
                models=dict(providers=dict(zai=dict(baseUrl="https://example.com/v1", apiKey="TEST-KEY"))))))
            model, complete = p.configured_completion(root)
            self.assertEqual(model, "zai/glm-5.3-flash")
            payload = dict(choices=[dict(finish_reason="stop", message=dict(
                content=json.dumps(SEMANTIC), reasoning_content="PRIVATE REASONING"))])
            opener = Mock()
            opener.open.return_value = io.BytesIO(json.dumps(payload).encode())
            with patch.object(p.urllib.request, "build_opener", return_value=opener):
                result = complete(SOURCE)
                self.assertEqual(result, SEMANTIC)
                self.assertNotIn("PRIVATE", str(result))
                request = opener.open.call_args.args[0]
                body = json.loads(request.data)
                self.assertFalse(body["stream"])
                self.assertNotIn("tools", body)
                self.assertEqual(len(body["messages"]), 2)
                payload["choices"][0]["finish_reason"] = "length"
                opener.open.return_value = io.BytesIO(json.dumps(payload).encode())
                with self.assertRaisesRegex(ValueError, "incomplete_model_final"):
                    complete(SOURCE)

    def test_relative_day_uses_publish_date_and_only_explicit_pst(self):
        result = p.render_semantics(SEMANTIC, SOURCE)
        self.assertEqual([c["utc08"] for c in result["candidates"]],
                         ["2026-10-23T02:00:00+08:00"])
        self.assertEqual(result["display"], "预计重置：2026-10-23 02:00前（UTC+08:00）")

    def test_old_cached_alternative_does_not_add_a_second_time_or_call_model(self):
        event = dict(detail=SOURCE["text"], occurred_at=SOURCE["publishedAt"],
                     forecast_signal=dict(window=SOURCE["window"]), time_context=SOURCE["context"])
        complete = Mock(return_value=dict(SEMANTIC, alternative_zone="America/Los_Angeles"))
        with tempfile.TemporaryDirectory() as directory:
            p.interpret_preview_time(event, directory, complete=complete)
            result = p.interpret_preview_time(event, directory, complete=complete)
            self.assertEqual(complete.call_count, 1)
            self.assertEqual(len(result["candidates"]), 1)
            self.assertEqual(result["candidates"][0]["utc08"], "2026-10-23T02:00:00+08:00")

    def midnight(self, **changes):
        source = dict(text="Lands by midnight PST.", publishedAt="2026-10-28T02:43:38Z",
                      window="by midnight today", context="Today is a reset.")
        source.update(changes)
        semantic = dict(SEMANTIC, expression="by midnight PST", day_offset=0, local_time="00:00")
        return source, semantic

    def test_midnight_at_end_of_publishers_day_not_the_already_passed_start(self):
        source, semantic = self.midnight()
        for offset in (0, 1, 2):
            with self.subTest(offset=offset):
                result = p.render_semantics(dict(semantic, day_offset=offset), source)
                self.assertEqual(result["display"], "预计重置：2026-10-28 16:00前（UTC+08:00）")
                self.assertEqual(result["normalization"], "end-of-source-day-midnight")

    def test_midnight_crosses_year_and_uses_only_literal_source_offset(self):
        source, semantic = self.midnight(publishedAt="2027-01-01T02:43:38Z")
        self.assertEqual(p.render_semantics(semantic, source)["candidates"][0]["utc08"],
                         "2027-01-01T16:00:00+08:00")
        source, semantic = self.midnight(text="Lands by midnight PDT.")
        semantic.update(expression="by midnight PDT", zone="PDT")
        self.assertEqual(p.render_semantics(semantic, source)["candidates"][0]["utc08"],
                         "2026-10-28T15:00:00+08:00")
        with self.assertRaisesRegex(ValueError, "literal_timezone"):
            p.render_semantics(dict(semantic, zone="PST"), source)

    def test_tomorrows_midnight_and_explicit_dates_are_not_rolled_to_the_next_available_day(self):
        source, semantic = self.midnight(text="Lands by midnight tomorrow PST.")
        semantic.update(expression="by midnight tomorrow PST", day_offset=2)
        self.assertEqual(p.render_semantics(semantic, source)["candidates"][0]["utc08"],
                         "2026-10-29T16:00:00+08:00")
        source["text"] = "By 2026-10-27 00:00 PST"
        semantic.update(expression=source["text"], day_offset=None, local_date="2026-10-27")
        with self.assertRaisesRegex(ValueError, "deadline_before_publication"):
            p.render_semantics(semantic, source)

    def test_impossible_deadlines_before_publication_are_rejected_not_shifted(self):
        source, semantic = self.midnight(text="Lands before 10am PST.")
        semantic.update(expression="before 10am PST", local_time="10:00")
        for relation in ("before", "at"):
            with self.subTest(relation=relation), self.assertRaisesRegex(ValueError, "deadline_before_publication"):
                p.render_semantics(dict(semantic, relation=relation), source)

    def test_expiry_is_rechecked_on_cached_semantics_without_another_model_call(self):
        source, semantic = self.midnight()
        event = dict(detail=source["text"], occurred_at=source["publishedAt"],
                     forecast_signal=dict(window=source["window"]), time_context=source["context"])
        complete = Mock(return_value=semantic)
        with tempfile.TemporaryDirectory() as directory:
            before = p.interpret_preview_time(event, directory, complete=complete,
                now=datetime(2026, 10, 28, 7, 59, tzinfo=timezone.utc))
            expired = p.interpret_preview_time(event, directory, complete=complete,
                now=datetime(2026, 10, 28, 8, 0, tzinfo=timezone.utc))
            self.assertEqual(before["status"], "parsed")
            self.assertEqual(expired["status"], "expired")
            self.assertNotIn("预计重置", expired["display"])
            self.assertEqual(before["candidates"], expired["candidates"])
            self.assertEqual(complete.call_count, 1)

    def test_previous_parser_cache_is_preserved_but_not_reused_after_rule_change(self):
        source, semantic = self.midnight()
        event = dict(detail=source["text"], occurred_at=source["publishedAt"],
                     forecast_signal=dict(window=source["window"]), time_context=source["context"])
        complete = Mock(return_value=semantic)
        with tempfile.TemporaryDirectory() as directory:
            key = hashlib.sha256(json.dumps([1, "injected-test-model", source], sort_keys=True).encode()).hexdigest()
            old = Path(directory) / (key + ".json")
            old.write_text(json.dumps(dict(semantic=semantic, parserVersion=1)))
            original = old.read_bytes()
            result = p.interpret_preview_time(event, directory, complete=complete,
                now=datetime(2026, 10, 28, 3, 0, tzinfo=timezone.utc))
            self.assertEqual(result["display"], "预计重置：2026-10-28 16:00前（UTC+08:00）")
            self.assertEqual(result["parserVersion"], 2)
            self.assertEqual(complete.call_count, 1)
            self.assertEqual(old.read_bytes(), original)
            self.assertEqual(len(list(Path(directory).glob("*.json"))), 2)

    def test_date_only_window_expires_at_end_not_beginning(self):
        source = dict(SOURCE, text="Tomorrow PST")
        semantic = dict(SEMANTIC, expression=source["text"], relation="on", local_time=None)
        result = p.render_semantics(semantic, source)
        start = p.timestamp(result["candidates"][0]["utc08"])
        end = p.timestamp(result["candidates"][0]["utc08End"])
        self.assertEqual(p.apply_delivery_time(result, start)["status"], "parsed")
        self.assertEqual(p.apply_delivery_time(result, end)["status"], "expired")

    def test_literal_timezone_cannot_be_silently_changed(self):
        with self.assertRaisesRegex(ValueError, "literal_timezone"):
            p.render_semantics(dict(SEMANTIC, zone="America/Los_Angeles"), SOURCE)

    def test_absolute_date_and_after_are_converted_without_guessing(self):
        source = dict(SOURCE, text="2026-12-01 after 10:00 UTC")
        semantic = dict(SEMANTIC, expression=source["text"], relation="after", day_offset=None,
                        local_date="2026-12-01", zone="UTC")
        with self.assertRaisesRegex(ValueError, "implausible"):
            p.render_semantics(semantic, source)
        source["publishedAt"] = "2026-11-30T23:00:00Z"
        result = p.render_semantics(semantic, source)
        self.assertEqual(result["candidates"][0]["utc08"], "2026-12-01T18:00:00+08:00")
        self.assertIn("18:00后", result["display"])

    def test_unknown_zone_never_invents_a_date(self):
        unknown = dict(SEMANTIC, relation="unknown", zone=None, expression=None,
                       local_time=None, day_offset=None)
        self.assertEqual(p.render_semantics(unknown, SOURCE)["status"], "unresolved")

    def test_invalid_schema_ungrounded_text_clock_and_offset_are_rejected(self):
        for changed in (dict(extra="do things"), dict(expression="invented"), dict(local_time="25:00"),
                        dict(day_offset=True), dict(day_offset=32), dict(zone="file:///tmp/secret"),
                        dict(local_date="2026-10-23"), dict(relation="already-reset")):
            with self.subTest(changed=changed), self.assertRaises((ValueError, TypeError)):
                p.render_semantics(dict(SEMANTIC, **changed), SOURCE)

    def test_dst_gap_and_fold_are_rejected(self):
        for day, clock in (("2026-03-08", "02:30"), ("2026-11-01", "01:30")):
            source = dict(SOURCE, text="Tomorrow at the specified time", publishedAt=day+"T00:00:00Z")
            semantic = dict(SEMANTIC, expression=source["text"], relation="at", zone="America/Los_Angeles",
                            day_offset=None, local_date=day, local_time=clock)
            with self.subTest(day=day), self.assertRaises(ValueError):
                p.render_semantics(semantic, source)

    def test_success_cache_calls_model_once_and_keeps_only_validated_semantics(self):
        event = dict(detail=SOURCE["text"], occurred_at=SOURCE["publishedAt"],
                     forecast_signal=dict(window=SOURCE["window"]), time_context=SOURCE["context"])
        complete = Mock(return_value=copy.deepcopy(SEMANTIC))
        with tempfile.TemporaryDirectory() as directory:
            a = p.interpret_preview_time(event, directory, complete=complete)
            b = p.interpret_preview_time(event, directory, complete=complete)
            self.assertEqual(a, b)
            self.assertEqual(complete.call_count, 1)
            self.assertEqual(len(list(Path(directory).glob("*.json"))), 1)
            event["detail"] += " Updated window."
            p.interpret_preview_time(event, directory, complete=complete)
            self.assertEqual(complete.call_count, 2)

    def test_model_failure_does_not_expose_diagnostics_or_block_preview(self):
        event = dict(detail=SOURCE["text"], occurred_at=SOURCE["publishedAt"],
                     forecast_signal=dict(window=SOURCE["window"]))
        with tempfile.TemporaryDirectory() as directory:
            result = p.interpret_preview_time(event, directory,
                complete=Mock(side_effect=RuntimeError("SECRET reasoning or token")))
            self.assertEqual(result["status"], "unresolved")
            self.assertNotIn("SECRET", str(result))
            self.assertEqual(list(Path(directory).glob("*.json")), [])


if __name__ == "__main__":
    unittest.main()
