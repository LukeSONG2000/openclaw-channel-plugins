#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const explicitDataDir = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const dataDir = explicitDataDir
  ? path.resolve(explicitDataDir.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), ".openclaw", "qqbot", "data");
const includeSamples = args.has("--samples");

const knownUsersPath = path.join(dataDir, "known-users.json");
const refIndexPath = path.join(dataDir, "ref-index.jsonl");

const report = {
  dataDir,
  knownUsers: inspectKnownUsers(knownUsersPath, includeSamples),
  refIndex: inspectRefIndex(refIndexPath, includeSamples),
};

console.log(JSON.stringify(report, null, 2));

function inspectKnownUsers(filePath, samples) {
  const result = {
    exists: fs.existsSync(filePath),
    entries: 0,
    byType: {},
    withNickname: 0,
    withGroupOpenid: 0,
    rawNumericLikeValues: 0,
  };
  if (!result.exists) return result;

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const entries = Array.isArray(raw) ? raw : Object.values(raw.users || raw || {});
  result.entries = entries.length;
  if (samples) result.samples = [];

  for (const entry of entries) {
    const type = String(entry?.type || "unknown");
    result.byType[type] = (result.byType[type] || 0) + 1;
    if (entry?.nickname) result.withNickname++;
    if (entry?.groupOpenid) result.withGroupOpenid++;
    for (const value of [entry?.openid, entry?.groupOpenid]) {
      if (typeof value === "string" && /^\d{5,}$/.test(value)) result.rawNumericLikeValues++;
    }
    if (samples && result.samples.length < 8) {
      result.samples.push({
        type: entry?.type,
        hasOpenid: Boolean(entry?.openid),
        hasGroupOpenid: Boolean(entry?.groupOpenid),
        hasNickname: Boolean(entry?.nickname),
      });
    }
  }

  return result;
}

function inspectRefIndex(filePath, samples) {
  const result = {
    exists: fs.existsSync(filePath),
    records: 0,
    withAttachments: 0,
    attachmentCount: 0,
    attachmentTypes: {},
    contentHints: {
      face: 0,
      url: 0,
      quoteLike: 0,
      voiceText: 0,
    },
  };
  if (!result.exists) return result;
  if (samples) result.samples = [];

  for (const line of fs.readFileSync(filePath, "utf8").split(/\n/g)) {
    if (!line.trim()) continue;
    result.records++;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = row?.v || {};
    const content = String(entry.content || "");
    if (/<faceType=/.test(content) || /【表情:/.test(content)) result.contentHints.face++;
    if (/https?:\/\//.test(content)) result.contentHints.url++;
    if (/ref_msg_idx|msg_idx|引用|回复/.test(content)) result.contentHints.quoteLike++;
    if (/\[语音/.test(content)) result.contentHints.voiceText++;

    if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
      result.withAttachments++;
      result.attachmentCount += entry.attachments.length;
      for (const attachment of entry.attachments) {
        const type = attachment?.contentType || attachment?.type || "unknown";
        result.attachmentTypes[type] = (result.attachmentTypes[type] || 0) + 1;
      }
      if (samples && result.samples.length < 5) {
        result.samples.push({
          contentLength: content.length,
          attachments: entry.attachments.map((attachment) => ({
            type: attachment?.type,
            contentType: attachment?.contentType,
            hasFilename: Boolean(attachment?.filename),
            hasLocalPath: Boolean(attachment?.localPath),
            hasUrl: Boolean(attachment?.url),
            hasTranscript: Boolean(attachment?.transcript),
            transcriptSource: attachment?.transcriptSource,
          })),
        });
      }
    }
  }

  return result;
}
