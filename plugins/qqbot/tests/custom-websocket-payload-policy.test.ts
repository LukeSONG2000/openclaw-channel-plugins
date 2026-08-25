import assert from "node:assert";
import {
  buildQQBotWebSocketHeartbeatPayload,
  resolveQQBotWebSocketDispatchDecision,
  resolveQQBotWebSocketHelloDecision,
  resolveQQBotWebSocketInvalidSessionDecision,
} from "../src/custom/websocket-payload-policy.js";

const resumeHello = resolveQQBotWebSocketHelloDecision({
  accessToken: "TOKEN",
  sessionId: "SESSION_ID",
  lastSeq: 42,
  intents: 123,
  intentsDesc: "full",
  heartbeatInterval: 45_000,
});
assert.deepEqual(resumeHello.outbound, {
  op: 6,
  d: {
    token: "QQBot TOKEN",
    session_id: "SESSION_ID",
    seq: 42,
  },
});
assert.equal(resumeHello.heartbeatIntervalMs, 45_000);
assert.equal(resumeHello.logs.some((item) => item.message.includes("Attempting to resume session SESSION_ID")), true);

const identifyHello = resolveQQBotWebSocketHelloDecision({
  accessToken: "TOKEN",
  sessionId: null,
  lastSeq: null,
  intents: 123,
  intentsDesc: "full",
  heartbeatInterval: "invalid",
});
assert.deepEqual(identifyHello.outbound, {
  op: 2,
  d: {
    token: "QQBot TOKEN",
    intents: 123,
    shard: [0, 1],
  },
});
assert.equal(identifyHello.heartbeatIntervalMs, 0);
assert.deepEqual(buildQQBotWebSocketHeartbeatPayload(42), { op: 1, d: 42 });
assert.deepEqual(buildQQBotWebSocketHeartbeatPayload(null), { op: 1, d: null });

const ready = resolveQQBotWebSocketDispatchDecision({
  eventType: "READY",
  data: { session_id: "NEW_SESSION" },
  pendingFirstReady: true,
  intentsDesc: "full",
});
assert.equal(ready.kind, "ready");
assert.equal(ready.kind === "ready" && ready.sessionId, "NEW_SESSION");
assert.equal(ready.kind === "ready" && ready.startupGreeting, "READY");
assert.equal(ready.logs.some((item) => item.message.includes("Ready with full")), true);

const reconnectReady = resolveQQBotWebSocketDispatchDecision({
  eventType: "READY",
  data: { session_id: "RECONNECT_SESSION" },
  pendingFirstReady: false,
  intentsDesc: "full",
});
assert.equal(reconnectReady.kind, "ready");
assert.equal(reconnectReady.kind === "ready" && reconnectReady.startupGreeting, null);
assert.equal(reconnectReady.logs.some((item) => item.message.includes("Skipping startup greeting")), true);

const resumed = resolveQQBotWebSocketDispatchDecision({
  eventType: "RESUMED",
  data: {},
  pendingFirstReady: true,
  intentsDesc: "full",
});
assert.equal(resumed.kind, "resumed");
assert.equal(resumed.kind === "resumed" && resumed.startupGreeting, "RESUMED");
assert.equal(resumed.kind === "resumed" && resumed.shouldSaveSession, true);

const event = resolveQQBotWebSocketDispatchDecision({
  eventType: "GROUP_MESSAGE_CREATE",
  data: { id: "msg" },
  pendingFirstReady: false,
  intentsDesc: "full",
});
assert.deepEqual(event, {
  kind: "event",
  logs: [],
  eventType: "GROUP_MESSAGE_CREATE",
  data: { id: "msg" },
});

const invalidNoResume = resolveQQBotWebSocketInvalidSessionDecision({
  canResume: false,
  intentsDesc: "full",
  rawData: "raw",
});
assert.equal(invalidNoResume.shouldClearSession, true);
assert.equal(invalidNoResume.shouldRefreshToken, true);
assert.equal(invalidNoResume.cleanup, true);
assert.equal(invalidNoResume.reconnectDelayMs, 3000);
assert.equal(invalidNoResume.logs.some((item) => item.level === "info" && item.message.includes("Will refresh token")), true);

const invalidCanResume = resolveQQBotWebSocketInvalidSessionDecision({
  canResume: true,
  intentsDesc: "full",
  rawData: "raw",
});
assert.equal(invalidCanResume.shouldClearSession, false);
assert.equal(invalidCanResume.shouldRefreshToken, false);
assert.equal(invalidCanResume.reconnect, true);
assert.equal(invalidCanResume.logs.some((item) => item.level === "error"), true);

console.log("custom websocket payload policy tests passed");
