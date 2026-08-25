import assert from "node:assert";
import { deliverCustomSlashGatewayReply } from "../src/custom/slash-reply-delivery-gateway-adapter.js";
import type { InlineKeyboard } from "../src/types.js";

const keyboard = { content: { rows: [] } } as unknown as InlineKeyboard;
const adminNotification = {
  groupOpenid: "GROUP",
  text: "approval",
  keyboard,
  requestId: "REQ",
};

const sentTexts: string[] = [];
const sentKeyboards: Array<{ text: string; keyboard?: InlineKeyboard }> = [];
const adminNotifications: unknown[] = [];
const errors: string[] = [];
const baseCallbacks = {
  sendText: async (text: string) => { sentTexts.push(text); },
  sendKeyboard: async (text: string, sentKeyboard?: InlineKeyboard) => { sentKeyboards.push({ text, keyboard: sentKeyboard }); },
  sendAdminGroupNotification: async (notification: any) => { adminNotifications.push(notification); },
  log: { error: (msg: string) => errors.push(msg) },
};

const textResult = await deliverCustomSlashGatewayReply({
  accountId: "default",
  reply: { kind: "text", text: "hello" },
  ...baseCallbacks,
});
assert.equal(textResult.kind, "text");
assert.deepEqual(sentTexts, ["hello"]);

const keyboardResult = await deliverCustomSlashGatewayReply({
  accountId: "default",
  reply: { kind: "keyboard", text: "choose", keyboard },
  ...baseCallbacks,
});
assert.equal(keyboardResult.kind, "keyboard");
assert.equal(keyboardResult.kind === "keyboard" && keyboardResult.fallbackToText, false);
assert.equal(sentKeyboards.at(-1)?.text, "choose");

const keyboardFallbackResult = await deliverCustomSlashGatewayReply({
  accountId: "default",
  reply: { kind: "keyboard", text: "fallback keyboard", keyboard },
  sendText: baseCallbacks.sendText,
  sendKeyboard: async () => { throw new Error("keyboard failed"); },
  log: baseCallbacks.log,
});
assert.equal(keyboardFallbackResult.kind, "keyboard");
assert.equal(keyboardFallbackResult.kind === "keyboard" && keyboardFallbackResult.fallbackToText, true);
assert.equal(sentTexts.at(-1), "fallback keyboard");
assert.equal(errors.some((line) => line.includes("Failed to send custom slash keyboard reply")), true);

const authCardResult = await deliverCustomSlashGatewayReply({
  accountId: "default",
  reply: {
    kind: "auth-approval",
    denialText: "denied",
    approvalText: "approve?",
    keyboard,
    adminGroupNotification: adminNotification as any,
  },
  ...baseCallbacks,
});
assert.equal(authCardResult.kind, "auth-approval");
assert.equal(authCardResult.kind === "auth-approval" && authCardResult.approvalCardSent, true);
assert.equal(authCardResult.kind === "auth-approval" && authCardResult.adminGroupNotified, true);
assert.equal(authCardResult.kind === "auth-approval" && authCardResult.fallbackToDenialText, false);
assert.equal(sentKeyboards.at(-1)?.text, "approve?");
assert.equal((adminNotifications.at(-1) as any)?.requestId, "REQ");

const authFallbackResult = await deliverCustomSlashGatewayReply({
  accountId: "default",
  reply: {
    kind: "auth-approval",
    denialText: "denied fallback",
    approvalText: "approve fail",
    keyboard,
    adminGroupNotification: adminNotification as any,
  },
  sendText: baseCallbacks.sendText,
  sendKeyboard: async () => { throw new Error("approval card failed"); },
  sendAdminGroupNotification: baseCallbacks.sendAdminGroupNotification,
  log: baseCallbacks.log,
});
assert.equal(authFallbackResult.kind, "auth-approval");
assert.equal(authFallbackResult.kind === "auth-approval" && authFallbackResult.approvalCardSent, false);
assert.equal(authFallbackResult.kind === "auth-approval" && authFallbackResult.fallbackToDenialText, true);
assert.equal(authFallbackResult.kind === "auth-approval" && authFallbackResult.adminGroupNotified, true);
assert.equal(sentTexts.at(-1), "denied fallback");
assert.equal(errors.some((line) => line.includes("Failed to send custom auth approval card")), true);

const noCardResult = await deliverCustomSlashGatewayReply({
  accountId: "default",
  reply: {
    kind: "auth-approval",
    denialText: "plain denial",
    adminGroupNotification: null,
  },
  ...baseCallbacks,
});
assert.equal(noCardResult.kind, "auth-approval");
assert.equal(noCardResult.kind === "auth-approval" && noCardResult.approvalCardSent, false);
assert.equal(noCardResult.kind === "auth-approval" && noCardResult.adminGroupNotified, false);
assert.equal(sentTexts.at(-1), "plain denial");

console.log("custom slash reply delivery gateway adapter tests passed");
