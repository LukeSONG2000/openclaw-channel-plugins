import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";
import {
  createCustomRuntimeServicesGateway,
  type CustomRuntimeServicesTaskExecutorFactoryParams,
} from "../src/custom/runtime-services-gateway-adapter.js";
import type { CustomTaskExecutionEffect } from "../src/custom/task-executor-adapter.js";
import type { CustomTaskNotificationAudience } from "../src/custom/task-notification-adapter.js";
import type { CustomUnreadSchedulerOptions } from "../src/custom/unread-scheduler.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-runtime-services-"));

try {
  const runtime = createCustomMessageFlowRuntime();
  const logs: string[] = [];
  let previousDisposed = false;
  let capturedTaskFactoryParams: CustomRuntimeServicesTaskExecutorFactoryParams | null = null;
  let capturedUnreadOptions: CustomUnreadSchedulerOptions | null = null;
  let restoredUnreadState: unknown = null;
  let persistedTaskCount = 0;
  let persistedUnreadCount = 0;
  const asyncEffectBatches: CustomTaskExecutionEffect[][] = [];

  const notifyAudiences: CustomTaskNotificationAudience[] = ["owner"];
  const services = createCustomRuntimeServicesGateway({
    cfg: {
      channels: {
        qqbot: {
          customRuntime: {
            enabled: true,
            unread: { historyLimit: 7 },
            tasks: {
              commandExecutor: {
                enabled: true,
                command: "node",
                notifyAudiences,
              },
            },
          },
        },
      },
    } as any,
    accountId: "acct",
    runtime,
    previousTaskExecutor: {
      dispose: () => {
        previousDisposed = true;
      },
    },
    enqueueMessage: async () => {},
    persistTaskState: () => {
      persistedTaskCount += 1;
    },
    persistUnreadState: () => {
      persistedUnreadCount += 1;
    },
    sendTaskStatusText: async () => {},
    log: {
      info: (msg) => logs.push(msg),
      debug: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    taskExecutorFactory: (params) => {
      capturedTaskFactoryParams = params;
      params.log?.info?.("task executor ready");
      return {
        id: "fake-executor",
        notifyAudiences,
        dispose: () => {},
      };
    },
    unreadSchedulerFactory: (options) => {
      capturedUnreadOptions = options;
      return {
        restore: (state) => {
          restoredUnreadState = state;
        },
        apply: () => {},
        dispose: () => {},
      };
    },
    applyAsyncTaskStatus: async (params) => {
      asyncEffectBatches.push(params.effects);
      params.persistTaskState();
      return {
        changed: true,
        deliveries: [],
        deliveryResults: [],
        failed: false,
      };
    },
  });

  assert.equal(previousDisposed, true);
  assert.equal(capturedTaskFactoryParams?.config?.enabled, true);
  assert.equal(capturedTaskFactoryParams?.config?.command, "node");
  assert.equal(logs.includes("[qqbot:acct] task executor ready"), true);
  assert.equal(capturedUnreadOptions?.accountId, "acct");
  assert.deepEqual(restoredUnreadState, { peers: {}, snapshots: {} });
  assert.equal(services.resolveUnreadForPeer("GROUP_OPENID")?.historyLimit, 7);
  assert.equal(persistedUnreadCount, 0);

  const created = runtime.tasks.createTask({
    accountId: "acct",
    peer: { kind: "group", id: "GROUP_OPENID" },
    actor: { id: "OWNER_OPENID", label: "Owner" },
    prompt: "run a long task",
    config: { workspaceRoot: tmpDir },
    now: 1_000,
  });
  assert.equal(created.allowed, true);
  const taskId = created.task!.id;
  runtime.tasks.startTask({
    taskId,
    executorId: "fake-executor",
    now: 1_100,
  });

  capturedTaskFactoryParams?.callbacks.progress?.({
    taskId,
    phase: "build",
    message: "half done",
    percent: 50,
    now: 1_200,
  });
  assert.equal(persistedTaskCount, 1);
  assert.equal(runtime.tasks.getTask(taskId)?.progress?.phase, "build");

  capturedTaskFactoryParams?.callbacks.complete({
    taskId,
    result: "done",
    now: 1_300,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.tasks.getTask(taskId)?.status, "completed");
  assert.equal(persistedTaskCount, 2);
  assert.equal(asyncEffectBatches.length, 1);
  assert.equal(asyncEffectBatches[0].some((effect) => effect.kind === "task-completed"), true);
  assert.equal(asyncEffectBatches[0].some((effect) => effect.kind === "notify"), true);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom runtime services gateway adapter tests passed");
