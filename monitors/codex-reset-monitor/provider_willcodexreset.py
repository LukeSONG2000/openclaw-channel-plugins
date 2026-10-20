"""Normalize the public /api/reset-radar response, not the SSR placeholders.

Observed 2026-10-20: the site's routes-DD3qGqQ1.js reads this endpoint and
api-client-CwCPP1Xb.js unwraps code=0/data. This community provider is not OpenAI.
There is no documented forecast-generation timestamp, confidence interval,
promise, or structured preview/distribution stage. Do not synthesize them.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
import re
from typing import Any
from urllib.parse import urlsplit

from source_fetch import fetch_json


PROVIDER_ID = "willcodexreset"
SOURCE_NAME = "Will Codex Reset"
SOURCE_URL = "https://willcodexreset.com/zh"
ENDPOINT = "https://willcodexreset.com/api/reset-radar"


class SourceSchemaError(ValueError):
    """Diagnostics identify only our fixed schema labels, never source content."""


def _timestamp(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SourceSchemaError("source schema: " + field)
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            raise ValueError
    except (ValueError, OverflowError):
        raise SourceSchemaError("source schema: " + field) from None
    return value


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SourceSchemaError("source schema: " + field)
    return value


def _public_url(value: Any) -> str | None:
    if value is None:
        return None
    try:
        parsed = urlsplit(value)
        if (not isinstance(value, str) or parsed.scheme != "https" or not parsed.hostname
                or parsed.username or parsed.password or parsed.port is not None):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise SourceSchemaError("source schema: event.url") from None
    return value


def _x_id(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlsplit(url)
    if parsed.netloc not in ("x.com", "www.x.com", "twitter.com", "www.twitter.com"):
        return None
    match = re.fullmatch(r"/([A-Za-z0-9_]+|i/web)/status/([0-9]+)(?:/)?", parsed.path)
    return match.group(2) if match else None


def _x_author(url: str | None) -> str | None:
    if not _x_id(url):
        return None
    author = urlsplit(url).path.split("/")[1]
    return None if author == "i" else author


def _event(event: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise SourceSchemaError("source schema: event")
    native_id = _text(event.get("id"), "event.id")
    raw_kind = _text(event.get("kind"), "event.kind")
    occurred_at = _timestamp(event.get("occurredAt"), "event.occurredAt")
    title = _text(event.get("title"), "event.title")
    detail = _text(event.get("detail"), "event.detail")
    source_url = _public_url(event.get("url"))
    status_id = _x_id(source_url)
    if "verified" in event and not isinstance(event["verified"], bool):
        raise SourceSchemaError("source schema: event.verified")
    verified = event.get("verified") is True
    native_type = event.get("resetType")
    if native_type is not None and not isinstance(native_type, str):
        raise SourceSchemaError("source schema: event.resetType")
    reset_type = {"usage": "regular", "banked": "banked"}.get(native_type)
    phase = None
    # Candidate confidence, autoDetectedReset, impact and prose are not approvals.
    if raw_kind == "reset" and verified:
        if reset_type == "regular":
            phase = "actual"
        elif reset_type == "banked":
            # Verified banked records also contain future announcements. They do
            # not provide a machine-readable guarantee of completed distribution.
            phase = "announced"
    return dict(event_id=status_id or (PROVIDER_ID + ":" + native_id),
                source_event_id=native_id, x_status_id=status_id,
                source_author=_x_author(source_url),
                occurred_at=occurred_at, source_url=source_url, raw_kind=raw_kind,
                reset_type=reset_type, verified=verified, title=title, detail=detail,
                phase=phase)


def normalize_snapshot(payload: dict[str, Any], *, retrieved_at: str) -> dict[str, Any]:
    """Retain source clocks independently; the caller must apply freshness policy.

    probability24h/48h are direct percentages, not fractions. Missing/null values
    remain absent. updatedAt is only a provider response clock, not evidence of a
    newly ingested signal or an independently published forecast. No cache is read.
    """
    if not isinstance(payload, dict) or type(payload.get("code")) is not int or payload["code"] != 0:
        raise SourceSchemaError("source schema: envelope.code")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise SourceSchemaError("source schema: envelope.data")
    source_updated_at = _timestamp(data.get("updatedAt"), "updatedAt")
    retrieved_at = _timestamp(retrieved_at, "retrieved_at")
    forecast = {"source_updated_at": source_updated_at, "forecast_generated_at": None}
    for hours in (24, 48):
        value = data.get("probability%dh" % hours)
        if value is None:
            continue
        if (type(value) not in (int, float) or not math.isfinite(value)
                or not 0 <= value <= 100):
            raise SourceSchemaError("source schema: probability%dh" % hours)
        forecast["prob_%d" % hours] = value
    if not any(key in forecast for key in ("prob_24", "prob_48")):
        raise SourceSchemaError("source schema: probabilities_missing")
    if "verdict" in data:
        forecast["verdict"] = _text(data["verdict"], "verdict")

    ingestion = data.get("lastIngestion")
    signal_checked_at = None
    signal_status = None
    if ingestion is not None:
        if not isinstance(ingestion, dict):
            raise SourceSchemaError("source schema: lastIngestion")
        if ingestion.get("checkedAt") is not None:
            signal_checked_at = _timestamp(ingestion["checkedAt"], "lastIngestion.checkedAt")
        x = ingestion.get("x")
        if x is not None:
            if not isinstance(x, dict):
                raise SourceSchemaError("source schema: lastIngestion.x")
            if x.get("status") is not None:
                signal_status = _text(x["status"], "lastIngestion.x.status")

    if not isinstance(data.get("events"), list):
        raise SourceSchemaError("source schema: events")
    if "tiboPosts" in data and not isinstance(data["tiboPosts"], list):
        raise SourceSchemaError("source schema: tiboPosts")
    if "tiboRelevantPosts" in data and not isinstance(data["tiboRelevantPosts"], list):
        raise SourceSchemaError("source schema: tiboRelevantPosts")
    events = [_event(event) for event in data["events"]]
    posts = [_event(event) for event in data.get("tiboPosts", [])]
    relevant_posts = [_event(event) for event in data.get("tiboRelevantPosts", [])]
    capabilities = dict(probability_24h="prob_24" in forecast,
                        probability_48h="prob_48" in forecast,
                        x_feed="tiboPosts" in data, regular_actual=True,
                        forecast_generation_time=False,
                        regular_preview=False, banked_distributed=False,
                        banked_announced=True)
    return dict(provider_id=PROVIDER_ID, source_name=SOURCE_NAME, source_url=SOURCE_URL,
                endpoint=ENDPOINT, retrieved_at=retrieved_at,
                source_updated_at=source_updated_at, signal_checked_at=signal_checked_at,
                forecast_generated_at=None,
                signal_status=signal_status, capabilities=capabilities,
                forecast=forecast, events=events, posts=posts, relevant_posts=relevant_posts)


def fetch_snapshot() -> dict[str, Any]:
    """Read the sole authorized HTTP endpoint; never fall back to the old source."""
    payload = fetch_json(ENDPOINT)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    return normalize_snapshot(payload, retrieved_at=retrieved_at)
