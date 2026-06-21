import assert from "node:assert";
import { CustomTaskSandboxRuntime, resolveTaskSandboxConfig } from "../src/custom/task-sandbox.js";
import type { CustomActor, CustomPeer } from "../src/custom/types.js";

const peer: CustomPeer = { kind: "group", id: "GROUP_OPENID", label: "Master Luke" };
const otherPeer: CustomPeer = { kind: "group", id: "OTHER_GROUP" };
const actor: CustomActor = { id: "MEMBER_OPENID", label: "Member" };
const admin: CustomActor = { id: "ADMIN_OPENID", label: "Admin" };

const runtime = new CustomTaskSandboxRuntime({
  workspaceRoot: "/tmp/openclaw-qqbot-tasks",
  maxActiveTasksPerPeer: 2,
});

const empty = runtime.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "   ",
  now: 1_000,
});
assert.equal(empty.allowed, false);
assert.equal(empty.reason, "empty_prompt");

const first = runtime.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Build a focused custom runtime task sandbox with persisted status",
  now: 2_000,
});
assert.equal(first.allowed, true);
if (!first.task) throw new Error("expected first task");
assert.equal(first.task.id, "qqbot-default-group-GROUP_OPENID-2000-1");
assert.equal(first.task.status, "queued");
assert.equal(first.task.title, "Build a focused custom runtime task sand...");
assert.equal(first.task.workspace, "/tmp/openclaw-qqbot-tasks/qqbot-default-group-GROUP_OPENID-2000-1");

const second = runtime.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Second task",
  now: 3_000,
});
assert.equal(second.allowed, true);
assert.equal(second.task?.id, "qqbot-default-group-GROUP_OPENID-3000-2");

const overLimit = runtime.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Third task",
  now: 4_000,
});
assert.equal(overLimit.allowed, false);
assert.equal(overLimit.reason, "too_many_active_tasks");

assert.deepEqual(resolveTaskSandboxConfig({
  workspaceRoot: "/tmp/base-tasks",
  maxActiveTasksPerPeer: 5,
}, {
  workspaceRoot: " /tmp/scene-tasks ",
  maxActiveTasksPerPeer: 1.8,
}), {
  workspaceRoot: "/tmp/scene-tasks",
  maxActiveTasksPerPeer: 1,
});

const sceneLimited = new CustomTaskSandboxRuntime({
  workspaceRoot: "/tmp/base-tasks",
  maxActiveTasksPerPeer: 5,
});
const sceneTaskOne = sceneLimited.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Scene specific task one",
  config: {
    workspaceRoot: "/tmp/scene-tasks",
    maxActiveTasksPerPeer: 1,
  },
  now: 4_100,
});
assert.equal(sceneTaskOne.allowed, true);
assert.equal(sceneTaskOne.task?.workspace, "/tmp/scene-tasks/qqbot-default-group-GROUP_OPENID-4100-1");
const sceneTaskTwo = sceneLimited.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Scene specific task two",
  config: {
    workspaceRoot: "/tmp/scene-tasks",
    maxActiveTasksPerPeer: 1,
  },
  now: 4_200,
});
assert.equal(sceneTaskTwo.allowed, false);
assert.equal(sceneTaskTwo.reason, "too_many_active_tasks");

const otherPeerTask = runtime.createTask({
  accountId: "default",
  peer: otherPeer,
  actor,
  prompt: "Other peer task",
  now: 5_000,
});
assert.equal(otherPeerTask.allowed, true);

const add = runtime.addRequirement({
  taskId: first.task.id,
  actor: admin,
  content: "Also include a gateway command adapter",
  now: 6_000,
});
assert.equal(add.allowed, true);
assert.equal(add.task?.requirements.length, 1);
assert.equal(add.task?.requirements[0]?.id, `${first.task.id}-req-1`);
assert.equal(add.task?.requirements[0]?.actor.id, "ADMIN_OPENID");
assert.equal(add.requirement?.content, "Also include a gateway command adapter");
assert.equal(add.intents?.[0]?.kind, "requirement-added");

const startSecond = runtime.startTask({
  taskId: second.task!.id,
  executorId: "executor-1",
  runId: "run-1",
  agentId: "dev-agent",
  now: 6_500,
});
assert.equal(startSecond.allowed, true);
assert.equal(startSecond.task?.status, "running");
assert.equal(startSecond.task?.execution?.executorId, "executor-1");
assert.equal(startSecond.task?.execution?.startedAt, 6_500);

const heartbeatSecond = runtime.heartbeatTask({
  taskId: second.task!.id,
  now: 6_750,
});
assert.equal(heartbeatSecond.allowed, true);
assert.equal(heartbeatSecond.task?.execution?.lastHeartbeatAt, 6_750);

const progressSecond = runtime.updateTaskProgress({
  taskId: second.task!.id,
  phase: "coding",
  message: "已完成核心模块",
  percent: 42.6,
  now: 6_800,
});
assert.equal(progressSecond.allowed, true);
assert.equal(progressSecond.task?.progress?.phase, "coding");
assert.equal(progressSecond.task?.progress?.message, "已完成核心模块");
assert.equal(progressSecond.task?.progress?.percent, 43);
assert.equal(progressSecond.task?.progress?.updatedAt, 6_800);
assert.equal(progressSecond.task?.execution?.lastHeartbeatAt, 6_800);

const emptyProgress = runtime.updateTaskProgress({
  taskId: second.task!.id,
  now: 6_850,
});
assert.equal(emptyProgress.allowed, false);
assert.equal(emptyProgress.reason, "empty_prompt");

const completeSecond = runtime.completeTask({
  taskId: second.task!.id,
  result: "Implemented sandbox execution adapter boundary.",
  now: 6_900,
});
assert.equal(completeSecond.allowed, true);
assert.equal(completeSecond.task?.status, "completed");
assert.equal(completeSecond.task?.execution?.completedAt, 6_900);
assert.equal(completeSecond.task?.result, "Implemented sandbox execution adapter boundary.");

const invalidComplete = runtime.completeTask({
  taskId: second.task!.id,
  result: "again",
  now: 6_950,
});
assert.equal(invalidComplete.allowed, false);
assert.equal(invalidComplete.reason, "invalid_transition");

const cancel = runtime.cancelTask({
  taskId: first.task.id,
  actor: admin,
  now: 7_000,
});
assert.equal(cancel.allowed, true);
assert.equal(cancel.task?.status, "cancelled");
assert.equal(cancel.task?.result, "Cancelled by Admin");

const addCancelled = runtime.addRequirement({
  taskId: first.task.id,
  actor,
  content: "Late requirement",
  now: 8_000,
});
assert.equal(addCancelled.allowed, false);
assert.equal(addCancelled.reason, "not_active");

const active = runtime.listTasks({ accountId: "default", peer, status: "active" });
assert.deepEqual(active.map((task) => task.id), []);

const failQueued = runtime.failTask({
  taskId: otherPeerTask.task!.id,
  error: "Executor unavailable",
  now: 8_500,
});
assert.equal(failQueued.allowed, true);
assert.equal(failQueued.task?.status, "failed");
assert.equal(failQueued.task?.error, "Executor unavailable");

const restored = new CustomTaskSandboxRuntime({ workspaceRoot: "/tmp/openclaw-qqbot-tasks" });
restored.loadState(runtime.getState());
assert.equal(restored.getTask(first.task.id)?.status, "cancelled");
const next = restored.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Next restored task",
  now: 9_000,
});
assert.equal(next.task?.id.endsWith("-4"), true);

restored.loadState({ tasks: {} });
const reset = restored.createTask({
  accountId: "default",
  peer,
  actor,
  prompt: "Reset sequence task",
  now: 10_000,
});
assert.equal(reset.task?.id.endsWith("-1"), true);

console.log("custom task sandbox tests passed");
