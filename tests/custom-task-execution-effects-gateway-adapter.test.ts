import assert from "node:assert";
import {
  applyCustomTaskAsyncStatusGateway,
  collectCustomTaskExecutionEffectDeliveries,
  sendCustomTaskExecutionNotificationDeliveries,
} from "../src/custom/task-execution-effects-gateway-adapter.js";
import type { CustomTaskExecutionEffect } from "../src/custom/task-executor-adapter.js";
import type { CustomSandboxTask } from "../src/custom/types.js";

const groupTask: CustomSandboxTask = {
  id: "task-1",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  owner: { id: "OWNER_OPENID", label: "Owner" },
  title: "Gateway task",
  prompt: "Prompt",
  status: "completed",
  workspace: "/tmp/task-1",
  createdAt: 1_000,
  updatedAt: 2_000,
  requirements: [],
  result: "Done",
};
const channelTask: CustomSandboxTask = {
  ...groupTask,
  id: "task-channel",
  peer: { kind: "channel", id: "CHANNEL_ID" },
};

const effects: CustomTaskExecutionEffect[] = [
  { kind: "task-completed", taskId: groupTask.id, runId: "run-1" },
  {
    kind: "notify",
    taskId: groupTask.id,
    message: "notify peer",
    notification: {
      kind: "notify",
      audience: "peer",
      taskId: groupTask.id,
      title: "done",
      text: "peer text",
    },
  },
  {
    kind: "notify",
    taskId: "missing-task",
    message: "missing",
    notification: {
      kind: "notify",
      audience: "peer",
      taskId: "missing-task",
      title: "missing",
      text: "missing text",
    },
  },
  { kind: "error", taskId: groupTask.id, message: "bad effect" },
];

const infoLogs: string[] = [];
const errorLogs: string[] = [];
const runtime = {
  getTask: (taskId: string) => taskId === groupTask.id ? groupTask : null,
};

const deliveries = collectCustomTaskExecutionEffectDeliveries({
  accountId: "default",
  tasks: runtime,
  effects,
  passiveMessageId: "MSG_PASSIVE",
  log: {
    info: (message) => { infoLogs.push(message); },
    error: (message) => { errorLogs.push(message); },
  },
});
assert.equal(deliveries.length, 1);
assert.equal(deliveries[0]?.target.type, "group");
assert.equal(deliveries[0]?.target.groupOpenid, "GROUP_OPENID");
assert.equal(deliveries[0]?.target.messageId, "MSG_PASSIVE");
assert.equal(deliveries[0]?.text, "peer text");
assert.equal(infoLogs.some((line) => line.includes("kind=task-completed task=task-1 run=run-1")), true);
assert.equal(infoLogs.some((line) => line.includes("kind=notify task=task-1 message=notify peer")), true);
assert.equal(errorLogs.some((line) => line.includes("kind=error task=task-1 message=bad effect")), true);

const sent: string[] = [];
const sentResults = await sendCustomTaskExecutionNotificationDeliveries({
  accountId: "default",
  deliveries,
  sendText: async (delivery) => {
    sent.push(`${delivery.target.type}:${delivery.text}`);
  },
  log: {
    info: (message) => { infoLogs.push(message); },
    error: (message) => { errorLogs.push(message); },
  },
});
assert.deepEqual(sent, ["group:peer text"]);
assert.equal(sentResults[0]?.status, "sent");
assert.equal(infoLogs.some((line) => line.includes("custom task notification sent")), true);

const asyncInfoLogs: string[] = [];
let persistCount = 0;
const asyncSent: string[] = [];
const asyncResult = await applyCustomTaskAsyncStatusGateway({
  accountId: "default",
  tasks: {
    getTask: (taskId: string) => {
      if (taskId === groupTask.id) return groupTask;
      if (taskId === channelTask.id) return channelTask;
      return null;
    },
  },
  effects: [
    {
      kind: "notify",
      taskId: groupTask.id,
      notification: {
        kind: "notify",
        audience: "peer",
        taskId: groupTask.id,
        title: "group",
        text: "group unanchored",
      },
    },
    {
      kind: "notify",
      taskId: channelTask.id,
      notification: {
        kind: "notify",
        audience: "peer",
        taskId: channelTask.id,
        title: "channel",
        text: "channel unanchored",
      },
    },
  ],
  persistTaskState: () => { persistCount += 1; },
  allowUnanchored: true,
  sendText: async (delivery) => { asyncSent.push(`${delivery.target.type}:${delivery.text}`); },
  log: {
    info: (message) => { asyncInfoLogs.push(message); },
    error: (message) => { errorLogs.push(message); },
  },
});
assert.equal(asyncResult.changed, true);
assert.equal(asyncResult.failed, false);
assert.equal(persistCount, 1);
assert.deepEqual(asyncSent, ["group:group unanchored"]);
assert.deepEqual(asyncResult.deliveryResults.map((item) => item.status), ["sent", "skipped"]);
assert.equal(asyncInfoLogs.some((line) => line.includes("custom task notification skipped")), true);

const empty = await applyCustomTaskAsyncStatusGateway({
  accountId: "default",
  tasks: runtime,
  effects: [],
  persistTaskState: () => { throw new Error("should not persist"); },
  sendText: async () => { throw new Error("should not send"); },
});
assert.deepEqual(empty, { changed: false, deliveries: [], deliveryResults: [], failed: false });

const failedErrors: string[] = [];
const failed = await applyCustomTaskAsyncStatusGateway({
  accountId: "default",
  tasks: runtime,
  effects: [{ kind: "task-failed", taskId: groupTask.id }],
  persistTaskState: () => { throw new Error("persist failed"); },
  sendText: async () => {},
  log: { error: (message) => { failedErrors.push(message); } },
});
assert.equal(failed.failed, true);
assert.equal(failedErrors.some((line) => line.includes("custom task async status handling failed")), true);

console.log("custom task execution effects gateway adapter tests passed");
