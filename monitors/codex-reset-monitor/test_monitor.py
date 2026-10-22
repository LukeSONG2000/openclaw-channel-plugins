import contextlib
import configparser
import copy
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import call, patch
import source_fetch


SPEC = importlib.util.spec_from_file_location("reset_monitor", Path(__file__).with_name("monitor.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
# Legacy fixtures exercise the unchanged transaction/phase contracts offline only.
m.FORECAST_URL = "https://legacy.invalid/api/forecast"
m.NOTIFY_URL = "https://legacy.invalid/api/notify"
m.FEED_URL = "https://legacy.invalid/api/feed"
OLD_ID = "2110618732666257557"
NEW_ID = "2110618732666257558"
HISTORICAL_ID = "2108040921044639779"
FAKE_ADMIN = "qqbot:c2c:test-admin"


def legacy_fixture_source():
    return (m.fetch_json(m.FORECAST_URL), m.fetch_json(m.NOTIFY_URL), m.fetch_json(m.FEED_URL))


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
        legacy = patch.object(m, "fetch_source_data", side_effect=legacy_fixture_source)
        legacy.start()
        self.addCleanup(legacy.stop)
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
        titles = {("regular", "preview"): "Codex确认重置！",
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

    def test_all_phase_and_daily_titles_are_h1_with_stage_then_source_before_image(self):
        forecast, _ = payloads()
        feed = feed_payload(forecast)
        events = m.validate_feed(feed)
        for (reset_type, phase), title in m.PHASE_TITLES.items():
            event = dict(eventId=NEW_ID, resetType=reset_type, phase=phase,
                         announcedAt="2026-10-19T03:00:00Z")
            for daily in (None, "2026-10-19"):
                with self.subTest(reset_type=reset_type, phase=phase, daily=daily):
                    batch = m.prepare_batch(self.state, forecast, feed, events, "", daily,
                                            phase_events=[event])
                    directory = self.state_file.parent / "outbox" / batch["batchId"]
                    parts = json.loads((directory / "batch.json").read_text())["parts"]
                    self.assertEqual(parts[:5], [
                        dict(type="heading", level=1, text="Codex会重置吗？" if daily else title),
                        dict(type="text", text=m.PHASE_DETAILS[(reset_type, phase)]),
                        dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
                        dict(type="image", path="forecast.png"),
                        dict(type="heading", level=1, text="Tibo宣布了什么"),
                    ])
        self.assertEqual(self.state_file.read_bytes(), self.original)
        self.sender.assert_not_called()
        self.batch_sender.assert_not_called()

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
        self.assertEqual(snapshot["title"], "Codex确认重置！")
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
        self.assertIs(m.fetch_json, source_fetch.fetch_json)
        result = subprocess.CompletedProcess([], 0, b'{"ok": true}\nSOURCE_FETCH_HTTP:200', b"")
        with patch.object(m.subprocess, "run", return_value=result) as run:
            self.assertEqual(m.fetch_json(m.provider.ENDPOINT), {"ok": True})
        args, kwargs = run.call_args
        self.assertIn("--ipv4", args[0])
        self.assertIn("=https", args[0])
        self.assertEqual(args[0][-1], m.provider.ENDPOINT)
        self.assertEqual(kwargs["timeout"], 25)
        self.assertNotIn("shell", kwargs)

    def test_fetch_retries_only_transient_errors_without_leaking_stderr(self):
        for response, attempts in ((subprocess.CompletedProcess([], 28, b"", b"proxy secret"), 3),
                         (subprocess.CompletedProcess([], 0, b"[]\nSOURCE_FETCH_HTTP:200", b""), 1),
                         (subprocess.CompletedProcess([], 0, b"bad json\nSOURCE_FETCH_HTTP:200", b""), 1)):
            with self.subTest(returncode=response.returncode, stdout=response.stdout), \
                    patch.object(m.subprocess, "run", return_value=response) as run, \
                    patch.object(source_fetch.time, "sleep"):
                with self.assertRaises(RuntimeError) as error:
                    m.fetch_json(m.provider.ENDPOINT)
                self.assertNotIn("proxy secret", str(error.exception))
                self.assertEqual(run.call_count, attempts)

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
        self.assertEqual([p["type"] for p in manifest["parts"]], ["heading", "link", "image"])
        self.assertEqual(manifest["parts"][1], dict(type="link", label="信息来源", url=m.SOURCE_PAGE))

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

    def test_missing_receipt_exposes_only_safe_sender_error_code(self):
        batch, directory, manifest = self.make_pending()
        for code, expected in (("group_unverified", "group_unverified"),
                               ("https://secret.invalid/token", "unknown")):
            response = subprocess.CompletedProcess([], 4, json.dumps(dict(errorCode=code)), "secret stderr")
            with self.subTest(code=code), patch.object(m.subprocess, "run", return_value=response):
                with self.assertRaises(RuntimeError) as caught:
                    m.deliver_batch(batch)
                self.assertIn("exit=4 code=" + expected, str(caught.exception))
                self.assertNotIn("secret", str(caught.exception))

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
        self.assertEqual(manifest["parts"][0], dict(type="heading", level=1, text="Codex会重置吗？"))
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
        self.assertEqual(manifest["parts"][2:5], [
            dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
            dict(type="image", path="forecast.png"),
            dict(type="heading", level=1, text="Tibo宣布了什么"),
        ])

    def test_new_batches_with_zero_one_or_multiple_announcements_have_no_timezone_footer(self):
        forecast, _ = payloads(False)
        feed = feed_payload(forecast)
        first = feed["events"][0]
        second = dict(first, id=OLD_ID, source_url=f"https://x.com/source/status/{OLD_ID}")
        for events in ([], [first], [first, second]):
            with self.subTest(count=len(events)):
                batch = m.prepare_batch(self.state, forecast, feed, events, "", None)
                directory = self.state_file.parent / "outbox" / batch["batchId"]
                manifest = json.loads((directory / "batch.json").read_text())
                expected = [dict(type="heading", level=1, text="Codex会重置吗？"),
                            dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
                            dict(type="image", path="forecast.png")]
                if events:
                    expected.append(dict(type="heading", level=1, text="Tibo宣布了什么"))
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
            dict(type="heading", level=1, text="Codex会重置吗？"),
            dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
            dict(type="image", path="forecast.png"),
            dict(type="heading", level=1, text="Tibo宣布了什么"),
            dict(type="image", path="announcement-0000.png"),
            dict(type="link", label="查看𝕏", url=first["source_url"]),
            dict(type="image", path="announcement-0001.png"),
            dict(type="link", label="查看𝕏", url=preview["source_url"]),
        ])
        snapshot = json.loads(manifests[0].with_name("snapshot.json").read_text())
        report = json.loads(manifests[0].with_name("preparation.json").read_text())
        self.assertEqual(snapshot["purpose"], "historical-layout-example-not-today")
        self.assertFalse(snapshot["businessStateMutation"])
        self.assertEqual([event["id"] for event in report["history"]], [NEW_ID, OLD_ID])
        self.assertTrue(report["businessStateUnchanged"])
        self.assertEqual(report["messagesSent"], 0)
        self.assertEqual(self.state_file.read_bytes(), before)
        self.assertFalse(self.state_file.parent.joinpath("outbox").exists())
        self.assertFalse(list(output.glob("*/batch.receipt.json")))
        self.sender.assert_not_called()
        self.batch_sender.assert_not_called()

    def sample_payloads(self):
        forecast, notify = payloads(False)
        feed = feed_payload(forecast)
        feed["events"].append(dict(feed["events"][0], id=OLD_ID, kind="reset_preview", preview=True,
                                   source_url=f"https://x.com/source/status/{OLD_ID}"))
        return [forecast, notify, feed]

    def test_dd_private_sample_has_three_images_and_visible_history_notice_without_business_state(self):
        with patch.object(m.sys, "argv", ["monitor.py", "--channel", "dd", "--prepare-private-test"]), \
                patch.object(m, "fetch_json", side_effect=self.sample_payloads()), \
                patch.object(m, "load_state") as load, patch.object(m, "migrate_delivery_state") as migrate, \
                patch.object(m, "establish_baseline") as baseline, patch.object(m, "complete_batch") as complete, \
                patch.object(m.fcntl, "flock") as lock, contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(m.main(), 0)
        report = json.loads(stdout.getvalue())
        directory = Path(report["manifestPath"]).parent
        self.assertEqual(directory.parent, self.state_file.parent / "dingtalk" / "layout-preview")
        manifest = json.loads(Path(report["manifestPath"]).read_text())
        snapshot = json.loads((directory / "snapshot.json").read_text())
        self.assertEqual(manifest["version"], 2)
        self.assertEqual(manifest["delivery"], "single_markdown")
        self.assertEqual(manifest["parts"][0], dict(type="heading", level=1, text="Codex会重置吗？"))
        self.assertEqual(manifest["parts"][1], dict(type="link", label="信息来源", url=m.SOURCE_PAGE))
        images = [part for part in manifest["parts"] if part["type"] == "image"]
        self.assertEqual(len(images), 3)
        self.assertTrue(all((directory / part["path"]).is_file() for part in images))
        self.assertTrue(all(set(part) == {"type", "path"} for part in images))
        self.assertEqual(report["channel"], "dingtalk")
        self.assertEqual(manifest["parts"], [
            dict(type="heading", level=1, text="Codex会重置吗？"),
            dict(type="link", label="信息来源", url=m.SOURCE_PAGE),
            dict(type="image", path="forecast.png"),
            dict(type="heading", level=1, text="Tibo宣布了什么"),
            dict(type="text", text="以下为历史公告，用于排版测试，非今日重置确认"),
            dict(type="image", path="announcement-0000.png"),
            dict(type="link", label="查看𝕏", url=f"https://x.com/source/status/{NEW_ID}"),
            dict(type="image", path="announcement-0001.png"),
            dict(type="link", label="查看𝕏", url=f"https://x.com/source/status/{OLD_ID}"),
        ])
        self.assertEqual([event["id"] for event in report["history"]], [NEW_ID, OLD_ID])
        self.assertEqual(report["announcementIds"], [NEW_ID, OLD_ID])
        self.assertEqual(report["messagesSent"], 0)
        self.assertTrue(report["sampleOnly"])
        self.assertFalse(report["businessStateMutation"])
        self.assertEqual(snapshot["purpose"], "private-test-current-forecast-with-history")
        self.assertEqual(snapshot["historicalNotice"], "以下为历史公告，用于排版测试，非今日重置确认")
        self.assertEqual(len(snapshot["announcements"]), 2)
        self.assertIsNotNone(snapshot["feedFetchedAt"])
        self.assertIsNone(snapshot["resetId"])
        self.assertIsNone(snapshot["dailyDate"])
        self.assertFalse(Path(report["receiptPath"]).exists())
        self.assertFalse((self.state_file.parent / "dingtalk" / "state.json").exists())
        self.assertFalse((self.state_file.parent / "outbox").exists())
        self.assertEqual(self.state_file.read_bytes(), self.original)
        for mock in (load, migrate, baseline, complete, lock, self.sender, self.batch_sender):
            mock.assert_not_called()

    def test_dd_sample_cannot_be_completed_into_business_success(self):
        with patch.object(m, "fetch_json", side_effect=self.sample_payloads()):
            report = m.prepare_dingtalk_sample()
        state = dict(self.state)
        with self.assertRaisesRegex(ValueError, "cannot acknowledge business delivery"):
            m.complete_batch(state, report)
        self.assertEqual(state, self.state)
        self.assertEqual(self.state_file.read_bytes(), self.original)

    def test_dd_sample_stdout_is_json_even_when_source_probability_warns(self):
        data = self.sample_payloads()
        data[0]["prob_24"] = 71
        with patch.object(m.sys, "argv", ["monitor.py", "--channel", "dd", "--prepare-private-test"]), \
                patch.object(m, "fetch_json", side_effect=data), contextlib.redirect_stdout(io.StringIO()) as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(m.main(), 0)
        self.assertEqual(json.loads(stdout.getvalue())["messagesSent"], 0)
        self.assertIn("source probability warning", stderr.getvalue())

    def test_dd_sample_fetches_current_forecast_and_two_historical_announcements(self):
        with patch.object(m, "fetch_json", side_effect=self.sample_payloads()) as fetch:
            report = m.prepare_dingtalk_sample()
        self.assertEqual(fetch.call_args_list, [call(m.FORECAST_URL), call(m.NOTIFY_URL), call(m.FEED_URL)])
        self.assertEqual(len(report["history"]), 2)
        self.assertEqual(len(report["imageHashes"]), 3)
        self.sender.assert_not_called()

    def test_dd_sample_missing_or_today_history_fails_before_creating_files(self):
        for missing in (True, False):
            data = self.sample_payloads()
            if missing:
                data[2]["events"] = data[2]["events"][:-1]
            else:
                for event in data[2]["events"]:
                    event["announced_at"] = m.now_utc().isoformat()
            with self.subTest(missing=missing), patch.object(m, "fetch_json", side_effect=data), \
                    self.assertRaisesRegex(RuntimeError, "historical reset/preview pair"):
                m.prepare_dingtalk_sample()
            self.assertFalse((self.state_file.parent / "dingtalk").exists())
        self.renderer.assert_not_called()

    def test_qq_batch_does_not_gain_dd_private_history_notice(self):
        forecast, _, feed = self.sample_payloads()
        batch = m.prepare_batch(self.state, forecast, feed, m.validate_feed(feed), "", None)
        directory = self.state_file.parent / "outbox" / batch["batchId"]
        manifest = json.loads((directory / "batch.json").read_text())
        self.assertTrue(any(part.get("text") == "Tibo宣布了什么" for part in manifest["parts"]))
        self.assertFalse(any("历史公告" in part.get("text", "") for part in manifest["parts"]))
        self.assertNotIn("historicalNotice", json.loads((directory / "snapshot.json").read_text()))

    def test_dd_sample_stale_forecast_fails_before_creating_files(self):
        data = self.sample_payloads()
        data[0]["computed_at"] = (m.now_utc() - timedelta(hours=3)).isoformat()
        with patch.object(m, "fetch_json", side_effect=data), self.assertRaises(ValueError):
            m.prepare_dingtalk_sample()
        self.assertFalse((self.state_file.parent / "dingtalk").exists())
        self.renderer.assert_not_called()

    def test_dd_sample_render_failure_preserves_business_state_and_has_no_receipt(self):
        self.renderer.side_effect = RuntimeError("render failed")
        with patch.object(m.sys, "argv", ["monitor.py", "--channel", "dd", "--prepare-private-test"]), \
                patch.object(m, "fetch_json", side_effect=self.sample_payloads()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(m.main(), 1)
        output = self.state_file.parent / "dingtalk" / "layout-preview"
        self.assertEqual(len(list(output.glob("*/snapshot.json"))), 1)
        self.assertFalse(list(output.glob("*/batch.receipt.json")))
        self.assertFalse(list(output.glob("*/preparation.json")))
        self.assertEqual(self.state_file.read_bytes(), self.original)
        self.sender.assert_not_called()
        self.batch_sender.assert_not_called()

    def test_prepare_private_test_rejects_qq_or_combined_modes_before_any_io(self):
        for channel in ([], ["--channel", "qq"], ["--channel", "dd", "--dry-run"],
                        ["--channel", "dd", "--no-send"], ["--channel", "dd", "--test-push"],
                        ["--channel", "dd", "--baseline-only"], ["--channel", "dd", "--daily-summary"],
                        ["--channel", "dd", "--manual-preview"]):
            with self.subTest(channel=channel), \
                    patch.object(m.sys, "argv", ["monitor.py", *channel, "--prepare-private-test"]), \
                    patch.object(m, "fetch_json") as fetch, patch.object(m, "load_state") as load, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                m.main()
            self.assertEqual(error.exception.code, 2)
            fetch.assert_not_called()
            load.assert_not_called()

    def test_frozen_pending_with_old_labels_and_timezone_footer_is_not_rewritten(self):
        batch, directory, manifest = self.make_pending()
        for part in manifest["parts"]:
            if part["type"] == "heading":
                part["type"] = "text"
                del part["level"]
                if part["text"] == "Tibo宣布了什么":
                    part["text"] = "\n\n历史排版示例（非今日确认）\nTibo宣布了什么"
            if part.get("label") == "查看𝕏":
                part["label"] = "原始公告"
        source = next(part for part in manifest["parts"] if part.get("label") == "信息来源")
        manifest["parts"].remove(source)
        manifest["parts"].insert(3, source)
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


class ChannelIsolationTests(unittest.TestCase):
    def setUp(self):
        legacy = patch.object(m, "fetch_source_data", side_effect=legacy_fixture_source)
        legacy.start()
        self.addCleanup(legacy.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "state"
        self.root.mkdir()
        self.qq_state = self.root / "state.json"
        self.dd_state = self.root / "dingtalk" / "state.json"
        self.qq_lock = self.root / "monitor.lock"
        self.qq_state.write_text(json.dumps(dict(
            version=1, initialized_at="2026-07-01T00:00:00Z",
            daily_summary_date="2026-10-19", notified_reset_ids=[OLD_ID],
            pendingBatch={"batchId": "existing-qq-pending"},
            consecutive_fetch_failures=9, lastSuccessfulPushAt="2026-10-19T00:00:00Z")))
        self.original = self.qq_state.read_bytes()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(m, "STATE_FILE", self.qq_state))
        stack.enter_context(patch.object(m, "STATE_DIR", self.root))
        stack.enter_context(patch.object(m, "LOCK_FILE", self.qq_lock))
        self.forbidden = {}
        for name in ("push", "deliver_batch", "prepare_batch", "render_snapshot", "complete_batch",
                     "establish_baseline", "migrate_delivery_state", "legacy_delivery_evidence",
                     "administrator_target", "atomic_write_json"):
            self.forbidden[name] = stack.enter_context(patch.object(
                m, name, side_effect=AssertionError(f"preview must not call {name}")))

    def invoke(self, *args, failure=False):
        forecast, notify = payloads()
        data = [forecast, notify, feed_payload(forecast)]
        with patch.object(m.sys, "argv", ["monitor.py", *args]), \
                patch.object(m, "fetch_json", side_effect=RuntimeError("offline") if failure else data), \
                patch.object(m.fcntl, "flock") as lock, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = m.main()
        lock.assert_not_called()
        return result

    def assert_preview_untouched(self):
        self.assertEqual(self.qq_state.read_bytes(), self.original)
        self.assertFalse(self.qq_lock.exists())
        self.assertFalse((self.root / "outbox").exists())
        self.assertFalse((self.dd_state.parent / "outbox").exists())
        self.assertFalse((self.dd_state.parent / "monitor.lock").exists())
        for mock in self.forbidden.values():
            mock.assert_not_called()

    def test_default_and_explicit_qq_keep_old_dispatch_arguments_and_paths(self):
        for channel in ([], ["--channel", "qq"]):
            for flags, expected in (
                    ([], dict(baseline_only=False, send_daily=False, no_send=False, manual_preview=False)),
                    (["--daily-summary"], dict(baseline_only=False, send_daily=True, no_send=False,
                                              manual_preview=False)),
                    (["--dry-run"], dict(baseline_only=False, send_daily=False, dry_run=True,
                                        manual_preview=False)),
                    (["--no-send"], dict(baseline_only=False, send_daily=False, no_send=True,
                                        manual_preview=False))):
                with self.subTest(channel=channel, flags=flags), \
                        patch.object(m.sys, "argv", ["monitor.py", *channel, *flags]), \
                        patch.object(m, "run_once", return_value=0) as runner:
                    self.assertEqual(m.main(), 0)
                    runner.assert_called_once_with(**expected)
                    self.assertEqual(m.STATE_FILE, self.qq_state)
                    self.assertEqual(m.LOCK_FILE, self.qq_lock)
        self.assertTrue(self.qq_lock.exists())
        self.assertFalse(self.dd_state.parent.exists())
        self.assertEqual(self.qq_state.read_bytes(), self.original)

    def test_dd_dry_run_ignores_qq_legacy_baseline_and_pending(self):
        with patch.object(m, "load_state", wraps=m.load_state) as loader:
            self.assertEqual(self.invoke("--channel", "dd", "--dry-run", "--daily-summary"), 0)
        loader.assert_called_once_with(self.dd_state)
        self.assertFalse(self.dd_state.parent.exists())
        self.assert_preview_untouched()

    def test_dd_does_not_read_even_corrupt_qq_state(self):
        self.qq_state.write_bytes(b"corrupt QQ state must not affect DD preview")
        self.original = self.qq_state.read_bytes()
        self.assertEqual(self.invoke("--channel", "dingtalk", "--dry-run"), 0)
        self.assert_preview_untouched()

    def test_dd_no_send_is_also_read_only_without_initializing_baseline(self):
        for flags in ([], ["--baseline-only"], ["--daily-summary"], ["--manual-preview"]):
            with self.subTest(flags=flags):
                self.assertEqual(self.invoke("--channel", "dingtalk", "--no-send", *flags), 0)
                self.assertFalse(self.dd_state.parent.exists())
                self.assert_preview_untouched()

    def test_dd_failed_preflight_never_sends_warning_or_writes_health(self):
        self.dd_state.parent.mkdir()
        self.dd_state.write_text(json.dumps(dict(channel="dingtalk", version=1,
                                                consecutive_fetch_failures=2)))
        original = self.dd_state.read_bytes()
        self.assertEqual(self.invoke("--channel", "dd", "--no-send", failure=True), 1)
        self.assertEqual(self.dd_state.read_bytes(), original)
        self.assert_preview_untouched()

    def test_dd_bound_state_and_pending_are_not_advanced_by_preview(self):
        self.dd_state.parent.mkdir()
        self.dd_state.write_text(json.dumps(dict(
            channel="dingtalk", version=2, initialized_at="2026-10-19T07:00:00Z",
            migrationLowerBound="2026-10-19T07:00:00Z", sentAnnouncementIds=[],
            deliveredPhaseKeys=[], pendingBatch={"batchId": "preserve-dd-pending"},
            consecutive_fetch_failures=9, lastSuccessfulPushAt=None)))
        original = self.dd_state.read_bytes()
        for flag in ("--dry-run", "--no-send"):
            with self.subTest(flag=flag):
                self.assertEqual(self.invoke("--channel", "dd", flag), 0)
                self.assertEqual(self.dd_state.read_bytes(), original)
                self.assert_preview_untouched()

    def test_dd_rejects_copied_qq_state_instead_of_using_qq_success(self):
        self.dd_state.parent.mkdir()
        for version in (1, 2):
            for binding in (None, "qq"):
                state = json.loads(self.original)
                state.update(version=version, channel=binding)
                self.dd_state.write_text(json.dumps(state))
                with self.subTest(version=version, binding=binding), self.assertRaisesRegex(
                        RuntimeError, "own channel binding"):
                    self.invoke("--channel", "dd", "--dry-run")
        self.assert_preview_untouched()

    def test_dd_cli_cannot_enable_sends_with_any_existing_mode(self):
        for channel in ("dd", "dingtalk"):
            for flags in ([], ["--test-push"], ["--daily-summary"], ["--baseline-only"],
                          ["--manual-preview"], ["--test-push", "--dry-run"]):
                with self.subTest(channel=channel, flags=flags), \
                        patch.object(m, "fetch_json") as fetch, self.assertRaises(SystemExit) as error:
                    self.invoke("--channel", channel, *flags)
                self.assertEqual(error.exception.code, 2)
                fetch.assert_not_called()
        self.assert_preview_untouched()

    def test_direct_runner_cannot_bypass_dd_preview_gate(self):
        for flags in ({}, {"send_daily": True}, {"baseline_only": True}, {"manual_preview": True}):
            with self.subTest(flags=flags), patch.object(m, "load_state") as loader, \
                    self.assertRaisesRegex(RuntimeError, "preview-only"):
                m.run_once(channel="dingtalk", **flags)
            loader.assert_not_called()
        with self.assertRaisesRegex(ValueError, "unsupported monitor channel"):
            m.run_once(channel="group", dry_run=True)
        self.assert_preview_untouched()

    def test_qq_lock_does_not_block_dd_preview(self):
        with self.qq_lock.open("a+") as lock:
            m.fcntl.flock(lock, m.fcntl.LOCK_EX | m.fcntl.LOCK_NB)
            self.assertEqual(self.invoke("--channel", "dd", "--dry-run"), 0)
        self.qq_lock.unlink()
        self.assert_preview_untouched()


class GroupMonitorTests(unittest.TestCase):
    def setUp(self):
        legacy = patch.object(m, "fetch_source_data", side_effect=legacy_fixture_source)
        legacy.start()
        self.addCleanup(legacy.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.qq_state = self.root / "state.json"
        self.qq_state.write_text(json.dumps(dict(pendingBatch={"batchId": "qq-keep"},
                                                daily_summary_date="2099-01-01")))
        self.qq_bytes = self.qq_state.read_bytes()
        self.dd_state = self.root / "dingtalk" / "group" / "state.json"
        self.config = self.root / "group.json"
        self.config.write_text(json.dumps(dict(version=1, openclawRoot="/unused",
            imageHosting="qq_upload_only", groupId="cidyHM8LHTEyQHtHoNc12qsUQ==")))
        self.config.chmod(0o600)
        self.status = "readback_confirmed"
        self.dispatches = []
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(m, "STATE_FILE", self.qq_state))
        stack.enter_context(patch.object(m, "STATE_DIR", self.root))
        stack.enter_context(patch.object(m, "LOCK_FILE", self.root / "monitor.lock"))
        stack.enter_context(patch.object(m, "render_snapshot", side_effect=fake_render))
        stack.enter_context(patch.object(m.subprocess, "run", side_effect=self.sender))
        self.qq_push = stack.enter_context(patch.object(m, "push", side_effect=AssertionError("QQ forbidden")))
        self.migration = stack.enter_context(patch.object(m, "migrate_delivery_state",
                                                        side_effect=AssertionError("QQ migration forbidden")))

    def sender(self, command, **kwargs):
        self.assertEqual(Path(command[1]).name, "send-dingtalk.mjs")
        self.assertIn("--send-group", command)
        self.assertEqual(Path(command[command.index("--config") + 1]), self.config.resolve())
        manifest_path = Path(command[command.index("--manifest") + 1])
        receipt_path = Path(command[command.index("--receipt") + 1])
        manifest = json.loads(manifest_path.read_text())
        self.dispatches.append(manifest)
        confirmed = self.status == "readback_confirmed"
        m.atomic_write_json(receipt_path, dict(version=2, batchId=manifest["batchId"],
            delivery="single_markdown", manifestSha256=m.digest_json(manifest),
            channel="dingtalk", targetSha256=m.GROUP_TARGET_SHA256,
            status=self.status, ok=confirmed, readbackObserved=confirmed, deliveryVerified=False))
        return subprocess.CompletedProcess(command, 0 if self.status in ("accepted", "readback_confirmed") else 5)

    def run_group(self, data=None, **flags):
        forecast, notify = payloads()
        with patch.object(m, "fetch_json", side_effect=data or [forecast, notify, feed_payload(forecast)]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return m.run_once(channel="dingtalk", group_config=self.config, **flags)

    def state(self):
        return json.loads(self.dd_state.read_text())

    def assert_qq_untouched(self):
        self.assertEqual(self.qq_state.read_bytes(), self.qq_bytes)
        self.assertFalse((self.root / "outbox").exists())
        self.assertEqual(m.STATE_FILE, self.qq_state)
        self.assertIsNone(m.GROUP_CONFIG)
        self.qq_push.assert_not_called()
        self.migration.assert_not_called()

    def test_first_call_baselines_then_unique_daily_and_quiet_poll(self):
        self.assertEqual(self.run_group(send_daily=True), 0)
        self.assertFalse(self.dispatches)
        self.assertIsNone(self.state()["daily_summary_date"])
        self.assertEqual(self.run_group(send_daily=True), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(sum(p["type"] == "image" for p in self.dispatches[0]["parts"]), 1)
        self.assertEqual(self.state()["daily_summary_date"], m.now_utc().astimezone(m.SHANGHAI).date().isoformat())
        self.assertEqual(self.run_group(send_daily=True), 0)
        self.assertEqual(self.run_group(), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assert_qq_untouched()

    def test_unconfirmed_receipt_preserves_same_batch_and_daily(self):
        for status in ("accepted", "unknown", "inflight", "failed"):
            with self.subTest(status=status):
                self.status = status
                self.assertEqual(self.run_group(baseline_only=True), 0)
                self.assertEqual(self.run_group(send_daily=True), 1)
                batch = self.state()["pendingBatch"]
                self.assertIsNone(self.state()["daily_summary_date"])
                self.assertEqual(self.run_group(send_daily=True), 1)
                self.assertEqual(self.state()["pendingBatch"], batch)
                self.assertEqual(self.dispatches[-1]["batchId"], self.dispatches[-2]["batchId"])
        self.status = "readback_confirmed"
        self.assertEqual(self.run_group(send_daily=True), 0)
        self.assertIsNone(self.state()["pendingBatch"])
        self.assert_qq_untouched()

    def test_target_or_channel_copied_state_is_rejected(self):
        self.run_group(baseline_only=True)
        original = self.dd_state.read_bytes()
        for key, wrong in (("channel", "qq"), ("targetSha256", "0" * 64), ("groupIdSha256", "1" * 64)):
            state = json.loads(original)
            state[key] = wrong
            self.dd_state.write_text(json.dumps(state))
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, "binding mismatch"):
                self.run_group(send_daily=True)
        self.assertFalse(self.dispatches)
        self.assert_qq_untouched()

    def test_bad_config_fails_closed_and_restores_qq_context(self):
        self.config.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "unpinned"):
            self.run_group(send_daily=True)
        self.config.chmod(0o600)
        config = json.loads(self.config.read_text())
        config["groupId"] = "wrong-group"
        self.config.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, "unpinned"):
            self.run_group(send_daily=True)
        self.assertFalse(self.dd_state.exists())
        self.assert_qq_untouched()

    def test_initialized_dd_fetch_failures_only_record_health_never_send_group_or_qq(self):
        self.run_group(baseline_only=True)
        self.run_group(send_daily=True)
        daily = self.state()["daily_summary_date"]
        self.dispatches.clear()
        self.status = "accepted"
        for _ in range(5):
            self.assertEqual(self.run_group(data=[RuntimeError("HTTP 502")]), 1)
        state = self.state()
        self.assertEqual(state["consecutive_fetch_failures"], 5)
        self.assertFalse(state["failure_notified"])
        self.assertEqual(state["daily_summary_date"], daily)
        self.assertFalse(self.dispatches)
        self.assertNotIn("pendingHealthBatch", state)
        self.assertEqual(self.run_group(), 0)
        self.assertEqual(self.state()["consecutive_fetch_failures"], 0)
        self.assertNotIn("pendingHealthBatch", self.state())
        self.assert_qq_untouched()

    def test_dd_read_only_and_no_send_do_not_consume_delivery(self):
        self.assertEqual(self.run_group(dry_run=True), 0)
        self.assertFalse(self.dd_state.exists())
        self.assertEqual(self.run_group(no_send=True), 0)
        self.assertIsNone(self.state()["initialized_at"])
        self.assertEqual(self.run_group(baseline_only=True), 0)
        original = self.dd_state.read_bytes()
        self.assertEqual(self.run_group(dry_run=True, send_daily=True), 0)
        self.assertEqual(self.dd_state.read_bytes(), original)
        self.assertFalse(self.dispatches)
        self.assert_qq_untouched()

    def test_qq_failure_cannot_consume_dd_pending(self):
        self.run_group(baseline_only=True)
        self.status = "accepted"
        self.run_group(send_daily=True)
        original = self.dd_state.read_bytes()
        with patch.object(m, "fetch_json", side_effect=RuntimeError("offline")), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(m.run_once(), 1)
        self.assertEqual(self.dd_state.read_bytes(), original)
        self.assertEqual(len(self.dispatches), 1)

    def test_bad_readback_receipts_cannot_complete(self):
        self.run_group(baseline_only=True)
        for key, wrong in (("channel", "qq"), ("targetSha256", "0" * 64),
                           ("manifestSha256", "1" * 64), ("batchId", "wrong"),
                           ("readbackObserved", False), ("ok", False), ("status", "accepted")):
            def bad_sender(command, **kwargs):
                result = self.sender(command, **kwargs)
                path = Path(command[command.index("--receipt") + 1])
                receipt = json.loads(path.read_text())
                receipt[key] = wrong
                m.atomic_write_json(path, receipt)
                return result
            with self.subTest(key=key), patch.object(m.subprocess, "run", side_effect=bad_sender):
                self.assertEqual(self.run_group(send_daily=True), 1)
                self.assertIsNone(self.state()["daily_summary_date"])
                self.assertIsNotNone(self.state()["pendingBatch"])
        self.assert_qq_untouched()

    def test_group_cli_uses_only_group_lock_and_qq_lock_cannot_block(self):
        forecast, notify = payloads()
        lock_path = self.root / "monitor.lock"
        with lock_path.open("a+") as lock, \
                patch.object(m.sys, "argv", ["monitor.py", "--channel", "dd", "--group-config",
                                            str(self.config), "--baseline-only"]), \
                patch.object(m, "fetch_json", side_effect=[forecast, notify, feed_payload(forecast)]), \
                contextlib.redirect_stdout(io.StringIO()):
            m.fcntl.flock(lock, m.fcntl.LOCK_EX | m.fcntl.LOCK_NB)
            self.assertEqual(m.main(), 0)
        self.assertTrue(self.dd_state.with_name("monitor.lock").exists())
        self.assert_qq_untouched()

    def test_group_lock_prevents_duplicate_pipeline(self):
        self.dd_state.parent.mkdir(parents=True)
        with self.dd_state.with_name("monitor.lock").open("a+") as lock, \
                patch.object(m.sys, "argv", ["monitor.py", "--channel", "dd", "--group-config",
                                            str(self.config), "--daily-summary"]), \
                patch.object(m, "fetch_json") as fetch, contextlib.redirect_stdout(io.StringIO()):
            m.fcntl.flock(lock, m.fcntl.LOCK_EX | m.fcntl.LOCK_NB)
            self.assertEqual(m.main(), 0)
            fetch.assert_not_called()
        self.assert_qq_untouched()

    def test_context_restores_after_exception_and_nested_calls_do_not_append_paths(self):
        original_script = m.PUSH_SCRIPT
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "forced"):
                with m.dingtalk_runtime(self.config):
                    self.assertEqual(m.STATE_FILE, self.dd_state)
                    with m.dingtalk_runtime(self.config):
                        self.assertEqual(m.STATE_FILE, self.dd_state)
                    with self.assertRaisesRegex(ValueError, "different"):
                        with m.dingtalk_runtime(self.config.with_name("other.json")):
                            self.fail("must not enter")
                    raise RuntimeError("forced")
            self.assertEqual(m.PUSH_SCRIPT, original_script)
            self.assertFalse(self.dd_state.parent.exists())
            self.assert_qq_untouched()

    def test_bad_target_cli_does_not_create_group_state_lock_or_outbox(self):
        config = json.loads(self.config.read_text())
        config["groupId"] = "wrong"
        self.config.write_text(json.dumps(config))
        with patch.object(m.sys, "argv", ["monitor.py", "--channel", "dd", "--group-config",
                                        str(self.config), "--daily-summary"]), \
                self.assertRaisesRegex(ValueError, "unpinned"):
            m.main()
        self.assertFalse(self.dd_state.parent.exists())
        self.assert_qq_untouched()

    def test_existing_old_banked_announcement_can_upgrade_without_historical_flood(self):
        forecast, notify = payloads()
        feed = feed_payload(forecast)
        banked = dict(id=str(int(NEW_ID) + 10), kind="banked", reset_kind="banked",
                      summary="Cards arriving", preview=True, banked_state="arriving",
                      announced_at=(m.now_utc() - timedelta(minutes=1)).isoformat(),
                      source_url=f"https://x.com/source/status/{int(NEW_ID) + 10}")
        feed["events"].append(banked)
        self.assertEqual(self.run_group(data=[forecast, notify, feed], baseline_only=True), 0)
        self.assertIn("banked:upcoming:" + banked["id"], self.state()["phaseBaselineKeys"])
        self.assertFalse(self.dispatches)
        banked.update(summary="Cards distributed", preview=False, banked_state="available")
        self.assertEqual(self.run_group(data=[forecast, notify, feed]), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(self.dispatches[0]["parts"][0]["text"], m.PHASE_TITLES[("banked", "distributed")])
        self.assertEqual(sum(p["type"] == "image" for p in self.dispatches[0]["parts"]), 2)
        self.assertIn("banked:distributed:" + banked["id"], self.state()["deliveredPhaseKeys"])
        self.assertEqual(self.run_group(data=[forecast, notify, feed]), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assert_qq_untouched()

    def test_unknown_old_banked_history_stays_silent(self):
        self.run_group(baseline_only=True)
        forecast, notify = payloads()
        feed = feed_payload(forecast)
        feed["events"].append(dict(id=str(int(NEW_ID) + 10), kind="banked", reset_kind="banked",
            summary="Previously unseen old cards", preview=False, banked_state="available",
            announced_at=(m.now_utc() - timedelta(days=1)).isoformat(),
            source_url=f"https://x.com/source/status/{int(NEW_ID) + 10}"))
        self.assertEqual(self.run_group(data=[forecast, notify, feed]), 0)
        self.assertFalse(self.dispatches)
        self.assert_qq_untouched()

    def test_group_units_schedule_and_timeout_cover_bounded_pipeline(self):
        root = Path(__file__).parent
        for kind, flag in (("monitor", False), ("summary", True)):
            service = configparser.ConfigParser(interpolation=None)
            service.read(root / f"codex-reset-dingtalk-{kind}.service")
            self.assertEqual(service["Service"]["TimeoutStartSec"], "30min")
            self.assertGreater(30 * 60, 3 * source_fetch.MAX_CALL_SECONDS + m.RENDER_TIMEOUT + m.SEND_TIMEOUT)
            command = service["Service"]["ExecStart"]
            self.assertIn("--channel dingtalk --group-config", command)
            self.assertEqual("--daily-summary" in command, flag)
            self.assertNotIn("--initialize-on-success", command)
            timer = configparser.ConfigParser(interpolation=None)
            timer.read(root / f"codex-reset-dingtalk-{kind}.timer")
            self.assertEqual(timer["Timer"]["Unit"], f"codex-reset-dingtalk-{kind}.service")
            self.assertEqual(timer["Timer"].get("OnCalendar") if flag else timer["Timer"]["OnUnitActiveSec"],
                             "*-*-* 08:00:00 Asia/Shanghai" if flag else "15min")

    def test_initialization_waits_silently_through_source_failures_then_sends_unique_daily(self):
        for _ in range(5):
            self.assertEqual(self.run_group(data=[RuntimeError("HTTP 502")], initialize_on_success=True), 1)
        state = self.state()
        self.assertTrue(state["initializationPending"])
        self.assertIsNone(state["initialized_at"])
        self.assertIsNone(state["daily_summary_date"])
        self.assertNotIn("pendingHealthBatch", state)
        self.assertFalse(self.dispatches)
        self.assertFalse((self.dd_state.parent / "outbox").exists())
        self.assertEqual(self.run_group(initialize_on_success=True), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(sum(p["type"] == "image" for p in self.dispatches[0]["parts"]), 1)
        self.assertFalse(self.state()["initializationPending"])
        self.assertTrue(self.state()["firstDailyCompletedAt"])
        self.assertEqual(self.state()["daily_summary_date"], m.now_utc().astimezone(m.SHANGHAI).date().isoformat())
        self.assertEqual(self.run_group(initialize_on_success=True), 0)
        self.assertEqual(self.run_group(send_daily=True), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assert_qq_untouched()

    def test_first_fresh_poll_can_initialize_without_prior_failure(self):
        self.assertEqual(self.run_group(initialize_on_success=True), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assertFalse(self.state()["initializationPending"])
        self.assert_qq_untouched()

    def test_initialization_intent_survives_accepted_and_plain_poll_resumes_same_batch(self):
        self.status = "accepted"
        self.assertEqual(self.run_group(initialize_on_success=True), 1)
        state = self.state()
        batch = state["pendingBatch"]
        self.assertTrue(state["initializationPending"])
        self.assertIsNone(state["daily_summary_date"])
        self.assertNotIn("firstDailyCompletedAt", state)
        for _ in range(4):
            self.assertEqual(self.run_group(data=[RuntimeError("HTTP 502")]), 1)
        self.assertEqual(len(self.dispatches), 1)
        self.assertNotIn("pendingHealthBatch", self.state())
        self.assertEqual(self.run_group(), 1)
        self.assertEqual(self.state()["pendingBatch"], batch)
        self.status = "readback_confirmed"
        self.assertEqual(self.run_group(), 0)
        self.assertFalse(self.state()["initializationPending"])
        self.assertTrue(all(p["batchId"] == batch["batchId"] for p in self.dispatches))
        self.assertEqual(self.run_group(), 0)
        self.assertEqual(len(self.dispatches), 3)
        self.assert_qq_untouched()

    def test_initialization_survives_render_failure_after_baseline(self):
        with patch.object(m, "render_snapshot", side_effect=RuntimeError("temporary render failure")):
            self.assertEqual(self.run_group(initialize_on_success=True), 1)
        self.assertTrue(self.state()["initialized_at"])
        self.assertTrue(self.state()["initializationPending"])
        self.assertIsNone(self.state()["pendingBatch"])
        self.assertIsNone(self.state()["daily_summary_date"])
        self.assertEqual(self.run_group(), 0)
        self.assertEqual(len(self.dispatches), 1)
        self.assertFalse(self.state()["initializationPending"])
        self.assert_qq_untouched()

    def test_initialize_flag_dry_run_and_no_send_never_create_baseline_or_daily(self):
        self.assertEqual(self.run_group(initialize_on_success=True, dry_run=True), 0)
        self.assertFalse(self.dd_state.exists())
        self.assertEqual(self.run_group(initialize_on_success=True, no_send=True), 0)
        self.assertTrue(self.state()["initializationPending"])
        self.assertIsNone(self.state()["initialized_at"])
        self.assertIsNone(self.state()["daily_summary_date"])
        self.assertFalse(self.dispatches)
        self.assert_qq_untouched()

    def test_initialize_flag_requires_valid_group_and_does_not_change_qq(self):
        for args in (["--initialize-on-success"], ["--channel", "dd", "--initialize-on-success"],
                     ["--channel", "dd", "--group-config", str(self.config),
                      "--initialize-on-success", "--baseline-only"]):
            with self.subTest(args=args), patch.object(m.sys, "argv", ["monitor.py", *args]), \
                    self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                m.main()
        with self.assertRaisesRegex(ValueError, "pinned DingTalk"):
            m.run_once(initialize_on_success=True)
        self.assertFalse(self.dd_state.parent.exists())
        self.assert_qq_untouched()


class SourceIntegrationTests(unittest.TestCase):
    """Clock-complete fixtures are hypothetical, not claims about the live source."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = Path(self.tmp.name) / "state.json"
        self.current = datetime(2026, 10, 20, 3, tzinfo=timezone.utc)
        self.state = dict(version=2, initialized_at="2026-09-17T03:51:39Z",
                          last_reset_id=OLD_ID, last_reset_at="2026-10-15T06:28:13Z",
                          notified_reset_ids=[OLD_ID], daily_summary_date="2026-10-19",
                          consecutive_fetch_failures=67, failure_notified=True,
                          migrationLowerBound="2026-10-19T00:00:00Z", pendingBatch=None,
                          sentAnnouncementIds=[OLD_ID], deliveredPhaseKeys=[f"regular:actual:{OLD_ID}"],
                          phaseSchemaVersion=1, phaseBaselineKeys=[], lastSuccessfulPushAt="2026-10-19T00:00:12Z")
        self.state_file.write_text(json.dumps(self.state))
        self.raw = json.loads((Path(__file__).parent / "fixtures" /
                               "willcodexreset-radar-20261020.json").read_text())
        self.snapshot = m.provider.normalize_snapshot(self.raw, retrieved_at=self.current.isoformat())
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(m, "STATE_FILE", self.state_file))
        stack.enter_context(patch.object(m, "now_utc", side_effect=lambda: self.current))
        stack.enter_context(patch.object(m.provider, "fetch_snapshot", side_effect=lambda: copy.deepcopy(self.snapshot)))
        stack.enter_context(patch.object(m, "render_snapshot", side_effect=fake_render))
        self.sender = stack.enter_context(patch.object(m, "deliver_batch", return_value=True))
        self.warning = stack.enter_context(patch.object(m, "push", side_effect=AssertionError("no transport")))

    def clock_complete_fixture(self):
        for key in ("source_updated_at", "signal_checked_at", "forecast_generated_at"):
            self.snapshot[key] = self.current.isoformat()
        self.snapshot["capabilities"]["forecast_generation_time"] = True
        self.snapshot["forecast"]["forecast_generated_at"] = self.current.isoformat()

    def run_monitor(self, **flags):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return m.run_once(**flags)

    def read_state(self):
        return json.loads(self.state_file.read_text())

    def add_event(self, event_id="2119999999999999999", **changes):
        event = dict(id="test-" + event_id, kind="reset", verified=True, resetType="usage",
                     occurredAt=self.current.isoformat(), title="Fixture reset", detail="Explicit source record",
                     url=f"https://x.com/thsottiaux/status/{event_id}")
        event.update(changes)
        raw = copy.deepcopy(self.raw)
        raw["data"]["events"] = [event]
        normalized = m.provider.normalize_snapshot(raw, retrieved_at=self.current.isoformat())["events"][0]
        self.snapshot["events"].append(normalized)
        return normalized

    def test_real_source_values_and_absent_fields_remain_truthful(self):
        forecast, notify, feed = m.fetch_source_data()
        card = m.forecast_card_data(forecast)
        self.assertEqual((card["probability_24h"], card["probability_48h"]), (.72, .82))
        self.assertIsNone(card["updated_at"])
        self.assertEqual(card["status"], "来源预测")
        for key in ("computed_at", "live_fetched_at", "confidence", "promise", "range_24", "factors"):
            self.assertNotIn(key, forecast)
        self.assertNotIn("last_reset_id", notify)
        self.assertEqual(feed["fetched_at"], self.snapshot["retrieved_at"])

    def test_old_ingestion_and_absent_prediction_clock_allow_daily_once(self):
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        state = self.read_state()
        self.assertEqual(state["consecutive_fetch_failures"], 0)
        self.assertFalse(state["failure_notified"])
        self.assertEqual(state["daily_summary_date"], "2026-10-20")
        self.assertEqual(self.sender.call_count, 1)
        batch = self.sender.call_args.args[0]
        snapshot = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["sourceTimes"]["signalCheckedAt"], self.snapshot["signal_checked_at"])
        self.assertIsNone(snapshot["sourceTimes"]["predictionGeneratedAt"])
        self.assertIsNone(snapshot["forecastCard"]["updated_at"])
        self.warning.assert_not_called()

    def test_old_ingestion_remains_audit_evidence_not_prediction_time(self):
        stamp = self.current.isoformat()
        old_ingestion = self.snapshot["signal_checked_at"]
        self.snapshot.update(source_updated_at=stamp, retrieved_at=stamp)
        m.validate_source_snapshot(self.snapshot)
        self.assertEqual(self.snapshot["signal_checked_at"], old_ingestion)
        self.assertIsNone(self.snapshot["forecast_generated_at"])
        self.assertIsNone(m.forecast_card_data(dict(self.snapshot["forecast"], sourceSnapshot=self.snapshot))["updated_at"])

    def test_source_clocks_and_health_are_still_required(self):
        self.clock_complete_fixture()
        for key in ("source_updated_at", "signal_checked_at"):
            for bad in (None, "bad",
                        (self.current + timedelta(minutes=5, seconds=1)).isoformat()):
                with self.subTest(key=key, bad=bad):
                    snapshot = copy.deepcopy(self.snapshot)
                    snapshot[key] = bad
                    with self.assertRaises(ValueError):
                        m.validate_source_snapshot(snapshot)
        for status in (None, "error", "unknown"):
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "signal_status"):
                m.validate_source_snapshot(dict(self.snapshot, signal_status=status))

    def test_only_ingestion_age_is_relaxed_not_response_age_or_future_tolerance(self):
        self.clock_complete_fixture()
        for age in (timedelta(hours=2, seconds=1), timedelta(days=30)):
            with self.subTest(age=age):
                old = (self.current - age).isoformat()
                m.validate_source_snapshot(dict(self.snapshot, signal_checked_at=old))
                with self.assertRaisesRegex(ValueError, "source_updated_at"):
                    m.validate_source_snapshot(dict(self.snapshot, source_updated_at=old))
        with self.assertRaisesRegex(ValueError, "signal_checked_at"):
            m.validate_source_snapshot(dict(self.snapshot,
                signal_checked_at=(self.current + timedelta(minutes=5, seconds=1)).isoformat()))

    def test_absent_prediction_clock_is_not_a_permanent_block_or_a_freshness_claim(self):
        self.snapshot["source_updated_at"] = self.snapshot["signal_checked_at"] = self.current.isoformat()
        m.validate_source_snapshot(self.snapshot)
        self.assertFalse(self.snapshot["capabilities"]["forecast_generation_time"])
        forecast = dict(self.snapshot["forecast"], sourceSnapshot=self.snapshot)
        self.assertIsNone(m.source_audit(forecast)["sourceTimes"]["predictionGeneratedAt"])
        self.assertIsNone(m.forecast_card_data(forecast)["updated_at"])

    def test_present_prediction_clock_cannot_be_stale_or_future(self):
        self.clock_complete_fixture()
        for stamp in ("bad", (self.current - timedelta(hours=2, seconds=1)).isoformat(),
                      (self.current + timedelta(minutes=5, seconds=1)).isoformat()):
            with self.subTest(stamp=stamp), self.assertRaisesRegex(ValueError, "forecast_generated_at"):
                m.validate_source_snapshot(dict(self.snapshot, forecast_generated_at=stamp))

    def test_dry_run_failure_is_byte_read_only(self):
        self.snapshot["source_updated_at"] = (self.current - timedelta(hours=3)).isoformat()
        original = self.state_file.read_bytes()
        self.assertEqual(self.run_monitor(dry_run=True, send_daily=True), 1)
        self.assertEqual(self.state_file.read_bytes(), original)
        self.sender.assert_not_called()

    def test_initial_provider_observation_suppresses_all_existing_history(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.run_monitor(), 0)
        state = self.read_state()
        self.assertEqual(state["sourceProviderId"], "willcodexreset")
        self.assertEqual(set(state["providerBaseline"]["eventIds"]),
                         {event["event_id"] for event in self.snapshot["events"]})
        for key in ("last_reset_id", "last_reset_at", "notified_reset_ids", "sentAnnouncementIds",
                    "deliveredPhaseKeys", "daily_summary_date", "lastSuccessfulPushAt", "migrationLowerBound"):
            self.assertEqual(state[key], self.state[key])
        self.sender.assert_not_called()

    def test_qq_daily_catchup_is_one_new_forecast_not_yesterdays_history(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        self.assertEqual(self.sender.call_count, 1)
        state = self.read_state()
        self.assertEqual(state["daily_summary_date"], "2026-10-20")
        self.assertEqual(state["notified_reset_ids"], [OLD_ID])
        post_ids = [post["event_id"] for post in self.snapshot["posts"]]
        self.assertEqual(state["sentAnnouncementIds"], [OLD_ID] + post_ids)
        directory = next((self.state_file.parent / "outbox").iterdir())
        snapshot = json.loads((directory / "snapshot.json").read_text())
        manifest = json.loads((directory / "batch.json").read_text())
        self.assertEqual([event["id"] for event in snapshot["announcements"]], post_ids)
        self.assertEqual(snapshot["eventPhases"], [])
        self.assertEqual(snapshot["sourceProvider"]["id"], "willcodexreset")
        self.assertEqual(snapshot["sourceTimes"]["signalCheckedAt"], self.snapshot["signal_checked_at"])
        self.assertEqual(manifest["parts"][1]["url"], "https://willcodexreset.com/zh")

    def test_missing_latest_reset_preserves_existing_reset_watermark(self):
        self.clock_complete_fixture()
        self.snapshot["events"] = []
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        for key in ("last_reset_id", "last_reset_at", "notified_reset_ids"):
            self.assertEqual(self.read_state()[key], self.state[key])

    def test_first_observation_no_send_does_not_consume_cutover(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(no_send=True), 0)
        self.assertNotIn("providerBaseline", self.read_state())
        self.assertNotIn("sourceProviderId", self.read_state())
        self.assertEqual(self.read_state()["last_reset_id"], OLD_ID)

    def test_new_explicit_reset_sends_once_with_native_and_x_identity(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        event = self.add_event()
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.sender.call_count, 1)
        directory = next((self.state_file.parent / "outbox").iterdir())
        snapshot = json.loads((directory / "snapshot.json").read_text())
        self.assertEqual(snapshot["title"], "Codex已重置，速蹬！")
        self.assertEqual(snapshot["stageText"], "常规重置（regular）｜来源已确认直接用量重置，不代表个人到账")
        self.assertEqual(snapshot["announcements"][0]["sourceEvent"]["source_event_id"], event["source_event_id"])
        self.assertEqual(snapshot["announcements"][0]["sourceEvent"]["x_status_id"], event["event_id"])

    def test_scheduled_preview_then_actual_are_separate_deduplicated_stages(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        event = self.add_event(kind="tibo", verified=False,
            forecastSignal=dict(stage="scheduled", window="tomorrow before 10am Pacific"))
        parsed = dict(status="parsed", display="预计重置：2026-10-21 01:00前（UTC+08:00）", candidates=[])
        with patch.object(m, "interpret_preview_time", return_value=parsed) as complete:
            self.assertEqual(self.run_monitor(), 0)
            self.assertEqual(self.run_monitor(), 0)
            self.assertEqual(complete.call_count, 1)
        self.assertEqual(self.sender.call_count, 1)
        self.assertEqual(self.read_state()["last_reset_id"], OLD_ID)
        self.assertEqual(self.read_state()["notified_reset_ids"], [OLD_ID])
        batch = self.sender.call_args.args[0]
        snapshot = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["title"], "Codex确认重置！")
        self.assertIn("尚未到账", snapshot["stageText"])
        self.assertIn("UTC+08:00", snapshot["forecastCard"]["summary"])
        self.assertEqual(snapshot["previewTime"], parsed)
        self.snapshot["events"].remove(event)
        self.add_event()
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.sender.call_count, 2)
        self.assertIn("2119999999999999999", self.read_state()["notified_reset_ids"])

    def test_old_ingestion_still_deduplicates_resets_and_keeps_unchanged_polls_silent(self):
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.run_monitor(), 0)
        self.sender.assert_not_called()
        self.current += timedelta(minutes=15)
        self.snapshot["source_updated_at"] = self.current.isoformat()
        self.add_event()
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.sender.call_count, 1)
        self.assertEqual(self.read_state()["consecutive_fetch_failures"], 0)

    def test_late_unknown_id_before_cutover_never_replays(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.add_event(occurredAt="2026-10-18T00:00:00Z")
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        batch = self.sender.call_args.args[0]
        self.assertEqual(set(batch["announcementIds"]),
                         {post["event_id"] for post in self.snapshot["posts"]})
        self.assertIsNone(batch["resetId"])

    def test_old_known_id_explicit_phase_upgrade_survives_old_lower_bound(self):
        self.clock_complete_fixture()
        event = self.add_event(kind="tibo", verified=False, occurredAt="2026-10-18T00:00:00Z")
        self.assertEqual(self.run_monitor(), 0)
        self.snapshot["events"].remove(event)
        self.add_event(occurredAt="2026-10-18T00:00:00Z")
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.sender.call_count, 1)
        self.assertIn(event["event_id"], self.sender.call_args.args[0]["announcementIds"])

    def test_unknown_type_candidate_and_unverified_records_do_not_trigger(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        for index, changes in enumerate((dict(resetType="unknown"), dict(kind="tibo"), dict(verified=False),
                                         dict(kind="tibo", autoDetectedReset=True, confidence=.99))):
            self.add_event(event_id=str(2119999999999999990 + index), **changes)
        self.assertEqual(self.run_monitor(), 0)
        self.sender.assert_not_called()

    def test_new_non_tibo_or_missing_original_url_is_blocked(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        for url in (None, "https://x.com/another_author/status/2119999999999999999"):
            self.snapshot["events"] = []
            self.add_event(url=url)
            self.assertEqual(self.run_monitor(), 1)
            self.sender.assert_not_called()

    def test_same_x_reset_and_post_make_one_card_not_two(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        self.add_event()
        self.add_event(kind="tibo", verified=False)
        self.assertEqual(self.run_monitor(), 0)
        self.assertEqual(self.sender.call_args.args[0]["announcementIds"].count("2119999999999999999"), 1)

    def test_x_feed_is_independent_of_reset_events_and_deduplicates_relevant_subset(self):
        self.snapshot["relevant_posts"].append(copy.deepcopy(self.snapshot["posts"][0]))
        forecast, notify, feed = m.fetch_source_data()
        expected = {post["event_id"] for post in self.snapshot["posts"] + self.snapshot["relevant_posts"]}
        self.assertEqual({post["id"] for post in feed["sourcePosts"]}, expected)
        self.assertEqual(len(feed["sourcePosts"]), len(expected))
        self.assertTrue(all(m.classify_reset_phase(post, forecast, notify) is None for post in feed["sourcePosts"]))
        self.assertEqual(feed["sourcePosts"][0]["summary"], self.snapshot["posts"][0]["detail"])

    def test_x_feed_does_not_trigger_poll_but_daily_sends_unseen_posts_once(self):
        self.clock_complete_fixture()
        self.snapshot["events"] = []
        self.assertEqual(self.run_monitor(), 0)
        self.sender.assert_not_called()
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        self.assertEqual(self.sender.call_count, 1)
        batch = self.sender.call_args.args[0]
        self.assertEqual(set(batch["announcementIds"]), {post["event_id"] for post in self.snapshot["posts"]})
        self.assertEqual(batch["deliveredPhaseKeys"], [])
        self.assertIsNone(batch["resetId"])

    def test_original_x_post_replaces_manual_summary_without_duplicate_card(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        event = self.add_event()
        post = dict(event, source_event_id="tibo-original", raw_kind="tibo", phase=None,
                    verified=False, detail="Original X text, not the manual reset summary")
        self.snapshot["posts"].append(post)
        self.snapshot["relevant_posts"].append(copy.deepcopy(post))
        self.assertEqual(self.run_monitor(), 0)
        batch = self.sender.call_args.args[0]
        snapshot = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "snapshot.json").read_text())
        cards = [item for item in snapshot["announcements"] if item["id"] == event["event_id"]]
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["summary"], post["detail"])
        self.assertEqual(snapshot["title"], "Codex已重置，速蹬！")

    def test_x_post_matching_baselined_reset_does_not_reannounce_reset_stage(self):
        self.clock_complete_fixture()
        event = self.add_event()
        self.assertEqual(self.run_monitor(), 0)
        self.snapshot["posts"].append(dict(event, phase=None, raw_kind="tibo", verified=False))
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        batch = self.sender.call_args.args[0]
        snapshot = json.loads((self.state_file.parent / "outbox" / batch["batchId"] / "snapshot.json").read_text())
        self.assertIn(event["event_id"], batch["announcementIds"])
        self.assertEqual(snapshot["eventPhases"], [])
        self.assertNotIn("stageText", snapshot)

    def test_x_post_duplicates_with_conflicting_original_text_fail_closed(self):
        self.snapshot["relevant_posts"].append(dict(self.snapshot["posts"][0], detail="Different original"))
        with self.assertRaisesRegex(ValueError, "conflicting duplicate original post"):
            m.fetch_source_data()

    def test_x_content_links_are_clickable_outside_the_card_and_snapshot_keeps_original(self):
        self.clock_complete_fixture()
        original = "Original text https://t.co/abc"
        self.snapshot["posts"][0]["detail"] = original
        self.assertEqual(self.run_monitor(send_daily=True), 0)
        batch = self.sender.call_args.args[0]
        directory = self.state_file.parent / "outbox" / batch["batchId"]
        snapshot = json.loads((directory / "snapshot.json").read_text())
        self.assertEqual(snapshot["announcements"][0]["summary"], original)
        parts = json.loads((directory / "batch.json").read_text())["parts"]
        extra = next(i for i, part in enumerate(parts) if part.get("url") == "https://t.co/abc")
        self.assertEqual(parts[extra]["type"], "link")
        self.assertEqual(parts[extra - 1]["label"], "查看𝕏")
        self.assertEqual(parts[extra - 2]["type"], "image")

    def test_unseen_old_x_posts_are_filtered_and_sent_ids_do_not_replay(self):
        _, _, feed = m.fetch_source_data()
        selected = m.select_announcements(feed["sourcePosts"], self.state)
        self.assertEqual({item["id"] for item in selected}, {post["event_id"] for post in self.snapshot["posts"]})
        state = dict(self.state, sentAnnouncementIds=[item["id"] for item in selected])
        self.assertEqual(m.select_announcements(feed["sourcePosts"], state), [])

    def test_new_x_feed_post_cannot_claim_another_author_or_missing_original_url(self):
        _, _, feed = m.fetch_source_data()
        for changes in (dict(source_author="another_author"), dict(source_url=None)):
            post = copy.deepcopy(feed["sourcePosts"][0])
            post["sourceEvent"].update(changes)
            if "source_url" in changes:
                post["source_url"] = changes["source_url"]
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                m.select_announcements([post], self.state)

    def test_same_x_unknown_history_and_post_keep_evidence_without_conflict(self):
        self.snapshot["events"] = []
        self.add_event(resetType=None, occurredAt="2026-07-28T03:10:00Z")
        self.add_event(kind="tibo", verified=False, resetType=None, id="post-native-id",
                       occurredAt="2026-07-28T03:09:23Z", detail="Source post with t.co link")
        _, _, feed = m.fetch_source_data()
        self.assertEqual(len(feed["events"]), 2)
        self.assertEqual(len({event["sourceEvent"]["source_event_id"] for event in feed["events"]}), 2)

    def test_conflicting_confirmed_duplicate_fails_closed(self):
        self.add_event()
        self.add_event(detail="Conflicting approved source record")
        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            m.fetch_source_data()

    def test_banked_verified_is_announced_not_distributed(self):
        self.clock_complete_fixture()
        self.assertEqual(self.run_monitor(), 0)
        self.current += timedelta(minutes=15)
        self.add_event(resetType="banked", detail="Will be there later")
        self.assertEqual(self.run_monitor(), 0)
        batch = self.sender.call_args.args[0]
        self.assertTrue(all(":announced:" in key for key in batch["deliveredPhaseKeys"]))
        self.assertIsNone(batch["resetId"])

    def test_frozen_pending_blocks_cutover_without_rewriting_files_or_ledger(self):
        self.clock_complete_fixture()
        self.state["pendingBatch"] = dict(batchId="codex-frozen-unknown")
        self.state_file.write_text(json.dumps(self.state))
        before = self.state_file.read_bytes()
        self.sender.return_value = False
        self.assertEqual(self.run_monitor(send_daily=True), 1)
        self.assertEqual(self.state_file.read_bytes(), before)
        self.assertEqual(self.sender.call_args.args[0], self.state["pendingBatch"])
        self.assertNotIn("providerBaseline", self.read_state())

    def test_new_sample_without_structured_preview_cannot_create_synthetic_history(self):
        self.clock_complete_fixture()
        with self.assertRaisesRegex(RuntimeError, "historical reset/preview"):
            m.prepare_dingtalk_sample()
        self.assertFalse((self.state_file.parent / "dingtalk").exists())
        self.sender.assert_not_called()

    def test_snapshot_source_time_and_links_are_not_old_provider(self):
        forecast, _, _ = m.fetch_source_data()
        audit = m.source_audit(forecast)
        self.assertIsNone(audit["sourceTimes"]["predictionGeneratedAt"])
        self.assertEqual(audit["sourceTimes"]["sourceUpdatedAt"], self.snapshot["source_updated_at"])
        self.assertEqual(audit["sourceProvider"]["page"], "https://willcodexreset.com/zh")
        self.assertTrue(audit["sourceCapabilities"]["regular_preview"])
        self.assertIn("https://willcodexreset.com/zh", m.failure_message(ValueError("stale"), 3))

    def test_absent_probability_is_not_replaced_by_zero_or_an_old_forecast(self):
        self.snapshot["forecast"].pop("prob_24")
        self.snapshot["capabilities"]["probability_24h"] = False
        forecast, _, _ = m.fetch_source_data()
        card = m.forecast_card_data(forecast)
        self.assertIsNone(card["probability_24h"])
        self.assertEqual(card["probability_48h"], .82)
        self.assertNotIn("24 小时概率", m.daily_summary(forecast, self.current))

    def group_config(self):
        path = self.state_file.parent / "group.json"
        path.write_text(json.dumps(dict(version=1, openclawRoot="/unused", imageHosting="qq_upload_only",
                                        groupId="cidyHM8LHTEyQHtHoNc12qsUQ==")))
        path.chmod(0o600)
        return path

    def test_new_source_unhealthy_ingestion_leaves_dd_pending_and_qq_untouched(self):
        self.snapshot["signal_status"] = "error"
        original = self.state_file.read_bytes()
        self.assertEqual(self.run_monitor(channel="dingtalk", group_config=self.group_config(),
                                          initialize_on_success=True), 1)
        dd_state = json.loads((self.state_file.parent / "dingtalk/group/state.json").read_text())
        self.assertTrue(dd_state["initializationPending"])
        self.assertIsNone(dd_state["initialized_at"])
        self.assertIsNone(dd_state["daily_summary_date"])
        self.assertIsNone(dd_state.get("pendingBatch"))
        self.assertEqual(self.state_file.read_bytes(), original)
        self.sender.assert_not_called()
        self.warning.assert_not_called()

    def test_new_source_healthy_ingestion_can_initialize_dd_once_without_faking_prediction_time(self):
        old_ingestion = self.snapshot["signal_checked_at"]
        self.snapshot["source_updated_at"] = self.current.isoformat()
        original = self.state_file.read_bytes()
        config = self.group_config()
        self.assertEqual(self.run_monitor(channel="dingtalk", group_config=config,
                                          initialize_on_success=True), 0)
        self.assertEqual(self.run_monitor(channel="dingtalk", group_config=config,
                                          initialize_on_success=True), 0)
        self.assertEqual(self.sender.call_count, 1)
        self.assertEqual(self.sender.call_args.args[0]["announcementIds"], [])
        dd_root = self.state_file.parent / "dingtalk/group"
        dd_state = json.loads((dd_root / "state.json").read_text())
        self.assertFalse(dd_state["initializationPending"])
        self.assertEqual(dd_state["daily_summary_date"], "2026-10-20")
        snapshot_path = next((dd_root / "outbox").glob("*/snapshot.json"))
        snapshot = json.loads(snapshot_path.read_text())
        self.assertIsNone(snapshot["sourceTimes"]["predictionGeneratedAt"])
        self.assertEqual(snapshot["sourceTimes"]["signalCheckedAt"], old_ingestion)
        self.assertIsNone(snapshot["forecastCard"]["updated_at"])
        self.assertEqual(self.state_file.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
