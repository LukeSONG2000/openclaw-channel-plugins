import assert from "node:assert";
import {
  buildCustomFallbackAlertDecision,
  DEFAULT_CUSTOM_FALLBACK_ALERT_COOLDOWN_MS,
  DEFAULT_CUSTOM_FALLBACK_ALERT_THRESHOLD,
  DEFAULT_CUSTOM_FALLBACK_ALERT_WINDOW_MS,
  resolveCustomFallbackAlertCooldownMs,
} from "../src/custom/fallback-alerts.js";
import { buildCustomFallbackEvent, type CustomFallbackEvent, type CustomFallbackEventKind } from "../src/custom/fallbacks.js";
import type { CustomRuntimeConfig } from "../src/custom/types.js";

assert.equal(DEFAULT_CUSTOM_FALLBACK_ALERT_WINDOW_MS, 15 * 60_000);
assert.equal(DEFAULT_CUSTOM_FALLBACK_ALERT_THRESHOLD, 3);
assert.equal(DEFAULT_CUSTOM_FALLBACK_ALERT_COOLDOWN_MS, 30 * 60_000);

const runtime: CustomRuntimeConfig = {
  enabled: true,
  admins: ["ADMIN_OPENID"],
  adminGroup: "GROUP_OPENID",
};

const t0 = Date.UTC(2026, 5, 21, 10, 0, 0);
const event1 = makeEvent("response-timeout", t0, "MSG_1");
const event2 = makeEvent("context-too-long", t0 + 60_000, "MSG_2");
const event3 = makeEvent("response-timeout", t0 + 120_000, "MSG_3");

const below = buildCustomFallbackAlertDecision({
  runtime,
  accountId: "default",
  currentEvent: event2,
  recentEvents: [event1, event2],
  now: event2.at,
});
assert.equal(below.alert, false);
assert.equal(below.reason, "below-threshold");
assert.equal(below.eventCount, 2);

const alert = buildCustomFallbackAlertDecision({
  runtime,
  accountId: "default",
  currentEvent: event3,
  recentEvents: [event1, event2, event3],
  now: event3.at,
});
assert.equal(alert.alert, true);
assert.equal(alert.groupOpenid, "GROUP_OPENID");
assert.equal(alert.cooldownKey, "default:group:GROUP_OPENID");
assert.equal(alert.eventCount, 3);
assert.equal(alert.text?.includes("QQBot 兜底事件告警"), true);
assert.equal(alert.text?.includes("窗口：15m 内 3 次"), true);
assert.equal(alert.text?.includes("response-timeout=2"), true);
assert.equal(alert.text?.includes("context-too-long=1"), true);
assert.equal(alert.text?.includes("pending=5, active=1/2, senderPending=2, activeMs=120000/180000"), true);
assert.equal(alert.text?.includes(`<qqbot-cmd-input text="/bot-queue" show="队列状态"/>`), true);
assert.equal(alert.text?.includes(`<qqbot-cmd-input text="/bot-fallback summary 20" show="兜底摘要"/>`), true);
assert.equal(alert.text?.includes("secret prompt body"), false);
assert.equal(alert.text?.includes("maximum context length"), false);

const otherPeer = makeEvent("response-timeout", t0 + 180_000, "MSG_4", { peerId: "OTHER_GROUP" });
const splitPeer = buildCustomFallbackAlertDecision({
  runtime,
  accountId: "default",
  currentEvent: otherPeer,
  recentEvents: [event1, event2, otherPeer],
  now: otherPeer.at,
});
assert.equal(splitPeer.alert, false);
assert.equal(splitPeer.reason, "below-threshold");
assert.equal(splitPeer.eventCount, 1);

const ignoredKind = buildCustomFallbackAlertDecision({
  runtime,
  accountId: "default",
  currentEvent: makeEvent("tool-fallback-no-output", t0 + 240_000, "MSG_TOOL"),
  recentEvents: [event1, event2, event3],
  now: t0 + 240_000,
});
assert.equal(ignoredKind.alert, false);
assert.equal(ignoredKind.reason, "kind-not-alerted");

const oldEvent = makeEvent("response-timeout", t0 - DEFAULT_CUSTOM_FALLBACK_ALERT_WINDOW_MS - 1, "MSG_OLD");
const outsideWindow = buildCustomFallbackAlertDecision({
  runtime,
  accountId: "default",
  currentEvent: event3,
  recentEvents: [oldEvent, event2, event3],
  now: event3.at,
});
assert.equal(outsideWindow.alert, false);
assert.equal(outsideWindow.eventCount, 2);

const disabled = buildCustomFallbackAlertDecision({
  runtime: { ...runtime, fallbackAlerts: { enabled: false } },
  accountId: "default",
  currentEvent: event3,
  recentEvents: [event1, event2, event3],
  now: event3.at,
});
assert.equal(disabled.alert, false);
assert.equal(disabled.reason, "disabled");

const missingGroup = buildCustomFallbackAlertDecision({
  runtime: { enabled: true, admins: ["ADMIN_OPENID"] },
  accountId: "default",
  currentEvent: event3,
  recentEvents: [event1, event2, event3],
  now: event3.at,
});
assert.equal(missingGroup.alert, false);
assert.equal(missingGroup.reason, "missing-admin-group");

const customConfigRuntime: CustomRuntimeConfig = {
  ...runtime,
  adminGroup: "qqbot:group:ADMIN_GROUP",
  fallbackAlerts: {
    threshold: 2,
    windowMs: 60_000,
    cooldownMs: 12_345,
    kinds: ["tool-fallback-no-output"],
  },
};
const customEvent1 = makeEvent("tool-fallback-no-output", t0, "MSG_CUSTOM_1");
const customEvent2 = makeEvent("tool-fallback-no-output", t0 + 1_000, "MSG_CUSTOM_2");
const customAlert = buildCustomFallbackAlertDecision({
  runtime: customConfigRuntime,
  accountId: "default",
  currentEvent: customEvent2,
  recentEvents: [customEvent1, customEvent2],
  now: customEvent2.at,
});
assert.equal(customAlert.alert, true);
assert.equal(customAlert.groupOpenid, "ADMIN_GROUP");
assert.equal(resolveCustomFallbackAlertCooldownMs(customConfigRuntime), 12_345);

console.log("custom fallback alerts tests passed");

function makeEvent(
  kind: CustomFallbackEventKind,
  at: number,
  messageId: string,
  options: { peerId?: string } = {},
): CustomFallbackEvent {
  return buildCustomFallbackEvent({
    kind,
    accountId: "default",
    peer: { kind: "group", id: options.peerId ?? "GROUP_OPENID" },
    actor: { id: "MEMBER_OPENID", label: "Member" },
    sessionKey: "agent:main:qqbot:default:group:group_openid",
    runId: messageId,
    messageId,
    reason: "maximum context length secret prompt body",
    at,
    timeoutMs: kind === "response-timeout" ? 300_000 : undefined,
    hasBlockResponse: false,
    details: {
      queueTotalPending: 5,
      queueActiveUsers: 1,
      queueMaxConcurrentUsers: 2,
      queueSenderPending: 2,
      queueSenderActiveMs: 120_000,
      queueMaxActiveMs: 180_000,
    },
  });
}
