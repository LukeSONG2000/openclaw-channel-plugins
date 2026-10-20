import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import provider_willcodexreset as provider
from source_fetch import SourceFetchError


FIXTURE = Path(__file__).parent / "fixtures" / "willcodexreset-radar-20261020.json"
RETRIEVED_AT = "2026-10-20T02:04:23+00:00"


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.payload = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def normalize(self):
        return provider.normalize_snapshot(self.payload, retrieved_at=RETRIEVED_AT)

    def event(self, native_id):
        return next(event for event in self.normalize()["events"]
                    if event["source_event_id"] == native_id)

    def test_captured_direct_percentages_not_inferred_or_rescaled(self):
        snapshot = self.normalize()
        self.assertEqual(snapshot["forecast"]["prob_24"], 72)
        self.assertEqual(snapshot["forecast"]["prob_48"], 82)
        self.assertTrue(snapshot["capabilities"]["probability_24h"])
        self.assertTrue(snapshot["capabilities"]["probability_48h"])
        self.assertEqual(snapshot["source_name"], "Will Codex Reset")
        self.assertEqual(snapshot["source_url"], "https://willcodexreset.com/zh")

    def test_source_clocks_are_distinct_and_no_forecast_clock_is_invented(self):
        snapshot = self.normalize()
        self.assertEqual(snapshot["retrieved_at"], RETRIEVED_AT)
        self.assertEqual(snapshot["source_updated_at"], "2026-10-20T02:04:22.949Z")
        self.assertEqual(snapshot["signal_checked_at"], "2026-10-19T19:45:40.146Z")
        self.assertEqual(snapshot["signal_status"], "ok")
        self.assertIsNone(snapshot["forecast_generated_at"])
        self.assertIsNone(snapshot["forecast"]["forecast_generated_at"])
        self.assertFalse(snapshot["capabilities"]["forecast_generation_time"])

    def test_missing_and_null_24h_remain_absent_not_zero_or_48h_derivation(self):
        for null in (True, False):
            with self.subTest(null=null):
                self.setUp()
                if null:
                    self.payload["data"]["probability24h"] = None
                else:
                    del self.payload["data"]["probability24h"]
                snapshot = self.normalize()
                self.assertNotIn("prob_24", snapshot["forecast"])
                self.assertFalse(snapshot["capabilities"]["probability_24h"])
                self.assertEqual(snapshot["forecast"]["prob_48"], 82)

    def test_missing_48h_is_not_derived_from_24h(self):
        del self.payload["data"]["probability48h"]
        snapshot = self.normalize()
        self.assertNotIn("prob_48", snapshot["forecast"])
        self.assertFalse(snapshot["capabilities"]["probability_48h"])

    def test_zero_is_valid_not_missing(self):
        self.payload["data"]["probability24h"] = 0
        self.assertEqual(self.normalize()["forecast"]["prob_24"], 0)

    def test_invalid_probabilities_fail_not_clamp(self):
        for value in (True, "72", -1, 101, float("nan"), float("inf"), [], {}):
            with self.subTest(value=value):
                self.payload["data"]["probability24h"] = value
                with self.assertRaisesRegex(provider.SourceSchemaError, "probability24h"):
                    self.normalize()

    def test_both_probabilities_missing_is_not_ssr_zero(self):
        self.payload["data"]["probability24h"] = None
        self.payload["data"]["probability48h"] = None
        with self.assertRaisesRegex(provider.SourceSchemaError, "probabilities_missing"):
            self.normalize()

    def test_real_regular_confirmation_uses_verified_kind_and_type(self):
        event = self.event("manual-ca2d88b7-8103-450f-ac6e-1c5e99ee4096")
        self.assertEqual(event["reset_type"], "regular")
        self.assertEqual(event["phase"], "actual")
        self.assertEqual(event["event_id"], "2111566005684289735")
        self.assertEqual(event["occurred_at"], "2026-10-17T21:12:00.000Z")
        self.assertEqual(event["source_url"], "https://x.com/thsottiaux/status/2111566005684289735")

    def test_old_dedupe_x_id_preserved_separately_from_native_id(self):
        event = self.event("approved-tibo-2109132167112782291")
        self.assertEqual(event["event_id"], "2109132167112782291")
        self.assertEqual(event["x_status_id"], "2109132167112782291")
        self.assertEqual(event["source_event_id"], "approved-tibo-2109132167112782291")

    def test_manual_record_without_url_is_not_given_a_fake_x_url(self):
        event = self.event("manual-fd64e0a7-0f2d-4f7e-8e6d-02bc2ff372c4")
        self.assertIsNone(event["x_status_id"])
        self.assertIsNone(event["source_url"])
        self.assertEqual(event["event_id"], "willcodexreset:manual-fd64e0a7-0f2d-4f7e-8e6d-02bc2ff372c4")

    def test_candidate_confidence_and_usage_type_are_not_reset_confirmation(self):
        event = self.event("tibo-2112034063934742720")
        self.assertEqual(event["reset_type"], "regular")
        self.assertFalse(event["verified"])
        self.assertIsNone(event["phase"])

    def test_banked_loading_impact100_is_not_distribution_or_typed_preview(self):
        event = self.event("tibo-2107913674593644711")
        self.assertEqual(event["reset_type"], "banked")
        self.assertIsNone(event["phase"])
        self.assertFalse(self.normalize()["capabilities"]["banked_distributed"])

    def test_verified_banked_including_future_text_only_announced(self):
        for native_id in ("manual-c71c7600-489e-449b-b20e-3153dad8f992",
                          "manual-5a2fce1d-a622-4b9d-a26c-6e2c81692ed5"):
            event = self.event(native_id)
            self.assertEqual((event["reset_type"], event["phase"]), ("banked", "announced"))

    def test_missing_or_unknown_type_never_defaults_to_regular(self):
        original = self.payload["data"]["events"][0]
        for reset_type in (None, "unknown", "regular", "hard"):
            event = copy.deepcopy(original)
            event["resetType"] = reset_type
            self.payload["data"]["events"] = [event]
            normalized = self.normalize()["events"][0]
            self.assertIsNone(normalized["reset_type"])
            self.assertIsNone(normalized["phase"])
        del event["resetType"]
        self.payload["data"]["events"] = [event]
        self.assertIsNone(self.normalize()["events"][0]["phase"])

    def test_title_or_text_does_not_invent_approval_or_phase(self):
        event = self.payload["data"]["events"][0]
        event.update(title="All reset!", detail="Done. All propagated.", verified=False,
                     autoDetectedReset=True, autoApprovalEligible=True,
                     resetCandidateConfidence=1, impact=100)
        self.payload["data"]["events"] = [event]
        self.assertIsNone(self.normalize()["events"][0]["phase"])

    def test_truthy_verified_string_is_invalid(self):
        self.payload["data"]["events"][0]["verified"] = "true"
        with self.assertRaisesRegex(provider.SourceSchemaError, "event.verified"):
            self.normalize()

    def test_posts_and_related_subset_preserve_their_actual_provenance(self):
        snapshot = self.normalize()
        self.assertEqual(len(snapshot["posts"]), 2)
        self.assertEqual(len(snapshot["relevant_posts"]), 3)
        self.assertTrue(all(post["source_author"] == "thsottiaux" for post in snapshot["posts"]))
        self.assertTrue(all(post["raw_kind"] == "tibo" for post in snapshot["posts"]))
        self.assertTrue(all(post["phase"] is None for post in snapshot["relevant_posts"]))

    def test_non_tibo_x_url_not_assigned_tibo_author(self):
        self.payload["data"]["tiboPosts"][0]["url"] = "https://x.com/other_author/status/123"
        self.assertEqual(self.normalize()["posts"][0]["source_author"], "other_author")

    def test_non_x_url_never_produces_an_x_dedupe_id(self):
        self.payload["data"]["events"][0]["url"] = "https://example.com/thsottiaux/status/123"
        event = self.normalize()["events"][0]
        self.assertIsNone(event["x_status_id"])
        self.assertIsNone(event["source_author"])

    def test_missing_ingestion_or_feed_not_replaced_with_local_time_or_events(self):
        del self.payload["data"]["lastIngestion"]
        del self.payload["data"]["tiboPosts"]
        snapshot = self.normalize()
        self.assertIsNone(snapshot["signal_checked_at"])
        self.assertIsNone(snapshot["signal_status"])
        self.assertFalse(snapshot["capabilities"]["x_feed"])
        self.assertEqual(snapshot["posts"], [])

    def test_incomplete_ingestion_preserves_missing_status_and_clock(self):
        self.payload["data"]["lastIngestion"] = {"x": {}}
        snapshot = self.normalize()
        self.assertIsNone(snapshot["signal_status"])
        self.assertIsNone(snapshot["signal_checked_at"])

    def test_failed_ingestion_status_is_not_hidden(self):
        self.payload["data"]["lastIngestion"]["x"]["status"] = "error"
        self.assertEqual(self.normalize()["signal_status"], "error")

    def test_no_legacy_confidence_promise_or_confirmation_fields_invented(self):
        forecast = self.normalize()["forecast"]
        for field in ("confidence", "range_24", "range_48", "promise", "last_reset_id",
                      "last_reset_at", "computed_at", "live_fetched_at", "factors"):
            self.assertNotIn(field, forecast)

    def test_timestamps_must_be_present_and_timezone_aware(self):
        for value in (None, "", "2026-10-20T02:04:23", "bad DO_NOT_LEAK", 42):
            self.payload["data"]["updatedAt"] = value
            with self.assertRaises(provider.SourceSchemaError) as caught:
                self.normalize()
            self.assertNotIn("DO_NOT_LEAK", str(caught.exception))

    def test_bad_envelope_never_exposes_source_error_message(self):
        for code in (None, True, "0", 1):
            self.payload["code"] = code
            self.payload["message"] = "DO_NOT_LEAK"
            with self.assertRaises(provider.SourceSchemaError) as caught:
                self.normalize()
            self.assertNotIn("DO_NOT_LEAK", str(caught.exception))

    def test_array_schema_changes_fail_closed(self):
        for key in ("events", "tiboPosts", "tiboRelevantPosts"):
            with self.subTest(key=key):
                self.setUp()
                self.payload["data"][key] = {}
                with self.assertRaises(provider.SourceSchemaError):
                    self.normalize()

    def test_input_not_mutated(self):
        original = copy.deepcopy(self.payload)
        self.normalize()
        self.assertEqual(self.payload, original)

    def test_fetch_uses_only_the_new_endpoint_once(self):
        with patch.object(provider, "fetch_json", return_value=self.payload) as fetch:
            snapshot = provider.fetch_snapshot()
        fetch.assert_called_once_with(provider.ENDPOINT)
        self.assertEqual(snapshot["provider_id"], "willcodexreset")
        self.assertIsNone(snapshot["forecast_generated_at"])

    def test_fetch_failure_has_no_old_source_or_cache_fallback(self):
        with patch.object(provider, "fetch_json", side_effect=SourceFetchError("http")) as fetch:
            with self.assertRaises(SourceFetchError):
                provider.fetch_snapshot()
        fetch.assert_called_once_with(provider.ENDPOINT)


if __name__ == "__main__":
    unittest.main()
