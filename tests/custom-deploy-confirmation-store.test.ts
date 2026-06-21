import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomDeployConfirmationStatePath,
  loadCustomDeployConfirmationState,
  saveCustomDeployConfirmationState,
} from "../src/custom/deploy-confirmation-store.js";
import type { CustomDeployConfirmationRuntimeState } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-deploy-confirmations-"));
try {
  const accountId = "default/account";
  const state: CustomDeployConfirmationRuntimeState = {
    confirmations: {
      "deploy-default-group-GROUP_OPENID-1000-1": {
        id: "deploy-default-group-GROUP_OPENID-1000-1",
        accountId,
        peer: { kind: "group", id: "GROUP_OPENID" },
        creator: { id: "CREATOR_OPENID", label: "Creator" },
        command: "/bot-upgrade --latest",
        status: "pending",
        createdAt: 1_000,
        expiresAt: 601_000,
      },
    },
  };

  assert.equal(saveCustomDeployConfirmationState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomDeployConfirmationStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "deploy-confirmations-default_account.json");
  assert.equal(fs.existsSync(filePath), true);
  const loaded = loadCustomDeployConfirmationState(accountId, { dir: tmpDir });
  assert.equal(loaded?.confirmations["deploy-default-group-GROUP_OPENID-1000-1"]?.command, "/bot-upgrade --latest");

  fs.writeFileSync(filePath, "{bad json", "utf8");
  assert.equal(loadCustomDeployConfirmationState(accountId, { dir: tmpDir }), null);
  fs.writeFileSync(filePath, JSON.stringify({ version: 999, accountId, state }), "utf8");
  assert.equal(loadCustomDeployConfirmationState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom deploy confirmation store tests passed");
