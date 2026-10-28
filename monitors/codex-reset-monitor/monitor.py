#!/usr/bin/env python3
"""Monitor public Codex reset signals from Will Codex Reset only."""

from __future__ import annotations

import argparse
import hashlib
import fcntl
import json
import math
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from source_fetch import fetch_json
from announcement_content import announcement_content
import provider_willcodexreset as provider
from preview_time import interpret_preview_time


SOURCE_URL = "https://willcodexreset.com/zh"
SOURCE_PAGE = SOURCE_URL
TIMEZONE_URL = "https://time.ms/zh-cn/utc+8/"
OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"
SHANGHAI = ZoneInfo("Asia/Shanghai")
ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"
STATE_FILE = STATE_DIR / "state.json"
LOCK_FILE = STATE_DIR / "monitor.lock"
PUSH_SCRIPT = ROOT / "send-openclaw-qq.mjs"
FAILURE_THRESHOLD = 3
MAX_NOTIFIED_IDS = 100
MAX_SOURCE_AGE = timedelta(hours=2)
MAX_CLOCK_SKEW = timedelta(minutes=5)
RENDER_TIMEOUT = 180
SEND_TIMEOUT = 600
GROUP_CONFIG: Path | None = None
GROUP_ID_SHA256 = "0d5f2f5090f8d0e2400b314bbd47f2607f4a922037b89cf4854ed6e87971e744"
GROUP_TARGET_SHA256 = "83586e66a30c9dc2cba735eb540c5fe84c82cd436e827a3019e854ed49984b17"


@contextmanager
def dingtalk_runtime(config: Path):
    """Scope the existing single-process pipeline to a separate group ledger."""
    global STATE_FILE, GROUP_CONFIG, PUSH_SCRIPT
    config = Path(config).resolve()
    if GROUP_CONFIG is not None:
        if config != GROUP_CONFIG:
            raise ValueError("cannot nest a different DingTalk target")
        yield
        return
    previous = STATE_FILE, GROUP_CONFIG, PUSH_SCRIPT
    STATE_FILE = STATE_FILE.parent / "dingtalk" / "group" / "state.json"
    GROUP_CONFIG = config
    PUSH_SCRIPT = ROOT / "send-dingtalk.mjs"
    try:
        yield
    finally:
        STATE_FILE, GROUP_CONFIG, PUSH_SCRIPT = previous


def group_binding() -> dict[str, str]:
    config = json.loads(GROUP_CONFIG.read_text(encoding="utf-8"))
    if (GROUP_CONFIG.stat().st_mode & 0o077 or config.get("version") != 1
            or config.get("imageHosting") != "qq_upload_only"
            or not isinstance(config.get("groupId"), str)
            or hashlib.sha256(config["groupId"].encode()).hexdigest() != GROUP_ID_SHA256):
        raise ValueError("invalid or unpinned DingTalk group configuration")
    return dict(channel="dingtalk", groupIdSha256=GROUP_ID_SHA256, targetSha256=GROUP_TARGET_SHA256)


class ResetPhaseEvent(TypedDict):
    eventId: str
    resetType: Literal["regular", "banked"]
    phase: Literal["preview", "actual", "upcoming", "distributed", "announced"]
    announcedAt: str


PHASE_TITLES = {
    ("regular", "preview"): "Codex确认重置！",
    ("regular", "actual"): "Codex已重置，速蹬！",
    ("banked", "upcoming"): "Codex重置卡即将发放！",
    ("banked", "distributed"): "Codex重置卡已发放！",
    ("banked", "announced"): "Codex已公布重置卡消息！",
}
PHASE_DETAILS = {
    ("regular", "preview"): "常规重置（regular）｜已预告，尚未到账",
    ("regular", "actual"): "常规重置（regular）｜已到账",
    ("banked", "upcoming"): "重置卡发放（banked）｜即将发放，尚未确认发放",
    ("banked", "distributed"): "重置卡发放（banked）｜来源已发放，不代表个人到账",
    ("banked", "announced"): "重置卡消息（banked）｜仅公告，未确认发放阶段",
}


def phase_event_key(event: ResetPhaseEvent) -> str:
    if ((event.get("resetType"), event.get("phase")) not in PHASE_TITLES
            or not isinstance(event.get("eventId"), str) or not event["eventId"].strip()):
        raise ValueError("invalid typed reset phase event")
    aware_time(event.get("announcedAt"), "phase.announcedAt")
    return f"{event['resetType']}:{event['phase']}:{event['eventId']}"


def primary_phase(phases: list[ResetPhaseEvent]) -> ResetPhaseEvent | None:
    for phase in phases:
        phase_event_key(phase)
    if not phases:
        return None
    return max(phases, key=lambda phase: (aware_time(phase["announcedAt"], "phase.announcedAt"),
                                         phase["phase"] in ("actual", "distributed")))


def batch_phase_title(phases: list[ResetPhaseEvent], daily: bool = False) -> str:
    latest = primary_phase(phases)
    if latest is None or (daily and latest["phase"] not in ("actual", "distributed")):
        return "Codex会重置吗？"
    return PHASE_TITLES[(latest["resetType"], latest["phase"])]


def classify_reset_phase(event: dict[str, Any], forecast: dict[str, Any],
                         notify: dict[str, Any]) -> ResetPhaseEvent | None:
    if "sourceSnapshot" in forecast:
        source_event = event["sourceEvent"]
        reset_type, phase = source_event["reset_type"], source_event["phase"]
        if (reset_type, phase) not in PHASE_TITLES:
            return None
        result = dict(eventId=event["id"], resetType=reset_type, phase=phase,
                      announcedAt=event["announced_at"])
        phase_event_key(result)
        return result
    kind, reset_kind = event["kind"], event.get("reset_kind")
    tags = event.get("tags") or []
    banked = kind == "banked" or reset_kind == "banked" or "banked" in tags
    phase = None
    reset_type = "banked" if banked else "regular"
    if banked:
        if kind == "banked":
            state = event.get("banked_state")
            if state == "available" and event.get("preview") is False:
                phase = "distributed"
            elif state == "arriving":
                phase = "upcoming"
            elif state == "announced":
                phase = "announced"
        elif (kind == "reset_preview" and "banked" in tags and event.get("preview") is True
              and event.get("banked_state") in (None, "", "unknown")):
            phase = "upcoming"
    elif (reset_kind == "hard" or (reset_kind in (None, "")
          and ("regular" in tags or (kind == "reset_preview" and event.get("preview") is True)))):
        if kind == "reset_preview" and event.get("preview") is True:
            phase = "preview"
        elif (kind == "reset" and event.get("preview") is False
              and event["id"] == confirmed_reset_id(forecast, notify)
              and event["announced_at"] == forecast["last_reset_at"] == notify["last_reset_at"]
              and event.get("source_url") == forecast.get("last_reset_url") == notify.get("last_reset_url")):
            phase = "actual"
    if phase is None:
        return None
    result = dict(eventId=event["id"], resetType=reset_type, phase=phase, announcedAt=event["announced_at"])
    phase_event_key(result)
    return result


def initialize_phase_state(state: dict[str, Any], phases: list[ResetPhaseEvent], fresh: bool = False) -> None:
    if state.get("phaseSchemaVersion") == 1:
        return
    lower = aware_time(state["migrationLowerBound"], "migrationLowerBound")
    anchor = (parse_time(state.get("initialized_at")) if fresh else
              parse_time(state.get("lastSuccessfulPushAt"))
              or parse_time(state.get("migrationEvidence", {}).get("observedSuccessAt"))) or lower
    state["phaseSchemaVersion"] = 1
    state["phaseBaselineAt"] = anchor.isoformat()
    state["phaseBaselineKeys"] = [phase_event_key(p) for p in phases
                                  if lower <= aware_time(p["announcedAt"], "phase.announcedAt") <= anchor]
    state.setdefault("deliveredPhaseKeys", [])


def pending_phase_events(phases: list[ResetPhaseEvent], state: dict[str, Any]) -> list[ResetPhaseEvent]:
    lower = aware_time(state["migrationLowerBound"], "migrationLowerBound")
    seen = set(state.get("deliveredPhaseKeys", [])) | set(state.get("phaseBaselineKeys", []))
    pending = []
    for phase in phases:
        if provider_phase_suppressed(phase, state):
            continue
        known_baseline = (phase["eventId"] in state.get("groupBaselineEventIds", [])
                          or phase["eventId"] in state.get("providerBaseline", {}).get("eventIds", []))
        if ((aware_time(phase["announcedAt"], "phase.announcedAt") < lower and not known_baseline)
                or phase_event_key(phase) in seen):
            continue
        if phase["resetType"] == "regular" and phase["phase"] == "actual":
            if (phase["eventId"] == state.get("baselineResetId")
                    or reset_is_older_than_state(phase["eventId"], phase["announcedAt"], state)):
                continue
        pending.append(phase)
    return pending


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        # Python 3.9 requires 3 or 6 fraction digits; normalize Go/API precision to 6.
        normalized = value.strip().replace("Z", "+00:00")
        normalized = re.sub(
            r"(\d{2}:\d{2}:\d{2})\.(\d+)(?=[+-]|$)",
            lambda match: match[1] + "." + match[2][:6].ljust(6, "0"), normalized, count=1,
        )
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def format_shanghai(value: Any) -> str:
    parsed = parse_time(value)
    if not parsed or parsed.year <= 1:
        return "暂无"
    return parsed.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M")


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    directory = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def load_state(path: Path | None = None) -> dict[str, Any]:
    path = STATE_FILE if path is None else path
    if not path.exists():
        return {
            "version": 1,
            "initialized_at": None,
            "last_reset_id": None,
            "daily_summary_date": None,
            "notified_reset_ids": [],
            "consecutive_fetch_failures": 0,
            "failure_notified": False,
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    raise RuntimeError(f"状态文件损坏：{path}")


def valid_percent(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 <= value <= 100)


def validate_source_snapshot(snapshot: dict[str, Any]) -> None:
    if (snapshot.get("provider_id") != provider.PROVIDER_ID
            or snapshot.get("source_url") != SOURCE_PAGE
            or snapshot.get("endpoint") != provider.ENDPOINT):
        raise ValueError("source provider identity mismatch")
    current = now_utc()
    for field in ("source_updated_at", "signal_checked_at"):
        stamp = aware_time(snapshot.get(field), "source." + field)
        # checkedAt is an ingestion observation, not a forecast expiry clock.
        if ((field == "source_updated_at" and current - stamp > MAX_SOURCE_AGE)
                or stamp - current > MAX_CLOCK_SKEW):
            raise ValueError(f"source.{field}: stale or future source timestamp")
    if snapshot.get("signal_status") != "ok":
        raise ValueError("source.signal_status: ingestion is not healthy")
    # This provider has no independent prediction clock. Preserve that absence;
    # it is not a reason to discard otherwise valid source/event observations.
    if snapshot.get("forecast_generated_at") is not None:
        stamp = aware_time(snapshot["forecast_generated_at"], "source.forecast_generated_at")
        if current - stamp > MAX_SOURCE_AGE or stamp - current > MAX_CLOCK_SKEW:
            raise ValueError("source.forecast_generated_at: stale or future prediction timestamp")
    # Retrieval is audit evidence, never a substitute for either source clock.
    aware_time(snapshot.get("retrieved_at"), "source.retrieved_at")


def fetch_source_data() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    snapshot = provider.fetch_snapshot()
    forecast = dict(snapshot["forecast"], sourceSnapshot=snapshot)
    unique = {}
    for event in snapshot["events"]:
        stamp = aware_time(event["occurred_at"], "event.occurred_at")
        if stamp > now_utc() + MAX_CLOCK_SKEW:
            raise ValueError("event.occurred_at: future source event")
        # Unclassified records may be a manual history row and its original post.
        # Keep both as evidence; neither is eligible to produce an announcement.
        key = event["event_id"], event["phase"] or event["source_event_id"]
        previous = unique.get(key)
        if previous and any(previous[field] != event[field] for field in (
                "occurred_at", "reset_type", "detail", "source_url", "raw_kind", "forecast_signal")):
            raise ValueError("source.events: conflicting duplicate event identity/phase")
        unique[key] = event
    events = [dict(id=event["event_id"], kind=event["raw_kind"], summary=event["detail"],
                   announced_at=event["occurred_at"], source_url=event["source_url"], sourceEvent=event)
              for event in unique.values()]
    events.sort(key=lambda event: aware_time(event["announced_at"], "event.announced_at"), reverse=True)
    # X content is independent of reset approvals: attach it to a daily/reset
    # delivery, but never use an ordinary post as a reset notification trigger.
    posts = {}
    for field, source_feed in (("posts", "tiboPosts"), ("relevant_posts", "tiboRelevantPosts")):
        for post in snapshot[field]:
            stamp = aware_time(post["occurred_at"], "post.occurred_at")
            if stamp > now_utc() + MAX_CLOCK_SKEW:
                raise ValueError("post.occurred_at: future source post")
            key = post["event_id"]
            previous = posts.get(key)
            if previous and any(previous["sourceEvent"][name] != post[name]
                                for name in ("occurred_at", "detail", "source_author")):
                raise ValueError("source.posts: conflicting duplicate original post")
            posts.setdefault(key, dict(id=key, kind="动态", summary=post["detail"],
                                       announced_at=post["occurred_at"], source_url=post["source_url"],
                                       sourceEvent=post, sourceFeed=source_feed))
    # These are internal pipeline projections, not fabricated legacy API responses.
    feed = dict(events=events, sourcePosts=list(posts.values()),
                fetched_at=snapshot["retrieved_at"], sourceSnapshot=snapshot)
    return forecast, dict(sourceSnapshot=snapshot), feed


def load_source_data() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    forecast, notify, feed = fetch_source_data()
    if "sourceSnapshot" in forecast:
        validate_source_snapshot(forecast["sourceSnapshot"])
        events = feed["events"]
    else:
        validate_payloads(forecast, notify)
        events = validate_feed(feed)
    forecast_card_data(forecast)
    return forecast, notify, feed, events


def latest_source_reset(forecast: dict[str, Any]) -> dict[str, Any] | None:
    events = [event for event in forecast["sourceSnapshot"]["events"]
              if event["reset_type"] == "regular" and event["phase"] == "actual"]
    return max(events, key=lambda event: aware_time(event["occurred_at"], "event.occurred_at"),
               default=None)


def source_audit(forecast: dict[str, Any]) -> dict[str, Any]:
    source = forecast.get("sourceSnapshot")
    if source is None:
        return {}
    return dict(sourceProvider=dict(id=source["provider_id"], name=source["source_name"],
                                    page=source["source_url"], endpoint=source["endpoint"]),
                sourceTimes=dict(retrievedAt=source["retrieved_at"],
                                 sourceUpdatedAt=source["source_updated_at"],
                                 signalCheckedAt=source["signal_checked_at"],
                                 predictionGeneratedAt=source.get("forecast_generated_at")),
                sourceSignalStatus=source["signal_status"], sourceCapabilities=source["capabilities"],
                sourceForecast=source["forecast"])


def migrate_source_state(state: dict[str, Any], forecast: dict[str, Any],
                         events: list[dict[str, Any]], phases: list[ResetPhaseEvent]) -> None:
    source = forecast.get("sourceSnapshot")
    if source is None or state.get("sourceProviderId") == source["provider_id"]:
        return
    state["providerBaseline"] = dict(providerId=source["provider_id"], observedAt=now_utc().isoformat(),
                                    eventIds=list(dict.fromkeys(event["id"] for event in events)),
                                    phaseKeys=list(dict.fromkeys(phase_event_key(p) for p in phases)),
                                    previousProviderId=state.get("sourceProviderId", "willreset"),
                                    evidence="fresh-source-observation-not-a-delivery")
    state["sourceProviderId"] = source["provider_id"]


def provider_phase_suppressed(phase: ResetPhaseEvent, state: dict[str, Any]) -> bool:
    baseline = state.get("providerBaseline")
    if not baseline:
        return False
    if phase_event_key(phase) in baseline["phaseKeys"]:
        return True
    return (phase["eventId"] not in baseline["eventIds"]
            and aware_time(phase["announcedAt"], "phase.announcedAt")
            <= aware_time(baseline["observedAt"], "providerBaseline.observedAt"))


def validate_payloads(forecast: dict[str, Any], notify: dict[str, Any]) -> None:
    current = now_utc()
    for name, payload in (("forecast", forecast), ("notify", notify)):
        if not isinstance(payload, dict):
            raise ValueError(f"{name}: expected object")
        for key in ("last_reset_id", "last_reset_at", "answer"):
            if not isinstance(payload.get(key), str) or not payload[key].strip():
                raise ValueError(f"{name}.{key}: expected nonempty string")
        if not re.fullmatch(r"[0-9]+", payload["last_reset_id"]):
            raise ValueError(f"{name}.last_reset_id: expected numeric source event ID")
        timestamp = parse_time(payload["last_reset_at"])
        if timestamp is None or timestamp.year <= 1 or timestamp > now_utc():
            raise ValueError(f"{name}.last_reset_at: invalid or future timestamp")
        for key in ("prob_24", "prob_48"):
            if payload.get(key) is not None and not valid_percent(payload[key]):
                raise ValueError(f"{name}.{key}: expected percentage number")
        for key in ("last_reset_text", "last_reset_url"):
            if key in payload and not isinstance(payload[key], str):
                raise ValueError(f"{name}.{key}: expected string")
        freshness_keys = ("computed_at", "live_fetched_at") if name == "forecast" else ("fetched_at",)
        for key in freshness_keys:
            value = payload.get(key)
            stamp = parse_time(value)
            if (stamp is None or not isinstance(value, str)
                    or current - stamp > MAX_SOURCE_AGE or stamp - current > MAX_CLOCK_SKEW):
                raise ValueError(f"{name}.{key}: missing, invalid, stale or future source timestamp")
    if type(notify.get("promise_active")) is not bool:
        raise ValueError("notify.promise_active: expected boolean")
    for key in ("confidence", "model_version"):
        if not isinstance(forecast.get(key), str) or not forecast[key].strip():
            raise ValueError(f"forecast.{key}: expected nonempty string")
    for key in ("range_24", "range_48"):
        values = forecast.get(key)
        if values is None:
            continue
        if (not isinstance(values, list) or len(values) != 2
                or not all(valid_percent(v) for v in values) or values[0] > values[1]):
            raise ValueError(f"forecast.{key}: expected ordered percentage pair")
    factors = forecast.get("factors")
    if not isinstance(factors, list) or any(
        not isinstance(f, dict) or not isinstance(f.get("code"), str) or not f["code"].strip()
        or any(k in f and not isinstance(f[k], str) for k in ("label", "detail"))
        for f in factors
    ):
        raise ValueError("forecast.factors: expected factor objects with string codes")
    for key in ("last_reset_id", "last_reset_at"):
        if forecast[key] != notify[key]:
            raise ValueError(f"forecast/notify disagree on {key}")
    for factor in factors:
        if factor["code"] != "last_reset":
            continue
        for key in ("label", "detail", "href"):
            if not isinstance(factor.get(key), str) or not factor[key].strip():
                raise ValueError(f"forecast.last_reset.{key}: expected nonempty string")
        url = urlsplit(factor["href"])
        if (url.scheme != "https" or url.hostname not in ("x.com", "twitter.com")
                or not url.path.endswith("/status/" + forecast["last_reset_id"])
                or factor["href"] != forecast.get("last_reset_url")
                or factor["href"] != notify.get("last_reset_url")):
            raise ValueError("last_reset factor does not identify the same source event")


def confirmed_reset_id(forecast: dict[str, Any], notify: dict[str, Any]) -> str:
    if "sourceSnapshot" in forecast:
        event = latest_source_reset(forecast)
        return event["event_id"] if event else ""
    if not any(f["code"] == "last_reset" for f in forecast["factors"]):
        return ""
    return notify["last_reset_id"].strip()


def reset_is_older_than_state(reset_id: str, reset_at: str, state: dict[str, Any]) -> bool:
    # X status IDs are ordered Snowflakes; legacy state has no event timestamp.
    known_ids = [state.get("last_reset_id"), *state.get("notified_reset_ids", [])]
    watermark = max((int(v) for v in known_ids if isinstance(v, str)
                     and re.fullmatch(r"[0-9]+", v)), default=0)
    known_at = parse_time(state.get("last_reset_at"))
    event_at = parse_time(reset_at)
    return ((reset_id.isdigit() and int(reset_id) < watermark)
            or (known_at is not None and event_at < known_at))


def forecast_probability(forecast: dict[str, Any], hours: int) -> str:
    probability = forecast.get(f"prob_{hours}")
    bounds = forecast.get(f"range_{hours}")
    if probability is None or bounds is None or not bounds[0] <= probability <= bounds[1]:
        return "不可用（来源概率与区间矛盾）"
    return f"{percent(probability)}（置信区间 {interval(bounds)}）"


def push(message: str) -> tuple[bool, str]:
    completed = subprocess.run(
        ["node", str(PUSH_SCRIPT), message],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )
    details = (completed.stdout or completed.stderr).strip().splitlines()
    last_line = details[-1] if details else "no output"
    return completed.returncode == 0, last_line


def percent(value: Any) -> str:
    try:
        return f"{float(value):g}%"
    except (TypeError, ValueError):
        return "暂无"


def interval(value: Any) -> str:
    if not isinstance(value, list) or len(value) != 2:
        return "暂无"
    return f"{percent(value[0])}–{percent(value[1])}"


def confidence_text(forecast: dict[str, Any]) -> str:
    confidence = str(forecast.get("confidence") or "unknown").lower()
    labels = {"low": "低", "medium": "中", "high": "高"}
    label = labels.get(confidence, confidence)
    note = str(forecast.get("confidence_note") or "").strip()
    if confidence == "low":
        if "experimental" in note.lower():
            return f"{label}；实验性，来源称滚动回测尚未同时优于两个基线，且未给出已校准声明"
        return f"{label}；低置信度，且未给出已校准声明"
    if note:
        return f"{label}；{note}"
    return label


def parse_clock(text: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*", text, re.I)
    if not match:
        return None
    hour = int(match.group(1)) % 12
    minute = int(match.group(2) or 0)
    if match.group(3).upper() == "PM":
        hour += 12
    if minute > 59:
        return None
    return hour, minute


def historical_window(forecast: dict[str, Any]) -> str:
    label = str(forecast.get("peak_label") or "").strip()
    match = re.fullmatch(r"\s*(.+?)\s*-\s*(.+?)\s*", label)
    if not match:
        return f"历史高频候选窗口：{label or '暂无'}（来源未给出具体未来日期）"
    start = parse_clock(match.group(1))
    end = parse_clock(match.group(2))
    if not start or not end:
        return f"历史高频候选窗口：{label} UTC（来源未给出具体未来日期）"
    base = datetime(2000, 1, 1, start[0], start[1], tzinfo=timezone.utc)
    end_dt = datetime(2000, 1, 1, end[0], end[1], tzinfo=timezone.utc)
    if end_dt <= base:
        end_dt += timedelta(days=1)
    start_local = base.astimezone(SHANGHAI)
    end_local = end_dt.astimezone(SHANGHAI)
    return (
        "历史高频候选窗口：UTC+08:00 "
        f"{start_local:%H:%M}–{end_local:%H:%M}（仅为历史时段，不代表具体日期）"
    )


def next_reset_text(forecast: dict[str, Any], current: datetime) -> str:
    promise = forecast.get("promise")
    if isinstance(promise, dict) and promise.get("active") is True:
        promised_at = parse_time(promise.get("at"))
        label = str(promise.get("label") or "").lower()
        last_reset_at = parse_time(forecast.get("last_reset_at"))
        explicit_future = (
            promised_at is not None
            and promised_at > current
            and "no clock" not in label
            and promised_at != last_reset_at
        )
        if explicit_future:
            return f"来源明确给出的未来时间：{promised_at.astimezone(SHANGHAI):%Y-%m-%d %H:%M}（UTC+08:00）"
    return historical_window(forecast)


def daily_summary(forecast: dict[str, Any], current: datetime) -> str:
    if "sourceSnapshot" in forecast:
        lines = ["Codex 统一重置今日预测"]
        for hours in (24, 48):
            if valid_percent(forecast.get(f"prob_{hours}")):
                lines.append(f"{hours} 小时概率：{percent(forecast[f'prob_{hours}'])}")
        return "\n".join(lines + ["下次重置预测：来源未提供具体时间", f"来源：{SOURCE_PAGE}"])
    return "\n".join(
        [
            "Codex 统一重置今日预测",
            f"今日重置概率（未来 24 小时）：{forecast_probability(forecast, 24)}",
            f"48 小时概率：{forecast_probability(forecast, 48)}",
            f"置信度：{confidence_text(forecast)}",
            (f"最近一次统一重置：{format_shanghai(forecast.get('last_reset_at'))}（UTC+08:00）"
             if confirmed_reset_id(forecast, forecast) else "最近一次统一重置：暂无有效确认记录"),
            f"下次重置预测：{next_reset_text(forecast, current)}",
            f"来源：{SOURCE_URL}",
        ]
    )


def reset_message(notify: dict[str, Any], reset_id: str, current: datetime) -> str:
    summary = str(notify.get("last_reset_text") or "公开来源已确认统一重置").strip()
    return "\n".join(
        [
            "Codex 统一重置已确认",
            f"确认时间：{current.astimezone(SHANGHAI):%Y-%m-%d %H:%M}（UTC+08:00）",
            f"重置时间：{format_shanghai(notify.get('last_reset_at'))}（UTC+08:00）",
            f"摘要：{summary}",
            f"新 ID：{reset_id}",
            f"来源：{SOURCE_URL}",
        ]
    )


def failure_message(error: Exception, count: int) -> str:
    return "\n".join(
        [
            "Codex 统一重置监控异常",
            f"连续抓取失败：{count} 次",
            f"错误：{str(error)[:300]}",
            "需要检查 OpenClaw 主机网络或 willcodexreset.com 数据有效性。",
            f"来源：{SOURCE_URL}",
        ]
    )


def aware_time(value: Any, field: str) -> datetime:
    if (not isinstance(value, str)
            or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value)):
        raise ValueError(f"{field}: expected timezone-aware ISO timestamp")
    stamp = parse_time(value)
    if stamp is None or stamp.year <= 1:
        raise ValueError(f"{field}: invalid timestamp")
    return stamp


def validate_feed(feed: dict[str, Any]) -> list[dict[str, Any]]:
    stamp = aware_time(feed.get("fetched_at"), "feed.fetched_at")
    current = now_utc()
    if current - stamp > MAX_SOURCE_AGE or stamp - current > MAX_CLOCK_SKEW:
        raise ValueError("feed.fetched_at: stale or future source timestamp")
    events = feed.get("events")
    if not isinstance(events, list) or not events:
        raise ValueError("feed.events: expected nonempty full event list")
    unique: dict[str, dict[str, Any]] = {}
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("feed.events: expected objects")
        for key in ("id", "kind", "summary", "announced_at"):
            if not isinstance(event.get(key), str) or not event[key].strip():
                raise ValueError(f"feed.event.{key}: expected nonempty string")
        for key in ("reset_kind", "banked_state"):
            if event.get(key) is not None and not isinstance(event[key], str):
                raise ValueError(f"feed.event.{key}: expected string or missing")
        if ("tags" in event and (not isinstance(event["tags"], list)
                or any(not isinstance(tag, str) for tag in event["tags"]))):
            raise ValueError("feed.event.tags: expected string array")
        for key in ("preview", "cadence"):
            if key in event and type(event[key]) is not bool:
                raise ValueError(f"feed.event.{key}: expected boolean")
        announced = aware_time(event["announced_at"], "event.announced_at")
        if announced > current + MAX_CLOCK_SKEW:
            raise ValueError("event.announced_at: future announcement")
        # Legacy history entries can lack a URL; validate URLs only in the send window.
        previous = unique.get(event["id"])
        keys = ("kind", "summary", "announced_at", "source_url")
        if previous and any(previous.get(k) != event.get(k) for k in keys):
            raise ValueError("feed.events: conflicting duplicate ID")
        unique[event["id"]] = event
    return sorted(unique.values(), key=lambda e: (aware_time(e["announced_at"], "event time"), e["id"]),
                  reverse=True)


def select_announcements(events: list[dict[str, Any]], state: dict[str, Any],
                         phase_events: list[ResetPhaseEvent] | None = None) -> list[dict[str, Any]]:
    lower = aware_time(state.get("migrationLowerBound"), "migrationLowerBound")
    sent = set(state.get("sentAnnouncementIds", []))
    seen_phase_keys = set(state.get("deliveredPhaseKeys", [])) | set(state.get("phaseBaselineKeys", []))
    phases_by_id: dict[str, set[str]] = {}
    for phase in pending_phase_events(phase_events or [], state):
        phases_by_id.setdefault(phase["eventId"], set()).add(phase_event_key(phase))
    result = {}
    for event in events:
        is_post = event.get("sourceFeed") in ("tiboPosts", "tiboRelevantPosts")
        if "sourceEvent" in event and not is_post:
            source_event = event["sourceEvent"]
            if source_event["phase"] is None:
                continue
            # A verified site record can trigger a reset without being an X post.
            if source_only_actual(event):
                continue
            phase = dict(eventId=event["id"], resetType=source_event["reset_type"],
                         phase=source_event["phase"], announcedAt=event["announced_at"])
            if provider_phase_suppressed(phase, state):
                continue
        phase_keys = phases_by_id.get(event["id"], set())
        baseline_upgrade = ((event["id"] in state.get("groupBaselineEventIds", [])
                             or event["id"] in state.get("providerBaseline", {}).get("eventIds", []))
                            and bool(phase_keys.difference(seen_phase_keys)))
        if (aware_time(event["announced_at"], "event time") < lower
                and not baseline_upgrade and event["id"] not in result):
            continue
        # Trigger baselines are not content acknowledgements: unseen IDs remain deliverable.
        if (event["id"] in sent and event["id"] not in result
                and (not phase_keys or not phase_keys.difference(seen_phase_keys))):
            continue
        if "sourceEvent" in event and event["sourceEvent"].get("source_author") != "thsottiaux":
            raise ValueError("pending source event lacks a verified original Tibo URL")
        url = urlsplit(event.get("source_url") or "")
        if (url.scheme != "https" or url.hostname not in ("x.com", "twitter.com")
                or url.username or url.password or url.port not in (None, 443)
                or not re.fullmatch(r"/[^/]+/status/[0-9]+", url.path)
                or (event["id"].isdigit() and not url.path.endswith("/status/" + event["id"]))):
            raise ValueError("pending announcement lacks a valid original X URL")
        # Prefer the original X text over a site's manual event summary.
        if is_post or event["id"] not in result:
            result[event["id"]] = event
    return sorted(result.values(), key=lambda event: aware_time(event["announced_at"], "event time"),
                  reverse=True)


def source_only_actual(event: dict[str, Any]) -> bool:
    source = event.get("sourceEvent", {})
    return (source.get("raw_kind") == "reset" and source.get("verified") is True
            and source.get("reset_type") == "regular" and source.get("phase") == "actual"
            and source.get("source_url") is None and source.get("x_status_id") is None
            and event.get("source_url") is None
            and event.get("id") == source.get("event_id")
            and event.get("sourceFeed") is None)


def legacy_service_start(service: str, success: datetime) -> datetime | None:
    completed = subprocess.run(
        ["systemctl", "--user", "show", service, "--property=ExecMainStartTimestamp",
         "--property=ExecMainExitTimestamp", "--property=ExecMainStatus", "--property=Result"],
        capture_output=True, text=True, timeout=10, check=False,
        env=dict(os.environ, TZ="UTC"),
    )
    fields = dict(line.split("=", 1) for line in completed.stdout.splitlines() if "=" in line)
    if completed.returncode or fields.get("Result") != "success" or fields.get("ExecMainStatus") != "0":
        return None
    try:
        start, end = (datetime.strptime(fields[key], "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
                      for key in ("ExecMainStartTimestamp", "ExecMainExitTimestamp"))
    except (KeyError, ValueError):
        return None
    return start if start <= success <= end + timedelta(seconds=2) else None


def administrator_target() -> str:
    try:
        config = json.loads(OPENCLAW_CONFIG.read_text(encoding="utf-8"))
        channel = config["channels"]["qqbot"]
        accounts = channel.get("accounts")
        account = accounts.get("default") if isinstance(accounts, dict) else None
        if account is None:
            account = channel
        admins = channel.get("customRuntime", {}).get("admins", [])
        admin = next((a for a in admins if isinstance(a, str) and a.strip()), None) if isinstance(admins, list) else None
        if (channel.get("enabled") is False or account.get("enabled") is False
                or not account.get("appId") or not account.get("clientSecret") or not admin
                or (admin.startswith("qqbot:") and not admin.startswith("qqbot:c2c:"))):
            raise ValueError("unavailable administrator")
        identifier = re.sub(r"^qqbot:c2c:", "", admin)
        if not identifier or re.search(r"[\s/]", identifier):
            raise ValueError("invalid administrator")
        return "qqbot:c2c:" + identifier
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise RuntimeError("configured first C2C administrator is unavailable") from None


def legacy_delivery_evidence() -> dict[str, Any]:
    target = administrator_target()
    # --user can be empty on this host even when the system journal has user-unit logs.
    # Give each indexed unit its own tail so busy monitor logs cannot hide a daily success.
    records = []
    for unit, prefix in (("codex-reset-summary.service", "daily summary sent date="),
                         ("codex-reset-monitor.service", "reset notification sent id=")):
        completed = subprocess.run(
            ["journalctl", "--no-pager", "-o", "json", "-n", "100",
             "--output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,MESSAGE",
             "_SYSTEMD_USER_UNIT=" + unit],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if completed.returncode:
            raise RuntimeError("legacy migration could not read both required unit journals")
        for line in completed.stdout.splitlines():
            try:
                row = json.loads(line)
                message = row.get("MESSAGE", "")
                if (not isinstance(message, str) or row.get("_SYSTEMD_USER_UNIT") != unit
                        or not message.startswith(prefix) or not message.endswith(" target=" + target)):
                    continue
                micros = int(row["__REALTIME_TIMESTAMP"])
                stamp = datetime.fromtimestamp(micros // 1000000, timezone.utc).replace(microsecond=micros % 1000000)
                if stamp <= now_utc():
                    records.append((stamp, unit))
            except (ValueError, TypeError, KeyError):
                continue
    if not records:
        raise RuntimeError("legacy migration requires an actual successful daily/reset C2C journal record")
    success, unit = max(records)
    start = legacy_service_start(unit, success)
    # Five minutes bounds the old two fetches + two 45s sends if the unit no longer matches.
    lower = start or (success - timedelta(minutes=5))
    return {"lowerBound": lower.isoformat(), "observedSuccessAt": success.isoformat(),
            "source": "system-journal-success", "unit": unit,
            "uncertainty": "service-start-inclusive" if start else "legacy-runtime-bound-5min"}


def migrate_delivery_state(state: dict[str, Any]) -> None:
    if state.get("version") == 2:
        aware_time(state.get("migrationLowerBound"), "migrationLowerBound")
        return
    evidence = legacy_delivery_evidence()
    legacy_day = state.get("daily_summary_date")
    success_day = aware_time(evidence["observedSuccessAt"], "observedSuccessAt").astimezone(SHANGHAI).date().isoformat()
    if isinstance(legacy_day, str) and legacy_day > success_day:
        raise RuntimeError("legacy journal does not cover the latest successful daily; migration needs newer evidence")
    state.update(version=2, migrationLowerBound=evidence["lowerBound"], migrationEvidence=evidence,
                 lastSuccessfulPushAt=None, announcementWatermark=None,
                 sentAnnouncementIds=[], pendingBatch=None)


def forecast_card_data(forecast: dict[str, Any]) -> dict[str, Any]:
    probabilities = {}
    for hours in (24, 48):
        probability = forecast.get(f"prob_{hours}")
        probabilities[f"probability_{hours}h"] = (probability / 100
            if valid_percent(probability) else None)
    if "sourceSnapshot" in forecast:
        latest = latest_source_reset(forecast)
        return dict(probabilities, status="来源预测",
                    summary="来源未提供今日重置状态或下次重置具体时间。",
                    updated_at=forecast.get("forecast_generated_at"),
                    last_reset_at=latest["occurred_at"] if latest else None)
    answer = forecast["answer"]
    did_reset = forecast.get("did_reset_today")
    if did_reset is not None and type(did_reset) is not bool:
        raise ValueError("forecast.did_reset_today: expected boolean")
    status = {"yes": "已重置", "no": "尚未重置", "promised": "已预告"}.get(answer, "尚未确认")
    summary = ("今天已确认发生全局重置。" if did_reset is True else
               "今天还没有确认重置。Tibo 已预告未来会有一次全局重置。" if answer == "promised" else
               "今天还没有确认重置。")
    return dict(probabilities, status=status, summary=summary, updated_at=forecast["computed_at"],
                last_reset_at=forecast["last_reset_at"] if confirmed_reset_id(forecast, forecast) else None)


RENDER_WORKER = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from render_cards import render_forecast_card, render_announcement_card
p = json.load(sys.stdin)
root = Path(p['directory'])
s = p['snapshot']
cards = [render_forecast_card(s['forecastCard'], root / 'forecast.png', now=s['createdAt'])]
for i, event in enumerate(s['announcements']):
    cards.append(render_announcement_card(dict(summary=event['summary'], published_at=event['announced_at'],
                 kind=event['kind']), root / ('announcement-%04d.png' % i), now=s['createdAt']))
print(json.dumps(cards))
"""


def render_snapshot(snapshot: dict[str, Any], directory: Path) -> list[dict[str, Any]]:
    result = subprocess.run(
        [sys.executable, "-c", RENDER_WORKER, str(ROOT)],
        input=json.dumps({"directory": str(directory), "snapshot": snapshot}, ensure_ascii=False),
        text=True, capture_output=True, timeout=RENDER_TIMEOUT, check=False,
    )
    if result.returncode:
        raise RuntimeError("snapshot render failed; no batch delivered")
    cards = json.loads(result.stdout)
    if not isinstance(cards, list) or len(cards) != 1 + len(snapshot["announcements"]):
        raise ValueError("snapshot renderer returned an incomplete card list")
    for card in cards:
        path = Path(card["path"])
        if (not path.is_absolute() or path.resolve().parent != directory.resolve()
                or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != card["sha256"]
                or type(card["width"]) is not int or card["width"] <= 0
                or type(card["height"]) is not int or card["height"] <= 0):
            raise ValueError("snapshot renderer returned an invalid card")
    return cards


def digest_json(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def prepare_batch(state: dict[str, Any], forecast: dict[str, Any], feed: dict[str, Any],
                  events: list[dict[str, Any]], reset_id: str, daily_date: str | None,
                  manual_preview: bool = False,
                  phase_events: list[ResetPhaseEvent] | None = None,
                  dingtalk_sample: bool = False) -> dict[str, Any]:
    phases = phase_events or []
    announcements = select_announcements(events + feed.get("sourcePosts", []), state, phase_events=phases)
    source_records = [event for event in events if source_only_actual(event)]
    selected_ids = {event["id"] for event in announcements + source_records}
    if "sourceSnapshot" in forecast:
        phases = pending_phase_events(phases, state)
    phases = [phase for phase in phases if phase["eventId"] in selected_ids]
    phase_keys = list(dict.fromkeys(phase_event_key(event) for event in phases))
    warnings = []
    for hours in (24, 48):
        probability = forecast.get(f"prob_{hours}")
        bounds = forecast.get(f"range_{hours}")
        if valid_percent(probability) and bounds is not None and not bounds[0] <= probability <= bounds[1]:
            warning = dict(code="source_probability_interval_mismatch", field=f"prob_{hours}",
                           probability=probability, interval=bounds)
            warnings.append(warning)
            print("source probability warning: " + json.dumps(warning, ensure_ascii=False),
                  file=sys.stderr if dingtalk_sample else sys.stdout)
    snapshot = dict(createdAt=now_utc().isoformat(), forecastCard=forecast_card_data(forecast),
                    announcements=announcements, feedFetchedAt=feed["fetched_at"],
                    resetId=reset_id or None, dailyDate=daily_date, manualPreview=manual_preview,
                    sourceWarnings=warnings, manifestVersion=2, delivery="single_markdown",
                    title=batch_phase_title(phases, daily=bool(daily_date)), eventPhases=phases)
    if source_records:
        phase_ids = {phase["eventId"] for phase in phases}
        snapshot["sourceResetEvents"] = [event["sourceEvent"] for event in source_records
                                       if event["id"] in phase_ids]
    snapshot.update(source_audit(forecast))
    if GROUP_CONFIG is not None:
        snapshot.update(group_binding())
    primary = primary_phase(phases)
    if primary:
        snapshot["stageText"] = PHASE_DETAILS[(primary["resetType"], primary["phase"])]
        if primary["phase"] in ("preview", "upcoming") and "sourceSnapshot" in forecast:
            event = next(e["sourceEvent"] for e in events if e["id"] == primary["eventId"]
                         and e["sourceEvent"].get("forecast_signal"))
            parsed_time = interpret_preview_time(event, STATE_FILE.parent / "preview-time-cache", now=now_utc())
            snapshot["previewTime"] = parsed_time
            if not event.get("reset_type_explicit"):
                snapshot["stageText"] = "重置预告｜尚未到账；具体类型及适用范围以原公告为准"
            snapshot["stageText"] += "\n" + parsed_time["display"]
            snapshot["forecastCard"].update(status="已预告，尚未到账", summary=parsed_time["display"])
            if parsed_time["status"] == "expired":
                if not daily_date:
                    snapshot["title"] = "Codex重置预告窗口已过"
                snapshot["stageText"] = "预告窗口已过｜不能据此确认到账；具体类型及适用范围以原公告为准"
                snapshot["forecastCard"].update(status="预告窗口已过")
        if ("sourceSnapshot" in forecast
                and (primary["resetType"], primary["phase"]) == ("regular", "actual")):
            snapshot["stageText"] = "常规重置（regular）｜来源已确认直接用量重置，不代表个人到账"
            confirmed_at = format_shanghai(primary["announcedAt"])
            snapshot["stageText"] += f"\n确认时间：{confirmed_at}（UTC+08:00）"
            snapshot["forecastCard"].update(status="已确认重置", summary=(
                f"来源已确认常规用量重置。\n确认时间：{confirmed_at}（UTC+08:00）"))
    if dingtalk_sample:
        snapshot.update(channel="dingtalk", purpose="private-test-current-forecast-with-history",
                        businessStateMutation=False,
                        historicalNotice="以下为历史公告，用于排版测试，非今日重置确认")
    batch_id = ("layout-" if dingtalk_sample else "codex-") + digest_json(snapshot)[:32]
    output = (STATE_FILE.parent / "dingtalk" / "layout-preview" if dingtalk_sample
              else STATE_FILE.parent / "outbox")
    directory = output / batch_id
    directory.mkdir(parents=True, exist_ok=not dingtalk_sample, mode=0o700)
    atomic_write_json(directory / "snapshot.json", snapshot)
    cards = render_snapshot(snapshot, directory)
    parts = [dict(type="heading", level=1, text=snapshot["title"]),
             dict(type="link", label="信息来源", url=SOURCE_PAGE),
             dict(type="image", path=Path(cards[0]["path"]).name)]
    if primary:
        parts.insert(1, dict(type="text", text=snapshot["stageText"]))
    if announcements:
        parts.append(dict(type="heading", level=1, text="Tibo宣布了什么"))
        if dingtalk_sample:
            parts.append(dict(type="text", text=snapshot["historicalNotice"]))
    for event, card in zip(announcements, cards[1:]):
        parts.extend([dict(type="image", path=Path(card["path"]).name),
                      dict(type="link", label="查看𝕏", url=event["source_url"])])
        _, content_links = announcement_content(event["summary"])
        for url in content_links:
            if url != event["source_url"]:
                parts.append(dict(type="link", label="附带链接", url=url))
    manifest = dict(version=2, batchId=batch_id, delivery="single_markdown", parts=parts)
    atomic_write_json(directory / "batch.json", manifest)
    return dict(batchId=batch_id, manifestSha256=digest_json(manifest), snapshotSha256=digest_json(snapshot),
                imageHashes={Path(c["path"]).name: c["sha256"] for c in cards},
                announcementIds=[e["id"] for e in announcements], dailyDate=daily_date,
                resetId=reset_id or None, feedFetchedAt=feed["fetched_at"], manualPreview=manual_preview,
                manifestVersion=2, delivery="single_markdown", deliveredPhaseKeys=phase_keys,
                **({"sampleOnly": True} if dingtalk_sample else {}))


def prepare_dingtalk_sample() -> dict[str, Any]:
    """Prepare a current forecast and clearly labelled history, without business state."""
    forecast, notify, feed, events = load_source_data()
    today = now_utc().astimezone(SHANGHAI).date()
    selected = []
    for kind, preview in (("reset", False), ("reset_preview", True)):
        event = next((event for event in events if event["kind"] == kind
                      and event.get("preview") is preview
                      and aware_time(event["announced_at"], "sample.announced_at").astimezone(SHANGHAI).date() < today),
                     None)
        if event is None:
            raise RuntimeError("source lacks a historical reset/preview pair; review before preparing sample")
        selected.append(event)
    # This selection floor is in memory only, never a business baseline or success ledger.
    selection = dict(migrationLowerBound=min(aware_time(event["announced_at"], "sample.announced_at")
                                            for event in selected).isoformat(), sentAnnouncementIds=[])
    batch = prepare_batch(selection, forecast, feed, selected, "", None,
                          manual_preview=True, dingtalk_sample=True)
    directory = STATE_FILE.parent / "dingtalk" / "layout-preview" / batch["batchId"]
    report = dict(channel="dingtalk", purpose="private-test-preparation-only", **batch,
                  manifestPath=str(directory / "batch.json"), receiptPath=str(directory / "batch.receipt.json"),
                  history=[dict(id=event["id"], kind=event["kind"], announced_at=event["announced_at"],
                                source_url=event["source_url"]) for event in selected],
                  businessStateMutation=False, messagesSent=0)
    atomic_write_json(directory / "preparation.json", report)
    return report


def deliver_batch(batch: dict[str, Any]) -> bool:
    batch_id = batch["batchId"]
    if not isinstance(batch_id, str) or not re.fullmatch(r"codex-[a-f0-9]{32}", batch_id):
        raise ValueError("invalid pending batch ID")
    directory = STATE_FILE.parent / "outbox" / batch_id
    manifest_path = directory / "batch.json"
    receipt_path = directory / "batch.receipt.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    snapshot = json.loads((directory / "snapshot.json").read_text(encoding="utf-8"))
    if digest_json(manifest) != batch["manifestSha256"] or digest_json(snapshot) != batch["snapshotSha256"]:
        raise ValueError("pending batch snapshot/manifest changed; manual reconciliation required")
    if GROUP_CONFIG is not None and any(snapshot.get(key) != value for key, value in group_binding().items()):
        raise ValueError("pending batch DingTalk target binding mismatch")
    if manifest.get("version") != 2 or manifest.get("delivery") != "single_markdown":
        raise ValueError("legacy segmented batch cannot resume; preserve its receipt for manual reconciliation")
    if receipt_path.exists():
        existing = json.loads(receipt_path.read_text(encoding="utf-8"))
        if existing.get("version") != 2:
            raise ValueError("legacy receipt cannot be reused for single-message delivery")
        if GROUP_CONFIG is None and isinstance(existing.get("message"), dict) and existing["message"].get("status") in ("inflight", "unknown"):
            print(f"batch blocked id={batch_id}; message outcome requires manual reconciliation")
            return False
    for name, checksum in batch["imageHashes"].items():
        if Path(name).name != name or hashlib.sha256((directory / name).read_bytes()).hexdigest() != checksum:
            raise ValueError("pending batch image changed; manual reconciliation required")
    timed_out = False
    command = ["node", str(PUSH_SCRIPT), "--manifest", str(manifest_path), "--receipt", str(receipt_path)]
    if GROUP_CONFIG is not None:
        command.extend(["--send-group", "--config", str(GROUP_CONFIG)])
    try:
        result = subprocess.run(
            command,
            cwd=str(ROOT), text=True, capture_output=True, timeout=SEND_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired:
        timed_out = True
        result = None
    # The durable receipt, never the exit code/stdout alone, is the delivery authority.
    if not receipt_path.exists():
        code = "unknown"
        if result is not None:
            try:
                diagnostic = json.loads(result.stdout.strip().splitlines()[-1])
                candidate = diagnostic.get("errorCode")
                if isinstance(candidate, str) and re.fullmatch(r"[a-z_]{1,64}", candidate):
                    code = candidate
            except (ValueError, IndexError, AttributeError):
                pass
        exit_code = result.returncode if result is not None else "timeout"
        raise RuntimeError(f"sender has no receipt; delivery is unconfirmed; exit={exit_code} code={code}")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    message = receipt.get("message")
    complete = (receipt.get("version") == 2 and receipt.get("batchId") == batch_id
                and receipt.get("delivery") == "single_markdown"
                and receipt.get("manifestSha256") == batch["manifestSha256"]
                and receipt.get("ok") is True and receipt.get("status") == "complete"
                and isinstance(message, dict) and message.get("status") == "sent"
                and isinstance(message.get("receiptSha256"), str)
                and re.fullmatch(r"[a-f0-9]{64}", message["receiptSha256"]) is not None)
    if GROUP_CONFIG is not None:
        complete = (receipt.get("version") == 2 and receipt.get("batchId") == batch_id
                    and receipt.get("delivery") == "single_markdown"
                    and receipt.get("manifestSha256") == batch["manifestSha256"]
                    and receipt.get("channel") == "dingtalk"
                    and receipt.get("targetSha256") == GROUP_TARGET_SHA256
                    and receipt.get("status") == "readback_confirmed"
                    and receipt.get("ok") is True and receipt.get("readbackObserved") is True)
    if timed_out or result.returncode != 0 or not complete:
        print(f"batch incomplete id={batch_id} status={receipt.get('status', 'invalid')} timeout={timed_out}")
        return False
    return True


def complete_batch(state: dict[str, Any], batch: dict[str, Any]) -> None:
    if batch.get("sampleOnly"):
        raise ValueError("private test sample cannot acknowledge business delivery")
    # Keep the migration floor fixed: late IDs must not be hidden by a rolling time watermark.
    sent = state.setdefault("sentAnnouncementIds", [])
    sent.extend(event_id for event_id in batch["announcementIds"] if event_id not in sent)
    if batch.get("deliveredPhaseKeys"):
        delivered = state.setdefault("deliveredPhaseKeys", [])
        delivered.extend(key for key in batch["deliveredPhaseKeys"] if key not in delivered)
    if batch.get("resetId"):
        notified = state.setdefault("notified_reset_ids", [])
        if batch["resetId"] not in notified:
            notified.append(batch["resetId"])
        state["notified_reset_ids"] = notified[-MAX_NOTIFIED_IDS:]
    if batch.get("dailyDate") and batch["dailyDate"] > (state.get("daily_summary_date") or ""):
        state["daily_summary_date"] = batch["dailyDate"]
    if GROUP_CONFIG is not None and batch.get("dailyDate"):
        state.setdefault("firstDailyCompletedAt", now_utc().isoformat())
        state["initializationPending"] = False
    state["lastSuccessfulPushAt"] = now_utc().isoformat()
    previous = state.get("announcementWatermark")
    state["announcementWatermark"] = (previous if previous and parse_time(previous) > parse_time(batch["feedFetchedAt"])
                                       else batch["feedFetchedAt"])
    state["pendingBatch"] = None


def establish_baseline(state: dict[str, Any], forecast: dict[str, Any], notify: dict[str, Any],
                       dry_run: bool = False, no_send: bool = False,
                       phase_events: list[ResetPhaseEvent] | None = None) -> None:
    reset_id = confirmed_reset_id(forecast, notify)
    state["initialized_at"] = now_utc().isoformat()
    if reset_id and not state.get("last_reset_id"):
        state["last_reset_id"] = reset_id
        source_reset = latest_source_reset(forecast) if "sourceSnapshot" in forecast else None
        state["last_reset_at"] = source_reset["occurred_at"] if source_reset else notify["last_reset_at"]
    state["version"] = 2
    for key, value in dict(migrationLowerBound=now_utc().replace(microsecond=0).isoformat(),
                           migrationEvidence={"source": "fresh-baseline-not-a-delivery"},
                           lastSuccessfulPushAt=None, announcementWatermark=None,
                           sentAnnouncementIds=[], pendingBatch=None,
                           baselineResetId=reset_id or None).items():
        state.setdefault(key, value)
    state["consecutive_fetch_failures"] = 0
    state["failure_notified"] = False
    initialize_phase_state(state, phase_events or [], fresh=True)
    if GROUP_CONFIG is not None:
        # Remember observed old stages so an in-place upgrade is new, not a history replay.
        state["migrationLowerBound"] = state["initialized_at"]
        state["phaseBaselineKeys"] = [phase_event_key(p) for p in phase_events or []]
        state["groupBaselineEventIds"] = list(dict.fromkeys(p["eventId"] for p in phase_events or []))
    if not dry_run:
        atomic_write_json(STATE_FILE, state)
    print(f"baseline established id={reset_id or 'none'}")


def run_once(baseline_only: bool = False, send_daily: bool = False,
             dry_run: bool = False, no_send: bool = False, manual_preview: bool = False,
             channel: str = "qq", group_config: Path | None = None,
             initialize_on_success: bool = False) -> int:
    channel = "dingtalk" if channel == "dd" else channel
    if channel not in ("qq", "dingtalk"):
        raise ValueError("unsupported monitor channel")
    if channel == "dingtalk" and group_config is not None:
        with dingtalk_runtime(group_config):
            return run_once(baseline_only=baseline_only, send_daily=send_daily,
                            dry_run=dry_run, no_send=no_send, manual_preview=manual_preview,
                            initialize_on_success=initialize_on_success)
    if initialize_on_success and GROUP_CONFIG is None:
        raise ValueError("initialize-on-success requires a pinned DingTalk group")
    if channel == "dingtalk":
        if not (dry_run or no_send):
            raise RuntimeError("DingTalk is preview-only; transport/target acceptance is pending")
        # Fail closed before the QQ lock, sender, journal migration or any state write.
        dry_run = True
        state_path = STATE_FILE.parent / "dingtalk" / "state.json"
        state = load_state(state_path)
        if state_path.exists() and state.get("channel") != "dingtalk":
            raise RuntimeError("DingTalk state requires its own channel binding; no QQ migration")
    else:
        state = load_state()
    if GROUP_CONFIG is not None:
        binding = group_binding()
        if STATE_FILE.exists() and any(state.get(key) != value for key, value in binding.items()):
            raise RuntimeError("DingTalk group state target/channel binding mismatch")
        if state.get("initialized_at") and state.get("version") != 2:
            raise RuntimeError("DingTalk group state cannot migrate QQ history")
        state.update(binding)
        if initialize_on_success and not state.get("firstDailyCompletedAt"):
            state["initializationPending"] = True
    initializing = GROUP_CONFIG is not None and state.get("initializationPending") is True

    def save() -> None:
        if not dry_run:
            atomic_write_json(STATE_FILE, state)

    def deliver(message: str, kind: str) -> tuple[bool, str]:
        if dry_run or no_send:
            print(f"delivery suppressed kind={kind}")
            return False, "no-send"
        if GROUP_CONFIG is not None:
            return False, "dingtalk-health-local-only"
        return push(message)

    try:
        forecast, notify, feed, events = load_source_data()
        confirmed = confirmed_reset_id(forecast, notify)
        if confirmed and "sourceSnapshot" not in forecast:
            event = next((e for e in events if e["id"] == confirmed), None)
            if (event is None or event["kind"] != "reset" or event.get("preview") is not False
                    or event["announced_at"] != notify["last_reset_at"]
                    or event.get("source_url") != notify.get("last_reset_url")):
                raise ValueError("feed/confirmed forecast disagree on reset evidence")
        phases = [phase for event in events if (phase := classify_reset_phase(event, forecast, notify)) is not None]
        if state.get("version") == 2 and "sourceSnapshot" not in forecast:
            select_announcements(events, state, phase_events=phases)
    except Exception as exc:
        state["consecutive_fetch_failures"] = int(state.get("consecutive_fetch_failures") or 0) + 1
        count = state["consecutive_fetch_failures"]
        if GROUP_CONFIG is None and count >= FAILURE_THRESHOLD and not state.get("failure_notified"):
            ok, target = deliver(failure_message(exc, count), "failure")
            if ok:
                state["failure_notified"] = True
                print(f"failure warning sent target={target}")
            elif not (dry_run or no_send):
                print(f"failure warning push failed: {target}", file=sys.stderr)
        save()
        print(f"fetch failed count={count}: {exc}", file=sys.stderr)
        return 1

    if dry_run or no_send:
        state["consecutive_fetch_failures"] = 0
        state["failure_notified"] = False
        save()
        print(f"fetch ok mode={'dry-run' if dry_run else 'no-send'}; no batch or delivery state advanced")
        return 0

    if not state.get("initialized_at"):
        migrate_source_state(state, forecast, events, phases)
        establish_baseline(state, forecast, notify, dry_run=dry_run, no_send=no_send, phase_events=phases)
        if not initializing:
            return 0
    if baseline_only:
        print(f"baseline already exists id={state.get('last_reset_id') or 'none'}")
        return 0

    try:
        state["consecutive_fetch_failures"] = 0
        state["failure_notified"] = False
        if GROUP_CONFIG is None:
            migrate_delivery_state(state)
        if state.get("pendingBatch"):
            pending = state["pendingBatch"]
            if not deliver_batch(pending):
                return 1
            complete_batch(state, pending)
            save()
            print(f"batch completed id={pending['batchId']}")
            if initializing and pending.get("dailyDate"):
                return 0
            if manual_preview and pending.get("manualPreview"):
                return 0

        migrate_source_state(state, forecast, events, phases)
        initialize_phase_state(state, phases)
        # Apply the source cutover before validating send-window URLs or selecting history.
        select_announcements(events + feed.get("sourcePosts", []), state, phase_events=phases)
        save()

        current = now_utc()
        reset_id = confirmed_reset_id(forecast, notify)
        source_reset = latest_source_reset(forecast) if "sourceSnapshot" in forecast else None
        reset_at = source_reset["occurred_at"] if source_reset else notify.get("last_reset_at")
        if reset_id and reset_is_older_than_state(reset_id, reset_at, state):
            print(f"older reset ignored id={reset_id}")
            reset_id = ""
        regular_actual = next((p for p in phases if p["resetType"] == "regular" and p["phase"] == "actual"), None)
        if (reset_id and regular_actual and reset_id != state.get("last_reset_id")
                and not provider_phase_suppressed(regular_actual, state)):
            state["last_reset_id"] = reset_id
            state["last_reset_at"] = reset_at
        pending_phases = pending_phase_events(phases, state)
        needs_reset = any(p["resetType"] == "regular" and p["phase"] == "actual" for p in pending_phases)
        today = current.astimezone(SHANGHAI).date().isoformat()
        daily_date = today if (send_daily or initializing) and today > (state.get("daily_summary_date") or "") else None
        if pending_phases or daily_date or manual_preview:
            batch = prepare_batch(state, forecast, feed, events, reset_id if needs_reset else "", daily_date,
                                  manual_preview=manual_preview, phase_events=phases)
            state["pendingBatch"] = batch
            save()
            if not deliver_batch(batch):
                return 1
            complete_batch(state, batch)
            save()
            print(f"batch completed id={batch['batchId']}")
        save()
        print(f"fetch ok confirmed_id={reset_id or 'none'} mode=normal")
        return 0
    except Exception as exc:
        # The outbox/receipt survives every incomplete batch, including process timeouts.
        print(f"batch failed closed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", choices=("qq", "dingtalk", "dd"), default="qq",
                        help="QQ by default; DingTalk group delivery requires --group-config")
    parser.add_argument("--group-config", type=Path, help="Explicit pinned DingTalk group configuration")
    parser.add_argument("--initialize-on-success", action="store_true",
                        help="DingTalk group only: initialize one daily when fresh source validation first succeeds")
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--daily-summary", action="store_true")
    parser.add_argument("--test-push", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Read-only fetch; no sends or state writes")
    parser.add_argument("--no-send", action="store_true", help="Persist fetch health without acknowledging deliveries")
    parser.add_argument("--manual-preview", action="store_true", help="Explicit real-data preview; shares batch/delivery dedupe")
    parser.add_argument("--prepare-private-test", action="store_true",
                        help="DingTalk only: render an isolated sample; never send or change business state")
    args = parser.parse_args()
    if args.group_config and (args.channel == "qq" or args.prepare_private_test or args.test_push):
        parser.error("--group-config requires DingTalk group mode")
    if args.initialize_on_success and (not args.group_config or args.baseline_only or args.manual_preview):
        parser.error("--initialize-on-success requires group mode without baseline/manual preview")

    if args.prepare_private_test:
        if args.channel == "qq" or any((args.test_push, args.dry_run, args.no_send, args.manual_preview,
                                        args.baseline_only, args.daily_summary)):
            parser.error("--prepare-private-test requires --channel dingtalk and no other mode flags")
        try:
            print(json.dumps(prepare_dingtalk_sample(), ensure_ascii=False))
            return 0
        except Exception as exc:
            print(f"DingTalk sample preparation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
    if args.test_push and (args.dry_run or args.no_send):
        parser.error("--test-push cannot be used with --dry-run/--no-send")
    if args.manual_preview and (args.test_push or args.baseline_only or args.daily_summary):
        parser.error("--manual-preview cannot be combined with other send/baseline modes")
    if args.channel != "qq":
        if args.group_config:
            def group_run() -> int:
                return run_once(baseline_only=args.baseline_only, send_daily=args.daily_summary,
                                dry_run=args.dry_run, no_send=args.no_send, manual_preview=args.manual_preview,
                                initialize_on_success=args.initialize_on_success)

            with dingtalk_runtime(args.group_config):
                group_binding()
                if args.dry_run:
                    return group_run()
                STATE_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with (STATE_FILE.parent / "monitor.lock").open("a+", encoding="utf-8") as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        print("another DingTalk group run is active")
                        return 0
                    return group_run()
        if args.test_push or not (args.dry_run or args.no_send):
            parser.error("DingTalk is preview-only; use --dry-run or --no-send; sends are disabled")
        return run_once(baseline_only=args.baseline_only, send_daily=args.daily_summary,
                        dry_run=args.dry_run, no_send=args.no_send, manual_preview=args.manual_preview,
                        channel="dingtalk")
    if args.dry_run:
        return run_once(baseline_only=args.baseline_only, send_daily=args.daily_summary, dry_run=True,
                        manual_preview=args.manual_preview)

    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with LOCK_FILE.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("another monitor run is active")
            return 0
        if args.test_push:
            state = load_state()
            reset_id = state.get("last_reset_id") or "未建立"
            message = "\n".join(
                [
                    "Codex 统一重置监控测试",
                    "推送通道测试，不代表发生了重置。",
                    f"当前基线 ID：{reset_id}",
                    "轮询周期：15 分钟；每日预测：UTC+08:00 08:00。",
                    f"唯一信息来源：{SOURCE_URL}",
                ]
            )
            ok, target = push(message)
            print(json.dumps({"ok": ok, "target": target}, ensure_ascii=False))
            return 0 if ok else 1
        return run_once(baseline_only=args.baseline_only, send_daily=args.daily_summary, no_send=args.no_send,
                        manual_preview=args.manual_preview)


if __name__ == "__main__":
    raise SystemExit(main())
