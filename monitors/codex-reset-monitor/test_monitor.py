import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("reset_monitor", Path(__file__).with_name("monitor.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
OLD_ID = "2110618732666257557"
NEW_ID = "2110618732666257558"
HISTORICAL_ID = "2108040921044639779"
FAKE_ADMIN = "qqbot:c2c:test-admin"


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


def feed_payload(forecast):
    return dict(fetched_at=m.now_utc().isoformat(), posts=[{"ignored": True}], events=[
        dict(id=forecast["last_reset_id"], kind="reset", summary="Direct usage reset", body="NOT summary",
             announced_at=forecast["last_reset_at"], source_url=forecast["last_reset_url"], preview=False,
             reset_kind="hard", tags=["regular", "x_post"]),
        dict(id="history-july-2026-5", kind="reset", summary="Legacy history",
             announced_at="2026-07-01T00:00:00Z", source_url=""),
    ])


def fake_render(snapshot, directory):
    cards = []
    for i in range(1 + len(snapshot["announcements"])):
        path = directory / ("forecast.png" if i == 0 else f"announcement-{i - 1:04d}.png")
        path.write_bytes(b"test PNG" + str(i).encode())
        cards.append(dict(path=str(path.resolve()), width=100, height=100,
                          sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    return cards


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = Path(self.tmp.name) / "state.json"
        self.state = dict(version=2, initialized_at="2026-09-17T03:51:39Z",
                          last_reset_id=OLD_ID, notified_reset_ids=[OLD_ID],
                          daily_summary_date="2026-10-15", consecutive_fetch_failures=18,
                          failure_notified=True, pending_reset_ids=["keep-pending"],
                          migrationLowerBound="2026-10-15T00:00:00Z", sentAnnouncementIds=[],
                          pendingBatch=None, lastSuccessfulPushAt=None, announcementWatermark=None)
        self.state_file.write_text(json.dumps(self.state))
        self.original = self.state_file.read_bytes()
        self.patcher = patch.object(m, "STATE_FILE", self.state_file)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.push = patch.object(m, "push", return_value=(True, "mock"))
        self.sender = self.push.start()
        self.addCleanup(self.push.stop)
        self.render = patch.object(m, "render_snapshot", side_effect=fake_render)
        self.renderer = self.render.start()
        self.addCleanup(self.render.stop)
        self.batch_push = patch.object(m, "deliver_batch", return_value=True)
        self.batch_sender = self.batch_push.start()
        self.addCleanup(self.batch_push.stop)

    def run_monitor(self, data=None, **kwargs):
        data = data or payloads()
        if len(data) == 2 and isinstance(data[0], dict) and data[0].get("last_reset_id"):
            data = [*data, feed_payload(data[0])]
        with patch.object(m, "fetch_json", side_effect=data), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return m.run_once(**kwargs)

    def read_state(self):
        return json.loads(self.state_file.read_text())

    def test_dry_run_confirmed_reset_is_read_only(self):
        self.assertEqual(self.run_monitor(dry_run=True, send_daily=True), 0)
        self.sender.assert_not_called()
        self.batch_sender.assert_not_called()
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
        self.assertEqual(self.batch_sender.call_count, 1)
        self.sender.assert_not_called()
        self.assertIn(NEW_ID, self.read_state()["notified_reset_ids"])

    def test_typed_phase_titles_keep_regular_and_banked_meanings_separate(self):
        titles = {("regular", "preview"): "Codex已确认重置！",
                  ("regular", "actual"): "Codex已重置，速蹬！",
                  ("banked", "upcoming"): "Codex重置卡即将发放！",
                  ("banked", "distributed"): "Codex重置卡已发放！",
                  ("banked", "announced"): "Codex已公布重置卡消息！"}
        keys = set()
        for (reset_type, phase), title in titles.items():
            event = dict(eventId=NEW_ID, resetType=reset_type, phase=phase,
                         announcedAt="2026-10-19T03:00:00Z")
            self.assertEqual(m.batch_phase_title([event]), title)
            self.assertEqual(m.batch_phase_title([event], daily=True), "Codex会重置吗？")
            keys.add(m.phase_event_key(event))
        self.assertEqual(len(keys), 5)
        with self.assertRaises(ValueError):
            m.phase_event_key(dict(eventId=NEW_ID, resetType="banked", phase="promise_active",
                                  announcedAt="2026-10-19T03:00:00Z"))

    def test_real_legacy_quotareset_preview_without_reset_type_is_regular(self):
        forecast, notify = payloads(confirmed=False)
        event = dict(id="2094144275957350900", kind="reset_preview", preview=True,
                     tags=["quotareset"], announced_at="2026-08-30T00:00:00Z",
                     summary="Legacy preview fixture",
                     source_url="https://x.com/thsottiaux/status/2094144275957350900")
        phase = m.classify_reset_phase(event, forecast, notify)
        self.assertEqual((phase["resetType"], phase["phase"]), ("regular", "preview"))
        for explicit_type in ("unknown", "future_type"):
            with self.subTest(reset_kind=explicit_type):
                self.assertIsNone(m.classify_reset_phase(dict(event, reset_kind=explicit_type),
                                                        forecast, notify))
        banked = m.classify_reset_phase(dict(event, tags=["quotareset", "banked"]), forecast, notify)
        self.assertEqual((banked["resetType"], banked["phase"]), ("banked", "upcoming"))
        self.assertIsNone(m.classify_reset_phase(dict(event, preview=False), forecast, notify))
        self.assertIsNone(m.classify_reset_phase(dict(event, kind="signal"), forecast, notify))

    def test_daily_preview_success_does_not_ack_actual_phase_for_same_id(self):
        forecast, notify = payloads()
        feed = feed_payload(forecast)
        preview = dict(eventId=NEW_ID, resetType="regular", phase="preview",
                       announcedAt="2026-10-19T03:00:00Z")
        actual = dict(preview, phase="actual")
        state = dict(self.state)
        batch = m.prepare_batch(state, forecast, feed, m.validate_feed(feed), "", "2026-10-19",
                                phase_events=[preview])
        self.assertNotIn("deliveredPhaseKeys", state)
        m.complete_batch(state, batch)
        self.assertIn(m.phase_event_key(preview), state["deliveredPhaseKeys"])
        self.assertNotIn(m.phase_event_key(actual), state["deliveredPhaseKeys"])
        actual_batch = m.prepare_batch(state, forecast, feed, m.validate_feed(feed), NEW_ID, None,
                                       phase_events=[actual])
        directory = self.state_file.parent / "outbox" / actual_batch["batchId"]
        manifest = json.loads((directory / "batch.json").read_text())
        self.assertEqual(manifest["parts"][0]["text"], "Codex已重置，速蹬！")
        snapshot = json.loads((directory / "snapshot.json").read_text())
        self.assertEqual([event["id"] for event in snapshot["announcements"]], [NEW_ID])
        self.assertNotIn(m.phase_event_key(actual), state["deliveredPhaseKeys"])
        m.complete_batch(state, actual_batch)
        self.assertIn(m.phase_event_key(actual), state["deliveredPhaseKeys"])
        self.assertEqual(m.select_announcements(m.validate_feed(feed), state, phase_events=[actual]), [])

    def test_phase_upgrade_baseline_blocks_trigger_not_unseen_daily_content(self):
        forecast, notify = payloads(confirmed=False)
        event = dict(id="2094144275957350900", kind="reset_preview", preview=True,
                     tags=["quotareset"], announced_at="2026-10-15T01:00:00Z",
                     summary="Legacy preview", source_url="https://x.com/thsottiaux/status/2094144275957350900")
        self.state["lastSuccessfulPushAt"] = "2026-10-15T02:00:00Z"
        self.state_file.write_text(json.dumps(self.state))
        feed = dict(fetched_at=m.now_utc().isoformat(), events=[event])
        self.assertEqual(self.run_monitor([forecast, notify, feed]), 0)
        self.batch_sender.assert_not_called()
        state = self.read_state()
        phase = m.classify_reset_phase(event, forecast, notify)
        self.assertIn(m.phase_event_key(phase), state["phaseBaselineKeys"])
        self.assertEqual(state["deliveredPhaseKeys"], [])
        self.assertEqual(state["lastSuccessfulPushAt"], "2026-10-15T02:00:00Z")
        self.assertEqual(m.select_announcements([event], state, [phase]), [event])
        self.assertEqual(self.run_monitor([forecast, notify, feed], send_daily=True), 0)
        self.assertEqual(self.batch_sender.call_count, 1)
        state = self.read_state()
        self.assertIn(event["id"], state["sentAnnouncementIds"])
        self.assertIn(m.phase_event_key(phase), state["deliveredPhaseKeys"])
        self.assertEqual(m.select_announcements([event], state, [phase]), [])

    def test_seen_id_baseline_phase_suppressed_but_new_phase_remains_content(self):
        forecast, notify = payloads()
        event = feed_payload(forecast)["events"][0]
        phase = m.classify_reset_phase(event, forecast, notify)
        preview = dict(phase, phase="preview")
        state = dict(self.state, sentAnnouncementIds=[NEW_ID],
                     phaseBaselineKeys=[m.phase_event_key(preview)])
        self.assertEqual(m.select_announcements([event], state, [preview]), [])
        self.assertEqual(m.select_announcements([event], state, [phase]), [event])
        state["deliveredPhaseKeys"] = [m.phase_event_key(phase)]
        self.assertEqual(m.select_announcements([event], state, [phase]), [])

    def test_run_once_legacy_preview_daily_then_same_id_actual_delivers_each_phase_once(self):
        forecast, notify = payloads(confirmed=False)
        event = dict(id=NEW_ID, kind="reset_preview", preview=True, tags=["quotareset"],
                     announced_at=forecast["last_reset_at"], summary="Upcoming regular reset",
                     source_url=forecast["last_reset_url"])
        feed = dict(fetched_at=m.now_utc().isoformat(), events=[event])
        self.assertEqual(self.run_monitor([forecast, notify, feed], send_daily=True), 0)
        batch = self.batch_sender.call_args.args[0]
        directory = self.state_file.parent / "outbox" / batch["batchId"]
        snapshot = json.loads((directory / "snapshot.json").read_text())
        self.assertEqual(snapshot["title"], "Codex会重置吗？")
        self.assertEqual(snapshot["stageText"], "常规重置（regular）｜已预告，尚未到账")
        self.assertEqual(self.run_monitor([forecast, notify, feed]), 0)
        self.assertEqual(self.batch_sender.call_count, 1)
        forecast, notify = payloads()
        self.assertEqual(self.run_monitor([forecast, notify, feed_payload(forecast)]), 0)
        self.assertEqual(self.batch_sender.call_count, 2)
        batch = self.batch_sender.call_args.args[0]
        manifest = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "batch.json").read_text())
        self.assertEqual(manifest["parts"][0]["text"], "Codex已重置，速蹬！")
        self.assertEqual(set(self.read_state()["deliveredPhaseKeys"]),
                         {f"regular:preview:{NEW_ID}", f"regular:actual:{NEW_ID}"})
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.batch_sender.call_count, 2)

    def test_legacy_preview_poll_triggers_once_without_confirming_arrival(self):
        forecast, notify = payloads(confirmed=False)
        event = dict(id="2094144275957350900", kind="reset_preview", preview=True,
                     tags=["quotareset"], announced_at="2026-10-15T03:00:00Z",
                     summary="Legacy preview", source_url="https://x.com/thsottiaux/status/2094144275957350900")
        feed = dict(fetched_at=m.now_utc().isoformat(), events=[event])
        self.assertEqual(self.run_monitor([forecast, notify, feed]), 0)
        self.assertEqual(self.batch_sender.call_count, 1)
        batch = self.batch_sender.call_args.args[0]
        snapshot = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["title"], "Codex已确认重置！")
        self.assertIn("尚未到账", snapshot["stageText"])
        self.assertIsNone(batch["resetId"])
        self.assertEqual(self.read_state()["notified_reset_ids"], [OLD_ID])
        self.assertEqual(self.run_monitor([forecast, notify, feed]), 0)
        self.assertEqual(self.batch_sender.call_count, 1)

    def test_real_banked_inventory_mapping_does_not_guess_distribution(self):
        forecast, notify = payloads(confirmed=False)
        fixtures = [
            ("2107975486798164736", "2026-10-07T23:24:55Z", "available", "distributed",
             "The banked reset Tibo announced landed on our monitoring accounts."),
            ("2090947196107764189", "2026-08-21T23:40:34Z", "arriving", "upcoming",
             "The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex. Do with this information what you may."),
            ("2095651088502591861", "2026-09-03T23:12:09Z", "announced", "announced",
             'Users are reporting that they’ve started receiving their banked resets. Sam Altman said "they should be able to begin broad rollout to API customers and chatgpt subscribers in t…'),
        ]
        for event_id, stamp, banked_state, expected, summary in fixtures:
            with self.subTest(banked_state=banked_state):
                event = dict(id=event_id, announced_at=stamp, kind="banked", reset_kind="banked",
                             banked_state=banked_state, preview=False, cadence=False, tags=["banked"],
                             summary=summary, source_url=f"https://x.com/thsottiaux/status/{event_id}")
                phase = m.classify_reset_phase(event, forecast, notify)
                self.assertEqual((phase["resetType"], phase["phase"]), ("banked", expected))
                for unknown in (None, "unknown", "issued", "preview"):
                    self.assertIsNone(m.classify_reset_phase(dict(event, banked_state=unknown), forecast, notify))
        self.assertIn("不代表个人到账", m.PHASE_DETAILS[("banked", "distributed")])

    def test_phase_upgrade_never_replays_months_but_new_late_id_is_not_rolling_filtered(self):
        forecast, notify = payloads(confirmed=False)
        event = dict(id="2107913738791596286", kind="reset_preview", preview=True,
                     tags=["banked", "x_post"], announced_at="2026-10-07T19:19:33Z",
                     summary="Will be there by EOD PST.",
                     source_url="https://x.com/thsottiaux/status/2107913738791596286")
        state = dict(self.state, lastSuccessfulPushAt="2026-10-19T03:00:00Z")
        old = m.classify_reset_phase(event, forecast, notify)
        m.initialize_phase_state(state, [old])
        self.assertEqual(m.pending_phase_events([old], state), [])
        self.assertEqual(m.select_announcements([event], state, [old]), [])
        late_event = dict(event, id=NEW_ID, announced_at="2026-10-16T00:00:00Z",
                          source_url=f"https://x.com/thsottiaux/status/{NEW_ID}")
        late = m.classify_reset_phase(late_event, forecast, notify)
        m.initialize_phase_state(state, [old, late])
        self.assertEqual(m.pending_phase_events([late], state), [late])
        self.assertEqual(m.select_announcements([late_event], state, [late]), [late_event])

    def test_failed_delivery_does_not_acknowledge_reset(self):
        self.batch_sender.return_value = False
        self.run_monitor()
        self.assertNotIn(NEW_ID, self.read_state()["notified_reset_ids"])
        self.assertEqual(self.read_state()["deliveredPhaseKeys"], [])
        self.run_monitor()
        self.assertEqual(self.batch_sender.call_count, 2)
        self.assertEqual(self.renderer.call_count, 1)

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
        self.assertEqual(self.read_state()["notified_reset_ids"], [])
        self.assertEqual(self.read_state()["baselineResetId"], NEW_ID)
        self.assertIsNone(self.read_state()["lastSuccessfulPushAt"])
        self.sender.assert_not_called()

    def test_first_no_send_baseline_does_not_acknowledge_reset(self):
        self.state_file.unlink()
        self.run_monitor(no_send=True)
        self.assertEqual(self.read_state()["notified_reset_ids"], [])
        self.assertIsNone(self.read_state()["initialized_at"])
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

    def test_iso_fraction_lengths_one_through_nine_preserve_timezone(self):
        for length in range(1, 10):
            fraction = "123456789"[:length]
            for suffix, offset in (("Z", 0), ("+00:00", 0), ("+08:00", 480), ("-03:30", -210)):
                with self.subTest(length=length, suffix=suffix):
                    parsed = m.parse_time(f"2026-10-19T03:08:02.{fraction}{suffix}")
                    expected = datetime(2026, 10, 19, 3, 8, 2, int(fraction[:6].ljust(6, "0")),
                                        tzinfo=timezone(timedelta(minutes=offset))).astimezone(timezone.utc)
                    self.assertEqual(parsed, expected)
        self.assertEqual(m.parse_time("2026-10-19T03:08:02Z"),
                         datetime(2026, 10, 19, 3, 8, 2, tzinfo=timezone.utc))

    def test_python39_qa_two_digit_timestamp_passes_freshness_without_relaxation(self):
        host_now = datetime(2026, 10, 19, 3, 8, 56, tzinfo=timezone.utc)
        self.assertEqual(m.MAX_SOURCE_AGE, timedelta(hours=2))
        self.assertEqual(m.MAX_CLOCK_SKEW, timedelta(minutes=5))
        with patch.object(m, "now_utc", return_value=host_now):
            forecast, notify = payloads()
            forecast.update(computed_at="2026-10-19T03:08:57.725544211Z",
                            live_fetched_at="2026-10-19T03:08:02.68Z")
            self.assertEqual(m.parse_time(forecast["live_fetched_at"]).microsecond, 680000)
            m.validate_payloads(forecast, notify)
            for length in range(1, 10):
                forecast["live_fetched_at"] = "2026-10-19T01:08:55." + "123456789"[:length] + "Z"
                with self.subTest(stale_fraction_digits=length), self.assertRaises(ValueError):
                    m.validate_payloads(forecast, notify)

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

    def test_all_legacy_user_visible_time_labels_use_utc8_without_renaming_zone(self):
        forecast, notify = payloads()
        current = m.now_utc()
        forecast["peak_label"] = "4 AM - 7 AM"
        texts = [m.daily_summary(forecast, current), m.reset_message(notify, NEW_ID, current),
                 m.historical_window(forecast)]
        forecast["promise"] = dict(active=True, at=(current + timedelta(hours=1)).isoformat(), label="scheduled")
        texts.append(m.next_reset_text(forecast, current))
        with patch.object(m, "STATE_DIR", Path(self.tmp.name)), \
                patch.object(m, "LOCK_FILE", Path(self.tmp.name) / "monitor.lock"), \
                patch.object(m.sys, "argv", ["monitor.py", "--test-push"]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(), 0)
        texts.append(self.sender.call_args.args[0])
        for text in texts:
            self.assertIn("UTC+08:00", text)
            self.assertNotIn("北京时间", text)
        self.assertEqual(m.SHANGHAI.key, "Asia/Shanghai")

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

    def test_daily_and_reset_share_one_batch_and_watermarks(self):
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        self.assertEqual(self.batch_sender.call_count, 1)
        state = self.read_state()
        self.assertEqual(state["sentAnnouncementIds"], [NEW_ID])
        self.assertIsNotNone(state["lastSuccessfulPushAt"])
        self.assertEqual(state["daily_summary_date"], m.now_utc().astimezone(m.SHANGHAI).date().isoformat())
        self.run_monitor(send_daily=True)
        self.assertEqual(self.batch_sender.call_count, 1)

    def test_daily_does_not_repeat_after_legacy_date_already_successful(self):
        self.state.update(daily_summary_date=m.now_utc().astimezone(m.SHANGHAI).date().isoformat(),
                          last_reset_id=NEW_ID, notified_reset_ids=[NEW_ID],
                          lastSuccessfulPushAt=m.now_utc().isoformat())
        self.state_file.write_text(json.dumps(self.state))
        self.run_monitor(send_daily=True)
        self.batch_sender.assert_not_called()

    def test_retry_reuses_exact_snapshot_images_and_manifest(self):
        self.batch_sender.return_value = False
        self.assertEqual(self.run_monitor(send_daily=True), 1)
        pending = self.read_state()["pendingBatch"]
        directory = self.state_file.parent / "outbox" / pending["batchId"]
        before = {p.name: p.read_bytes() for p in directory.iterdir()}
        self.batch_sender.return_value = True
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.renderer.call_count, 1)
        self.assertEqual(before, {p.name: p.read_bytes() for p in directory.iterdir()})
        self.assertIsNone(self.read_state()["pendingBatch"])

    def test_no_send_and_dry_run_do_not_advance_pending_batch(self):
        self.batch_sender.return_value = False
        self.run_monitor(send_daily=True)
        original = self.read_state()
        self.batch_sender.reset_mock()
        self.renderer.reset_mock()
        self.run_monitor(no_send=True, manual_preview=True)
        self.assertEqual(self.read_state(), original)
        before = self.state_file.read_bytes()
        self.run_monitor(dry_run=True, manual_preview=True)
        self.assertEqual(self.state_file.read_bytes(), before)
        self.batch_sender.assert_not_called()
        self.renderer.assert_not_called()

    def test_feed_failure_or_render_failure_never_acknowledges(self):
        for fail_feed in (True, False):
            with self.subTest(fail_feed=fail_feed):
                self.state_file.write_text(json.dumps(self.state))
                data = list(payloads()) + [RuntimeError("feed unavailable")]
                if not fail_feed:
                    data = list(payloads())
                    self.renderer.side_effect = RuntimeError("render unavailable")
                self.assertEqual(self.run_monitor(data, send_daily=True), 1)
                state = self.read_state()
                self.assertEqual(state["sentAnnouncementIds"], [])
                self.assertNotIn(NEW_ID, state["notified_reset_ids"])
                self.assertIsNone(state["lastSuccessfulPushAt"])
                self.assertIsNone(state["pendingBatch"])
        self.batch_sender.assert_not_called()

    def test_feed_failure_does_not_resume_existing_batch(self):
        self.batch_sender.return_value = False
        self.run_monitor()
        pending = self.read_state()["pendingBatch"]
        self.batch_sender.reset_mock()
        self.assertEqual(self.run_monitor([*payloads(), RuntimeError("feed failed")]), 1)
        self.assertEqual(self.read_state()["pendingBatch"], pending)
        self.batch_sender.assert_not_called()

    def test_late_announcement_not_hidden_by_success_watermark(self):
        self.run_monitor()
        data = list(payloads(False))
        feed = feed_payload(data[0])
        event = dict(feed["events"][0], id="late-nonnumeric-id", kind="signal", preview=True,
                     announced_at="2026-10-15T01:00:00+00:00", summary="Late announcement",
                     source_url="https://x.com/thsottiaux/status/1234")
        feed["events"].append(event)
        self.assertEqual(self.run_monitor([*data, feed], send_daily=True), 0)
        self.assertIn(event["id"], self.read_state()["sentAnnouncementIds"])
        self.assertEqual(self.batch_sender.call_count, 2)
        # A later daily has no unseen announcements, so the empty Tibo header is omitted.
        self.state = self.read_state()
        self.state["daily_summary_date"] = "2026-10-15"
        self.state_file.write_text(json.dumps(self.state))
        self.run_monitor([*data, feed], send_daily=True)
        pending = self.batch_sender.call_args.args[0]
        manifest = json.loads((self.state_file.parent / "outbox" / pending["batchId"] / "batch.json").read_text())
        self.assertEqual([p["type"] for p in manifest["parts"]], ["text", "image", "link"])
        self.assertEqual(manifest["parts"][-1], dict(type="link", label="信息来源", url=m.SOURCE_PAGE))

    def test_boundary_is_inclusive_timezone_aware_and_does_not_use_posts(self):
        data = list(payloads(False))
        feed = feed_payload(data[0])
        feed["events"][0].update(announced_at="2026-10-15T08:00:00+08:00", cadence=False)
        feed["posts"] = [dict(id="must-not-send", text="not an event")]
        self.run_monitor([*data, feed], send_daily=True)
        self.assertEqual(self.read_state()["sentAnnouncementIds"], [NEW_ID])
        self.assertEqual(len(self.renderer.call_args.args[0]["announcements"]), 1)

    def test_all_feed_events_after_floor_not_just_first_twelve_or_cadence(self):
        data = list(payloads(False))
        feed = feed_payload(data[0])
        template = feed["events"][0]
        feed["events"] += [dict(template, id=f"nonnumeric-{i}", kind="boost" if i % 2 else "signal",
                                cadence=False, scope="not-used-as-a-filter") for i in range(25)]
        self.run_monitor([*data, feed], send_daily=True)
        self.assertEqual(len(self.read_state()["sentAnnouncementIds"]), 26)

    def test_duplicate_ids_are_deduped_but_conflicts_fail_closed(self):
        for conflicting in (False, True):
            with self.subTest(conflicting=conflicting):
                self.state_file.write_text(json.dumps(self.state))
                data = list(payloads())
                feed = feed_payload(data[0])
                duplicate = dict(feed["events"][0])
                if conflicting:
                    duplicate["summary"] = "Conflicting content"
                feed["events"].append(duplicate)
                self.assertEqual(self.run_monitor([*data, feed]), int(conflicting))
                self.assertEqual(self.read_state()["sentAnnouncementIds"], [] if conflicting else [NEW_ID])

    def test_old_history_missing_url_ok_new_missing_url_fails(self):
        data = list(payloads())
        feed = feed_payload(data[0])
        self.assertEqual(self.run_monitor([*data, feed]), 0)
        self.state_file.write_text(json.dumps(self.state))
        feed["events"][1]["announced_at"] = "2026-10-15T00:01:00Z"
        self.assertEqual(self.run_monitor([*data, feed]), 1)
        self.assertEqual(self.read_state()["sentAnnouncementIds"], [])

    def test_long_special_summary_never_falls_back_to_body(self):
        data = list(payloads())
        feed = feed_payload(data[0])
        summary = "原文\n<>&\"'\\特殊字符 😀 " + "long-text" * 2000
        feed["events"][0].update(summary=summary, body="Do not substitute")
        self.run_monitor([*data, feed])
        self.assertEqual(self.renderer.call_args.args[0]["announcements"][0]["summary"], summary)
        self.state_file.write_text(json.dumps(self.state))
        feed["events"][0]["summary"] = ""
        self.assertEqual(self.run_monitor([*data, feed]), 1)

    def test_feed_timestamp_boundaries_and_malformed_rows(self):
        data = list(payloads())
        base = feed_payload(data[0])
        for field, value in (("fetched_at", None), ("fetched_at", "2026-01-01T00:00:00Z"),
                             ("fetched_at", m.now_utc().replace(tzinfo=None).isoformat()),
                             ("fetched_at", (m.now_utc() + timedelta(minutes=6)).isoformat()),
                             ("events", []), ("events", [None])):
            with self.subTest(field=field, value=value):
                self.state_file.write_text(json.dumps(self.state))
                feed = dict(base, **{field: value})
                self.assertEqual(self.run_monitor([*data, feed]), 1)
                self.assertEqual(self.read_state()["consecutive_fetch_failures"], 19)
        self.batch_sender.assert_not_called()

    def test_snapshot_missing_probability_is_none_but_valid_source_value_is_preserved(self):
        data = list(payloads())
        data[0].update(prob_24=None, prob_48=28)
        self.run_monitor(data)
        normalized = self.renderer.call_args.args[0]["forecastCard"]
        self.assertIsNone(normalized["probability_24h"])
        self.assertEqual(normalized["probability_48h"], 0.28)
        self.assertIn(NEW_ID, self.read_state()["sentAnnouncementIds"])

    def test_card_preserves_official_probabilities_despite_ci_warning(self):
        forecast, notify = payloads()
        forecast.update(prob_24=71, range_24=[30, 60], prob_48=81, range_48=[50, 85])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            batch = m.prepare_batch(self.state, forecast, feed_payload(forecast),
                                    m.validate_feed(feed_payload(forecast)), "", None)
        snapshot = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["forecastCard"]["probability_24h"], 0.71)
        self.assertEqual(snapshot["forecastCard"]["probability_48h"], 0.81)
        self.assertEqual(snapshot["sourceWarnings"], [dict(code="source_probability_interval_mismatch",
                         field="prob_24", probability=71, interval=[30, 60])])
        self.assertIn('"probability": 71', output.getvalue())
        self.assertIn("不可用", m.forecast_probability(forecast, 24))
        self.assertEqual(forecast["prob_24"], 71)

    def test_manual_preview_real_forecast_shared_dedupe_no_fake_reset(self):
        self.assertEqual(self.run_monitor(payloads(False), manual_preview=True), 0)
        state = self.read_state()
        self.assertEqual(state["notified_reset_ids"], [OLD_ID])
        self.assertEqual(state["daily_summary_date"], "2026-10-15")
        self.assertEqual(state["sentAnnouncementIds"], [NEW_ID])
        self.assertIsNotNone(state["lastSuccessfulPushAt"])
        self.run_monitor(payloads(False))
        self.assertEqual(self.batch_sender.call_count, 1)

    def test_manual_preview_retry_does_not_send_second_preview(self):
        self.batch_sender.return_value = False
        self.run_monitor(payloads(False), manual_preview=True)
        self.batch_sender.return_value = True
        self.run_monitor(payloads(False), manual_preview=True)
        self.assertEqual(self.batch_sender.call_count, 2)
        self.assertEqual(self.renderer.call_count, 1)

    def test_migration_uses_evidence_not_old_notified_or_daily_date(self):
        self.state["version"] = 1
        self.state_file.write_text(json.dumps(self.state))
        evidence = dict(lowerBound="2026-10-19T00:00:08Z", observedSuccessAt="2026-10-19T00:00:12.133779Z",
                        source="system-journal-success", uncertainty="service-start-inclusive")
        with patch.object(m, "legacy_delivery_evidence", return_value=evidence):
            self.run_monitor(payloads(False))
        state = self.read_state()
        self.assertEqual(state["migrationLowerBound"], evidence["lowerBound"])
        self.assertEqual(state["sentAnnouncementIds"], [])
        self.assertIsNone(state["lastSuccessfulPushAt"])
        self.assertIsNone(state["announcementWatermark"])
        self.batch_sender.assert_not_called()

    def test_migration_no_evidence_never_defaults_to_entire_history(self):
        self.state["version"] = 1
        self.state_file.write_text(json.dumps(self.state))
        with patch.object(m, "legacy_delivery_evidence", side_effect=RuntimeError("no evidence")):
            self.assertEqual(self.run_monitor(send_daily=True), 1)
        self.batch_sender.assert_not_called()
        self.assertEqual(self.read_state()["version"], 1)

    def test_journal_only_accepts_correct_unit_and_real_c2c_success(self):
        stamp = int(datetime(2026, 10, 19, tzinfo=timezone.utc).timestamp() * 1000000)
        rows = [dict(__REALTIME_TIMESTAMP=str(stamp), _SYSTEMD_USER_UNIT="codex-reset-summary.service",
                     MESSAGE="daily summary sent date=2026-10-19 target=" + FAKE_ADMIN),
                dict(__REALTIME_TIMESTAMP=str(stamp + 1000000), _SYSTEMD_USER_UNIT="other.service",
                     MESSAGE="daily summary sent date=2026-10-19 target=" + FAKE_ADMIN),
                dict(__REALTIME_TIMESTAMP=str(stamp + 2000000), _SYSTEMD_USER_UNIT="codex-reset-monitor.service",
                     MESSAGE="baseline established id=123"),
                dict(__REALTIME_TIMESTAMP=str(stamp + 3000000), _SYSTEMD_USER_UNIT="codex-reset-summary.service",
                     MESSAGE="daily summary sent date=2026-10-19 target=qqbot:group:wrong")]
        with patch.object(m, "administrator_target", return_value=FAKE_ADMIN), \
                patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0,
                          "\n".join(json.dumps(r) for r in rows), "")) as run, \
                patch.object(m, "legacy_service_start", return_value=datetime(2026, 10, 18, 23, 59, 56,
                                                                              tzinfo=timezone.utc)):
            evidence = m.legacy_delivery_evidence()
        self.assertEqual(evidence["observedSuccessAt"], "2026-10-19T00:00:00+00:00")
        self.assertEqual(run.call_count, 2)
        for call, unit in zip(run.call_args_list, ("codex-reset-summary.service", "codex-reset-monitor.service")):
            command = call.args[0]
            self.assertIn("_SYSTEMD_USER_UNIT=" + unit, command)
            self.assertEqual(command[command.index("-n") + 1], "100")
            self.assertIn("--output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,MESSAGE", command)
            self.assertNotIn("--user", command)
            self.assertFalse(any(argument.startswith("--grep") for argument in command))

    def test_separate_journal_tails_preserve_daily_and_choose_latest_success(self):
        current = m.now_utc()
        daily = current - timedelta(hours=1)
        reset = current - timedelta(minutes=30)
        def row(stamp, unit, message):
            return json.dumps(dict(__REALTIME_TIMESTAMP=str(int(stamp.timestamp() * 1000000)),
                                   _SYSTEMD_USER_UNIT=unit, MESSAGE=message))
        daily_rows = row(daily, "codex-reset-summary.service",
                         "daily summary sent date=" + daily.astimezone(m.SHANGHAI).date().isoformat()
                         + " target=" + FAKE_ADMIN)
        reset_rows = row(reset, "codex-reset-monitor.service", "reset notification sent id=123 target=" + FAKE_ADMIN)
        for reset_sent in (False, True):
            busy_monitor = "\n".join(row(current, "codex-reset-monitor.service", "fetch ok") for _ in range(99))
            monitor_rows = busy_monitor + "\n" + (reset_rows if reset_sent else "")
            with self.subTest(reset_sent=reset_sent), \
                    patch.object(m, "administrator_target", return_value=FAKE_ADMIN), \
                    patch.object(m, "legacy_service_start", return_value=None), \
                    patch.object(m.subprocess, "run", side_effect=[
                        subprocess.CompletedProcess([], 0, daily_rows, ""),
                        subprocess.CompletedProcess([], 0, monitor_rows, "")]):
                evidence = m.legacy_delivery_evidence()
            expected = reset if reset_sent else daily
            self.assertEqual(m.parse_time(evidence["observedSuccessAt"]), expected)

    def test_journal_unit_query_failure_or_only_wrong_targets_blocks_migration(self):
        valid = json.dumps(dict(__REALTIME_TIMESTAMP=str(int(m.now_utc().timestamp() * 1000000)),
                                _SYSTEMD_USER_UNIT="codex-reset-summary.service",
                                MESSAGE="daily summary sent date=2026-10-19 target=" + FAKE_ADMIN))
        for monitor_code, daily_rows in ((1, valid), (0, valid.replace(FAKE_ADMIN, "qqbot:c2c:another-person"))):
            with self.subTest(monitor_code=monitor_code), \
                    patch.object(m, "administrator_target", return_value=FAKE_ADMIN), \
                    patch.object(m, "legacy_service_start") as start, \
                    patch.object(m.subprocess, "run", side_effect=[
                        subprocess.CompletedProcess([], 0, daily_rows, ""),
                        subprocess.CompletedProcess([], monitor_code, "", "")]):
                with self.assertRaises(RuntimeError):
                    m.legacy_delivery_evidence()
                start.assert_not_called()

    def test_forecast_updated_at_uses_computation_not_fetch_time(self):
        forecast, _ = payloads()
        forecast["computed_at"] = "2026-10-19T00:01:00Z"
        forecast["live_fetched_at"] = "2026-10-19T00:02:00Z"
        self.assertEqual(m.forecast_card_data(forecast)["updated_at"], forecast["computed_at"])

    def test_dynamic_administrator_matches_sender_no_fallback(self):
        config_file = Path(self.tmp.name) / "openclaw.json"
        channel = dict(appId="fake-app", clientSecret="fake-test-only", enabled=True,
                       customRuntime=dict(admins=["", "qqbot:c2c:first", "second"], adminGroup="group"))
        config_file.write_text(json.dumps(dict(channels=dict(qqbot=channel))))
        with patch.object(m, "OPENCLAW_CONFIG", config_file):
            self.assertEqual(m.administrator_target(), "qqbot:c2c:first")
            channel["customRuntime"]["admins"] = ["qqbot:group:blocked", "valid-second-admin"]
            config_file.write_text(json.dumps(dict(channels=dict(qqbot=channel))))
            with self.assertRaises(RuntimeError) as error:
                m.administrator_target()
            self.assertNotIn("fake-test-only", str(error.exception))
            self.assertNotIn("blocked", str(error.exception))

    def test_lock_serializes_daily_and_reset_before_any_fetch(self):
        lock_file = Path(self.tmp.name) / "monitor.lock"
        with lock_file.open("a+") as lock:
            m.fcntl.flock(lock, m.fcntl.LOCK_EX | m.fcntl.LOCK_NB)
            with patch.object(m, "STATE_DIR", Path(self.tmp.name)), patch.object(m, "LOCK_FILE", lock_file), \
                    patch.object(m.sys, "argv", ["monitor.py", "--daily-summary"]), \
                    patch.object(m, "fetch_json") as fetch, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 0)
                fetch.assert_not_called()

    def test_service_timeout_covers_maximum_two_batches(self):
        required = 3 * (25 * 2 + 2) + m.RENDER_TIMEOUT + 2 * m.SEND_TIMEOUT + 40
        self.assertLess(required, 30 * 60)
        for name in ("codex-reset-monitor.service", "codex-reset-summary.service"):
            self.assertIn("TimeoutStartSec=30min", Path(__file__).with_name(name).read_text())

    def make_pending(self):
        self.batch_sender.return_value = False
        self.run_monitor(send_daily=True)
        self.batch_push.stop()
        batch = self.read_state()["pendingBatch"]
        directory = self.state_file.parent / "outbox" / batch["batchId"]
        manifest = json.loads((directory / "batch.json").read_text())
        return batch, directory, manifest

    def receipt_sender(self, batch, directory, manifest, status="complete", code=0, timeout=False):
        def send(*args, **kwargs):
            message = dict(status="sent" if status == "complete" else "inflight" if status == "blocked" else "failed")
            if status == "complete":
                message["receiptSha256"] = hashlib.sha256(b"mock-real-qq-message-id").hexdigest()
            receipt = dict(version=2, batchId=batch["batchId"], delivery="single_markdown",
                           manifestSha256=batch["manifestSha256"], ok=status == "complete", status=status,
                           message=message)
            m.atomic_write_json(directory / "batch.receipt.json", receipt)
            if timeout:
                raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])
            return subprocess.CompletedProcess(args[0], code, json.dumps(receipt), "")
        return send

    def test_receipt_complete_required_not_stdout_or_exit_zero(self):
        batch, directory, manifest = self.make_pending()
        with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"ok":true}', "")):
            with self.assertRaises(RuntimeError):
                m.deliver_batch(batch)
        for status in ("partial", "blocked", "dry_run"):
            (directory / "batch.receipt.json").unlink(missing_ok=True)
            with self.subTest(status=status), patch.object(m.subprocess, "run",
                    side_effect=self.receipt_sender(batch, directory, manifest, status=status)):
                self.assertFalse(m.deliver_batch(batch))

    def test_receipt_complete_plus_zero_exit_is_success(self):
        batch, directory, manifest = self.make_pending()
        with patch.object(m.subprocess, "run", side_effect=self.receipt_sender(batch, directory, manifest)) as run:
            self.assertTrue(m.deliver_batch(batch))
        self.assertEqual(run.call_args.kwargs["timeout"], 600)
        self.assertIn("--manifest", run.call_args.args[0])
        self.assertIn("--receipt", run.call_args.args[0])

    def test_nonzero_or_timeout_never_commits_even_if_receipt_claims_complete(self):
        batch, directory, manifest = self.make_pending()
        for code, timeout in ((1, False), (0, True)):
            with self.subTest(code=code, timeout=timeout), patch.object(m.subprocess, "run",
                    side_effect=self.receipt_sender(batch, directory, manifest, code=code, timeout=timeout)):
                self.assertEqual(self.run_monitor(send_daily=True), 1)
                state = self.read_state()
                self.assertEqual(state["pendingBatch"]["batchId"], batch["batchId"])
                self.assertEqual(state["sentAnnouncementIds"], [])
                self.assertIsNone(state["lastSuccessfulPushAt"])

    def test_receipt_wrong_binding_missing_message_or_id_proof_fails_closed(self):
        batch, directory, manifest = self.make_pending()
        sender = self.receipt_sender(batch, directory, manifest)
        for mutation in (dict(batchId="other"), dict(message={}), dict(message=dict(status="sent")),
                         dict(manifestSha256="0" * 64), dict(delivery="segmented"), dict(version=1)):
            def send(*args, **kwargs):
                result = sender(*args, **kwargs)
                receipt = json.loads((directory / "batch.receipt.json").read_text())
                receipt.update(mutation)
                m.atomic_write_json(directory / "batch.receipt.json", receipt)
                return result
            with self.subTest(mutation=mutation), patch.object(m.subprocess, "run", side_effect=send):
                self.assertFalse(m.deliver_batch(batch))

    def test_v2_manifest_keeps_layout_order_strict_image_schema_without_timezone_footer(self):
        batch, directory, manifest = self.make_pending()
        self.assertEqual(manifest["version"], 2)
        self.assertEqual(manifest["delivery"], "single_markdown")
        self.assertEqual(batch["manifestVersion"], 2)
        self.assertEqual(batch["manifestSha256"], m.digest_json(manifest))
        self.assertEqual(manifest["parts"][0], dict(type="text", text="Codex会重置吗？"))
        self.assertEqual([part for part in manifest["parts"] if part["type"] == "link"], [
            dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
            dict(type="link", label="查看𝕏", url=f"https://x.com/source/status/{NEW_ID}"),
        ])
        self.assertEqual(manifest["parts"][-1]["label"], "查看𝕏")
        for part in manifest["parts"]:
            if part["type"] == "image":
                self.assertEqual(set(part), {"type", "path"})
                self.assertEqual(batch["imageHashes"][part["path"]],
                                 hashlib.sha256((directory / part["path"]).read_bytes()).hexdigest())
        self.assertEqual(manifest["parts"][1],
                         dict(type="text", text="常规重置（regular）｜已到账"))
        self.assertIn(dict(type="text", text="\n\nTibo宣布了什么"), manifest["parts"])

    def test_new_batches_with_zero_or_multiple_announcements_have_no_timezone_footer(self):
        forecast, _ = payloads(False)
        feed = feed_payload(forecast)
        first = feed["events"][0]
        second = dict(first, id=OLD_ID, source_url=f"https://x.com/source/status/{OLD_ID}")
        for events in ([], [first, second]):
            with self.subTest(count=len(events)):
                batch = m.prepare_batch(self.state, forecast, feed, events, "", None)
                directory = self.state_file.parent / "outbox" / batch["batchId"]
                manifest = json.loads((directory / "batch.json").read_text())
                expected = [dict(type="text", text="Codex会重置吗？"),
                            dict(type="image", path="forecast.png"),
                            dict(type="link", label="信息来源", url=m.SOURCE_PAGE)]
                if events:
                    expected.append(dict(type="text", text="\n\nTibo宣布了什么"))
                for i, event in enumerate(events):
                    expected.extend([dict(type="image", path=f"announcement-{i:04d}.png"),
                                     dict(type="link", label="查看𝕏", url=event["source_url"])])
                self.assertEqual(manifest["delivery"], "single_markdown")
                self.assertEqual(manifest["parts"], expected)

    def test_historical_layout_helper_uses_new_links_without_mutating_business_state(self):
        spec = importlib.util.spec_from_file_location(
            "layout_preview", Path(__file__).with_name("prepare_layout_preview.py"))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        forecast, notify = payloads(False)
        feed = feed_payload(forecast)
        first = feed["events"][0]
        preview = dict(first, id=OLD_ID, kind="reset_preview", preview=True,
                       source_url=f"https://x.com/source/status/{OLD_ID}")
        feed["events"].append(preview)
        output = self.state_file.parent / "state" / "layout-preview"
        before = self.state_file.read_bytes()
        with patch.object(helper.importlib.util, "spec_from_file_location"), \
                patch.object(helper.importlib.util, "module_from_spec", return_value=m), \
                patch.object(m, "fetch_json", side_effect=[forecast, notify, feed]), \
                patch("sys.argv", ["prepare_layout_preview.py", "--output-root", str(output)]), \
                contextlib.redirect_stdout(io.StringIO()):
            helper.main()
        manifests = list(output.glob("*/batch.json"))
        self.assertEqual(len(manifests), 1)
        manifest = json.loads(manifests[0].read_text())
        self.assertEqual(manifest["version"], 2)
        self.assertEqual(manifest["delivery"], "single_markdown")
        self.assertEqual(manifest["parts"], [
            dict(type="text", text="Codex会重置吗？"),
            dict(type="image", path="forecast.png"),
            dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
            dict(type="text", text="\n\n历史排版示例（非今日确认）\nTibo宣布了什么"),
            dict(type="image", path="announcement-0000.png"),
            dict(type="link", label="查看𝕏", url=first["source_url"]),
            dict(type="image", path="announcement-0001.png"),
            dict(type="link", label="查看𝕏", url=preview["source_url"]),
        ])
        self.assertEqual(self.state_file.read_bytes(), before)
        self.assertFalse(self.state_file.parent.joinpath("outbox").exists())
        self.assertFalse(list(output.glob("*/batch.receipt.json")))
        self.sender.assert_not_called()
        self.batch_sender.assert_not_called()

    def test_frozen_pending_with_old_labels_and_timezone_footer_is_not_rewritten(self):
        batch, directory, manifest = self.make_pending()
        for part in manifest["parts"]:
            if part.get("label") == "查看𝕏":
                part["label"] = "原始公告"
        manifest["parts"].append(dict(type="link", label="UTC+08:00", url=m.TIMEZONE_URL))
        m.atomic_write_json(directory / "batch.json", manifest)
        batch["manifestSha256"] = m.digest_json(manifest)
        state = self.read_state()
        state["pendingBatch"] = batch
        m.atomic_write_json(self.state_file, state)
        before = {path.name: path.read_bytes() for path in directory.iterdir()}
        with patch.object(m.subprocess, "run", side_effect=self.receipt_sender(batch, directory, manifest)) as send:
            self.assertEqual(self.run_monitor(), 0)
        send.assert_called_once()
        self.assertEqual(self.renderer.call_count, 1)
        for name, content in before.items():
            self.assertEqual((directory / name).read_bytes(), content)
        self.assertIsNone(self.read_state()["pendingBatch"])

    def test_old_v1_batches_are_never_resumed_even_with_complete_receipt(self):
        batch, directory, manifest = self.make_pending()
        manifest["version"] = 1
        del manifest["delivery"]
        m.atomic_write_json(directory / "batch.json", manifest)
        batch["manifestSha256"] = m.digest_json(manifest)
        for status in ("partial", "complete"):
            receipt = dict(version=1, batchId=batch["batchId"], ok=status == "complete", status=status,
                           parts=[dict(partIndex=0, status="sent")])
            path = directory / "batch.receipt.json"
            m.atomic_write_json(path, receipt)
            original = path.read_bytes()
            with self.subTest(status=status), patch.object(m.subprocess, "run") as sender:
                with self.assertRaisesRegex(ValueError, "legacy segmented batch"):
                    m.deliver_batch(batch)
                sender.assert_not_called()
                self.assertEqual(path.read_bytes(), original)

    def test_v2_batch_rejects_v1_receipt_without_invoking_sender(self):
        batch, directory, manifest = self.make_pending()
        path = directory / "batch.receipt.json"
        m.atomic_write_json(path, dict(version=1, status="partial", batchId=batch["batchId"]))
        before = path.read_bytes()
        with patch.object(m.subprocess, "run") as sender:
            with self.assertRaisesRegex(ValueError, "legacy receipt"):
                m.deliver_batch(batch)
            sender.assert_not_called()
        self.assertEqual(path.read_bytes(), before)

    def test_v2_unknown_or_inflight_receipt_blocks_before_invoking_sender(self):
        batch, directory, manifest = self.make_pending()
        path = directory / "batch.receipt.json"
        for status in ("unknown", "inflight"):
            m.atomic_write_json(path, dict(version=2, batchId=batch["batchId"],
                                           message=dict(status=status)))
            before = path.read_bytes()
            with self.subTest(status=status), patch.object(m.subprocess, "run") as sender:
                self.assertFalse(m.deliver_batch(batch))
                sender.assert_not_called()
            self.assertEqual(path.read_bytes(), before)

    def test_new_v2_preview_preserves_complete_v1_history_and_success_until_complete(self):
        prior_success = "2026-10-19T03:23:54.493778Z"
        self.state.update(lastSuccessfulPushAt=prior_success, sentAnnouncementIds=[NEW_ID])
        self.state_file.write_text(json.dumps(self.state))
        history = self.state_file.parent / "old-v1.receipt.json"
        history.write_text(json.dumps(dict(version=1, ok=True, status="complete")))
        original = history.read_bytes()
        self.batch_sender.return_value = False
        self.run_monitor(payloads(False), manual_preview=True)
        state = self.read_state()
        self.assertEqual(state["lastSuccessfulPushAt"], prior_success)
        self.assertEqual(state["sentAnnouncementIds"], [NEW_ID])
        self.assertEqual(state["notified_reset_ids"], [OLD_ID])
        self.assertEqual(state["pendingBatch"]["manifestVersion"], 2)
        self.assertEqual(history.read_bytes(), original)

    def test_tampered_outbox_never_calls_sender_or_rerenders(self):
        batch, directory, manifest = self.make_pending()
        for name in ("forecast.png", "snapshot.json", "batch.json"):
            path = directory / name
            original = path.read_bytes()
            path.write_bytes(b"corrupt")
            with self.subTest(name=name), patch.object(m.subprocess, "run") as send:
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    m.deliver_batch(batch)
                send.assert_not_called()
            path.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
