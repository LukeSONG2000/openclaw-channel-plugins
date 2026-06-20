import assert from "node:assert";
import {
  notificationForCustomTaskStatus,
  notificationsForCustomTaskStatus,
} from "../src/custom/task-notification-adapter.js";
import type { CustomSandboxTask } from "../src/custom/types.js";

const baseTask: CustomSandboxTask = {
  id: "task-1",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  owner: { id: "MEMBER_OPENID", label: "Member" },
  title: "Notify task",
  prompt: "Run a long task",
  status: "running",
  workspace: "/tmp/task-1",
  createdAt: 1_000,
  updatedAt: 2_000,
  requirements: [],
  execution: {
    executorId: "executor-1",
    runId: "run-1",
    agentId: "agent-dev",
    startedAt: 1_500,
    lastHeartbeatAt: 2_000,
  },
};

assert.equal(notificationForCustomTaskStatus({ task: baseTask }), null);

const completed = notificationForCustomTaskStatus({
  task: {
    ...baseTask,
    status: "completed",
    result: "A".repeat(80),
    updatedAt: 3_000,
  },
  includeWorkspace: true,
  maxResultChars: 40,
});
assert.equal(completed?.kind, "notify");
assert.equal(completed?.audience, "peer");
assert.equal(completed?.title, "✅ 长任务已完成");
assert.equal(completed?.text.includes("工作区：/tmp/task-1"), true);
assert.equal(completed?.text.includes("...(已截断)"), true);

const failed = notificationsForCustomTaskStatus({
  task: {
    ...baseTask,
    status: "failed",
    error: "Executor crashed",
    updatedAt: 4_000,
  },
  audiences: ["peer", "owner", "peer"],
});
assert.equal(failed.length, 2);
assert.deepEqual(failed.map((item) => item.audience), ["peer", "owner"]);
assert.equal(failed[0]?.text.includes("错误："), true);
assert.equal(failed[0]?.text.includes("Executor crashed"), true);

const cancelled = notificationForCustomTaskStatus({
  task: {
    ...baseTask,
    status: "cancelled",
    result: "Cancelled by admin",
    updatedAt: 5_000,
  },
});
assert.equal(cancelled?.title, "✅ 长任务已取消");
assert.equal(cancelled?.text.includes("Cancelled by admin"), true);

console.log("custom task notification adapter tests passed");
