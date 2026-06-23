import assert from "node:assert";
import {
  handleCustomUnreadStatusCommand,
  parseCustomUnreadStatusCommand,
} from "../src/custom/unread-status-gateway-adapter.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig } from "../src/custom/unread-runtime.js";
import type { CustomInboundMessage } from "../src/custom/types.js";

const cfg = resolveCustomUnreadConfig({
  runtime: {
    enabled: true,
    unread: {
      enabled: true,
      sleepDelayMs: 10_000,
      followupDelayMs: 1_000,
    },
  },
  scene: { scene: "chat" },
});

function msg(overrides: Partial<CustomInboundMessage> = {}): CustomInboundMessage {
  return {
    accountId: "default",
    peer: { kind: "group", id: "GROUP_OPENID" },
    actor: { id: "USER_OPENID", label: "Luke" },
    content: "secret chat content",
    messageId: "msg-1",
    timestamp: 1_000,
    mentionedBot: false,
    ...overrides,
  };
}

assert.deepEqual(parseCustomUnreadStatusCommand("hello"), { matched: false });
assert.deepEqual(parseCustomUnreadStatusCommand("/bot-unread"), {
  matched: true,
  command: { kind: "status", limit: 5 },
});
assert.deepEqual(parseCustomUnreadStatusCommand("/bot-unread summary 2"), {
  matched: true,
  command: { kind: "status", limit: 2 },
});
const invalidLimit = parseCustomUnreadStatusCommand("/bot-unread status 0");
assert.equal(invalidLimit.matched, true);
assert.equal(invalidLimit.matched && invalidLimit.error?.includes("数量需要"), true);

const unread = new CustomUnreadRuntime();
unread.recordNonMention({ message: msg(), cfg, now: 2_000 });
unread.recordNonMention({
  message: msg({ peer: { kind: "group", id: "OTHER_GROUP" }, messageId: "msg-2", timestamp: 2_000 }),
  cfg,
  now: 3_000,
});
unread.createCatchup({
  peerId: "GROUP_OPENID",
  cfg,
  source: "manual",
  now: 4_000,
});

const status = handleCustomUnreadStatusCommand({
  unread,
  rawContent: "/bot-unread status 1",
});
assert.equal(status.handled, true);
assert.equal(status.reply?.includes("自适应未读轮询状态"), true);
assert.equal(status.reply?.includes("会话数：2"), true);
assert.equal(status.reply?.includes("待处理消息：2"), true);
assert.equal(status.reply?.includes("快照：1"), true);
assert.equal(status.reply?.includes("显示：1/2"), true);
assert.equal(status.reply?.includes("secret chat content"), false);

const empty = handleCustomUnreadStatusCommand({
  unread: new CustomUnreadRuntime(),
  rawContent: "/bot-unread",
});
assert.equal(empty.handled, true);
assert.equal(empty.reply?.includes("暂无未读状态记录"), true);

console.log("custom unread status gateway adapter tests passed");
