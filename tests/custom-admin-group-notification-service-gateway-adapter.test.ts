import assert from "node:assert";
import { createCustomAdminGroupNotificationServiceGateway } from "../src/custom/admin-group-notification-service-gateway-adapter.js";
import type { CustomRuntimeConfig } from "../src/custom/types.js";

const runtime: CustomRuntimeConfig = {
  enabled: true,
  admins: ["ADMIN_OPENID"],
  adminGroup: "qqbot:group:ADMIN_GROUP",
  fallbackAlerts: { cooldownMs: 1_000 },
};

{
  const sent: Array<{ kind: "text" | "keyboard"; groupOpenid: string; text: string }> = [];
  let guardCalls = 0;
  let commits = 0;
  const service = createCustomAdminGroupNotificationServiceGateway({
    accountId: "default",
    getRuntime: () => runtime,
    buildProactiveGuard: () => (payload) => {
      guardCalls += 1;
      assert.equal(payload.targetType, "group");
      assert.equal(payload.targetId, "ADMIN_GROUP");
      return { allowed: true, commit: () => { commits += 1; } };
    },
    sendText: async (groupOpenid, text) => {
      sent.push({ kind: "text", groupOpenid, text });
    },
    sendKeyboard: async (groupOpenid, text) => {
      sent.push({ kind: "keyboard", groupOpenid, text });
    },
  });

  await service.sendAuthAdminGroupNotification({
    groupOpenid: "ADMIN_GROUP",
    text: "auth request",
    keyboard: { content: { rows: [] } },
    requestId: "authreq-1",
    source: "slash",
  });

  assert.equal(guardCalls, 1);
  assert.equal(commits, 1);
  assert.deepEqual(sent, [{ kind: "keyboard", groupOpenid: "ADMIN_GROUP", text: "auth request" }]);
}

{
  const sent: string[] = [];
  const logs: string[] = [];
  const service = createCustomAdminGroupNotificationServiceGateway({
    accountId: "default",
    getRuntime: () => runtime,
    buildProactiveGuard: () => () => ({ allowed: true }),
    sendText: async (_groupOpenid, text) => {
      sent.push(text);
    },
    sendKeyboard: async (_groupOpenid, text) => {
      sent.push(text);
    },
    clock: () => 10_000,
    log: { info: (msg) => logs.push(msg) },
  });

  await service.sendFallbackAdminGroupAlert({
    groupOpenid: "ADMIN_GROUP",
    text: "fallback alert",
    cooldownKey: "peer-1",
    eventCount: 3,
  });
  await service.sendFallbackAdminGroupAlert({
    groupOpenid: "ADMIN_GROUP",
    text: "fallback alert duplicate",
    cooldownKey: "peer-1",
    eventCount: 4,
  });

  assert.deepEqual(sent, ["fallback alert"]);
  assert.equal(logs.some((line) => line.includes("skipped by cooldown")), true);
}

{
  const sent: Array<{ groupOpenid: string; text: string }> = [];
  const debugLogs: string[] = [];
  const service = createCustomAdminGroupNotificationServiceGateway({
    accountId: "default",
    getRuntime: () => runtime,
    buildProactiveGuard: () => () => ({ allowed: true }),
    sendText: async (groupOpenid, text) => {
      sent.push({ groupOpenid, text });
    },
    sendKeyboard: async (groupOpenid, text) => {
      sent.push({ groupOpenid, text });
    },
    log: { debug: (msg) => debugLogs.push(msg) },
  });

  await service.sendUpdateAvailableNotification({
    status: "update-available",
    packageName: "@lukesong/openclaw-qqbot",
    current: "1.0.0",
    latest: "1.0.1",
    checkedAt: Date.UTC(2026, 5, 22),
  });
  await service.sendUpdateAvailableNotification({
    status: "up-to-date",
    packageName: "@lukesong/openclaw-qqbot",
    current: "1.0.1",
    latest: "1.0.1",
    checkedAt: Date.UTC(2026, 5, 22),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.groupOpenid, "ADMIN_GROUP");
  assert.equal(sent[0]?.text.includes("二开版本更新可用"), true);
  assert.equal(sent[0]?.text.includes("不会自动安装"), true);
  assert.equal(debugLogs.some((line) => line.includes("notification skipped")), true);
}

console.log("custom admin group notification service gateway adapter tests passed");
