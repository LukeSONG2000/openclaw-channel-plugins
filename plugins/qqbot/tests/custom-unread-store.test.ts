import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomUnreadStatePath,
  loadCustomUnreadState,
  saveCustomUnreadState,
} from "../src/custom/unread-store.js";
import type { CustomUnreadRuntimeState } from "../src/custom/unread-runtime.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-unread-"));
try {
  const accountId = "default/account";
  const state: CustomUnreadRuntimeState = {
    peers: {
      GROUP_OPENID: {
        history: [{
          actorId: "MEMBER_OPENID",
          actorLabel: "Member",
          body: "hello",
          timestamp: 2_000,
          messageId: "msg-1",
          attachments: [{ contentType: "image/png", filename: "a.png", url: "https://example.com/a.png" }],
        }],
        followupActive: true,
        catchupAnchor: 2_000,
        scheduledFollowupDueAt: 3_000,
        scheduledSleepDigestDueAt: 12_000,
      },
    },
    snapshots: {
      "custom-unread-GROUP_OPENID-2000-1": {
        id: "custom-unread-GROUP_OPENID-2000-1",
        peerId: "GROUP_OPENID",
        source: "followup",
        entries: [{
          actorId: "MEMBER_OPENID",
          body: "hello",
          timestamp: 2_000,
          messageId: "msg-1",
        }],
        createdAt: 2_000,
        policyGated: false,
        prompt: "prompt",
      },
    },
  };

  assert.equal(saveCustomUnreadState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomUnreadStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "unread-default_account.json");
  assert.equal(fs.existsSync(filePath), true);

  const loaded = loadCustomUnreadState(accountId, { dir: tmpDir });
  assert.deepEqual(loaded, state);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, accountId: "other", state }), "utf8");
  assert.equal(loadCustomUnreadState(accountId, { dir: tmpDir }), null);

  fs.writeFileSync(filePath, "{not json", "utf8");
  assert.equal(loadCustomUnreadState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom unread store tests passed");
