import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomAuthorizationStatePath,
  loadCustomAuthorizationState,
  saveCustomAuthorizationState,
} from "../src/custom/auth-store.js";
import type { CustomAuthorizationRuntimeState } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-auth-"));
try {
  const accountId = "default/account";
  const state: CustomAuthorizationRuntimeState = {
    grants: {
      "grant-1000-1": {
        id: "grant-1000-1",
        peerId: "GROUP_OPENID",
        actorId: "MEMBER_OPENID",
        capability: "deploy.check",
        grantedBy: "ADMIN_OPENID",
        createdAt: 1_000,
        expiresAt: 61_000,
      },
    },
    requests: {
      "authreq-2000-1": {
        id: "authreq-2000-1",
        peer: { kind: "group", id: "GROUP_OPENID" },
        actor: { id: "MEMBER_OPENID", label: "Member" },
        capability: "config.write",
        scene: "chat",
        reason: "missing_capability",
        requestedAt: 2_000,
        expiresAt: 602_000,
        admins: ["ADMIN_OPENID"],
        status: "pending",
      },
    },
  };

  assert.equal(saveCustomAuthorizationState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomAuthorizationStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "auth-default_account.json");
  assert.equal(fs.existsSync(filePath), true);

  const loaded = loadCustomAuthorizationState(accountId, { dir: tmpDir });
  assert.deepEqual(loaded, state);

  fs.writeFileSync(filePath, JSON.stringify({ version: 1, accountId: "other", state }), "utf8");
  assert.equal(loadCustomAuthorizationState(accountId, { dir: tmpDir }), null);

  fs.writeFileSync(filePath, "{not json", "utf8");
  assert.equal(loadCustomAuthorizationState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom auth store tests passed");
