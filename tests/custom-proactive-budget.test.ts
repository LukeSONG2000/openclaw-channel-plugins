import assert from "node:assert";
import {
  CustomProactiveBudgetRuntime,
  customProactiveBudgetKey,
  resolveCustomProactiveConfig,
} from "../src/custom/proactive-budget.js";
import type { CustomPeer, CustomRuntimeConfig, CustomSceneConfig } from "../src/custom/types.js";

const peer: CustomPeer = { kind: "group", id: "GROUP_OPENID" };
const runtimeCfg: CustomRuntimeConfig = {
  enabled: true,
  proactive: {
    monthlyLimit: 2,
    rateLimitWindowMs: 1_000,
    rateLimitMax: 1,
  },
};
const sceneCfg: CustomSceneConfig = {
  scene: "chat",
  proactive: {
    rateLimitMax: 2,
  },
};

const cfg = resolveCustomProactiveConfig({ runtime: runtimeCfg, scene: sceneCfg });
assert.equal(cfg.enabled, true);
assert.equal(cfg.monthlyLimit, 2);
assert.equal(cfg.rateLimitWindowMs, 1_000);
assert.equal(cfg.rateLimitMax, 2);
assert.equal(customProactiveBudgetKey("default", peer), "default:group:GROUP_OPENID");

const budget = new CustomProactiveBudgetRuntime();
const first = budget.check({ accountId: "default", peer, cfg, now: 1_000 });
assert.equal(first.allowed, true);
assert.equal(first.used, 0);
const firstRecorded = budget.record({ accountId: "default", peer, cfg, now: 1_000 });
assert.equal(firstRecorded.allowed, true);
assert.equal(firstRecorded.used, 1);

const secondRecorded = budget.record({ accountId: "default", peer, cfg, now: 1_200 });
assert.equal(secondRecorded.allowed, true);
assert.equal(secondRecorded.used, 2);

const monthlyBlocked = budget.check({ accountId: "default", peer, cfg, now: 1_300 });
assert.equal(monthlyBlocked.allowed, false);
assert.equal(monthlyBlocked.reason, "monthly_limit");

const rateBudget = new CustomProactiveBudgetRuntime();
const rateCfg = resolveCustomProactiveConfig({
  runtime: {
    enabled: true,
    proactive: { monthlyLimit: 10, rateLimitWindowMs: 1_000, rateLimitMax: 1 },
  },
  scene: { scene: "chat" },
});
rateBudget.record({ accountId: "default", peer, cfg: rateCfg, now: 5_000 });
const rateBlocked = rateBudget.check({ accountId: "default", peer, cfg: rateCfg, now: 5_500 });
assert.equal(rateBlocked.allowed, false);
assert.equal(rateBlocked.reason, "rate_limit");
assert.equal(rateBlocked.retryAfterMs, 500);
const afterWindow = rateBudget.check({ accountId: "default", peer, cfg: rateCfg, now: 6_001 });
assert.equal(afterWindow.allowed, true);

const disabledCfg = resolveCustomProactiveConfig({
  runtime: { enabled: true, proactive: { enabled: false } },
  scene: { scene: "chat" },
});
const disabled = budget.check({ accountId: "default", peer, cfg: disabledCfg, now: 10_000 });
assert.equal(disabled.allowed, false);
assert.equal(disabled.reason, "disabled");

const restored = new CustomProactiveBudgetRuntime();
restored.loadState(budget.getState(), { now: Date.UTC(2026, 5, 15) });
assert.equal(Object.keys(restored.getState().entries).length, 0);
restored.loadState(budget.getState(), { now: 1_500, pruneOldPeriods: false });
assert.equal(Object.keys(restored.getState().entries).length, 1);

console.log("custom proactive budget tests passed");
