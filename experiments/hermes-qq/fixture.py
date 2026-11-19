"""Deterministic local provider for the QQ pilot replay, not a production model."""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, payload):
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_json({"object": "list", "data": [{"id": "qq-test-model", "object": "model"}]})
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        content = next((m["content"] for m in reversed(body["messages"]) if m["role"] == "user"), "")
        content = str(content)
        if "[QQ_BACKGROUND_WORK]" in content:
            time.sleep(12)
            answer = "The background report is ready."
        elif "[QQ_AMBIENT_WINDOW]" in content:
            answer = json.dumps({"natural": "A is worth a look.", "reply": {"target": "m3", "text": "B is at seven."}})
        elif "[QQ_MENTION_ROUTE]" in content:
            answer = json.dumps(
                {"route": "work", "text": "Prepare the report."} if "make a report" in content
                else {"route": "chat", "text": "I'm here."}
            )
        else:
            answer = "ready"
        base = {"id": "chatcmpl-fixture", "model": body["model"], "created": int(time.time())}
        if not body.get("stream"):
            self.send_json(dict(base, object="chat.completion", choices=[{
                "index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop",
            }], usage={"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}))
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in (({"role": "assistant", "content": answer}, None), ({}, "stop")):
            event = dict(base, object="chat.completion.chunk", choices=[
                {"index": 0, "delta": delta, "finish_reason": finish},
            ])
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


ThreadingHTTPServer(("0.0.0.0", 8000), Fixture).serve_forever()
