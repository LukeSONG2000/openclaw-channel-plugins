import assert from "node:assert";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";
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
assert.deepEqual(active.map((task) => task.id), [second.task?.id]);

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
