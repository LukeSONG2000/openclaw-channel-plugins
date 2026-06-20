import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomPollStatePath,
  loadCustomPollState,
  saveCustomPollState,
} from "../src/custom/poll-store.js";
import type { CustomPollRuntimeState } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-polls-"));
try {
  const accountId = "default/account";
  const state: CustomPollRuntimeState = {
    polls: {
      "poll-default-group-GROUP_OPENID-3000-1": {
        id: "poll-default-group-GROUP_OPENID-3000-1",
        accountId,
        peer: { kind: "group", id: "GROUP_OPENID" },
        creator: { id: "CREATOR_OPENID", label: "Creator" },
        question: "Pick one",
        options: [
          { id: "1", label: "A" },
          { id: "2", label: "B" },
        ],
        votes: {
          VOTER_OPENID: {
            actor: { id: "VOTER_OPENID", label: "Voter" },
            optionId: "2",
            votedAt: 4_000,
          },
        },
        status: "open",
        createdAt: 3_000,
        updatedAt: 4_000,
      },
    },
  };

  assert.equal(saveCustomPollState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomPollStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "polls-default_account.json");
  assert.equal(fs.existsSync(filePath), true);

  const loaded = loadCustomPollState(accountId, { dir: tmpDir });
  assert.deepEqual(loaded, state);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, accountId: "other", state }), "utf8");
  assert.equal(loadCustomPollState(accountId, { dir: tmpDir }), null);

  fs.writeFileSync(filePath, "{not json", "utf8");
  assert.equal(loadCustomPollState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom poll store tests passed");
