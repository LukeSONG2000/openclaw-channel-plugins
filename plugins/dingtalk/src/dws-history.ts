import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DingTalkChatEntry, DingTalkHistoryBatch } from "./chat-runtime.js";

const execFileAsync = promisify(execFile);

interface DwsHistoryMessage {
  content?: string;
  createTime?: string;
  openMessageId?: string;
  sender?: string;
  senderOpenDingTalkId?: string;
}

function formatDwsTime(timestamp: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function parseDwsTime(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}+08:00`);
}

export function extractDwsImageMediaIds(content: string): string[] {
  return [...content.matchAll(/\[图片消息\]\(mediaId=([^)]+)\)/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function contentTypeForFile(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    default: return "image/png";
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

async function downloadDwsImage(params: {
  binary: string;
  groupId: string;
  messageId: string;
  resourceId: string;
  mediaRoot: string;
}): Promise<NonNullable<DingTalkChatEntry["media"]>[number]> {
  const outputDir = path.join(params.mediaRoot, safePathPart(params.groupId), safePathPart(params.messageId));
  fs.mkdirSync(outputDir, { recursive: true });
  await execFileAsync(params.binary, [
    "chat", "message", "download-media",
    "--type", "mediaId",
    "--resource-id", params.resourceId,
    "--message-id", params.messageId,
    "--open-conversation-id", params.groupId,
    "--output", outputDir,
    "--format", "json",
  ], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const files = fs.readdirSync(outputDir)
    .map((name) => path.join(outputDir, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const file = files[0];
  if (!file) throw new Error(`DWS downloaded no file for ${params.messageId}`);
  return {
    kind: "picture",
    path: file,
    contentType: contentTypeForFile(file),
    fileName: path.basename(file),
    fileSize: fs.statSync(file).size,
  };
}

function pruneDwsMediaRoot(root: string, maxAgeMs = 24 * 60 * 60 * 1_000): void {
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() - maxAgeMs;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(item);
        if (fs.readdirSync(item).length === 0) fs.rmdirSync(item);
      } else if (fs.statSync(item).mtimeMs < cutoff) {
        fs.rmSync(item, { force: true });
      }
    }
  };
  visit(root);
}

export function parseDwsHistoryResponse(
  stdout: string,
  selfNames: ReadonlySet<string>,
): DingTalkHistoryBatch {
  const envelope = JSON.parse(stdout) as {
    success?: boolean;
    errorMsg?: string | null;
    result?: { messages?: DwsHistoryMessage[] };
  };
  if (!envelope.success) throw new Error(envelope.errorMsg || "DWS history request failed");
  let cursorAt = 0;
  const entries = (envelope.result?.messages ?? []).flatMap((message) => {
    const messageId = message.openMessageId?.trim();
    const senderName = message.sender?.trim();
    const body = message.content?.trim();
    const timestamp = message.createTime ? parseDwsTime(message.createTime) : NaN;
    if (Number.isFinite(timestamp)) cursorAt = Math.max(cursorAt, timestamp);
    const mentionsSelf = [...selfNames].some((name) => body?.includes(`@${name}`));
    if (!messageId || !senderName || !body || !Number.isFinite(timestamp) || selfNames.has(senderName) || mentionsSelf) return [];
    return [{
      messageId,
      senderId: message.senderOpenDingTalkId?.trim() || senderName,
      senderName,
      body,
      timestamp,
    }];
  });
  return { entries, cursorAt };
}

export async function fetchDwsGroupHistory(params: {
  groupId: string;
  since: number;
  selfNames?: string[];
  binary?: string;
  mediaRoot?: string;
}): Promise<DingTalkHistoryBatch> {
  const binary = params.binary || process.env.DWS_BIN || "dws";
  const { stdout } = await execFileAsync(binary, [
    "chat", "message", "list",
    "--group", params.groupId,
    "--time", formatDwsTime(params.since),
    "--limit", "100",
    "--format", "json",
  ], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const batch = parseDwsHistoryResponse(stdout, new Set(params.selfNames?.filter(Boolean) ?? []));
  const mediaRoot = params.mediaRoot ?? path.join(
    process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw"),
    "media", "ddingtalk", "history",
  );
  pruneDwsMediaRoot(mediaRoot);
  for (const entry of batch.entries) {
    const mediaIds = extractDwsImageMediaIds(entry.body);
    if (mediaIds.length === 0) continue;
    entry.media = [];
    for (const resourceId of mediaIds) {
      entry.media.push(await downloadDwsImage({
        binary,
        groupId: params.groupId,
        messageId: entry.messageId,
        resourceId,
        mediaRoot,
      }));
    }
    entry.body = entry.body.replace(/\[图片消息\]\(mediaId=[^)]+\)(?:\s*注意：[^\n]*)?/g, "[图片]").trim();
  }
  return batch;
}
