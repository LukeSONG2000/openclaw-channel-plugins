import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { InboundMediaContext } from "./monitor.js";

type Turn = {
  account: string;
  scope: "group" | "direct";
  chat: string;
  messageId: string;
  text: string;
  instruction?: string;
  ambient: boolean;
  media?: InboundMediaContext;
};

const imageLimit = 2 * 1024 * 1024;

async function imageInputs(media?: InboundMediaContext): Promise<string[]> {
  const images: string[] = [];
  for (const item of media?.items ?? []) {
    if (images.length === 2) break;
    if (item.kind !== "picture" || !/^image\/(png|jpeg|gif|webp)$/i.test(item.contentType)) continue;
    try {
      const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > imageLimit) continue;
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead === buffer.length) images.push(`data:${item.contentType.toLowerCase()};base64,${buffer.toString("base64")}`);
      } finally { await file.close(); }
    } catch {
      // A vanished attachment should not lose the text turn.
    }
  }
  return images;
}

export function createHermesDingTalkReply(container: string) {
  if (!/^r2-hermes-qq-dingtalk$/.test(container)) throw new Error("Invalid DingTalk Hermes target");
  return async ({ media, ...turn }: Turn): Promise<string> => {
    const input = JSON.stringify({
      ...turn, text: turn.text.slice(0, 16_000),
      instruction: turn.instruction?.slice(0, 4_000), images: await imageInputs(media),
    });
    return await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/podman", ["exec", "-i", "-u", "hermes", container,
        "node", "/pilot/hermes-qq/shadow.mjs", "dingtalk"], { stdio: ["pipe", "pipe", "ignore"] });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("DingTalk Hermes reply timed out")); }, 155_000);
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 65_536) { child.kill(); reject(new Error("DingTalk Hermes response exceeded limit")); }
      });
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timeout); reject(new Error("DingTalk Hermes bridge unavailable")); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error("DingTalk Hermes turn failed"));
        try {
          const result = JSON.parse(stdout);
          if (typeof result.text !== "string" || result.text.length > 12_000) throw new Error();
          resolve(result.text);
        } catch { reject(new Error("Invalid DingTalk Hermes response")); }
      });
      child.stdin.end(input);
    });
  };
}
