#!/usr/bin/env python3
"""Prepare an isolated historical layout sample; never send or acknowledge events."""

import argparse
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--monitor-root", type=Path,
                        default=Path(__file__).resolve().parent)
    parser.add_argument("--output-root", type=Path)
    args = parser.parse_args()
    root = args.monitor_root.resolve()
    spec = importlib.util.spec_from_file_location("layout_monitor", root / "monitor.py")
    monitor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(monitor)
    output = (args.output_root or monitor.STATE_FILE.parent / "layout-preview").resolve()
    if output.name != "layout-preview" or output.parent.name != "state":
        parser.error("output must be an isolated state/layout-preview directory")

    state_file = monitor.STATE_FILE
    before = state_file.read_bytes() if state_file.exists() else None
    forecast = monitor.fetch_json(monitor.FORECAST_URL)
    notify = monitor.fetch_json(monitor.NOTIFY_URL)
    monitor.validate_payloads(forecast, notify)
    feed = monitor.fetch_json(monitor.FEED_URL)
    events = monitor.validate_feed(feed)
    if forecast["answer"] != "promised" or forecast.get("did_reset_today") is True:
        raise RuntimeError("live forecast changed; review the requested current-promised sample first")

    selected = []
    for kind, preview in (("reset", False), ("reset_preview", True)):
        event = next((event for event in events if event["kind"] == kind
                      and event.get("preview") is preview), None)
        if event is None:
            raise RuntimeError("source has no requested confirmed/preview historical example")
        monitor.select_announcements([event], dict(migrationLowerBound=event["announced_at"],
                                                   sentAnnouncementIds=[]))
        selected.append(event)
    if (monitor.parse_time(selected[0]["announced_at"]).astimezone(monitor.SHANGHAI).date()
            >= monitor.now_utc().astimezone(monitor.SHANGHAI).date()):
        raise RuntimeError("selected confirmed reset is not historical; review the non-today label first")

    snapshot = dict(purpose="historical-layout-example-not-today", businessStateMutation=False,
                    createdAt=monitor.now_utc().isoformat(), forecastCard=monitor.forecast_card_data(forecast),
                    forecastComputedAt=forecast["computed_at"], feedFetchedAt=feed["fetched_at"],
                    announcements=selected, manifestVersion=2, delivery="single_markdown")
    snapshot["sourceWarnings"] = [dict(code="source_probability_interval_mismatch", field=f"prob_{hours}",
                                       probability=forecast[f"prob_{hours}"], interval=forecast[f"range_{hours}"])
                                  for hours in (24, 48) if monitor.valid_percent(forecast.get(f"prob_{hours}"))
                                  and forecast.get(f"range_{hours}") is not None
                                  and not forecast[f"range_{hours}"][0] <= forecast[f"prob_{hours}"]
                                  <= forecast[f"range_{hours}"][1]]
    batch_id = "layout-" + monitor.digest_json(snapshot)[:32]
    directory = output / batch_id
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    monitor.atomic_write_json(directory / "snapshot.json", snapshot)
    cards = monitor.render_snapshot(snapshot, directory)
    parts = [dict(type="text", text="Codex会重置吗？"),
             dict(type="image", path=Path(cards[0]["path"]).name),
             dict(type="link", label="信息来源", url=monitor.SOURCE_PAGE),
             dict(type="text", text="\n\n历史排版示例（非今日确认）\nTibo宣布了什么")]
    for event, card in zip(selected, cards[1:]):
        parts.extend([dict(type="image", path=Path(card["path"]).name),
                      dict(type="link", label="查看𝕏", url=event["source_url"])])
    manifest = dict(version=2, batchId=batch_id, delivery="single_markdown", parts=parts)
    monitor.atomic_write_json(directory / "batch.json", manifest)

    after = state_file.read_bytes() if state_file.exists() else None
    if before != after:
        raise RuntimeError("business state changed during preparation; review before using sample")
    report = dict(batchId=batch_id, manifestPath=str(directory / "batch.json"),
                  receiptPath=str(directory / "batch.receipt.json"),
                  manifestSha256=monitor.digest_json(manifest), historicalCardCount=len(selected),
                  history=[dict(id=e["id"], kind=e["kind"], announced_at=e["announced_at"],
                                source_url=e["source_url"]) for e in selected],
                  forecastStatus=snapshot["forecastCard"]["status"],
                  probability24=snapshot["forecastCard"]["probability_24h"],
                  probability48=snapshot["forecastCard"]["probability_48h"],
                  imageHashes={Path(card["path"]).name: card["sha256"] for card in cards},
                  businessStateUnchanged=True, messagesSent=0)
    monitor.atomic_write_json(directory / "preparation.json", report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
