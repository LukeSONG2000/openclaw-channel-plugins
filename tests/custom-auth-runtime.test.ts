import assert from "node:assert";
import {
  CustomAuthorizationRuntime,
  defaultSceneCapabilities,
  evaluateCustomAuthorization,
  inspectCustomAdminBindings,
  isCustomRuntimeAdmin,
  resolveCustomAdminGroupKey,
} from "../src/custom/auth.js";
import type { CustomActor, CustomPeer, CustomRuntimeConfig, CustomSceneConfig } from "../src/custom/types.js";

const peer: CustomPeer = { kind: "group", id: "GROUP_OPENID", label: "Master Luke" };
const member: CustomActor = { id: "MEMBER_OPENID", label: "Member" };
const admin: CustomActor = { id: "ADMIN_OPENID", label: "Admin" };

const runtimeCfg: CustomRuntimeConfig = {
  enabled: true,
  admins: ["ADMIN_OPENID"],
  adminGroup: "group:ADMIN_GROUP_OPENID",
};
const chatScene: CustomSceneConfig = {
  scene: "chat",
};
const devScene: CustomSceneConfig = {
  scene: "dev-lab",
  capabilities: ["chat.send", "codex.run"],
};

assert.deepEqual(defaultSceneCapabilities("chat"), ["chat.send"]);
assert.equal(resolveCustomAdminGroupKey(runtimeCfg.adminGroup), "qqbot:group:ADMIN_GROUP_OPENID");
assert.deepEqual(inspectCustomAdminBindings(runtimeCfg), {
  enabled: true,
  admins: ["ADMIN_OPENID"],
  adminGroup: "qqbot:group:ADMIN_GROUP_OPENID",
  missing: [],
  ready: true,
});
assert.equal(isCustomRuntimeAdmin(runtimeCfg, admin), true);
assert.equal(isCustomRuntimeAdmin(runtimeCfg, member), false);

const sceneAllowed = evaluateCustomAuthorization({
  runtime: runtimeCfg,
  scene: devScene,
  peer,
  actor: member,
  capability: "codex.run",
});
assert.equal(sceneAllowed.allowed, true);
assert.equal(sceneAllowed.source, "scene");

const adminAllowed = evaluateCustomAuthorization({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: admin,
  capability: "system.restart",
});
assert.equal(adminAllowed.allowed, true);
assert.equal(adminAllowed.source, "admin");

const disabled = evaluateCustomAuthorization({
  runtime: { enabled: false },
  scene: devScene,
  peer,
  actor: member,
  capability: "chat.send",
});
assert.equal(disabled.allowed, false);
assert.equal(disabled.reason, "scene_disabled");

const authRuntime = new CustomAuthorizationRuntime();
const denied = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "system.restart",
  now: 1_000,
});
assert.equal(denied.decision.allowed, false);
assert.equal(denied.decision.reason, "missing_capability");
assert.equal(denied.intents.length, 1);
assert.equal(denied.intents[0]!.kind, "request-approval");
if (denied.intents[0]!.kind !== "request-approval") throw new Error("expected approval request");
assert.equal(denied.intents[0].deduped, false);
const requestId = denied.intents[0].request.id;
assert.equal(denied.decision.requestId, requestId);
assert.deepEqual(denied.intents[0].request.admins, ["ADMIN_OPENID"]);
assert.equal(denied.intents[0].request.adminGroup, "qqbot:group:ADMIN_GROUP_OPENID");

const duplicate = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "system.restart",
  now: 2_000,
});
assert.equal(duplicate.intents.length, 1);
assert.equal(duplicate.intents[0]!.kind, "request-approval");
if (duplicate.intents[0]!.kind !== "request-approval") throw new Error("expected approval request");
assert.equal(duplicate.intents[0].deduped, true);
assert.equal(duplicate.intents[0].request.id, requestId);

const resolved = authRuntime.resolveApproval({
  requestId,
  approved: true,
  resolvedBy: admin.id,
  now: 3_000,
  grantUse: "once",
});
assert.equal(resolved?.kind, "approval-resolved");
if (!resolved || resolved.kind !== "approval-resolved" || !resolved.grant) throw new Error("expected approval grant");
const grantId = resolved.grant.id;
assert.equal(resolved.grant.remainingUses, 1);

const granted = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "system.restart",
  now: 4_000,
});
assert.equal(granted.decision.allowed, true);
assert.equal(granted.decision.source, "temporary-grant");
assert.equal(granted.decision.grantId, grantId);
assert.equal(granted.intents.some((intent) => intent.kind === "grant-consumed" && intent.grantId === grantId), true);

const secondUse = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "system.restart",
  now: 5_000,
  requestApproval: false,
});
assert.equal(secondUse.decision.allowed, false);

const timedGrant = authRuntime.grant({
  peerId: peer.id,
  actorId: member.id,
  capability: "deploy.check",
  grantedBy: admin.id,
  use: "timed",
  now: 10_000,
  ttlMs: 1_000,
});
assert.equal(timedGrant.expiresAt, 11_000);
const expired = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "deploy.check",
  now: 11_500,
  requestApproval: false,
});
assert.equal(expired.decision.allowed, false);
assert.equal(expired.intents.some((intent) => intent.kind === "grant-expired" && intent.grantId === timedGrant.id), true);

authRuntime.grant({
  peerId: peer.id,
  actorId: member.id,
  capability: "codex.longTask",
  grantedBy: admin.id,
  use: "task",
  taskId: "task-1",
  now: 20_000,
});
const wrongTask = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "codex.longTask",
  taskId: "task-2",
  now: 21_000,
  requestApproval: false,
});
assert.equal(wrongTask.decision.allowed, false);
const rightTask = authRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "codex.longTask",
  taskId: "task-1",
  now: 21_000,
  requestApproval: false,
});
assert.equal(rightTask.decision.allowed, true);
assert.equal(rightTask.decision.source, "temporary-grant");

const restoredRuntime = new CustomAuthorizationRuntime();
const loadIntents = restoredRuntime.loadState(authRuntime.getState(), { now: 22_000 });
assert.equal(loadIntents.length, 0);
const restoredTask = restoredRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "codex.longTask",
  taskId: "task-1",
  now: 23_000,
  requestApproval: false,
});
assert.equal(restoredTask.decision.allowed, true);
assert.equal(restoredTask.decision.source, "temporary-grant");

const nextDenied = restoredRuntime.check({
  runtime: runtimeCfg,
  scene: chatScene,
  peer,
  actor: member,
  capability: "deploy.apply",
  now: 24_000,
});
assert.equal(nextDenied.intents[0]?.kind, "request-approval");
if (nextDenied.intents[0]?.kind !== "request-approval") throw new Error("expected restored runtime request");
assert.equal(nextDenied.intents[0].request.id.endsWith("-2"), true);

console.log("custom auth runtime tests passed");
