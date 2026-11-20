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
        tools = {t.get("function", {}).get("name") for t in body.get("tools", [])}
        tool_call = None
        if "kanban_complete" in tools and not any(m["role"] == "tool" for m in body["messages"]):
            time.sleep(5)
            answer = None
            tool_call = {"id": "call_qq_fixture", "type": "function", "function": {
                "name": "kanban_complete", "arguments": json.dumps({
                    "summary": "Synthetic Kanban run finished.",
                    "result": "The durable report is ready.",
                }),
            }}
        elif "[QQ_BACKGROUND_WORK]" in content:
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
        message = {"role": "assistant", "content": answer}
        reason = "stop"
        if tool_call:
            message["tool_calls"] = [tool_call]
            reason = "tool_calls"
        base = {"id": "chatcmpl-fixture", "model": body["model"], "created": int(time.time())}
        if not body.get("stream"):
            self.send_json(dict(base, object="chat.completion", choices=[{
                "index": 0, "message": message, "finish_reason": reason,
            }], usage={"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}))
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if tool_call:
            message["tool_calls"] = [dict(tool_call, index=0)]
        for delta, finish in ((message, None), ({}, reason)):
            event = dict(base, object="chat.completion.chunk", choices=[
                {"index": 0, "delta": delta, "finish_reason": finish},
            ])
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


ThreadingHTTPServer(("0.0.0.0", 8000), Fixture).serve_forever()
