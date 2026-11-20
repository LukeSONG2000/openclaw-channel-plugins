"""Send a typed render request for this worker's native task only."""

import http.client
import json
import os
import re
import socket


class RendererConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/run/luke-imagen/render.sock")


def render(args, **_):
    task = os.environ.get("HERMES_KANBAN_TASK", "")
    prompt, use_images = args.get("prompt"), args.get("use_images")
    if (not re.fullmatch(r"t_[a-f0-9]{8,32}", task) or not isinstance(prompt, str)
            or not 1 <= len(prompt.strip()) <= 1800 or not isinstance(use_images, bool)):
        return json.dumps({"status": "denied"})
    conn = RendererConnection("localhost", timeout=235)
    try:
        conn.request("POST", "/render", body=json.dumps(
            {"id": task, "args": prompt, "useImages": use_images}, ensure_ascii=False).encode("utf-8"))
        response = conn.getresponse()
        if response.status == 200:
            return response.read(8192).decode("utf-8")
    except (OSError, http.client.HTTPException):
        pass
    finally:
        conn.close()
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
