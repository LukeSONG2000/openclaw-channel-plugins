import assert from "node:assert";
import { CustomDeployConfirmationRuntime, normalizeDeployCommand } from "../src/custom/deploy-confirmation.js";

assert.equal(normalizeDeployCommand("/bot-upgrade   --latest"), "/bot-upgrade --latest");
assert.equal(normalizeDeployCommand("/bot-upgrade"), null);
assert.equal(normalizeDeployCommand("/bot-upgradefoo --latest"), null);
assert.equal(normalizeDeployCommand("/bot-version"), null);

const runtime = new CustomDeployConfirmationRuntime();
const created = runtime.create({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID", label: "Creator" },
  command: "/bot-upgrade --latest",
  now: 1_000,
});
assert.equal(created.allowed, true);
assert.equal(created.confirmation?.id, "deploy-default-group-GROUP_OPENID-1000-1");
assert.equal(created.confirmation?.status, "pending");
assert.equal(created.confirmation?.expiresAt, 601_000);

const confirmed = runtime.resolve({
  confirmationId: created.confirmation!.id,
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  approved: true,
  now: 2_000,
});
assert.equal(confirmed.allowed, true);
assert.equal(confirmed.confirmation?.status, "confirmed");
assert.equal(confirmed.confirmation?.resolvedBy?.id, "ADMIN_OPENID");

const alreadyHandled = runtime.resolve({
  confirmationId: created.confirmation!.id,
  actor: { id: "ADMIN_OPENID" },
  approved: true,
  now: 2_500,
});
assert.equal(alreadyHandled.allowed, false);
assert.equal(alreadyHandled.reason, "not_pending");

const expiring = runtime.create({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID" },
  command: "/bot-upgrade --version 1.7.2-luke.3",
  now: 3_000,
  ttlMs: 100,
});
assert.equal(expiring.allowed, true);
const expired = runtime.resolve({
  confirmationId: expiring.confirmation!.id,
  actor: { id: "ADMIN_OPENID" },
  approved: true,
  now: 3_200,
});
assert.equal(expired.allowed, false);
assert.equal(expired.reason, "expired");
assert.equal(expired.confirmation?.status, "expired");

assert.equal(runtime.list({ status: "active", now: 3_300 }).length, 0);
assert.deepEqual(runtime.list({ status: "confirmed" }).map((item) => item.id), [created.confirmation!.id]);

const invalid = runtime.create({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID" },
  command: "/bot-upgrade",
});
assert.equal(invalid.allowed, false);
assert.equal(invalid.reason, "invalid_command");

const restored = new CustomDeployConfirmationRuntime();
restored.loadState(runtime.getState(), { now: 4_000 });
assert.equal(restored.get(created.confirmation!.id)?.status, "confirmed");
const next = restored.create({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID" },
  command: "/bot-upgrade --latest",
  now: 5_000,
});
assert.equal(next.confirmation?.id.endsWith("-3"), true);

console.log("custom deploy confirmation tests passed");
