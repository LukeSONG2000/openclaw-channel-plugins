import assert from "node:assert";
import {
  handleCustomInitBindCommand,
  parseCustomInitBindCommand,
} from "../src/custom/init-bind-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";
import { handleCustomSlashPrequeueGateway } from "../src/custom/slash-prequeue-gateway-adapter.js";

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-init-bind BIND123",
  messageId: "msg-group",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const c2cMessage: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/bot-init-bind BIND123",
  messageId: "msg-c2c",
  timestamp: "2026-06-22T00:00:00.000Z",
};

function cfg(runtime: Record<string, unknown> = {}) {
  return {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: false,
          ...runtime,
        },
      },
    },
  } as any;
}

assert.deepEqual(parseCustomInitBindCommand("/bot-init-bind BIND123"), { matched: true, code: "BIND123" });
assert.deepEqual(parseCustomInitBindCommand("  /BOT-INIT-BIND   CODE_1  "), { matched: true, code: "CODE_1" });
assert.deepEqual(parseCustomInitBindCommand("/bot-init-bind"), { matched: true, code: undefined });
assert.deepEqual(parseCustomInitBindCommand("/bot-auth status"), { matched: false });

const usage = handleCustomInitBindCommand({
  cfg: cfg(),
  message: groupMessage,
  rawContent: "/bot-init-bind",
  now: 1_000,
});
assert.equal(usage.handled, true);
assert.equal(usage.changed, false);
assert.equal(usage.persist, undefined);

const noChallenge = handleCustomInitBindCommand({
  cfg: cfg(),
  message: groupMessage,
  rawContent: "/bot-init-bind BIND123",
  now: 1_000,
});
assert.equal(noChallenge.handled, true);
assert.equal(noChallenge.changed, false);
assert.equal(noChallenge.persist, undefined);
assert.equal(noChallenge.reply.includes("customRuntime.initBind.code"), true);

const expired = handleCustomInitBindCommand({
  cfg: cfg({
    admins: ["OLD_ADMIN"],
    adminGroup: "OLD_GROUP",
    initBind: { code: "BIND123", expiresAt: 999 },
  }),
  message: groupMessage,
  rawContent: "/bot-init-bind BIND123",
  now: 1_000,
});
assert.equal(expired.handled, true);
assert.equal(expired.changed, true);
assert.deepEqual(expired.persist, {
  admins: ["OLD_ADMIN"],
  adminGroup: "qqbot:group:OLD_GROUP",
  clearInitBind: true,
});

const wrongCode = handleCustomInitBindCommand({
  cfg: cfg({
    initBind: { code: "BIND123", expiresAt: 2_000 },
  }),
  message: groupMessage,
  rawContent: "/bot-init-bind WRONG",
  now: 1_000,
});
assert.equal(wrongCode.handled, true);
assert.equal(wrongCode.changed, false);
assert.equal(wrongCode.persist, undefined);

const groupSuccess = handleCustomInitBindCommand({
  cfg: cfg({
    admins: ["OLD_ADMIN"],
    initBind: { code: "BIND123", expiresAt: 2_000, enableRuntimeOnComplete: true },
  }),
  message: groupMessage,
  rawContent: "/bot-init-bind BIND123",
  now: 1_000,
});
assert.equal(groupSuccess.handled, true);
assert.equal(groupSuccess.changed, true);
assert.deepEqual(groupSuccess.persist, {
  admins: ["OLD_ADMIN", "MEMBER_OPENID"],
  adminGroup: "qqbot:group:GROUP_OPENID",
  clearInitBind: true,
  enableRuntime: true,
});
assert.equal(groupSuccess.reply.includes("member_openid"), true);
assert.equal(groupSuccess.reply.includes("group_openid"), true);


const bareGroupSuccess = handleCustomInitBindCommand({
  cfg: cfg({
    admins: ["OLD_ADMIN"],
    initBind: { code: "BIND123", expiresAt: 2_000, enableRuntimeOnComplete: true },
  }),
  message: groupMessage,
  rawContent: "BIND123",
  now: 1_000,
});
assert.equal(bareGroupSuccess.handled, true);
assert.equal(bareGroupSuccess.changed, true);
assert.deepEqual(bareGroupSuccess.persist, {
  admins: ["OLD_ADMIN", "MEMBER_OPENID"],
  adminGroup: "qqbot:group:GROUP_OPENID",
  clearInitBind: true,
  enableRuntime: true,
});

const bareWrongCode = handleCustomInitBindCommand({
  cfg: cfg({
    initBind: { code: "BIND123", expiresAt: 2_000 },
  }),
  message: groupMessage,
  rawContent: "WRONG",
  now: 1_000,
});
assert.deepEqual(bareWrongCode, { handled: false });


const prequeueCfg = cfg({
  initBind: { code: "BIND123", expiresAt: 2_000, enableRuntimeOnComplete: true },
});
let prequeuePersisted: any = null;
const prequeueReplies: string[] = [];
let prequeueEnqueued = 0;
const prequeueResult = await handleCustomSlashPrequeueGateway({
  cfg: prequeueCfg,
  account: { accountId: "default", appId: "APP", accountConfig: {} as any },
  runtime: { auth: {}, tasks: {}, polls: {}, games: {}, deployConfirmations: {} } as any,
  message: { ...groupMessage, content: "BIND123" },
  queue: {
    enqueue: () => { prequeueEnqueued += 1; },
    getSnapshot: () => ({ totalPending: 0, activeUsers: 0, maxConcurrency: 1, byPeer: [] }) as any,
    getMessagePeerId: () => "group:GROUP_OPENID",
    stopPeer: () => ({ dropped: [] }) as any,
  },
  effects: {
    getConfigApi: () => ({
      loadConfig: () => prequeueCfg,
      writeConfigFile: async (next) => { prequeuePersisted = next; },
    }),
  },
  sendText: async (_target, text) => { prequeueReplies.push(text); },
  sendKeyboard: async () => {},
  sendFile: async () => {},
  now: () => 1_000,
});
assert.equal(prequeueResult.kind, "custom-slash");
assert.equal(prequeueEnqueued, 0);
assert.equal(prequeueReplies.some((text) => text.includes("初始化绑定完成")), true);
assert.deepEqual(prequeuePersisted.channels.qqbot.customRuntime.admins, ["MEMBER_OPENID"]);
assert.equal(prequeuePersisted.channels.qqbot.customRuntime.adminGroup, "qqbot:group:GROUP_OPENID");
assert.equal(prequeuePersisted.channels.qqbot.customRuntime.initBind, undefined);

const c2cPartial = handleCustomInitBindCommand({
  cfg: cfg({
    initBind: { code: "BIND123", expiresAt: 2_000, enableRuntimeOnComplete: true },
  }),
  message: c2cMessage,
  rawContent: "/bot-init-bind BIND123",
  now: 1_000,
});
assert.equal(c2cPartial.handled, true);
assert.equal(c2cPartial.changed, true);
assert.deepEqual(c2cPartial.persist, {
  admins: ["USER_OPENID"],
  adminGroup: undefined,
  clearInitBind: false,
  enableRuntime: false,
});
assert.equal(c2cPartial.reply.includes("user_openid"), true);
assert.equal(c2cPartial.reply.includes("group_openid"), true);

const c2cComplete = handleCustomInitBindCommand({
  cfg: cfg({
    adminGroup: "GROUP_OPENID",
    initBind: { code: "BIND123", expiresAt: 2_000, enableRuntimeOnComplete: true },
  }),
  message: c2cMessage,
  rawContent: "/bot-init-bind BIND123",
  now: 1_000,
});
assert.equal(c2cComplete.handled, true);
assert.deepEqual(c2cComplete.persist, {
  admins: ["USER_OPENID"],
  adminGroup: "qqbot:group:GROUP_OPENID",
  clearInitBind: true,
  enableRuntime: true,
});

console.log("custom init bind gateway adapter tests passed");
