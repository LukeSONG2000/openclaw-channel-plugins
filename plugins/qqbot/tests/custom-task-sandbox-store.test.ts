import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomTaskSandboxStatePath,
  loadCustomTaskSandboxState,
  saveCustomTaskSandboxState,
} from "../src/custom/task-sandbox-store.js";
import type { CustomTaskSandboxRuntimeState } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-tasks-"));
try {
  const accountId = "default/account";
  const state: CustomTaskSandboxRuntimeState = {
    tasks: {
      "qqbot-default-group-GROUP_OPENID-2000-1": {
        id: "qqbot-default-group-GROUP_OPENID-2000-1",
        accountId,
        peer: { kind: "group", id: "GROUP_OPENID" },
        owner: { id: "MEMBER_OPENID", label: "Member" },
        title: "Persist task state",
        prompt: "Persist task state",
        status: "queued",
        workspace: "/tmp/tasks/qqbot-default-group-GROUP_OPENID-2000-1",
        createdAt: 2_000,
        updatedAt: 2_000,
        execution: {
          executorId: "executor-1",
          runId: "run-1",
        },
        requirements: [],
      },
    },
  };

  assert.equal(saveCustomTaskSandboxState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomTaskSandboxStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "tasks-default_account.json");
  assert.equal(fs.existsSync(filePath), true);

  const loaded = loadCustomTaskSandboxState(accountId, { dir: tmpDir });
  assert.deepEqual(loaded, state);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, accountId: "other", state }), "utf8");
  assert.equal(loadCustomTaskSandboxState(accountId, { dir: tmpDir }), null);

  fs.writeFileSync(filePath, "{not json", "utf8");
  assert.equal(loadCustomTaskSandboxState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom task sandbox store tests passed");
