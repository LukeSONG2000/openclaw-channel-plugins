import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomProactiveBudgetStatePath,
  loadCustomProactiveBudgetState,
  saveCustomProactiveBudgetState,
} from "../src/custom/proactive-budget-store.js";
import type { CustomProactiveBudgetRuntimeState } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-budget-"));
try {
  const accountId = "default/account";
  const state: CustomProactiveBudgetRuntimeState = {
    entries: {
      "default:group:GROUP_OPENID": {
        period: "2026-06",
        count: 2,
        recent: [1_000, 2_000],
        updatedAt: 2_000,
      },
    },
  };

  assert.equal(saveCustomProactiveBudgetState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomProactiveBudgetStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "budget-default_account.json");
  assert.equal(fs.existsSync(filePath), true);

  const loaded = loadCustomProactiveBudgetState(accountId, { dir: tmpDir });
  assert.deepEqual(loaded, state);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, accountId: "other", state }), "utf8");
  assert.equal(loadCustomProactiveBudgetState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom proactive budget store tests passed");
