import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
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

    def test_relative_day_uses_publish_date_and_preserves_pst_daylight_ambiguity(self):
        result = p.render_semantics(SEMANTIC, SOURCE)
        self.assertEqual([c["utc08"] for c in result["candidates"]],
                         ["2026-10-23T02:00:00+08:00", "2026-10-23T01:00:00+08:00"])
        self.assertIn("02:00前", result["display"])
        self.assertIn("夏令时", result["display"])

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
