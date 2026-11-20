"""Fixture-only relay: loopback HTTP -> private Unix socket -> official API."""

import argparse
import asyncio
import json
import socketserver
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import httpx

CHAT = "/v1/chat/completions"
EMBEDDINGS = "/v1/embeddings"
MODELS = {CHAT: "glm-5.3-flash", EMBEDDINGS: "text-embedding-v4"}
ZHIPU = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
BAILIAN = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"


def upstream(socket_path, credential_file, embedding_file):
    from dotenv import dotenv_values

    key = dotenv_values(credential_file).get("ZAI_API_KEY")
    embedding_key = embedding_file.read_text().strip() if embedding_file else None
    if not key or (embedding_file and not embedding_key):
        raise RuntimeError("missing fixture credentials")
    with httpx.Client(timeout=35, trust_env=False, follow_redirects=False) as client:
        class Handler(BaseHTTPRequestHandler):
            def address_string(self):
                return "local-fixture"

            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    size = int(self.headers.get("Content-Length", "-1"))
                    if self.path not in MODELS or not 0 < size <= 64 * 1024:
                        return self.send_error(403)
                    body = json.loads(self.rfile.read(size))
                    if body.get("model") != MODELS[self.path] or body.get("stream"):
                        return self.send_error(403)
                    if self.path == CHAT:
                        body["thinking"] = {"type": "disabled"}
                        endpoint, credential = ZHIPU, key
                    elif embedding_key:
                        if body.get("dimensions") != 1536 or body.get("encoding_format") != "float":
                            return self.send_error(403)
                        endpoint, credential = BAILIAN, embedding_key
                    else:
                        return self.send_error(403)
                    response = client.post(endpoint, json=body,
                                           headers={"Authorization": "Bearer " + credential})
                    print(self.path, response.status_code, flush=True)
                    self.send_response(response.status_code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response.content)))
                    self.end_headers()
                    self.wfile.write(response.content)
                except (OSError, ValueError, httpx.HTTPError) as error:
                    print(self.path, "relay_error", type(error).__name__, flush=True)
                    self.send_error(502)

        with socketserver.ThreadingUnixStreamServer(socket_path, Handler) as server:
            Path(socket_path).chmod(0o600)
            server.serve_forever()


async def local(socket_path):
    async def handle(reader, writer):
        async def copy(src, dst):
            while data := await src.read(65536):
                dst.write(data)
                await dst.drain()

        other = None
        try:
            inbound, other = await asyncio.open_unix_connection(socket_path)
            tasks = [asyncio.create_task(copy(reader, other)), asyncio.create_task(copy(inbound, writer))]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED, timeout=50)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            writer.close()
            if other:
                other.close()

    async with await asyncio.start_server(handle, "127.0.0.1", 18080) as server:
        await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["upstream", "local"])
    parser.add_argument("socket")
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--embedding-credentials", type=Path)
    args = parser.parse_args()
    if args.mode == "upstream":
        if not args.credentials:
            parser.error("upstream requires a Zhipu credential file")
        upstream(args.socket, args.credentials, args.embedding_credentials)
    else:
        asyncio.run(local(args.socket))
