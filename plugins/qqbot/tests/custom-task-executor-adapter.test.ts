import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyCustomTaskExecutionIntents,
  completeCustomTaskExecution,
  failCustomTaskExecution,
  heartbeatCustomTaskExecution,
  progressCustomTaskExecution,
  type CustomTaskExecutor,
} from "../src/custom/task-executor-adapter.js";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";
import type { CustomActor, CustomPeer } from "../src/custom/types.js";

const peer: CustomPeer = { kind: "group", id: "GROUP_OPENID" };
const actor: CustomActor = { id: "MEMBER_OPENID", label: "Member" };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-task-executor-"));

try {
  const queuedRuntime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });
  const queued = queuedRuntime.createTask({
    accountId: "default",
    peer,
    actor,
    prompt: "Queue without executor",
    now: 1_000,
  });
  const queuedApply = applyCustomTaskExecutionIntents({
    tasks: queuedRuntime,
    intents: queued.intents,
    now: 1_500,
  });
  assert.equal(queuedApply.changed, false);
  assert.equal(queuedApply.effects.some((effect) => effect.kind === "workspace-materialized"), true);
  assert.equal(queuedApply.effects.some((effect) => effect.kind === "executor-unavailable"), true);
  assert.equal(queuedRuntime.getTask(queued.task!.id)?.status, "queued");
  assert.equal(fs.existsSync(path.join(queued.task!.workspace, "TASK.md")), true);

  const runtime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });
  const created = runtime.createTask({
    accountId: "default",
    peer,
    actor,
    prompt: "Run through executor",
    now: 2_000,
  });
  const forwarded: string[] = [];
  const executor: CustomTaskExecutor = {
    id: "executor-1",
    agentId: "agent-dev",
    start: ({ task }) => ({ accepted: true, runId: `run-${task.id}`, agentId: "agent-dev" }),
    appendRequirement: ({ requirement }) => {
      forwarded.push(requirement.content);
      return { accepted: true };
    },
    cancel: ({ task }) => {
      forwarded.push(`cancel:${task.id}`);
      return { accepted: true };
    },
  };
  const started = applyCustomTaskExecutionIntents({
    tasks: runtime,
    intents: created.intents,
    executor,
    now: 2_500,
  });
  assert.equal(started.changed, true);
  assert.equal(started.effects.some((effect) => effect.kind === "executor-started"), true);
  const taskId = created.task!.id;
  assert.equal(runtime.getTask(taskId)?.status, "running");
  assert.equal(runtime.getTask(taskId)?.execution?.executorId, "executor-1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(created.task!.workspace, "status.json"), "utf8")).status, "running");

  const add = runtime.addRequirement({
    taskId,
    actor,
    content: "Add more logs",
    now: 3_000,
  });
  const appended = applyCustomTaskExecutionIntents({
    tasks: runtime,
    intents: add.intents,
    executor,
    now: 3_500,
  });
  assert.equal(appended.changed, false);
  assert.equal(forwarded.includes("Add more logs"), true);
  assert.equal(appended.effects.some((effect) => effect.kind === "workspace-requirement-appended"), true);

  const heartbeat = heartbeatCustomTaskExecution({
    tasks: runtime,
    taskId,
    now: 4_000,
  });
  assert.equal(heartbeat.changed, true);
  assert.equal(heartbeat.decision.task?.execution?.lastHeartbeatAt, 4_000);

  const progress = progressCustomTaskExecution({
    tasks: runtime,
    taskId,
    phase: "planning",
    message: "拆分任务步骤",
    percent: 25,
    now: 4_050,
  });
  assert.equal(progress.changed, true);
  assert.equal(progress.decision.task?.progress?.phase, "planning");
  assert.equal(progress.decision.task?.progress?.message, "拆分任务步骤");
  assert.equal(progress.effects.some((effect) => effect.kind === "task-progress"), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(created.task!.workspace, "status.json"), "utf8")).progress.percent, 25);

  const cancelRuntime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });
  const cancelCreated = cancelRuntime.createTask({
    accountId: "default",
    peer,
    actor,
    prompt: "Cancel me",
    now: 4_100,
  });
  const cancel = cancelRuntime.cancelTask({
    taskId: cancelCreated.task!.id,
    actor,
    now: 4_200,
  });
  const cancelApply = applyCustomTaskExecutionIntents({
    tasks: cancelRuntime,
    intents: cancel.intents,
    notifyAudiences: ["peer"],
    applyWorkspaceEffects: false,
    now: 4_300,
  });
  assert.equal(cancelApply.effects.some((effect) => effect.kind === "notify" && effect.notification?.text.includes("长任务已取消")), true);

  const completed = completeCustomTaskExecution({
    tasks: runtime,
    taskId,
    result: "Done",
    notifyAudiences: ["peer"],
    includeWorkspaceInNotification: true,
    now: 5_000,
  });
  assert.equal(completed.changed, true);
  assert.equal(completed.decision.task?.status, "completed");
  assert.equal(completed.effects.some((effect) => effect.kind === "notify" && effect.notification?.text.includes("长任务已完成")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(created.task!.workspace, "status.json"), "utf8")).status, "completed");

  const failRuntime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });
  const failCreated = failRuntime.createTask({
    accountId: "default",
    peer,
    actor,
    prompt: "Fail me",
    now: 6_000,
  });
  const failed = failCustomTaskExecution({
    tasks: failRuntime,
    taskId: failCreated.task!.id,
    error: "No executor",
    notifyAudiences: ["peer", "owner"],
    now: 6_500,
  });
  assert.equal(failed.changed, true);
  assert.equal(failed.decision.task?.status, "failed");
  assert.equal(failed.effects.some((effect) => effect.kind === "task-failed"), true);
  assert.equal(failed.effects.filter((effect) => effect.kind === "notify").length, 2);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom task executor adapter tests passed");
