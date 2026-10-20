import json
import subprocess
import unittest
from unittest.mock import patch

import source_fetch as source


URL = "https://willcodexreset.com/api/reset-radar"


def response(status=200, body=b'{}', code=0):
    return subprocess.CompletedProcess([], code,
                                       body + source.HTTP_MARKER + str(status).encode(),
                                       b"private proxy diagnostic token=DO_NOT_LEAK")


class SourceFetchTests(unittest.TestCase):
    def setUp(self):
        runner = patch.object(source.subprocess, "run")
        sleeper = patch.object(source.time, "sleep")
        self.run = runner.start()
        self.sleep = sleeper.start()
        self.addCleanup(runner.stop)
        self.addCleanup(sleeper.stop)

    def test_success_returns_original_data_without_normalizing_events(self):
        payload = {"events": [{"reset_kind": "banked", "preview": True}],
                   "fetched_at": "2026-10-19T10:00:00Z", "prob_24": 25}
        self.run.return_value = response(body=json.dumps(payload).encode())
        self.assertEqual(source.fetch_json(URL), payload)
        self.assertEqual(self.run.call_count, 1)
        self.sleep.assert_not_called()

    def test_authorized_endpoint(self):
        self.run.return_value = response()
        for path in source.SOURCE_PATHS:
            self.assertEqual(source.fetch_json("https://willcodexreset.com" + path), {})

    def test_curl_scope_and_time_budget(self):
        self.run.return_value = response()
        source.fetch_json(URL)
        args, kwargs = self.run.call_args
        command = args[0]
        self.assertEqual(command[:3], ["curl", "--disable", "--ipv4"])
        self.assertEqual(command[command.index("--proto") + 1], "=https")
        self.assertEqual(command[command.index("--max-time") + 1], "20")
        self.assertEqual(command[command.index("--connect-timeout") + 1], "5")
        self.assertEqual(command[-1], URL)
        self.assertNotIn("--location", command)
        self.assertNotIn("--insecure", command)
        self.assertNotIn("--retry", command)
        self.assertNotIn("env", kwargs)
        self.assertEqual(kwargs["timeout"], 25)
        self.assertEqual(source.MAX_CALL_SECONDS, 81)

    def test_transient_http_retries_then_returns_fresh_response(self):
        for status in sorted(source.RETRY_HTTP):
            with self.subTest(status=status):
                self.run.reset_mock()
                self.sleep.reset_mock()
                self.run.side_effect = [response(status, b"outage", 22),
                                        response(body=b'{"fresh": true}')]
                self.assertEqual(source.fetch_json(URL), {"fresh": True})
                self.assertEqual(self.run.call_count, 2)
                self.sleep.assert_called_once_with(2)

    def test_persistent_502_has_bounded_attempts_and_safe_diagnostics(self):
        self.run.return_value = response(502, b"DO_NOT_LEAK", 22)
        with self.assertRaises(source.SourceFetchError) as caught:
            source.fetch_json(URL)
        error = caught.exception
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual((error.kind, error.http_status, error.curl_exit, error.attempts),
                         ("http", 502, 22, 3))
        self.assertEqual(self.run.call_count, 3)
        self.assertEqual([call.args for call in self.sleep.call_args_list], [(2,), (4,)])
        self.assertNotIn("DO_NOT_LEAK", str(error))
        self.assertIn("http=502", str(error))

    def test_permanent_http_and_redirect_do_not_retry(self):
        for status in (201, 204, 301, 302, 400, 401, 403, 404, 407, 410, 501):
            with self.subTest(status=status):
                self.run.reset_mock()
                self.run.return_value = response(status, code=22)
                with self.assertRaises(source.SourceFetchError) as caught:
                    source.fetch_json(URL)
                self.assertEqual(caught.exception.http_status, status)
                self.assertEqual(self.run.call_count, 1)
        self.sleep.assert_not_called()

    def test_transient_curl_errors_retry(self):
        for code in sorted(source.RETRY_CURL):
            with self.subTest(code=code):
                self.run.reset_mock()
                self.run.side_effect = [response(0, code=code), response()]
                self.assertEqual(source.fetch_json(URL), {})
                self.assertEqual(self.run.call_count, 2)

    def test_certificate_or_local_curl_failure_is_not_retried(self):
        for code in (2, 3, 23, 60, 63, 77):
            with self.subTest(code=code):
                self.run.reset_mock()
                self.run.return_value = response(0, code=code)
                with self.assertRaises(source.SourceFetchError) as caught:
                    source.fetch_json(URL)
                self.assertEqual(caught.exception.curl_exit, code)
                self.assertEqual(self.run.call_count, 1)
        self.sleep.assert_not_called()

    def test_timeout_diagnostics_are_sanitized_and_bounded(self):
        self.run.side_effect = subprocess.TimeoutExpired(["private-proxy"], 25,
                                                        output=b"DO_NOT_LEAK")
        with self.assertRaises(source.SourceFetchError) as caught:
            source.fetch_json(URL)
        self.assertEqual(caught.exception.kind, "process_timeout")
        self.assertEqual(caught.exception.attempts, 3)
        self.assertNotIn("DO_NOT_LEAK", str(caught.exception))
        self.assertEqual(self.run.call_count, 3)

    def test_missing_curl_is_client_environment_not_site_failure(self):
        self.run.side_effect = FileNotFoundError("DO_NOT_LEAK")
        with self.assertRaises(source.SourceFetchError) as caught:
            source.fetch_json(URL)
        self.assertEqual(caught.exception.kind, "client_environment")
        self.assertNotIn("DO_NOT_LEAK", str(caught.exception))
        self.assertEqual(self.run.call_count, 1)

    def test_invalid_json_and_non_object_never_retry(self):
        for body, kind in [(b"error code: 502", "invalid_json"),
                           (b"\xff", "invalid_json"),
                           (b'{"p": NaN}', "invalid_json"),
                           (b'{"p": Infinity}', "invalid_json"),
                           (b"[]", "json_root"), (b"null", "json_root")]:
            with self.subTest(body=body):
                self.run.reset_mock()
                self.run.return_value = response(body=body)
                with self.assertRaises(source.SourceFetchError) as caught:
                    source.fetch_json(URL)
                self.assertEqual(caught.exception.kind, kind)
                self.assertEqual(self.run.call_count, 1)
        self.sleep.assert_not_called()

    def test_empty_object_returned_for_caller_schema_validation(self):
        self.run.return_value = response()
        self.assertEqual(source.fetch_json(URL), {})

    def test_incomplete_body_does_not_become_success(self):
        self.run.side_effect = [response(200, b'{"partial":', 18)] * 3
        with self.assertRaises(source.SourceFetchError) as caught:
            source.fetch_json(URL)
        self.assertEqual(caught.exception.kind, "network")
        self.assertEqual(caught.exception.http_status, 200)
        self.assertEqual(caught.exception.attempts, 3)

    def test_missing_http_metadata_is_not_success(self):
        self.run.return_value = subprocess.CompletedProcess([], 0, b'{"old": true}', b"")
        with self.assertRaises(source.SourceFetchError) as caught:
            source.fetch_json(URL)
        self.assertEqual(caught.exception.kind, "http_metadata")
        self.assertEqual(self.run.call_count, 1)

    def test_invalid_urls_never_reach_curl_or_leak_credentials(self):
        for url in ["http://willcodexreset.com/api/reset-radar", "https://evil.test/api/reset-radar",
                    "https://user:DO_NOT_LEAK@willcodexreset.com/api/reset-radar",
                    URL + "?token=DO_NOT_LEAK", URL + "#DO_NOT_LEAK",
                    "https://willcodexreset.com/developers", "--config=DO_NOT_LEAK", None,
                    "https://willreset.com/api/forecast", "https://willreset.com/api/notify",
                    "https://willreset.com/api/feed", "https://willcodexreset.com/api/forecast",
                    "https://willcodexreset.com:443/api/reset-radar"]:
            with self.subTest(url=url):
                with self.assertRaises(source.SourceFetchError) as caught:
                    source.fetch_json(url)
                self.assertEqual(caught.exception.kind, "invalid_url")
                self.assertNotIn("DO_NOT_LEAK", str(caught.exception))
        self.run.assert_not_called()
        self.sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
