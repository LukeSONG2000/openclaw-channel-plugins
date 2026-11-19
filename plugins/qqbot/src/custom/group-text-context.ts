import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MAX_LOG_BYTES = 48 * 1024 * 1024;
const BUCKETS = 12;
const PER_BUCKET = 6;
const MAX_MESSAGE_LENGTH = 140;

export type GroupContextRange = "today" | "last24h";
const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 8 * 3_600_000;
export function groupContextStart(range: GroupContextRange, at: number): number {
  return range === "today" ? Math.floor((at + CHINA_OFFSET_MS) / DAY_MS) * DAY_MS - CHINA_OFFSET_MS : at - DAY_MS;
}

export async function loadGroupTextContext(params: {
  accountId: string;
  groupOpenid: string;
  requestMessageId: string;
  since: number;
  through: number;
  logDir?: string;
  skipText?: (text: string) => boolean;
}): Promise<{ messages: Array<{ at: string; text: string }>; count: number; limited: boolean }> {
  const { since, through } = params;
  if (!Number.isFinite(since) || !Number.isFinite(through) || since >= through || through - since > DAY_MS) {
    return { messages: [], count: 0, limited: false };
  }
  const logDir = params.logDir ?? join(tmpdir(), "openclaw");
  const eventPrefix = `[qqbot:${params.accountId}] `;
  const peer = params.groupOpenid.toLowerCase();
  const buckets: Array<Array<{ at: number; text: string }>> = Array.from({ length: BUCKETS }, () => []);
  const seen = new Set<string>();
  let count = 0;
  let limited = false;
  const files = (await readdir(logDir, { withFileTypes: true }).catch(() => []))
    .filter((file) => file.isFile() && /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(file.name))
    .map((file) => file.name).sort().slice(-3);
  for (const file of files) {
    const path = join(logDir, file);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.mtimeMs < since || info.size === 0) continue;
    const start = Math.max(0, info.size - MAX_LOG_BYTES);
    limited ||= start > 0;
    const lines = createInterface({ input: createReadStream(path, { start, end: info.size - 1, encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes("Dispatch event: t=GROUP") || !line.toLowerCase().includes(peer)) continue;
        try {
          const record = JSON.parse(line);
          const at = Date.parse(record.time);
          const raw = record["1"];
          if (!Number.isFinite(at) || at < since || at >= through || typeof raw !== "string" || !raw.startsWith(eventPrefix)) continue;
          const event = /Dispatch event: t=GROUP_(?:AT_)?MESSAGE_CREATE, d=(\{.*\})\s*$/u.exec(raw);
          if (!event) continue;
          const message = JSON.parse(event[1]);
          if (String(message.group_openid).toLowerCase() !== peer || message.author?.bot ||
              typeof message.id !== "string" || message.id === params.requestMessageId || seen.has(message.id) ||
              typeof message.content !== "string") continue;
          const text = message.content
            .replace(/<@!?[^>]+>|<faceType=[^>]+>|https?:\/\/[^\s<>]+|\bsk-[\w-]{10,}|\b[0-9a-f]{32,}\b/giu, "")
            .replace(/\s+/gu, " ").trim();
          if (!text || text.startsWith("/") || params.skipText?.(text) ||
              /(?:密码|密钥|验证码|access[_ -]?token|api[_ -]?key)/iu.test(text)) continue;
          seen.add(message.id);
          if (seen.size > 8192) seen.delete(seen.values().next().value!);
          count++;
          const bucket = buckets[Math.min(BUCKETS - 1, Math.floor((at - since) / (through - since) * BUCKETS))]!;
          bucket.push({ at, text: text.slice(0, MAX_MESSAGE_LENGTH) });
          if (bucket.length > PER_BUCKET) bucket.shift();
        } catch { /* Ignore partial lines and malformed log events. */ }
      }
    } catch {
      limited = true;
    } finally {
      lines.close();
    }
  }
  const sampled = buckets.flat().sort((a, b) => a.at - b.at);
  const format = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return { messages: sampled.map(({ at, text }) => ({ at: format.format(at), text })), count, limited };
}
