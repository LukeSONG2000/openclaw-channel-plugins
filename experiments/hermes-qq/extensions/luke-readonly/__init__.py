"""Native Hermes tool registration; no terminal, network, or write tools."""

import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKILLS = ROOT / "skills"
DATA = ROOT / "data"
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def normalize(value):
    return unicodedata.normalize("NFKC", value).casefold()


def read_skill(args, **_):
    name = args.get("name")
    if isinstance(name, str) and SLUG.fullmatch(name) and (SKILLS / name / "SKILL.md").is_file():
        from tools.skills_tool import skill_view

        return skill_view("luke-readonly:" + name, preprocess=False)
    return json.dumps({"error": "Unknown skill"})


def search(args, **_):
    name, query = args.get("name"), args.get("query")
    if not isinstance(name, str) or not SLUG.fullmatch(name) or not isinstance(query, str) or not 1 <= len(query.strip()) <= 100:
        return json.dumps({"error": "Invalid reference or query"})
    path = DATA / (name + ".jsonl")
    if not path.is_file() or path.stat().st_size > 2_000_000:
        return json.dumps({"error": "Reference unavailable"})
    needle = normalize(query.strip())
    hits = []
    for line in path.read_text().splitlines():
        row = json.loads(line)
        key = normalize(row["key"])
        searchable = normalize(row.get("search", ""))
        score = 3 if key == needle else 2 if needle in key else 1 if needle in searchable else 0
        if score:
            hits.append((score, row))
    hits.sort(key=lambda entry: -entry[0])
    return json.dumps({"matches": [row["display"][:800] for _, row in hits[:6]]}, ensure_ascii=False)


def register(ctx):
    skills = []
    for path in sorted(SKILLS.glob("*/SKILL.md")):
        description = next(line.split(":", 1)[1].strip() for line in path.read_text().splitlines()
                           if line.startswith("description:"))
        ctx.register_skill(path.parent.name, path, description)
        skills.append(path.parent.name + ": " + description)
    for name, description, handler, fields in (
        ("luke_skill_read", "Load an applicable skill only when needed. Available: " + "; ".join(skills),
         read_skill, {"name": "Bare skill name"}),
        ("luke_reference_search", "Search an installed skill's read-only reference by exact term or short phrase.",
         search, {"name": "Bare skill name", "query": "Term or phrase"}),
    ):
        ctx.register_tool(name=name, toolset="luke-readonly", handler=handler, schema={
            "name": name, "description": description, "parameters": {
                "type": "object", "additionalProperties": False, "required": list(fields),
                "properties": {k: {"type": "string", "description": v} for k, v in fields.items()},
            },
        })
