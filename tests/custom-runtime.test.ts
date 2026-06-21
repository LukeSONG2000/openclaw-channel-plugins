import assert from "node:assert";
import {
  evaluateCustomAuthorization,
  inspectCustomAdminBindings,
  isCustomRuntimeAdmin,
  resolveCustomAdminGroupKey,
} from "../src/custom/auth.js";
import {
  applyCustomRuntimeAdminGroupSceneBinding,
  formatCustomPeerKey,
  resolveCustomRuntimeConfig,
  resolveCustomSceneConfig,
} from "../src/custom/config.js";
import { createCustomMessageFlowRuntime, inspectCustomRuntimeMessage, inspectCustomUnreadConfig } from "../src/custom/runtime.js";
import type { CustomActor, CustomPeer } from "../src/custom/types.js";

const groupPeer: CustomPeer = { kind: "group", id: "GROUP_OPENID", label: "test-group" };
const user: CustomActor = { id: "USER_OPENID", label: "member" };
const admin: CustomActor = { id: "ADMIN_OPENID", label: "admin" };

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        adminGroup: "GROUP_OPENID",
        defaultScene: "default-dm",
        scenes: {
          [formatCustomPeerKey(groupPeer)]: {
            scene: "dev-lab",
            label: "dev group",
            unread: {
              followupDelayMs: 5_000,
            },
            capabilities: ["chat.send", "codex.run"],
          },
        },
        unread: {
          historyLimit: 20,
          sleepDelayMs: 60_000,
        },
        fallbackAlerts: {
          threshold: 2,
          windowMs: 60_000,
        },
      },
    },
  },
} as any;

const runtime = resolveCustomRuntimeConfig(cfg);
assert.equal(runtime.enabled, true);
assert.equal(runtime.adminGroup, "GROUP_OPENID");
assert.deepEqual(runtime.fallbackAlerts, {
  threshold: 2,
  windowMs: 60_000,
});
assert.equal(isCustomRuntimeAdmin(runtime, admin), true);
assert.equal(isCustomRuntimeAdmin(runtime, user), false);
assert.equal(resolveCustomAdminGroupKey(runtime.adminGroup), "qqbot:group:GROUP_OPENID");
assert.deepEqual(inspectCustomAdminBindings(runtime), {
  enabled: true,
  admins: ["ADMIN_OPENID"],
  adminGroup: "qqbot:group:GROUP_OPENID",
  missing: [],
  ready: true,
});
assert.deepEqual(inspectCustomAdminBindings({ enabled: true, admins: [] }), {
  enabled: true,
  admins: [],
  adminGroup: undefined,
  missing: ["admins", "adminGroup"],
  ready: false,
});
assert.equal(resolveCustomAdminGroupKey("qqbot:channel:CHANNEL_ID"), undefined);
assert.deepEqual(applyCustomRuntimeAdminGroupSceneBinding({}, "qqbot:group:ADMIN_GROUP"), {
  scenes: {
    "qqbot:group:ADMIN_GROUP": { scene: "system-admin" },
  },
});
assert.deepEqual(applyCustomRuntimeAdminGroupSceneBinding({
  scenes: {
    "qqbot:group:ADMIN_GROUP": { scene: "dev-lab", label: "custom" },
  },
}, "qqbot:group:ADMIN_GROUP"), {
  scenes: {
    "qqbot:group:ADMIN_GROUP": { scene: "dev-lab", label: "custom" },
  },
});

const scene = resolveCustomSceneConfig(cfg, groupPeer);
assert.equal(scene.scene, "dev-lab");
assert.equal(scene.label, "dev group");

const allowed = evaluateCustomAuthorization({
  runtime,
  scene,
  peer: groupPeer,
  actor: user,
  capability: "codex.run",
});
assert.equal(allowed.allowed, true);
assert.equal(allowed.reason, "allowed");

const denied = evaluateCustomAuthorization({
  runtime,
  scene,
  peer: groupPeer,
  actor: user,
  capability: "system.restart",
});
assert.equal(denied.allowed, false);
assert.equal(denied.reason, "missing_capability");

const adminAllowed = evaluateCustomAuthorization({
  runtime,
  scene,
  peer: groupPeer,
  actor: admin,
  capability: "system.restart",
});
assert.equal(adminAllowed.allowed, true);

const disabledDecision = inspectCustomRuntimeMessage({
  cfg: { channels: { qqbot: {} } } as any,
  message: {
    accountId: "default",
    peer: groupPeer,
    actor: user,
    content: "hello",
    messageId: "msg-1",
    timestamp: Date.now(),
    mentionedBot: false,
  },
});
assert.equal(disabledDecision.enabled, false);
assert.equal(disabledDecision.scene.scene, "chat");
assert.equal(disabledDecision.sceneState.source, "default");

const sceneDecision = inspectCustomRuntimeMessage({
  cfg,
  message: {
    accountId: "default",
    peer: groupPeer,
    actor: user,
    content: "hello",
    messageId: "msg-scene",
    timestamp: Date.now(),
    mentionedBot: false,
  },
  capability: "codex.run",
});
assert.equal(sceneDecision.enabled, true);
assert.equal(sceneDecision.sceneState.key, "qqbot:group:GROUP_OPENID");
assert.equal(sceneDecision.sceneSystemPrompt?.includes("dev group"), true);
assert.equal(sceneDecision.authorization?.allowed, true);

const unreadCfg = inspectCustomUnreadConfig({
  cfg,
  message: {
    accountId: "default",
    peer: groupPeer,
    actor: user,
    content: "hello",
    messageId: "msg-2",
    timestamp: Date.now(),
    mentionedBot: false,
  },
});
assert.equal(unreadCfg.historyLimit, 20);
assert.equal(unreadCfg.followupDelayMs, 5_000);
assert.equal(unreadCfg.sleepDelayMs, 60_000);

const flowRuntime = createCustomMessageFlowRuntime();
assert.equal(flowRuntime.unread.getPendingCount(groupPeer.id), 0);

console.log("custom runtime tests passed");
