import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomTaskCommandExecutor, resolveCustomTaskCommandExecutorConfig } from "../src/custom/task-command-executor.js";
import {
  CUSTOM_TASK_COMMAND_DEFAULT_MAX_OUTPUT_CHARS,
  CUSTOM_TASK_COMMAND_DEFAULT_TIMEOUT_MS,
  resolveCustomTaskCommandExecutorConfig as resolveCustomTaskCommandExecutorConfigDirect,
} from "../src/custom/task-command-config.js";
import {
  appendCustomTaskCommandOutput,
  formatCustomTaskCommandOutput,
  formatCustomTaskRequirementInput,
  parseCustomTaskCommandProgressLine,
  processCustomTaskCommandStdoutChunk,
} from "../src/custom/task-command-output.js";
import { applyCustomTaskExecutionIntents, completeCustomTaskExecution, failCustomTaskExecution, progressCustomTaskExecution } from "../src/custom/task-executor-adapter.js";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-task-command-executor-"));
const runtime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });

assert.equal(CUSTOM_TASK_COMMAND_DEFAULT_TIMEOUT_MS, 1_800_000);
assert.equal(CUSTOM_TASK_COMMAND_DEFAULT_MAX_OUTPUT_CHARS, 6_000);
assert.deepEqual(resolveCustomTaskCommandExecutorConfig(undefined), {
  enabled: false,
  command: undefined,
  args: [],
  cwd: undefined,
  forwardRequirementsToStdin: false,
  timeoutMs: 1_800_000,
  maxOutputChars: 6_000,
  notifyAudiences: ["peer"],
});
assert.deepEqual(resolveCustomTaskCommandExecutorConfig(undefined), resolveCustomTaskCommandExecutorConfigDirect(undefined));
const directConfig = resolveCustomTaskCommandExecutorConfigDirect({
  enabled: true,
  command: "node",
  args: ["--version"],
  timeoutMs: 10,
  maxOutputChars: 20,
  forwardRequirementsToStdin: true,
  notifyAudiences: ["owner", "peer", "peer"],
});
assert.deepEqual(resolveCustomTaskCommandExecutorConfig({
  enabled: true,
  command: "node",
  args: ["--version"],
  timeoutMs: 10,
  maxOutputChars: 20,
  forwardRequirementsToStdin: true,
  notifyAudiences: ["owner", "peer", "peer"],
}), directConfig);
assert.deepEqual(directConfig, {
  enabled: true,
  command: "node",
  args: ["--version"],
  cwd: undefined,
  forwardRequirementsToStdin: true,
  timeoutMs: 10,
  maxOutputChars: 20,
  notifyAudiences: ["owner", "peer"],
});

assert.deepEqual(parseCustomTaskCommandProgressLine("QQBOT_TASK_PROGRESS {\"phase\":\"setup\",\"message\":\"ready\",\"percent\":33.4}"), {
  phase: "setup",
  message: "ready",
  percent: 33,
});
const stdoutState = { stdout: [] as string[], stdoutLineBuffer: "" };
const directProgress: string[] = [];
processCustomTaskCommandStdoutChunk({
  state: stdoutState,
  chunk: "{\"type\":\"progress\",\"phase\":\"run\",\"progress\":101}\npartial",
  maxOutputChars: 20,
  onProgress: (progress) => directProgress.push(`${progress.phase}:${progress.percent}`),
});
assert.deepEqual(directProgress, ["run:100"]);
assert.equal(stdoutState.stdoutLineBuffer, "partial");
appendCustomTaskCommandOutput(stdoutState.stdout, " more output", 12);
assert.equal(stdoutState.stdout.join(""), " more output");
assert.deepEqual(formatCustomTaskRequirementInput({
  id: "req-1",
  actor: { id: "MEMBER_OPENID", label: "Member" },
  content: "追加需求",
  createdAt: 123,
}), {
  type: "requirement",
  id: "req-1",
  actor: { id: "MEMBER_OPENID", label: "Member" },
  content: "追加需求",
  createdAt: 123,
});
assert.match(formatCustomTaskCommandOutput({
  code: 7,
  signal: null,
  stdout: "ok",
  stderr: "boom",
  maxOutputChars: 1000,
}), /Exit code: 7/);

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
const progressEvents: string[] = [];
const executor = new CustomTaskCommandExecutor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ["-e", "console.log(JSON.stringify({ type: 'qqbot.task.progress', phase: 'running', message: 'executor started', percent: 15 })); console.log(process.env.QQBOT_CUSTOM_TASK_ID); console.error('warn line')"],
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
    progress: (result) => {
      progressEvents.push(`${result.taskId}:${result.percent}:${result.phase}:${result.message}`);
      progressCustomTaskExecution({
        tasks: runtime,
        taskId: result.taskId,
        phase: result.phase,
        message: result.message,
        percent: result.percent,
        applyWorkspaceEffects: false,
        now: 1_750,
      });
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
assert.equal(progressEvents.includes(`${taskId}:15:running:executor started`), true);
assert.equal(runtime.getTask(taskId)?.progress?.message, "executor started");

const stdinRuntime = new CustomTaskSandboxRuntime({ workspaceRoot: tmpDir });
const stdinCreated = stdinRuntime.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID", label: "Owner" },
  prompt: "Wait for forwarded requirement",
  now: 2_100,
});
const stdinTaskId = stdinCreated.task!.id;
const stdinCompleted: Array<{ taskId: string; result: string }> = [];
const stdinExecutor = new CustomTaskCommandExecutor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ["-e", [
      "const chunks=[];",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => chunks.push(chunk));",
      "setTimeout(() => {",
      "  const lines = chunks.join('').trim().split(/\\n+/).filter(Boolean);",
      "  const parsed = lines.map((line) => JSON.parse(line));",
      "  console.log(JSON.stringify(parsed));",
      "  process.exit(0);",
      "}, 250);",
    ].join("")],
    timeoutMs: 5_000,
    maxOutputChars: 2_000,
    forwardRequirementsToStdin: true,
  },
  callbacks: {
    complete: (result) => {
      stdinCompleted.push(result);
      completeCustomTaskExecution({
        tasks: stdinRuntime,
        taskId: result.taskId,
        result: result.result,
        applyWorkspaceEffects: false,
        now: 2_600,
      });
    },
    fail: (result) => {
      failCustomTaskExecution({
        tasks: stdinRuntime,
        taskId: result.taskId,
        error: result.error,
        applyWorkspaceEffects: false,
        now: 2_600,
      });
    },
  },
});
applyCustomTaskExecutionIntents({
  tasks: stdinRuntime,
  intents: stdinCreated.intents,
  executor: stdinExecutor,
  now: 2_200,
});
const stdinRequirement = stdinRuntime.addRequirement({
  taskId: stdinTaskId,
  actor: { id: "MEMBER_OPENID", label: "Member" },
  content: "追加一条来自群聊的新需求",
  now: 2_300,
});
const stdinAppend = applyCustomTaskExecutionIntents({
  tasks: stdinRuntime,
  intents: stdinRequirement.intents,
  executor: stdinExecutor,
  now: 2_350,
});
assert.equal(stdinAppend.effects.some((effect) => effect.kind === "executor-requirement-forwarded" && effect.message?.includes("stdin")), true);
await waitFor(() => stdinCompleted.length === 1);
assert.match(stdinCompleted[0]?.result ?? "", /追加一条来自群聊的新需求/);
assert.match(stdinCompleted[0]?.result ?? "", /"type":"requirement"/);
assert.equal(stdinRuntime.getTask(stdinTaskId)?.status, "completed");

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
