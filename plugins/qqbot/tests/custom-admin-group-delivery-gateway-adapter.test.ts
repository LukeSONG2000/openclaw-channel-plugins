import assert from "node:assert";
import { applyCustomAdminGroupDelivery } from "../src/custom/admin-group-delivery-gateway-adapter.js";

let commits = 0;
let textSends = 0;
let keyboardSends = 0;
const logs: string[] = [];
const log = {
  info: (msg: string) => logs.push(`info:${msg}`),
  error: (msg: string) => logs.push(`error:${msg}`),
};

const sent = await applyCustomAdminGroupDelivery({
  accountId: "default",
  delivery: {
    groupOpenid: "GROUP_OPENID",
    text: "审批申请",
    keyboard: { content: { rows: [] } } as any,
    label: "auth admin-group notification",
    details: "source=slash request=req-1",
  },
  proactiveGuard: ({ targetType, targetId, text }) => {
    assert.equal(targetType, "group");
    assert.equal(targetId, "GROUP_OPENID");
    assert.equal(text, "审批申请");
    return { allowed: true, commit: () => { commits++; } };
  },
  sendText: async () => { textSends++; },
  sendKeyboard: async (groupOpenid, text, keyboard) => {
    keyboardSends++;
    assert.equal(groupOpenid, "GROUP_OPENID");
    assert.equal(text, "审批申请");
    assert.deepEqual(keyboard.content.rows, []);
  },
  log,
});
assert.equal(sent.status, "sent");
assert.equal(commits, 1);
assert.equal(textSends, 0);
assert.equal(keyboardSends, 1);
assert.equal(logs.some((line) => line.includes("custom auth admin-group notification sent")), true);

let now = 10_000;
const cooldowns = new Map<string, number>();
const blocked = await applyCustomAdminGroupDelivery({
  accountId: "default",
  delivery: {
    groupOpenid: "GROUP_OPENID",
    text: "兜底告警",
    label: "fallback admin-group alert",
    details: "key=default:group:GROUP_OPENID count=3",
    cooldownKey: "default:group:GROUP_OPENID",
    cooldownMs: 30_000,
  },
  proactiveGuard: () => ({ allowed: false, reason: "budget blocked" }),
  sendText: async () => { throw new Error("blocked delivery should not send"); },
  sendKeyboard: async () => { throw new Error("blocked delivery should not send"); },
  cooldowns,
  clock: () => now,
  log,
});
assert.equal(blocked.status, "blocked");
assert.equal(blocked.reason, "budget blocked");
assert.equal(cooldowns.get("default:group:GROUP_OPENID"), 40_000);

now = 20_000;
const skipped = await applyCustomAdminGroupDelivery({
  accountId: "default",
  delivery: {
    groupOpenid: "GROUP_OPENID",
    text: "兜底告警",
    label: "fallback admin-group alert",
    details: "key=default:group:GROUP_OPENID count=4",
    cooldownKey: "default:group:GROUP_OPENID",
    cooldownMs: 30_000,
  },
  proactiveGuard: () => { throw new Error("cooldown skip should not call guard"); },
  sendText: async () => { throw new Error("cooldown skip should not send"); },
  sendKeyboard: async () => { throw new Error("cooldown skip should not send"); },
  cooldowns,
  clock: () => now,
  log,
});
assert.equal(skipped.status, "skipped");
assert.equal(skipped.reason, "cooldown");
assert.equal(logs.some((line) => line.includes("skipped by cooldown")), true);

const failed = await applyCustomAdminGroupDelivery({
  accountId: "default",
  delivery: {
    groupOpenid: "GROUP_OPENID",
    text: "版本更新",
    label: "update available notification",
    details: "package=@lukesong/openclaw-qqbot latest=1.2.3",
  },
  proactiveGuard: () => ({ allowed: true, commit: () => { commits++; } }),
  sendText: async () => { throw new Error("send failed"); },
  sendKeyboard: async () => { throw new Error("send failed"); },
  log,
});
assert.equal(failed.status, "failed");
assert.equal(failed.reason?.includes("send failed"), true);
assert.equal(commits, 1);
assert.equal(logs.some((line) => line.includes("Failed to send custom update available notification")), true);

console.log("custom admin group delivery gateway adapter tests passed");
