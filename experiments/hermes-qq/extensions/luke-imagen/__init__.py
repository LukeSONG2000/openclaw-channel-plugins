"""Send a typed render request for this worker's native task only."""

import json
import os
import re
import time
import uuid
from pathlib import Path


def render(args, **_):
    task = os.environ.get("HERMES_KANBAN_TASK", "")
    prompt, use_images = args.get("prompt"), args.get("use_images")
    if (not re.fullmatch(r"t_[a-f0-9]{8,32}", task) or not isinstance(prompt, str)
            or not 1 <= len(prompt.strip()) <= 1800 or not isinstance(use_images, bool)):
        return json.dumps({"status": "denied"})
    name = uuid.uuid4().hex + ".json"
    request = Path("/run/luke-imagen/requests") / name
    temporary = request.with_suffix(".tmp")
    response = Path("/run/luke-imagen/responses") / name
    try:
        temporary.write_text(json.dumps({"id": task, "args": prompt, "useImages": use_images}, ensure_ascii=False))
        temporary.chmod(0o644)
        temporary.rename(request)
        deadline = time.monotonic() + 235
        while time.monotonic() < deadline:
            if response.is_file():
                return response.read_text()[:8192]
            time.sleep(0.5)
    except OSError:
        pass
    return json.dumps({"status": "unknown", "message": "Render not confirmed. Do not retry automatically."})


def register(ctx):
    ctx.register_tool(name="luke_imagen", toolset="luke-imagen", handler=render, schema={
        "name": "luke_imagen",
        "description": "Create the final image for this task after loading the imagen skill. The approved source images are supplied by the bridge. No file paths or URLs.",
        "parameters": {
            "type": "object", "additionalProperties": False,
            "required": ["prompt", "use_images"],
            "properties": {
                "prompt": {"type": "string", "description": "A concrete visual brief; preserve requested GIF, edit or reference mode."},
                "use_images": {"type": "boolean", "description": "Use current or quoted source images for an edit/reference."},
            },
        },
    })
