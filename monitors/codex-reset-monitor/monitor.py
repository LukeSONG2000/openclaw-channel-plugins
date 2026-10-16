#!/usr/bin/env python3
"""Monitor public Codex global reset signals from willreset.com only."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


SOURCE_URL = "https://willreset.com"
FORECAST_URL = f"{SOURCE_URL}/api/forecast"
NOTIFY_URL = f"{SOURCE_URL}/api/notify"
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


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        # Go emits nanoseconds; Python 3.9's ISO parser accepts at most microseconds.
        normalized = value.strip().replace("Z", "+00:00")
        normalized = re.sub(r"(\.\d{6})\d+(?=[+-]|$)", r"\1", normalized)
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
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
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
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    raise RuntimeError(f"状态文件损坏：{STATE_FILE}")


def fetch_json(url: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            # This host's IPv6 HTTPS path stalls; scope IPv4 to this fetch only.
            response = subprocess.run(
                ["curl", "--disable", "--ipv4", "--fail", "--silent", "--show-error",
                 "--proto", "=https", "--connect-timeout", "5", "--max-time", "20",
                 "--header", "Accept: application/json",
                 "--user-agent", "OpenClaw-CodexResetMonitor/1.0", url],
                capture_output=True, text=True, timeout=25, check=False,
            )
            if response.returncode:
                # Do not echo proxy configuration or curl diagnostics containing credentials.
                raise RuntimeError(f"curl exit={response.returncode}")
            payload = json.loads(response.stdout)
            if not isinstance(payload, dict):
                raise RuntimeError("JSON 根节点不是对象")
            return payload
        except Exception as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(2)
    raise RuntimeError(f"抓取 {url} 失败：{last_error}")


def valid_percent(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 <= value <= 100)


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
            if not valid_percent(payload.get(key)):
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
    return int(reset_id) < watermark or (known_at is not None and event_at < known_at)


def forecast_probability(forecast: dict[str, Any], hours: int) -> str:
    probability = forecast[f"prob_{hours}"]
    bounds = forecast[f"range_{hours}"]
    if not bounds[0] <= probability <= bounds[1]:
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
        "历史高频候选窗口：北京时间 "
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
            return f"来源明确给出的未来时间：{promised_at.astimezone(SHANGHAI):%Y-%m-%d %H:%M}（北京时间）"
    return historical_window(forecast)


def daily_summary(forecast: dict[str, Any], current: datetime) -> str:
    return "\n".join(
        [
            "Codex 统一重置今日预测",
            f"今日重置概率（未来 24 小时）：{forecast_probability(forecast, 24)}",
            f"48 小时概率：{forecast_probability(forecast, 48)}",
            f"置信度：{confidence_text(forecast)}",
            (f"最近一次统一重置：{format_shanghai(forecast.get('last_reset_at'))}（北京时间）"
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
            f"确认时间：{current.astimezone(SHANGHAI):%Y-%m-%d %H:%M}（北京时间）",
            f"重置时间：{format_shanghai(notify.get('last_reset_at'))}（北京时间）",
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
            "需要检查 OpenClaw 主机网络或 willreset.com 可用性。",
            f"来源：{SOURCE_URL}",
        ]
    )


def establish_baseline(state: dict[str, Any], forecast: dict[str, Any], notify: dict[str, Any],
                       dry_run: bool = False, no_send: bool = False) -> None:
    reset_id = confirmed_reset_id(forecast, notify)
    state["initialized_at"] = now_utc().isoformat()
    state["last_reset_id"] = reset_id or None
    if reset_id:
        state["last_reset_at"] = notify["last_reset_at"]
    if reset_id and not no_send:
        state["notified_reset_ids"] = [reset_id]
    state["consecutive_fetch_failures"] = 0
    state["failure_notified"] = False
    if not dry_run:
        atomic_write_json(STATE_FILE, state)
    print(f"baseline established id={reset_id or 'none'}")


def run_once(baseline_only: bool = False, send_daily: bool = False,
             dry_run: bool = False, no_send: bool = False) -> int:
    state = load_state()

    def save() -> None:
        if not dry_run:
            atomic_write_json(STATE_FILE, state)

    def deliver(message: str, kind: str) -> tuple[bool, str]:
        if dry_run or no_send:
            print(f"delivery suppressed kind={kind}")
            return False, "no-send"
        return push(message)

    try:
        forecast = fetch_json(FORECAST_URL)
        notify = fetch_json(NOTIFY_URL)
        validate_payloads(forecast, notify)
    except Exception as exc:
        state["consecutive_fetch_failures"] = int(state.get("consecutive_fetch_failures") or 0) + 1
        count = state["consecutive_fetch_failures"]
        if count >= FAILURE_THRESHOLD and not state.get("failure_notified"):
            ok, target = deliver(failure_message(exc, count), "failure")
            if ok:
                state["failure_notified"] = True
                print(f"failure warning sent target={target}")
            elif not (dry_run or no_send):
                print(f"failure warning push failed: {target}", file=sys.stderr)
        save()
        print(f"fetch failed count={count}: {exc}", file=sys.stderr)
        return 1

    if not state.get("initialized_at"):
        establish_baseline(state, forecast, notify, dry_run=dry_run, no_send=no_send)
        return 0
    if baseline_only:
        print(f"baseline already exists id={state.get('last_reset_id') or 'none'}")
        return 0

    state["consecutive_fetch_failures"] = 0
    state["failure_notified"] = False
    current = now_utc()
    reset_id = confirmed_reset_id(forecast, notify)
    notified = [str(value) for value in state.get("notified_reset_ids", []) if value]
    if reset_id and reset_is_older_than_state(reset_id, notify["last_reset_at"], state):
        print(f"older reset ignored id={reset_id}")
        reset_id = ""

    if reset_id and reset_id != state.get("last_reset_id"):
        state["last_reset_id"] = reset_id
        state["last_reset_at"] = notify["last_reset_at"]
        save()

    if reset_id and reset_id not in notified:
        ok, target = deliver(reset_message(notify, reset_id, current), f"reset id={reset_id}")
        if ok:
            notified.append(reset_id)
            state["notified_reset_ids"] = notified[-MAX_NOTIFIED_IDS:]
            print(f"reset notification sent id={reset_id} target={target}")
        elif not (dry_run or no_send):
            print(f"reset notification push failed id={reset_id}: {target}", file=sys.stderr)

    today = current.astimezone(SHANGHAI).date().isoformat()
    if send_daily and state.get("daily_summary_date") != today:
        ok, target = deliver(daily_summary(forecast, current), "daily-summary")
        if ok:
            state["daily_summary_date"] = today
            print(f"daily summary sent date={today} target={target}")
        elif not (dry_run or no_send):
            print(f"daily summary push failed date={today}: {target}", file=sys.stderr)

    save()
    print(f"fetch ok confirmed_id={reset_id or 'none'} mode={'dry-run' if dry_run else 'no-send' if no_send else 'normal'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--daily-summary", action="store_true")
    parser.add_argument("--test-push", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Read-only fetch; no sends or state writes")
    parser.add_argument("--no-send", action="store_true", help="Persist fetch health without acknowledging deliveries")
    args = parser.parse_args()

    if args.test_push and (args.dry_run or args.no_send):
        parser.error("--test-push cannot be used with --dry-run/--no-send")
    if args.dry_run:
        return run_once(baseline_only=args.baseline_only, send_daily=args.daily_summary, dry_run=True)

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
                    "轮询周期：15 分钟；每日预测：北京时间 08:00。",
                    f"唯一信息来源：{SOURCE_URL}",
                ]
            )
            ok, target = push(message)
            print(json.dumps({"ok": ok, "target": target}, ensure_ascii=False))
            return 0 if ok else 1
        return run_once(baseline_only=args.baseline_only, send_daily=args.daily_summary, no_send=args.no_send)


if __name__ == "__main__":
    raise SystemExit(main())
