import assert from "node:assert";
import { resolveCustomRuntimeConfig } from "../src/custom/config.js";
import {
  formatCustomGroupPermission,
  normalizeCustomGroupPermission,
  resolveCustomGroupPermission,
} from "../src/custom/group-permissions.js";
import { buildCustomSceneSystemPrompt, resolveCustomScene } from "../src/custom/scenes.js";
import type { CustomPeer, CustomRuntimeConfig } from "../src/custom/types.js";

const freePeer: CustomPeer = { kind: "group", id: "FREE_GROUP" };
const adminPeer: CustomPeer = { kind: "group", id: "ADMIN_GROUP" };
const defaultPeer: CustomPeer = { kind: "group", id: "UNKNOWN_GROUP" };
const runtime: CustomRuntimeConfig = {
  enabled: true,
  adminGroup: "qqbot:group:ADMIN_GROUP",
  groupPermissions: {
    default: "default",
    bindings: {
      "qqbot:group:FREE_GROUP": "free",
      EXPLICIT_ADMIN: "admin",
    },
  },
};

assert.equal(resolveCustomGroupPermission(runtime, freePeer), "free");
assert.equal(resolveCustomGroupPermission(runtime, adminPeer), "admin");
assert.equal(resolveCustomGroupPermission(runtime, defaultPeer), "default");
assert.equal(resolveCustomGroupPermission(runtime, { kind: "group", id: "explicit_admin" }), "admin");
assert.equal(resolveCustomGroupPermission(runtime, { kind: "c2c", id: "FREE_GROUP" }), null);
assert.equal(normalizeCustomGroupPermission(" FREE "), "free");
assert.equal(normalizeCustomGroupPermission("unknown"), null);
assert.match(formatCustomGroupPermission("default"), /仅 @/);

const freeScene = resolveCustomScene(runtime, freePeer);
assert.equal(freeScene.groupPermission, "free");
assert.equal(freeScene.config.scene, "chat");
assert.equal(freeScene.config.allowAutonomousReply, true);
assert.equal(freeScene.config.allowProactiveSend, true);
assert.equal(freeScene.config.unread?.enabled, true);
assert.equal(freeScene.config.proactive?.enabled, true);
assert.match(buildCustomSceneSystemPrompt(freeScene), /free（全量消息与轮询）/);

const adminScene = resolveCustomScene(runtime, adminPeer);
assert.equal(adminScene.groupPermission, "admin");
assert.equal(adminScene.config.scene, "system-admin");
assert.equal(adminScene.config.allowAutonomousReply, false);
assert.equal(adminScene.config.unread?.enabled, false);
assert.deepEqual(adminScene.capabilities, ["system.status", "deploy.check", "config.read", "web.search"]);

const defaultScene = resolveCustomScene(runtime, defaultPeer);
assert.equal(defaultScene.groupPermission, "default");
assert.equal(defaultScene.config.scene, "chat");
assert.equal(defaultScene.config.allowAutonomousReply, false);
assert.equal(defaultScene.config.allowProactiveSend, false);
assert.equal(defaultScene.config.unread?.enabled, false);
assert.equal(defaultScene.config.proactive?.enabled, false);
assert.match(buildCustomSceneSystemPrompt(defaultScene), /default（仅 @）/);

const legacyScene = resolveCustomScene({ enabled: true }, defaultPeer);
assert.equal(legacyScene.groupPermission, undefined);
assert.equal(legacyScene.profile.allowAutonomousReply, true);

const cfg = resolveCustomRuntimeConfig({
  channels: {
    qqbot: {
      customRuntime: runtime,
    },
  },
} as any);
assert.deepEqual(cfg.groupPermissions, runtime.groupPermissions);

console.log("custom group permissions tests passed");
