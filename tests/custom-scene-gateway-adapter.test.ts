import assert from "node:assert";
import {
  buildCustomSceneSwitchKeyboard,
  handleCustomSceneCommand,
  parseCustomSceneCommand,
} from "../src/custom/scene-gateway-adapter.js";
import { parseCustomSceneCommand as parseCustomSceneCommandDirect } from "../src/custom/scene-command-parser.js";
import {
  buildCustomSceneSwitchKeyboard as buildCustomSceneSwitchKeyboardDirect,
  formatCustomSceneBindings as formatCustomSceneBindingsDirect,
} from "../src/custom/scene-presentation.js";
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
  command: { kind: "set", scene: "dev-lab", agentId: undefined },
});
assert.deepEqual(
  parseCustomSceneCommandDirect("/bot-scene set dev-lab"),
  parseCustomSceneCommand("/bot-scene set dev-lab"),
);
assert.deepEqual(parseCustomSceneCommand("/bot-scene set dev-lab --agent Dev-Agent"), {
  matched: true,
  command: { kind: "set", scene: "dev-lab", agentId: "Dev-Agent" },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene codex-only --agent=codex-cli"), {
  matched: true,
  command: { kind: "set", scene: "codex-only", agentId: "codex-cli" },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene set chat --clear-agent"), {
  matched: true,
  command: { kind: "set", scene: "chat", agentId: null },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene codex-only"), {
  matched: true,
  command: { kind: "set", scene: "codex-only", agentId: undefined },
});
assert.deepEqual(parseCustomSceneCommand("/bot-scene bindings"), {
  matched: true,
  command: { kind: "bindings" },
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
        scenes: {
          "qqbot:group:ADMIN_GROUP": {
            scene: "system-admin",
            label: "Admin group",
            agentId: "admin-agent",
          },
          "qqbot:c2c:USER_OPENID": {
            scene: "default-dm",
            enabled: false,
            capabilities: ["system.status"],
          },
        },
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
assert.equal(status.reply?.includes("Agent：默认路由"), true);
assert.equal(status.keyboard?.content?.rows.length, 5);
assert.equal(status.keyboard?.content?.rows[0]?.buttons[0]?.action?.type, 2);
assert.equal(status.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, "/bot-scene set codex-only");
assert.equal(status.keyboard?.content?.rows[0]?.buttons[0]?.action?.enter, true);

const list = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene list",
});
assert.equal(list.handled, true);
assert.equal(list.reply?.includes("dev-lab"), true);
assert.equal(list.keyboard?.content?.rows[3]?.buttons[0]?.action?.data, "/bot-scene set dev-lab");

const bindings = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene bindings",
});
assert.equal(bindings.handled, true);
assert.equal(bindings.reply?.includes("已配置自定义场景绑定"), true);
assert.equal(bindings.reply?.includes("数量：2"), true);
assert.equal(bindings.reply?.includes("- qqbot:group:ADMIN_GROUP"), true);
assert.equal(bindings.reply?.includes("scene=system-admin, enabled=yes"), true);
assert.equal(bindings.reply?.includes("label=Admin group"), true);
assert.equal(bindings.reply?.includes("agent=admin-agent"), true);
assert.equal(bindings.reply?.includes("- qqbot:c2c:USER_OPENID"), true);
assert.equal(bindings.reply?.includes("scene=default-dm, enabled=no"), true);
assert.equal(bindings.reply?.includes("capabilities=system.status"), true);
assert.equal(formatCustomSceneBindingsDirect(cfg.channels.qqbot.customRuntime).includes("agent=admin-agent"), true);

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
assert.equal(set.reply?.includes("Agent：默认路由"), true);
assert.equal(set.keyboard?.content?.rows[3]?.buttons[0]?.render_data?.label, "当前：dev-lab");
assert.equal(buildCustomSceneSwitchKeyboard("chat").content?.rows[1]?.buttons[0]?.render_data?.style, 4);
assert.deepEqual(buildCustomSceneSwitchKeyboardDirect("chat"), buildCustomSceneSwitchKeyboard("chat"));

const setAgent = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene set dev-lab --agent Dev-Agent",
});
assert.equal(setAgent.handled, true);
assert.equal(setAgent.changed, true);
assert.equal(cfg.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].agentId, "Dev-Agent");
assert.equal(setAgent.reply?.includes("Agent：Dev-Agent"), true);

const updatedStatus = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene status",
});
assert.equal(updatedStatus.reply?.includes("场景：dev-lab"), true);
assert.equal(updatedStatus.reply?.includes("来源：exact"), true);
assert.equal(updatedStatus.reply?.includes("Agent：Dev-Agent"), true);

const clearAgent = handleCustomSceneCommand({
  cfg,
  message,
  rawContent: "/bot-scene set dev-lab --clear-agent",
});
assert.equal(clearAgent.handled, true);
assert.equal(clearAgent.changed, true);
assert.equal(cfg.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].agentId, undefined);
assert.equal(clearAgent.reply?.includes("Agent：默认路由"), true);

const emptyBindings = handleCustomSceneCommand({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          scenes: {},
        },
      },
    },
  } as any,
  message,
  rawContent: "/bot-scene bindings",
});
assert.equal(emptyBindings.handled, true);
assert.equal(emptyBindings.reply?.includes("数量：0"), true);
assert.equal(emptyBindings.reply?.includes("暂无显式场景绑定"), true);

console.log("custom scene gateway adapter tests passed");
