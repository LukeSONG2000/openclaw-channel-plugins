import assert from "node:assert";
import { createCustomProactiveGatewayGuard } from "../src/custom/proactive-gateway-adapter.js";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";

const runtime = createCustomMessageFlowRuntime();
let now = Date.UTC(2026, 5, 21, 8, 0, 0);
let persisted = 0;
const logs: string[] = [];
const guard = createCustomProactiveGatewayGuard({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          proactive: {
            enabled: true,
            monthlyLimit: 1,
            rateLimitWindowMs: 60_000,
            rateLimitMax: 1,
          },
        },
      },
    },
  } as any,
  accountId: "default",
  budget: runtime.proactiveBudget,
  persistBudgetState: () => { persisted++; },
  log: { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) },
  clock: () => now,
});

const allowed = guard({
  targetType: "group",
  targetId: "GROUP_OPENID",
  text: "管理群通知",
});
assert.equal(allowed.allowed, true);
if (allowed.allowed) allowed.commit?.();
assert.equal(persisted, 1);
assert.equal(runtime.proactiveBudget.getState().entries["default:group:GROUP_OPENID"]?.count, 1);
assert.equal(logs.some((line) => line.includes("Custom proactive budget recorded")), true);

now += 1_000;
const monthlyBlocked = guard({
  targetType: "group",
  targetId: "GROUP_OPENID",
  text: "第二条管理群通知",
});
assert.equal(monthlyBlocked.allowed, false);
assert.equal(monthlyBlocked.allowed ? "" : monthlyBlocked.reason.includes("reason=monthly_limit"), true);

const disabledRuntime = createCustomMessageFlowRuntime();
const disabledGuard = createCustomProactiveGatewayGuard({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: false,
          proactive: { monthlyLimit: 0, rateLimitMax: 0 },
        },
      },
    },
  } as any,
  accountId: "default",
  budget: disabledRuntime.proactiveBudget,
  persistBudgetState: () => {
    throw new Error("disabled runtime should not persist proactive budget");
  },
  clock: () => now,
});
const disabledAllowed = disabledGuard({
  targetType: "group",
  targetId: "GROUP_OPENID",
  text: "runtime disabled",
});
assert.equal(disabledAllowed.allowed, true);
if (disabledAllowed.allowed) disabledAllowed.commit?.();
assert.deepEqual(disabledRuntime.proactiveBudget.getState().entries, {});

const sceneRuntime = createCustomMessageFlowRuntime();
const sceneGuard = createCustomProactiveGatewayGuard({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          scenes: {
            "qqbot:group:BLOCKED_GROUP": {
              scene: "chat",
              proactive: { enabled: false },
            },
          },
        },
      },
    },
  } as any,
  accountId: "default",
  budget: sceneRuntime.proactiveBudget,
  clock: () => now,
});
const disabledScene = sceneGuard({
  targetType: "group",
  targetId: "BLOCKED_GROUP",
  text: "scene disabled proactive",
});
assert.equal(disabledScene.allowed, false);
assert.equal(disabledScene.allowed ? "" : disabledScene.reason.includes("reason=disabled"), true);

console.log("custom proactive gateway adapter tests passed");
