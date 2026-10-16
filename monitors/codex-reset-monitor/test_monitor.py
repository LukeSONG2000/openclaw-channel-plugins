import contextlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("reset_monitor", Path(__file__).with_name("monitor.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
OLD_ID = "2110618732666257557"
NEW_ID = "2110618732666257558"
HISTORICAL_ID = "2108040921044639779"


def payloads(confirmed=True):
    common = dict(last_reset_id=NEW_ID, last_reset_at="2026-10-15T06:28:13Z",
                  last_reset_text="Confirmed reset", last_reset_url=f"https://x.com/source/status/{NEW_ID}",
                  answer="yes", prob_24=40, prob_48=60)
    stamp = m.now_utc().isoformat()
    forecast = dict(common, model_version="evidence-v2", confidence="low",
                    computed_at=stamp, live_fetched_at=stamp,
                    range_24=[30, 60], range_48=[50, 85],
                    factors=[dict(code="last_reset", label="Last verified reset", detail="Confirmed reset",
                                  href=common["last_reset_url"])] if confirmed else [])
    notify = dict(common, promise_active=not confirmed, fetched_at=stamp)
    if not confirmed:
        forecast["answer"] = notify["answer"] = "promised"
    return forecast, notify


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = Path(self.tmp.name) / "state.json"
        self.state = dict(version=1, initialized_at="2026-09-17T03:51:39Z",
                          last_reset_id=OLD_ID, notified_reset_ids=[OLD_ID],
                          daily_summary_date="2026-10-15", consecutive_fetch_failures=18,
                          failure_notified=True, pending_reset_ids=["keep-pending"])
        self.state_file.write_text(json.dumps(self.state))
        self.original = self.state_file.read_bytes()
        self.patcher = patch.object(m, "STATE_FILE", self.state_file)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.push = patch.object(m, "push", return_value=(True, "mock"))
        self.sender = self.push.start()
        self.addCleanup(self.push.stop)

    def run_monitor(self, data=None, **kwargs):
        with patch.object(m, "fetch_json", side_effect=data or payloads()), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return m.run_once(**kwargs)

    def read_state(self):
        return json.loads(self.state_file.read_text())

    def test_dry_run_confirmed_reset_is_read_only(self):
        self.assertEqual(self.run_monitor(dry_run=True, send_daily=True), 0)
        self.sender.assert_not_called()
        self.assertEqual(self.state_file.read_bytes(), self.original)

    def test_no_send_recovers_health_without_consuming_pending(self):
        self.assertEqual(self.run_monitor(no_send=True, send_daily=True), 0)
        self.sender.assert_not_called()
        state = self.read_state()
        self.assertEqual(state["consecutive_fetch_failures"], 0)
        self.assertFalse(state["failure_notified"])
        self.assertEqual(state["notified_reset_ids"], self.state["notified_reset_ids"])
        self.assertEqual(state["pending_reset_ids"], ["keep-pending"])
        self.assertEqual(state["daily_summary_date"], "2026-10-15")

    def test_promise_new_top_level_id_never_notifies(self):
        self.run_monitor(payloads(confirmed=False))
        self.sender.assert_not_called()
        self.assertEqual(self.read_state()["last_reset_id"], OLD_ID)
        self.assertEqual(self.read_state()["notified_reset_ids"], [OLD_ID])

    def test_confirmed_reset_sent_once(self):
        self.run_monitor()
        self.run_monitor()
        self.assertEqual(self.sender.call_count, 1)
        self.assertIn(NEW_ID, self.read_state()["notified_reset_ids"])

    def test_failed_delivery_does_not_acknowledge_reset(self):
        self.sender.return_value = (False, "mock failed")
        self.run_monitor()
        self.assertNotIn(NEW_ID, self.read_state()["notified_reset_ids"])
        self.run_monitor()
        self.assertEqual(self.sender.call_count, 2)

    def test_schema_failure_preserves_counter_and_dedupe(self):
        self.assertEqual(self.run_monitor([{}, {}]), 1)
        state = self.read_state()
        self.assertEqual(state["consecutive_fetch_failures"], 19)
        self.assertTrue(state["failure_notified"])
        self.assertEqual(state["notified_reset_ids"], [OLD_ID])
        self.sender.assert_not_called()

    def test_failure_warning_after_three_failures_only_once(self):
        self.state.update(consecutive_fetch_failures=0, failure_notified=False)
        self.state_file.write_text(json.dumps(self.state))
        for count in range(1, 5):
            self.run_monitor([RuntimeError("mock fetch failed")])
            self.assertEqual(self.sender.call_count, int(count >= 3))
        self.assertTrue(self.read_state()["failure_notified"])

    def test_dry_run_failure_does_not_write_or_send(self):
        self.assertEqual(self.run_monitor([RuntimeError("mock failed")], dry_run=True), 1)
        self.sender.assert_not_called()
        self.assertEqual(self.state_file.read_bytes(), self.original)

    def test_no_send_failure_never_acknowledges_warning(self):
        self.state.update(consecutive_fetch_failures=2, failure_notified=False)
        self.state_file.write_text(json.dumps(self.state))
        self.run_monitor([RuntimeError("mock failed")], no_send=True)
        self.sender.assert_not_called()
        self.assertFalse(self.read_state()["failure_notified"])
        self.assertEqual(self.read_state()["consecutive_fetch_failures"], 3)

    def test_first_baseline_does_not_accept_promise_id(self):
        self.state_file.unlink()
        self.run_monitor(payloads(confirmed=False))
        state = self.read_state()
        self.assertIsNone(state["last_reset_id"])
        self.assertEqual(state["notified_reset_ids"], [])
        self.sender.assert_not_called()

    def test_first_confirmed_baseline_is_silent(self):
        self.state_file.unlink()
        self.run_monitor()
        self.assertEqual(self.read_state()["notified_reset_ids"], [NEW_ID])
        self.sender.assert_not_called()

    def test_first_no_send_baseline_does_not_acknowledge_reset(self):
        self.state_file.unlink()
        self.run_monitor(no_send=True)
        self.assertEqual(self.read_state()["notified_reset_ids"], [])
        self.sender.assert_not_called()

    def test_invalid_confirmed_factor_rejected(self):
        for key, value in (("href", "https://x.com/source/status/other-reset"),
                           ("href", True), ("detail", ""), ("label", None)):
            with self.subTest(key=key, value=value):
                data = payloads()
                data[0]["factors"][0][key] = value
                with self.assertRaises(ValueError):
                    m.validate_payloads(*data)

    def test_older_confirmed_event_ignored_whether_notified_or_unseen(self):
        for previously_notified in (False, True):
            with self.subTest(previously_notified=previously_notified):
                state = dict(self.state)
                state["notified_reset_ids"] = [OLD_ID] + ([HISTORICAL_ID] if previously_notified else [])
                self.state_file.write_text(json.dumps(state))
                data = payloads()
                for obj in data:
                    obj.update(last_reset_id=HISTORICAL_ID, last_reset_at="2026-10-08T03:00:00Z",
                               last_reset_url=f"https://x.com/source/status/{HISTORICAL_ID}")
                data[0]["factors"][0]["href"] = data[0]["last_reset_url"]
                self.assertEqual(self.run_monitor(data), 0)
                actual = self.read_state()
                self.assertEqual(actual["last_reset_id"], OLD_ID)
                self.assertEqual(actual["notified_reset_ids"], state["notified_reset_ids"])
                self.sender.assert_not_called()

    def test_known_timestamp_prevents_backdated_new_id(self):
        self.state["last_reset_at"] = "2026-10-15T07:00:00Z"
        self.state_file.write_text(json.dumps(self.state))
        self.run_monitor()
        self.sender.assert_not_called()
        self.assertEqual(self.read_state()["last_reset_id"], OLD_ID)

    def test_notified_watermark_prevents_regression_with_older_baseline(self):
        self.state["last_reset_id"] = HISTORICAL_ID
        self.state["notified_reset_ids"] = [str(int(NEW_ID) + 1)]
        self.state_file.write_text(json.dumps(self.state))
        self.run_monitor()
        self.sender.assert_not_called()
        self.assertEqual(self.read_state()["last_reset_id"], HISTORICAL_ID)

    def test_stale_or_invalid_freshness_never_recovers_health(self):
        for idx, key in ((0, "computed_at"), (0, "live_fetched_at"), (1, "fetched_at")):
            for value in ("2026-09-01T00:00:00Z", None, True, "invalid",
                          (m.now_utc() + timedelta(hours=1)).isoformat()):
                with self.subTest(key=key, value=value):
                    self.state_file.write_text(json.dumps(self.state))
                    data = payloads()
                    data[idx][key] = value
                    self.assertEqual(self.run_monitor(data), 1)
                    self.assertEqual(self.read_state()["consecutive_fetch_failures"], 19)
                    self.assertTrue(self.read_state()["failure_notified"])
                    self.sender.assert_not_called()

    def test_all_old_source_timestamps_fail(self):
        data = payloads()
        data[0].update(computed_at="2026-09-01T00:00:00Z", live_fetched_at="2026-09-01T00:00:00Z")
        data[1]["fetched_at"] = "2026-09-01T00:00:00Z"
        self.assertEqual(self.run_monitor(data), 1)
        self.assertEqual(self.read_state()["consecutive_fetch_failures"], 19)
        self.sender.assert_not_called()

    def test_nanosecond_source_timestamps_supported_on_python39(self):
        parsed = m.parse_time("2026-10-16T01:56:09.808265035Z")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.microsecond, 808265)
        data = payloads()
        fresh = m.now_utc().strftime("%Y-%m-%dT%H:%M:%S") + ".123456789Z"
        data[0].update(computed_at=fresh, live_fetched_at=fresh)
        data[1]["fetched_at"] = fresh
        m.validate_payloads(*data)

    def test_invalid_field_types_rejected(self):
        cases = [(0, "prob_24", True), (0, "prob_48", "60"), (0, "prob_24", float("nan")),
                 (0, "prob_48", 101), (0, "last_reset_id", 123), (0, "last_reset_at", "bad"),
                 (0, "last_reset_at", "2099-01-01T00:00:00Z"), (0, "answer", []),
                 (0, "range_24", [60, 30]), (0, "range_48", [True, 80]),
                 (0, "confidence", {}), (0, "model_version", None),
                 (0, "factors", {}), (0, "factors", [{"code": 1}]),
                 (0, "factors", [{"code": "last_reset", "detail": {}}]),
                 (1, "promise_active", "false"), (1, "last_reset_text", []),
                 (1, "last_reset_id", "different-reset")]
        for idx, key, value in cases:
            with self.subTest(key=key, value=value):
                data = payloads()
                data[idx][key] = value
                with self.assertRaises(ValueError):
                    m.validate_payloads(*data)

    def test_inconsistent_probability_marked_unavailable(self):
        forecast, _ = payloads(False)
        forecast.update(prob_24=0, prob_48=28)
        text = m.daily_summary(forecast, m.now_utc())
        self.assertEqual(text.count("不可用（来源概率与区间矛盾）"), 2)
        self.assertNotIn("0%", text)
        self.assertNotIn("28%", text)

    def test_consistent_probability_keeps_source_values(self):
        forecast, _ = payloads()
        self.assertEqual(m.forecast_probability(forecast, 24), "40%（置信区间 30%–60%）")

    def test_fetch_uses_ipv4_https_and_bounded_timeout(self):
        result = subprocess.CompletedProcess([], 0, '{"ok": true}', "")
        with patch.object(m.subprocess, "run", return_value=result) as run:
            self.assertEqual(m.fetch_json(m.FORECAST_URL), {"ok": True})
        args, kwargs = run.call_args
        self.assertIn("--ipv4", args[0])
        self.assertIn("=https", args[0])
        self.assertEqual(args[0][-1], m.FORECAST_URL)
        self.assertEqual(kwargs["timeout"], 25)
        self.assertNotIn("shell", kwargs)

    def test_fetch_retries_http_and_invalid_json_without_leaking_stderr(self):
        for response in (subprocess.CompletedProcess([], 28, "", "proxy secret"),
                         subprocess.CompletedProcess([], 0, "[]", ""),
                         subprocess.CompletedProcess([], 0, "bad json", "")):
            with self.subTest(returncode=response.returncode, stdout=response.stdout), \
                    patch.object(m.subprocess, "run", return_value=response) as run, \
                    patch.object(m.time, "sleep"):
                with self.assertRaises(RuntimeError) as error:
                    m.fetch_json(m.FORECAST_URL)
                self.assertNotIn("proxy secret", str(error.exception))
                self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
