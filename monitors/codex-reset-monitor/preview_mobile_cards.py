#!/usr/bin/env python3
"""Offline, isolated mobile previews from an existing API snapshot; never send."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

from render_cards import render_announcement_card, render_forecast_card


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    source = args.snapshot.resolve()
    output = args.output_root.resolve()
    if output == source.parent or source.is_relative_to(output):
        parser.error("output must be separate from the source snapshot")
    snapshot_bytes = source.read_bytes()
    snapshot = json.loads(snapshot_bytes)
    output.mkdir(parents=True, exist_ok=True)
    forecast, now = snapshot["forecastCard"], snapshot["createdAt"]
    rendered = [render_forecast_card(forecast, output / "forecast.png", now=now)]
    for index, event in enumerate(snapshot["announcements"][:2]):
        data = dict(summary=event["summary"], kind=event["kind"],
                    published_at=event["announced_at"])
        rendered.append(render_announcement_card(data, output / ("announcement-%d.png" % index), now=now))
    rendered.append(render_forecast_card(dict(forecast, probability_24h=1, probability_48h=1),
                                         output / "forecast-100.png", now=now))
    rendered.append(render_forecast_card(dict(forecast, probability_24h=None, probability_48h=None,
                                               last_reset_at=None), output / "forecast-unavailable.png", now=now))
    previews = {}
    for width in (320, 360):
        scaled = []
        for meta in rendered:
            path = Path(meta["path"])
            with Image.open(path) as image:
                small = image.resize((width, round(image.height * width / image.width)),
                                     Image.Resampling.LANCZOS)
            target = output / (path.stem + "-%d.png" % width)
            small.save(target)
            scaled.append(small)
        # Stacked cards stay at exactly QQ's image width, never a wide contact sheet.
        stack = Image.new("RGB", (width, sum(im.height for im in scaled[:3]) + 32), "#ececf0")
        y = 0
        for image in scaled[:3]:
            stack.paste(image, (0, y))
            y += image.height + 16
        target = output / ("qq-stack-%d.png" % width)
        stack.save(target)
        previews[str(width)] = str(target)
    assert source.read_bytes() == snapshot_bytes, "source snapshot changed"
    report = dict(sourceSnapshot=str(source), sourceSnapshotSha256=hashlib.sha256(snapshot_bytes).hexdigest(),
                  sourceSnapshotUnchanged=True, runtimeStateAccess=False, messagesSent=0,
                  sourcePurpose=snapshot.get("purpose"), cards=rendered, previews=previews)
    (output / "preview-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
