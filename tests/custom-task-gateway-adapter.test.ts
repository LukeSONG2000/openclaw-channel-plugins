import assert from "node:assert";
import { handleCustomTaskCommand, parseCustomTaskCommand } from "../src/custom/task-gateway-adapter.js";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";
import type { QueuedMessage } from "../src/message-queue.js";

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-task create Build custom sandbox",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(parseCustomTaskCommand("hello"), { matched: false });
assert.deepEqual(parseCustomTaskCommand("/bot-task create Build custom sandbox"), {
  matched: true,
  command: { kind: "create", prompt: "Build custom sandbox" },
});
assert.deepEqual(parseCustomTaskCommand("/bot-task add task-1 add docs"), {
  matched: true,
  command: { kind: "add", taskId: "task-1", content: "add docs" },
});
assert.deepEqual(parseCustomTaskCommand("/bot-task cancel"), {
  matched: true,
  error: "缺少 taskId",
});

const tasks = new CustomTaskSandboxRuntime({
  workspaceRoot: "/tmp/openclaw-qqbot-tasks",
  maxActiveTasksPerPeer: 3,
});

const create = handleCustomTaskCommand({
  accountId: "default",
  tasks,
  message,
  rawContent: "/bot-task create Build custom sandbox",
  now: 1_000,
});
assert.equal(create.handled, true);
assert.equal(create.changed, true);
assert.equal(create.reply?.includes("长任务已创建"), true);

const taskId = Object.keys(tasks.getState().tasks)[0]!;
assert.equal(taskId, "qqbot-default-group-GROUP_OPENID-1000-1");

const list = handleCustomTaskCommand({
  accountId: "default",
  tasks,
  message,
  rawContent: "/bot-task list",
  now: 2_000,
});
assert.equal(list.handled, true);
assert.equal(list.changed, undefined);
assert.equal(list.reply?.includes(taskId), true);

const statusBySuffix = handleCustomTaskCommand({
  accountId: "default",
  tasks,
  message,
  rawContent: "/bot-task status 1",
  now: 3_000,
});
assert.equal(statusBySuffix.handled, true);
assert.equal(statusBySuffix.reply?.includes("长任务状态"), true);

const add = handleCustomTaskCommand({
  accountId: "default",
  tasks,
  message,
  rawContent: `/bot-task add ${taskId} Also persist it`,
  now: 4_000,
});
assert.equal(add.handled, true);
assert.equal(add.changed, true);
assert.equal(add.reply?.includes("当前追加需求数：1"), true);

const cancel = handleCustomTaskCommand({
  accountId: "default",
  tasks,
  message,
  rawContent: `/bot-task cancel ${taskId}`,
  now: 5_000,
});
assert.equal(cancel.handled, true);
assert.equal(cancel.changed, true);
assert.equal(cancel.reply?.includes("已取消长任务"), true);

const noMatch = handleCustomTaskCommand({
  accountId: "default",
  tasks,
  message,
  rawContent: "/bot-ping",
  now: 6_000,
});
assert.deepEqual(noMatch, { handled: false });

console.log("custom task gateway adapter tests passed");
