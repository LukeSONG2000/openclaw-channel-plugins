import assert from "node:assert";
import {
  buildCustomTaskCleanupPlan,
  formatCustomTaskCleanupDuration,
  parseCustomTaskCleanupDuration,
  parseCustomTaskCleanupLimit,
} from "../src/custom/task-cleanup.js";
import type { CustomTaskSandboxRuntimeState } from "../src/custom/types.js";

const state: CustomTaskSandboxRuntimeState = {
  tasks: {
    oldDone: task("oldDone", "completed", 1_000, "GROUP_OPENID"),
    oldFailed: task("oldFailed", "failed", 2_000, "GROUP_OPENID"),
    oldCancelledOtherPeer: task("oldCancelledOtherPeer", "cancelled", 2_500, "OTHER_GROUP"),
    freshDone: task("freshDone", "completed", 9_500, "GROUP_OPENID"),
    running: task("running", "running", 1_000, "GROUP_OPENID"),
    otherAccount: { ...task("otherAccount", "completed", 1_000, "GROUP_OPENID"), accountId: "other" },
  },
};

const plan = buildCustomTaskCleanupPlan(state, {
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  now: 10_000,
  olderThanMs: 5_000,
  limit: 1,
});
assert.equal(plan.totalEligible, 2);
assert.equal(plan.items.length, 1);
assert.equal(plan.items[0]?.taskId, "oldDone");
assert.equal(plan.items[0]?.ageMs, 9_000);
assert.equal(plan.truncated, true);

const failedOnly = buildCustomTaskCleanupPlan(state, {
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  now: 10_000,
  olderThanMs: 5_000,
  statuses: ["failed"],
});
assert.deepEqual(failedOnly.items.map((item) => item.taskId), ["oldFailed"]);

assert.equal(parseCustomTaskCleanupDuration("7d"), 604_800_000);
assert.equal(parseCustomTaskCleanupDuration("12h"), 43_200_000);
assert.equal(parseCustomTaskCleanupDuration("30m"), 1_800_000);
assert.equal(parseCustomTaskCleanupDuration("bad"), null);
assert.equal(parseCustomTaskCleanupLimit("50"), 50);
assert.equal(parseCustomTaskCleanupLimit("51"), null);
assert.equal(formatCustomTaskCleanupDuration(604_800_000), "7d");
assert.equal(formatCustomTaskCleanupDuration(43_200_000), "12h");

console.log("custom task cleanup tests passed");

function task(
  id: string,
  status: CustomTaskSandboxRuntimeState["tasks"][string]["status"],
  updatedAt: number,
  peerId: string,
): CustomTaskSandboxRuntimeState["tasks"][string] {
  return {
    id,
    accountId: "default",
    peer: { kind: "group", id: peerId },
    owner: { id: "OWNER_OPENID", label: "Owner" },
    title: `Task ${id}`,
    prompt: `Prompt ${id}`,
    status,
    workspace: `/tmp/${id}`,
    createdAt: updatedAt - 100,
    updatedAt,
    requirements: [],
  };
}
