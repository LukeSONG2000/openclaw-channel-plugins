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
// 保护已关闭：主动发送不再记录到 budget entries，也不再因 monthly_limit 被拦截。
assert.equal(runtime.proactiveBudget.getState().entries["default:group:GROUP_OPENID"]?.count, undefined);
assert.equal(logs.some((line) => line.includes("protection disabled")), true);

now += 1_000;
const second = guard({
  targetType: "group",
  targetId: "GROUP_OPENID",
  text: "第二条管理群通知",
});
assert.equal(second.allowed, true);

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
    // 保护已关闭：commit 仍会触发持久化回调，此处仅作为 no-op 占位。
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
// 保护已全局关闭：即使场景配置 proactive.enabled=false 也不再拦截主动发送。
assert.equal(disabledScene.allowed, true);

console.log("custom proactive gateway adapter tests passed");
