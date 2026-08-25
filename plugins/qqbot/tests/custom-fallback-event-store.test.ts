import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendCustomFallbackEvent,
  clearCustomFallbackEvents,
  getCustomFallbackEventStorePath,
  loadCustomFallbackEvents,
  saveCustomFallbackEvents,
} from "../src/custom/fallback-event-store.js";
import { buildCustomFallbackEvent, type CustomFallbackEvent } from "../src/custom/fallbacks.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-fallback-events-"));
try {
  const accountId = "default/account";
  const event1 = makeEvent(accountId, "MSG_1", 1_000);
  const event2 = makeEvent(accountId, "MSG_2", 2_000);
  const event3 = makeEvent(accountId, "MSG_3", 3_000);

  assert.equal(saveCustomFallbackEvents(accountId, [event1, event2], { dir: tmpDir, limit: 10 }), true);
  const filePath = getCustomFallbackEventStorePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "events-default_account.json");
  assert.equal(fs.existsSync(filePath), true);
  assert.deepEqual(loadCustomFallbackEvents(accountId, { dir: tmpDir }), [event1, event2]);

  assert.equal(appendCustomFallbackEvent(accountId, event3, { dir: tmpDir, limit: 2 }), true);
  assert.deepEqual(loadCustomFallbackEvents(accountId, { dir: tmpDir, limit: 10 }), [event2, event3]);

  assert.equal(clearCustomFallbackEvents(accountId, { dir: tmpDir }), true);
  assert.deepEqual(loadCustomFallbackEvents(accountId, { dir: tmpDir }), []);

  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    accountId,
    events: [
      { type: "other", accountId, at: 4_000 },
      makeEvent("other", "MSG_OTHER", 4_000),
      makeEvent(accountId, "MSG_4", 4_000),
    ],
  }), "utf8");
  assert.deepEqual(loadCustomFallbackEvents(accountId, { dir: tmpDir }), [makeEvent(accountId, "MSG_4", 4_000)]);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, accountId: "other", events: [event1] }), "utf8");
  assert.deepEqual(loadCustomFallbackEvents(accountId, { dir: tmpDir }), []);

  fs.writeFileSync(filePath, "{not json", "utf8");
  assert.deepEqual(loadCustomFallbackEvents(accountId, { dir: tmpDir }), []);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeEvent(accountId: string, messageId: string, at: number): CustomFallbackEvent {
  return buildCustomFallbackEvent({
    kind: "response-timeout",
    accountId,
    peer: { kind: "group", id: "GROUP_OPENID" },
    actor: { id: "MEMBER_OPENID" },
    sessionKey: "agent:main:qqbot:default:group:group_openid",
    runId: messageId,
    messageId,
    reason: "Response timeout",
    at,
    timeoutMs: 300_000,
    hasBlockResponse: false,
  });
}

console.log("custom fallback event store tests passed");
