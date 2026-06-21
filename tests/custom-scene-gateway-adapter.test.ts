import assert from "node:assert";
import {
  handleCustomSceneCommand,
  parseCustomSceneCommand,
} from "../src/custom/scene-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-scene status",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(parseCustomSceneCommand("hello"), { matched: false });
assert.deepEqual(parseCustomSceneCommand("/bot-scene"), {
  matched: true,
  command: { kind: "status" },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene set dev-lab"), {
  matched: true,
  command: { kind: "set", scene: "dev-lab" },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene codex-only"), {
  matched: true,
  command: { kind: "set", scene: "codex-only" },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene set missing"), {
  matched: true,
  error: "未知 scene：missing",
});

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        scenes: {},
      },
    },
  },
} as any;

const status = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene status",
});
assert.equal(status.handled, true);
assert.equal(status.changed, undefined);
assert.equal(status.reply?.includes("场景：chat"), true);
assert.equal(status.reply?.includes("目标：qqbot:group:GROUP_OPENID"), true);

const list = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene list",
});
assert.equal(list.handled, true);
assert.equal(list.reply?.includes("dev-lab"), true);

const set = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene set dev-lab",
});
assert.equal(set.handled, true);
assert.equal(set.changed, true);
assert.equal(set.sceneKey, "qqbot:group:GROUP_OPENID");
assert.equal(cfg.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].scene, "dev-lab");
assert.equal(set.reply?.includes("场景：dev-lab"), true);

const updatedStatus = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene status",
});
assert.equal(updatedStatus.reply?.includes("场景：dev-lab"), true);
assert.equal(updatedStatus.reply?.includes("来源：exact"), true);

console.log("custom scene gateway adapter tests passed");
