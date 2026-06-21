import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomTaskCommandExecutor, resolveCustomTaskCommandExecutorConfig } from "../src/custom/task-command-executor.js";
import { applyCustomTaskExecutionIntents, completeCustomTaskExecution, failCustomTaskExecution } from "../src/custom/task-executor-adapter.js";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-task-command-executor-"));
const runtime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });

assert.deepEqual(resolveCustomTaskCommandExecutorConfig(undefined), {
  enabled: false,
  command: undefined,
  args: [],
  cwd: undefined,
  timeoutMs: 1_800_000,
  maxOutputChars: 6_000,
  notifyAudiences: ["peer"],
});
assert.deepEqual(resolveCustomTaskCommandExecutorConfig({
  enabled: true,
  command: "node",
  args: ["--version"],
  timeoutMs: 10,
  maxOutputChars: 20,
  notifyAudiences: ["owner", "peer", "peer"],
}), {
  enabled: true,
  command: "node",
  args: ["--version"],
  cwd: undefined,
  timeoutMs: 10,
  maxOutputChars: 20,
  notifyAudiences: ["owner", "peer"],
});

const disabled = new CustomTaskCommandExecutor({
  config: { enabled: false, command: process.execPath },
  callbacks: {
    complete: () => assert.fail("disabled executor should not complete"),
    fail: () => assert.fail("disabled executor should not fail"),
  },
});
assert.equal(disabled.start({
  task: {
    id: "task-disabled",
    accountId: "default",
    peer: { kind: "group", id: "GROUP_OPENID" },
    owner: { id: "OWNER_OPENID" },
    title: "Disabled",
    prompt: "Disabled",
    status: "queued",
    workspace: path.join(tmpDir, "disabled"),
    createdAt: 1,
    updatedAt: 1,
    requirements: [],
  },
}).accepted, false);

const created = runtime.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID", label: "Owner" },
  prompt: "Run command executor",
  now: 1_000,
});
assert.equal(created.allowed, true);
const taskId = created.task!.id;

const completed: Array<{ taskId: string; result: string }> = [];
const failed: Array<{ taskId: string; error: string }> = [];
const heartbeats: string[] = [];
const executor = new CustomTaskCommandExecutor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ["-e", "console.log(process.env.QQBOT_CUSTOM_TASK_ID); console.error('warn line')"],
    timeoutMs: 5_000,
    maxOutputChars: 1_000,
    notifyAudiences: ["peer", "owner"],
  },
  callbacks: {
    complete: (result) => {
      completed.push(result);
      completeCustomTaskExecution({
        tasks: runtime,
        taskId: result.taskId,
        result: result.result,
        notifyAudiences: ["peer"],
        applyWorkspaceEffects: true,
        now: 2_000,
      });
    },
    fail: (result) => {
      failed.push(result);
      failCustomTaskExecution({
        tasks: runtime,
        taskId: result.taskId,
        error: result.error,
        notifyAudiences: ["peer"],
        applyWorkspaceEffects: true,
        now: 2_000,
      });
    },
    heartbeat: (result) => {
      heartbeats.push(result.taskId);
    },
  },
});

const applied = applyCustomTaskExecutionIntents({
  tasks: runtime,
  intents: created.intents,
  executor,
  now: 1_500,
});
assert.equal(applied.changed, true);
assert.equal(runtime.getTask(taskId)?.status, "running");
assert.equal(runtime.getTask(taskId)?.execution?.executorId, "command-executor");
assert.equal(executor.notifyAudiences.length, 2);

await waitFor(() => completed.length === 1);
assert.equal(failed.length, 0);
assert.equal(completed[0]?.taskId, taskId);
assert.match(completed[0]?.result ?? "", new RegExp(taskId));
assert.match(completed[0]?.result ?? "", /warn line/);
assert.equal(runtime.getTask(taskId)?.status, "completed");
assert.equal(heartbeats.includes(taskId), true);

const failedRuntime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });
const failedCreated = failedRuntime.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID", label: "Owner" },
  prompt: "Fail command executor",
  now: 3_000,
});
const failedTaskId = failedCreated.task!.id;
const failedCallbacks: Array<{ taskId: string; error: string }> = [];
const failingExecutor = new CustomTaskCommandExecutor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ["-e", "console.error('boom'); process.exit(7)"],
    timeoutMs: 5_000,
  },
  callbacks: {
    complete: () => assert.fail("failing command should not complete"),
    fail: (result) => {
      failedCallbacks.push(result);
      failCustomTaskExecution({
        tasks: failedRuntime,
        taskId: result.taskId,
        error: result.error,
        applyWorkspaceEffects: false,
        now: 4_000,
      });
    },
  },
});
applyCustomTaskExecutionIntents({
  tasks: failedRuntime,
  intents: failedCreated.intents,
  executor: failingExecutor,
  now: 3_500,
});
await waitFor(() => failedCallbacks.length === 1);
assert.equal(failedCallbacks[0]?.taskId, failedTaskId);
assert.match(failedCallbacks[0]?.error ?? "", /Exit code: 7/);
assert.match(failedCallbacks[0]?.error ?? "", /boom/);
assert.equal(failedRuntime.getTask(failedTaskId)?.status, "failed");

console.log("custom task command executor tests passed");

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
