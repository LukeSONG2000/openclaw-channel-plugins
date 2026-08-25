import assert from "node:assert";
import {
  resolveQQBotConnectionFailureReconnectDelay,
  resolveQQBotWebSocketCloseDecision,
} from "../src/custom/websocket-reconnect-policy.js";

const base = {
  isAborted: false,
  lastConnectTime: 10_000,
  quickDisconnectCount: 0,
  quickDisconnectThresholdMs: 5_000,
  maxQuickDisconnectCount: 3,
  rateLimitDelayMs: 60_000,
  now: 20_000,
};

const offline = resolveQQBotWebSocketCloseDecision({ ...base, code: 4914, quickDisconnectCount: 2 });
assert.equal(offline.reconnect, false);
assert.equal(offline.shouldRefreshToken, false);
assert.equal(offline.shouldClearSession, false);
assert.equal(offline.nextQuickDisconnectCount, 2);
assert.equal(offline.logs.some((item) => item.level === "error" && item.message.includes("offline/sandbox-only")), true);

const invalidToken = resolveQQBotWebSocketCloseDecision({ ...base, code: 4004, quickDisconnectCount: 2 });
assert.equal(invalidToken.reconnect, true);
assert.equal(invalidToken.shouldRefreshToken, true);
assert.equal(invalidToken.shouldClearSession, false);
assert.equal(invalidToken.nextQuickDisconnectCount, 2);
assert.equal(invalidToken.reconnectDelayMs, undefined);

const invalidTokenAborted = resolveQQBotWebSocketCloseDecision({ ...base, code: 4004, isAborted: true });
assert.equal(invalidTokenAborted.reconnect, false);
assert.equal(invalidTokenAborted.shouldRefreshToken, true);

const rateLimited = resolveQQBotWebSocketCloseDecision({ ...base, code: 4008 });
assert.equal(rateLimited.reconnect, true);
assert.equal(rateLimited.reconnectDelayMs, 60_000);
assert.equal(rateLimited.shouldRefreshToken, false);

const sessionReset = resolveQQBotWebSocketCloseDecision({ ...base, code: 4007 });
assert.equal(sessionReset.reconnect, true);
assert.equal(sessionReset.shouldRefreshToken, true);
assert.equal(sessionReset.shouldClearSession, true);
assert.equal(sessionReset.nextQuickDisconnectCount, 0);
assert.equal(sessionReset.logs.some((item) => item.message.includes("invalid seq on resume")), true);

const internalReset = resolveQQBotWebSocketCloseDecision({ ...base, code: 4905 });
assert.equal(internalReset.reconnect, true);
assert.equal(internalReset.shouldRefreshToken, true);
assert.equal(internalReset.shouldClearSession, true);
assert.equal(internalReset.logs.some((item) => item.message.includes("Internal error (4905)")), true);

const quickDisconnect = resolveQQBotWebSocketCloseDecision({
  ...base,
  code: 4006,
  now: 11_000,
  quickDisconnectCount: 1,
});
assert.equal(quickDisconnect.reconnect, true);
assert.equal(quickDisconnect.reconnectDelayMs, undefined);
assert.equal(quickDisconnect.nextQuickDisconnectCount, 2);
assert.equal(quickDisconnect.logs.some((item) => item.message.includes("Quick disconnect detected (1000ms), count: 2")), true);

const tooManyQuickDisconnects = resolveQQBotWebSocketCloseDecision({
  ...base,
  code: 4006,
  now: 11_000,
  quickDisconnectCount: 2,
});
assert.equal(tooManyQuickDisconnects.reconnect, true);
assert.equal(tooManyQuickDisconnects.reconnectDelayMs, 60_000);
assert.equal(tooManyQuickDisconnects.nextQuickDisconnectCount, 0);
assert.equal(tooManyQuickDisconnects.logs.some((item) => item.level === "error" && item.message.includes("Too many quick disconnects")), true);

const normalCloseTooManyQuickDisconnects = resolveQQBotWebSocketCloseDecision({
  ...base,
  code: 1000,
  now: 11_000,
  quickDisconnectCount: 2,
});
assert.equal(normalCloseTooManyQuickDisconnects.reconnect, false);
assert.equal(normalCloseTooManyQuickDisconnects.reconnectDelayMs, 60_000);
assert.equal(normalCloseTooManyQuickDisconnects.nextQuickDisconnectCount, 0);

assert.equal(resolveQQBotConnectionFailureReconnectDelay(new Error("Too many requests"), 60_000), 60_000);
assert.equal(resolveQQBotConnectionFailureReconnectDelay("100001 gateway limited", 60_000), 60_000);
assert.equal(resolveQQBotConnectionFailureReconnectDelay(new Error("ECONNRESET"), 60_000), undefined);

console.log("custom websocket reconnect policy tests passed");
