import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCustomFallbackEvents } from "../src/custom/fallback-event-store.js";
import {
  createCustomDispatchFallbackRecorder,
  recordCustomFallbackEventGateway,
  type CustomFallbackAlertDelivery,
} from "../src/custom/fallback-record-gateway-adapter.js";
import type { CustomRuntimeConfig } from "../src/custom/types.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-fallback-record-"));
try {
  const accountId = "default";
  const storeOptions = { dir: tmpRoot };
  const runtime: CustomRuntimeConfig = {
    enabled: true,
    admins: ["ADMIN_OPENID"],
    adminGroup: "GROUP_OPENID",
    fallbackAlerts: {
      threshold: 2,
      windowMs: 60_000,
      kinds: ["response-timeout"],
    },
  };
  const logs: string[] = [];
  const alerts: CustomFallbackAlertDelivery[] = [];
  const log = {
    info: (msg: string) => logs.push(`info:${msg}`),
    error: (msg: string) => logs.push(`error:${msg}`),
    debug: (msg: string) => logs.push(`debug:${msg}`),
  };

  const first = recordCustomFallbackEventGateway({
    accountId,
    runtime,
    storeOptions,
    log,
    sendAlert: (alert) => alerts.push(alert),
    event: {
      kind: "response-timeout",
      peer: { kind: "group", id: "GROUP_OPENID" },
      actor: { id: "MEMBER_OPENID", label: "Member" },
      messageId: "msg-1",
      runId: "msg-1",
      at: 1_000,
      details: { queueTotalPending: 1 },
    },
  });
  assert.equal(first.persisted, true);
  assert.equal(first.alert?.sent, false);
  assert.equal(first.alert?.reason, "below-threshold");
  assert.equal(alerts.length, 0);
  assert.equal(loadCustomFallbackEvents(accountId, storeOptions).length, 1);
  assert.equal(logs.some((line) => line.includes("custom fallback event")), true);

  const second = recordCustomFallbackEventGateway({
    accountId,
    runtime,
    storeOptions,
    log,
    sendAlert: (alert) => alerts.push(alert),
    event: {
      kind: "response-timeout",
      peer: { kind: "group", id: "GROUP_OPENID" },
      actor: { id: "MEMBER_OPENID", label: "Member" },
      messageId: "msg-2",
      runId: "msg-2",
      at: 2_000,
      details: { queueTotalPending: 2 },
    },
  });
  assert.equal(second.persisted, true);
  assert.equal(second.alert?.sent, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].groupOpenid, "GROUP_OPENID");
  assert.equal(alerts[0].cooldownKey, "default:group:GROUP_OPENID");
  assert.equal(alerts[0].eventCount, 2);
  assert.equal(alerts[0].text.includes("窗口"), true);
  assert.equal(loadCustomFallbackEvents(accountId, storeOptions).length, 2);

  let queueSnapshotReads = 0;
  let dispatchSnapshotReads = 0;
  const dispatchRecorder = createCustomDispatchFallbackRecorder({
    accountId,
    runtime,
    storeOptions,
    log,
    message: {
      type: "group",
      senderId: "MEMBER_OPENID",
      senderName: "Member",
      content: "hello",
      messageId: "msg-dispatch",
      timestamp: "2026-06-21T00:00:00.000Z",
      groupOpenid: "GROUP_OPENID",
    },
    sessionKey: "qqbot:group:GROUP_OPENID",
    getQueueSnapshot: () => {
      queueSnapshotReads += 1;
      return {
        totalPending: 4,
        activeUsers: 1,
        maxConcurrentUsers: 10,
        senderPending: 2,
        senderActiveMs: 123,
        maxActiveMs: 456,
      };
    },
    getDispatchSnapshot: () => {
      dispatchSnapshotReads += 1;
      return {
        hasResponse: true,
        hasBlockResponse: false,
        hasModelBlockOutput: false,
        dispatchTimedOut: false,
        toolDeliverCount: 3,
        toolTextCount: 2,
        toolMediaCount: 1,
        toolFallbackSent: false,
        toolRenewalCount: 0,
      };
    },
  });
  const dispatchRecorded = dispatchRecorder({
    kind: "tool-fallback-text",
    reason: "tool text fallback",
    details: { fallbackTextChars: 12 },
  });
  assert.equal(dispatchRecorded.persisted, true);
  assert.equal(dispatchRecorded.event.kind, "tool-fallback-text");
  assert.equal(dispatchRecorded.event.sessionKey, "qqbot:group:GROUP_OPENID");
  assert.equal(dispatchRecorded.event.toolDeliverCount, 3);
  assert.equal(dispatchRecorded.event.details?.queueTotalPending, 4);
  assert.equal(dispatchRecorded.event.details?.fallbackTextChars, 12);
  assert.equal(queueSnapshotReads, 1);
  assert.equal(dispatchSnapshotReads, 1);
  assert.equal(loadCustomFallbackEvents(accountId, storeOptions).length, 3);

  const urgent = recordCustomFallbackEventGateway({
    accountId,
    storeOptions,
    log,
    event: {
      type: "custom-fallback",
      kind: "urgent-queue-bypass",
      accountId,
      peer: { kind: "c2c", id: "USER_OPENID" },
      messageId: "urgent-1",
      at: 3_000,
    },
  });
  assert.equal(urgent.persisted, true);
  assert.equal(urgent.event.kind, "urgent-queue-bypass");
  assert.equal(loadCustomFallbackEvents(accountId, storeOptions).length, 4);

  const disabledRuntime = recordCustomFallbackEventGateway({
    accountId,
    runtime: { ...runtime, enabled: false },
    storeOptions,
    log,
    sendAlert: (alert) => alerts.push(alert),
    event: {
      kind: "response-timeout",
      peer: { kind: "group", id: "GROUP_OPENID" },
      messageId: "msg-3",
      at: 4_000,
    },
  });
  assert.equal(disabledRuntime.persisted, true);
  assert.equal(disabledRuntime.alert?.sent, false);
  assert.equal(disabledRuntime.alert?.reason, "runtime-disabled");
  assert.equal(logs.some((line) => line.includes("runtime-disabled")), true);
  assert.equal(alerts.length, 1);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("custom fallback record gateway adapter tests passed");
