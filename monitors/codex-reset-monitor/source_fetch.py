"""Fetch current willreset REST data without cache or alternate-source fallback.

The caller must still validate schema, freshness and reset confirmation. This
module never updates monitor health, delivery state, or notification watermarks.
"""

from __future__ import annotations

import json
import subprocess
import time
from typing import Any, Optional
from urllib.parse import urlsplit


MAX_ATTEMPTS = 3
CONNECT_TIMEOUT = 5
TRANSFER_TIMEOUT = 20
PROCESS_TIMEOUT = 25
RETRY_DELAYS = (2, 4)
MAX_CALL_SECONDS = MAX_ATTEMPTS * PROCESS_TIMEOUT + sum(RETRY_DELAYS)
RETRY_HTTP = frozenset((408, 425, 429, 500, 502, 503, 504))
RETRY_CURL = frozenset((5, 6, 7, 18, 28, 35, 52, 55, 56, 92))
SOURCE_PATHS = frozenset(("/api/forecast", "/api/notify", "/api/feed"))
HTTP_MARKER = b"\nSOURCE_FETCH_HTTP:"


class SourceFetchError(RuntimeError):
    """Safe diagnostics: never include response bodies, stderr or proxy URLs."""

    def __init__(self, kind: str, endpoint: str = "source", *,
                 http_status: Optional[int] = None,
                 curl_exit: Optional[int] = None, attempts: int = 0):
        self.kind = kind
        self.http_status = http_status
        self.curl_exit = curl_exit
        self.attempts = attempts
        # Endpoint is selected from the allowlist, never copied from user input.
        endpoint = endpoint if endpoint in SOURCE_PATHS else "source"
        fields = [f"source fetch {endpoint}", f"kind={kind}", f"attempts={attempts}"]
        if http_status is not None:
            fields.append(f"http={http_status}")
        if curl_exit is not None:
            fields.append(f"curl_exit={curl_exit}")
        super().__init__(" ".join(fields))


def _endpoint(url: str) -> str:
    try:
        parsed = urlsplit(url)
        if (parsed.scheme == "https" and parsed.netloc == "willreset.com"
                and parsed.path in SOURCE_PATHS and not parsed.query
                and not parsed.fragment):
            return parsed.path
    except (TypeError, ValueError, AttributeError):
        pass
    raise SourceFetchError("invalid_url") from None


def _reject_constant(value: str) -> None:
    raise ValueError("non-finite JSON number")


def fetch_json(url: str) -> dict[str, Any]:
    """Return a newly fetched JSON object or raise SourceFetchError.

    IPv4/HTTPS only; system proxy environment is left unchanged. No redirects,
    cache, browser, other endpoint or stale-data fallback. Transient HTTP and
    network failures get at most three attempts (25s process limit each, with
    2s/4s backoff: 81s nominal maximum). Invalid JSON and permanent errors stop
    immediately. A successful object is not proof of freshness or health.
    """
    endpoint = _endpoint(url)
    command = [
        "curl", "--disable", "--ipv4", "--fail", "--silent", "--show-error",
        "--proto", "=https", "--connect-timeout", str(CONNECT_TIMEOUT),
        "--max-time", str(TRANSFER_TIMEOUT), "--header", "Accept: application/json",
        "--user-agent", "OpenClaw-CodexResetMonitor/1.0",
        "--write-out", HTTP_MARKER.decode("ascii") + "%{http_code}", url,
    ]
    for attempt in range(1, MAX_ATTEMPTS + 1):
        retryable = False
        try:
            result = subprocess.run(command, capture_output=True,
                                    timeout=PROCESS_TIMEOUT, check=False)
        except subprocess.TimeoutExpired:
            error = SourceFetchError("process_timeout", endpoint, attempts=attempt)
            retryable = True
        except OSError:
            raise SourceFetchError("client_environment", endpoint,
                                   attempts=attempt) from None
        else:
            body, marker, status_bytes = result.stdout.rpartition(HTTP_MARKER)
            status = (int(status_bytes) if marker and len(status_bytes) == 3
                      and status_bytes.isdigit() else 0)
            http_status = status or None
            if status and status != 200:
                error = SourceFetchError("http", endpoint, http_status=status,
                                         curl_exit=result.returncode, attempts=attempt)
                retryable = status in RETRY_HTTP
            elif result.returncode:
                error = SourceFetchError("network" if result.returncode in RETRY_CURL
                                         else "curl", endpoint, http_status=http_status,
                                         curl_exit=result.returncode, attempts=attempt)
                retryable = result.returncode in RETRY_CURL
            elif status != 200:
                error = SourceFetchError("http_metadata", endpoint, attempts=attempt)
            else:
                try:
                    payload = json.loads(body.decode("utf-8-sig"),
                                         parse_constant=_reject_constant)
                except (ValueError, UnicodeError):
                    raise SourceFetchError("invalid_json", endpoint,
                                           http_status=200, attempts=attempt) from None
                if not isinstance(payload, dict):
                    raise SourceFetchError("json_root", endpoint,
                                           http_status=200, attempts=attempt) from None
                return payload
        if not retryable or attempt == MAX_ATTEMPTS:
            raise error from None
        time.sleep(RETRY_DELAYS[attempt - 1])
    raise AssertionError("unreachable")
