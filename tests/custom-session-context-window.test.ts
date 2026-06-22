import assert from "node:assert/strict";
import { applyCustomSessionContextWindow, resetCustomSessionContextWindowForTests } from "../src/custom/session-context-window.js";
import type { CustomAgentRoute } from "../src/custom/route.js";

function route(): CustomAgentRoute {
  return {
    agentId: "main",
    channel: "qqbot",
    accountId: "default",
    sessionKey: "agent:main:qqbot:group:GROUP",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "test",
  };
}

resetCustomSessionContextWindowForTests();
for (let i = 0; i < 4; i++) {
  const result = applyCustomSessionContextWindow({
    route: route(),
    peerId: "GROUP",
    content: `hello ${i}`,
    runtime: { enabled: true, context: { maxSessionTurns: 4 } },
  });
  assert.equal(result.generation, 1);
  assert.equal(result.rotated, false);
}
const autoRotated = applyCustomSessionContextWindow({
  route: route(),
  peerId: "GROUP",
  content: "hello 4",
  runtime: { enabled: true, context: { maxSessionTurns: 4 } },
});
assert.equal(autoRotated.generation, 2);
assert.equal(autoRotated.rotated, true);
assert.equal(autoRotated.reason, "turn-limit");
assert.equal(autoRotated.route.sessionKey, "agent:main:qqbot:group:GROUP:qqctx:2");

const manualNew = applyCustomSessionContextWindow({
  route: route(),
  peerId: "GROUP",
  content: "/new",
  runtime: { enabled: true, context: { maxSessionTurns: 4 } },
});
assert.equal(manualNew.generation, 3);
assert.equal(manualNew.turns, 0);
assert.equal(manualNew.reason, "manual-new");
assert.equal(manualNew.route.sessionKey, "agent:main:qqbot:group:GROUP:qqctx:3");

console.log("custom session context window tests passed");
