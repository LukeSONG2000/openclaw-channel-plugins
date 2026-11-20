"""Prepare only public names and approved glossary rows for the read-only tools."""

import argparse
import json
import re
from pathlib import Path


def glossary(path):
    for line in path.read_text().splitlines():
        if not line.startswith("|"):
            continue
        fields = [part.strip().replace(r"\|", "|") for part in re.split(r"(?<!\\)\|", line)[1:-1]]
        if len(fields) < 5 or not fields[0] or fields[0] == "名称" or not fields[0].strip("-: "):
            continue
        yield {"key": fields[0], "search": " ".join(fields[1:]),
               "display": " | ".join(fields[:5])}
    people = path.with_name("people.md")
    if people.is_file():
        heading = ""
        for line in people.read_text().splitlines():
            if line.startswith("## "):
                heading = line.removeprefix("## ").strip()
            elif heading and line.startswith("- 识别锚点："):
                yield {"key": heading, "search": line, "display": heading + " | " + line}


def goh_names(path):
    for base, row in json.loads(path.read_text()).items():
        name, slug, kind = row.get("name"), row.get("slug"), row.get("type")
        if not name or not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9-]+", slug):
            continue
        aliases = " / ".join(row[key] for key in ("cn", "nickname") if row.get(key))
        url = "https://swgoh.gg/units/" + slug + "/"
        yield {"key": name, "search": " ".join([base, aliases]),
               "display": " | ".join(x for x in (name, aliases, kind, url) if x)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lexicon", type=Path)
    parser.add_argument("goh_names", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    for name, build, source in (("dongwuyuan-skill", glossary, args.lexicon), ("goh", goh_names, args.goh_names)):
        rows = list(build(source))
        if not rows:
            raise SystemExit("empty reference: " + name)
        (args.destination / (name + ".jsonl")).write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
