import assert from "node:assert";
import { evaluateCustomAuthorization, isCustomRuntimeAdmin } from "../src/custom/auth.js";
import { formatCustomPeerKey, resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "../src/custom/config.js";
import { inspectCustomRuntimeMessage } from "../src/custom/runtime.js";
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
        defaultScene: "default-dm",
        scenes: {
          [formatCustomPeerKey(groupPeer)]: {
            scene: "dev-lab",
            label: "dev group",
            capabilities: ["chat.send", "codex.run"],
          },
        },
      },
    },
  },
} as any;

const runtime = resolveCustomRuntimeConfig(cfg);
assert.equal(runtime.enabled, true);
assert.equal(isCustomRuntimeAdmin(runtime, admin), true);
assert.equal(isCustomRuntimeAdmin(runtime, user), false);

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

console.log("custom runtime tests passed");
