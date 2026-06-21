import assert from "node:assert";
import { createCustomSlashPrequeueHandlerGateway } from "../src/custom/slash-prequeue-handler-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const message: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/status",
  messageId: "msg-1",
  timestamp: "2026-06-22T00:00:00.000Z",
};

const tokenCalls: string[] = [];
const textCalls: string[] = [];
const keyboardCalls: string[] = [];
const fileCalls: string[] = [];
const taskNotifications: string[] = [];
const adminNotifications: string[] = [];
const fallbackEvents: string[] = [];

const handler = createCustomSlashPrequeueHandlerGateway({
  cfg: {} as any,
  account: {
    accountId: "default",
    appId: "APP",
    clientSecret: "SECRET",
    config: { allowFrom: ["USER_OPENID"] },
  } as any,
  runtime: {} as any,
  queue: {
    enqueue: () => {},
    getSnapshot: () => ({ pending: 0 }) as any,
    getMessagePeerId: () => "c2c:USER_OPENID",
    stopPeer: () => ({ dropped: [] }) as any,
  } as any,
  getTaskExecutor: () => ({ id: "task-executor" }) as any,
  getConfigApi: () => ({ writeConfigFile: async () => {} }),
  persistAuthState: () => {},
  persistTaskState: () => {},
  persistPollState: () => {},
  persistGameState: () => {},
  persistDeployConfirmationState: () => {},
  sendAdminGroupNotification: async (notification) => {
    adminNotifications.push((notification as any).id);
  },
  getAccessToken: async (appId, clientSecret) => {
    tokenCalls.push(`${appId}:${clientSecret}`);
    return "TOKEN";
  },
  sendC2CMessage: async (token, userOpenid, text, msgId) => {
    textCalls.push(`c2c:${token}:${userOpenid}:${text}:${msgId}`);
  },
  sendGroupMessage: async (token, groupOpenid, text, msgId) => {
    textCalls.push(`group:${token}:${groupOpenid}:${text}:${msgId}`);
  },
  sendChannelMessage: async (token, channelId, text, msgId) => {
    textCalls.push(`channel:${token}:${channelId}:${text}:${msgId}`);
  },
  sendDmMessage: async (token, guildId, text, msgId) => {
    textCalls.push(`dm:${token}:${guildId}:${text}:${msgId}`);
  },
  sendC2CMessageWithInlineKeyboard: async (token, userOpenid, text, keyboard, msgId) => {
    keyboardCalls.push(`c2c:${token}:${userOpenid}:${text}:${(keyboard as any).id}:${msgId}`);
  },
  sendGroupMessageWithInlineKeyboard: async (token, groupOpenid, text, keyboard, msgId) => {
    keyboardCalls.push(`group:${token}:${groupOpenid}:${text}:${(keyboard as any).id}:${msgId}`);
  },
  sendDocument: async (mediaCtx, filePath) => {
    fileCalls.push(`${mediaCtx.targetType}:${mediaCtx.targetId}:${mediaCtx.replyToId}:${filePath}`);
  },
  sendTextToTarget: async (ctx, text) => {
    taskNotifications.push(`${ctx.target.type}:${text}`);
  },
  recordFallbackEventGateway: ({ accountId, event }) => {
    fallbackEvents.push(`${accountId}:${(event as any).kind}`);
  },
  handleSlashPrequeue: async (params) => {
    assert.equal(params.account.accountId, "default");
    assert.equal(params.account.appId, "APP");
    assert.deepEqual(params.account.accountConfig?.allowFrom, ["USER_OPENID"]);
    assert.deepEqual(params.taskExecutor, { id: "task-executor" });
    await params.effects.sendTaskNotificationText({
      target: { type: "c2c", senderId: "USER_OPENID", messageId: "task-msg" } as any,
      text: "task done",
    });
    await params.effects.sendAdminGroupNotification?.({ id: "admin-note" } as any);
    params.recordFallbackEvent?.({ kind: "response-timeout" } as any);
    await params.sendText({ kind: "c2c", userOpenid: "USER_OPENID", msgId: "m1" }, "hello c2c", message);
    await params.sendText({ kind: "group", groupOpenid: "GROUP_OPENID", msgId: "m2" }, "hello group", message);
    await params.sendText({ kind: "channel", channelId: "CHANNEL_ID", msgId: "m3" }, "hello channel", message);
    await params.sendText({ kind: "dm", guildId: "GUILD_ID", msgId: "m4" }, "hello dm", message);
    await params.sendKeyboard({ kind: "c2c", userOpenid: "USER_OPENID", msgId: "k1" }, "card c2c", { id: "keyboard-1" } as any, message);
    await params.sendKeyboard({ kind: "group", groupOpenid: "GROUP_OPENID", msgId: "k2" }, "card group", { id: "keyboard-2" } as any, message);
    await params.sendFile({ targetType: "group", targetId: "GROUP_OPENID" }, "/tmp/report.txt", message);
    return { kind: "framework-reply", content: "/status", fileSent: true };
  },
});

const result = await handler(message);

assert.deepEqual(result, { kind: "framework-reply", content: "/status", fileSent: true });
assert.deepEqual(tokenCalls, [
  "APP:SECRET",
  "APP:SECRET",
  "APP:SECRET",
  "APP:SECRET",
  "APP:SECRET",
  "APP:SECRET",
]);
assert.deepEqual(textCalls, [
  "c2c:TOKEN:USER_OPENID:hello c2c:m1",
  "group:TOKEN:GROUP_OPENID:hello group:m2",
  "channel:TOKEN:CHANNEL_ID:hello channel:m3",
  "dm:TOKEN:GUILD_ID:hello dm:m4",
]);
assert.deepEqual(keyboardCalls, [
  "c2c:TOKEN:USER_OPENID:card c2c:keyboard-1:k1",
  "group:TOKEN:GROUP_OPENID:card group:keyboard-2:k2",
]);
assert.deepEqual(fileCalls, ["group:GROUP_OPENID:msg-1:/tmp/report.txt"]);
assert.deepEqual(taskNotifications, ["c2c:task done"]);
assert.deepEqual(adminNotifications, ["admin-note"]);
assert.deepEqual(fallbackEvents, ["default:response-timeout"]);

console.log("custom slash prequeue handler gateway adapter tests passed");
