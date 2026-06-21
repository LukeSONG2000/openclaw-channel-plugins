import type { CustomSandboxTask, CustomTaskIntent, CustomTaskRequirement } from "./types.js";
import type { CustomTaskSandboxDecision, CustomTaskSandboxRuntime } from "./task-sandbox.js";
import {
  appendCustomTaskRequirement,
  materializeCustomTaskWorkspace,
  writeCustomTaskStatus,
} from "./task-workspace.js";
import {
  notificationsForCustomTaskStatus,
  type CustomTaskNotificationAudience,
  type CustomTaskNotificationEffect,
} from "./task-notification-adapter.js";

export interface CustomTaskExecutorStartResult {
  accepted?: boolean;
  runId?: string;
  agentId?: string;
  message?: string;
}

export interface CustomTaskExecutorAck {
  accepted?: boolean;
  message?: string;
}

export interface CustomTaskExecutor {
  id: string;
  agentId?: string;
  start?: (params: { task: CustomSandboxTask }) => CustomTaskExecutorStartResult | void;
  appendRequirement?: (params: {
    task: CustomSandboxTask;
    requirement: CustomTaskRequirement;
  }) => CustomTaskExecutorAck | void;
  cancel?: (params: { task: CustomSandboxTask }) => CustomTaskExecutorAck | void;
}

export interface CustomTaskExecutionEffect {
  kind:
    | "workspace-materialized"
    | "workspace-status-written"
    | "workspace-requirement-appended"
    | "executor-unavailable"
    | "executor-started"
    | "executor-requirement-forwarded"
    | "executor-cancel-requested"
    | "task-heartbeat"
    | "task-completed"
    | "task-failed"
    | "notify"
    | "error";
  taskId?: string;
  runId?: string;
  message?: string;
  notification?: CustomTaskNotificationEffect;
}

export interface CustomTaskExecutionApplyResult {
  changed: boolean;
  effects: CustomTaskExecutionEffect[];
}

export interface CustomTaskExecutionStatusResult extends CustomTaskExecutionApplyResult {
  decision: CustomTaskSandboxDecision;
}

export function applyCustomTaskExecutionIntents(params: {
  tasks: CustomTaskSandboxRuntime;
  intents?: CustomTaskIntent[];
  executor?: CustomTaskExecutor;
  applyWorkspaceEffects?: boolean;
  notifyAudiences?: CustomTaskNotificationAudience[];
  includeWorkspaceInNotification?: boolean;
  maxNotificationResultChars?: number;
  now?: number;
}): CustomTaskExecutionApplyResult {
  const effects: CustomTaskExecutionEffect[] = [];
  let changed = false;
  const applyWorkspaceEffects = params.applyWorkspaceEffects !== false;

  for (const intent of params.intents ?? []) {
    try {
      if (intent.kind === "start-requested") {
        if (applyWorkspaceEffects) {
          materializeCustomTaskWorkspace(intent.task, { now: params.now });
          effects.push({ kind: "workspace-materialized", taskId: intent.task.id });
        }
        const start = params.executor?.start?.({ task: intent.task });
        if (!params.executor || start?.accepted === false) {
          effects.push({
            kind: "executor-unavailable",
            taskId: intent.task.id,
            message: start?.message ?? "task queued; no custom task executor is attached",
          });
          continue;
        }

        const runId = start?.runId ?? `${intent.task.id}-run-${params.now ?? Date.now()}`;
        const decision = params.tasks.startTask({
          taskId: intent.task.id,
          executorId: params.executor.id,
          runId,
          agentId: start?.agentId ?? params.executor.agentId,
          now: params.now,
        });
        if (!decision.allowed || !decision.task) {
          effects.push({
            kind: "error",
            taskId: intent.task.id,
            message: `failed to start task: ${decision.reason}`,
          });
          continue;
        }
        changed = true;
        if (applyWorkspaceEffects) {
          writeCustomTaskStatus(decision.task, { now: params.now });
          effects.push({ kind: "workspace-status-written", taskId: decision.task.id });
        }
        effects.push({ kind: "executor-started", taskId: decision.task.id, runId });
        continue;
      }

      if (intent.kind === "requirement-added") {
        if (applyWorkspaceEffects) {
          appendCustomTaskRequirement(intent.task, intent.requirement, { now: params.now });
          effects.push({ kind: "workspace-requirement-appended", taskId: intent.task.id });
        }
        const forwarded = params.executor?.appendRequirement?.({
          task: intent.task,
          requirement: intent.requirement,
        });
        if (params.executor && forwarded?.accepted !== false) {
          effects.push({
            kind: "executor-requirement-forwarded",
            taskId: intent.task.id,
            message: forwarded?.message,
          });
        }
        continue;
      }

      if (intent.kind === "cancel-requested") {
        if (applyWorkspaceEffects) {
          writeCustomTaskStatus(intent.task, { now: params.now });
          effects.push({ kind: "workspace-status-written", taskId: intent.task.id });
        }
        const cancelled = params.executor?.cancel?.({ task: intent.task });
        if (params.executor && cancelled?.accepted !== false) {
          effects.push({
            kind: "executor-cancel-requested",
            taskId: intent.task.id,
            message: cancelled?.message,
          });
        }
        if (params.notifyAudiences?.length) {
          for (const notification of notificationsForCustomTaskStatus({
            task: intent.task,
            audiences: params.notifyAudiences,
            includeWorkspace: params.includeWorkspaceInNotification,
            maxResultChars: params.maxNotificationResultChars,
          })) {
            effects.push({
              kind: "notify",
              taskId: intent.task.id,
              message: notification.title,
              notification,
            });
          }
        }
        continue;
      }

      if (intent.kind === "status-updated") {
        if (applyWorkspaceEffects) {
          writeCustomTaskStatus(intent.task, { now: params.now });
          effects.push({ kind: "workspace-status-written", taskId: intent.task.id });
        }
      }
    } catch (err) {
      effects.push({
        kind: "error",
        taskId: "task" in intent ? intent.task.id : undefined,
        message: String(err),
      });
    }
  }

  return { changed, effects };
}

export function heartbeatCustomTaskExecution(params: {
  tasks: CustomTaskSandboxRuntime;
  taskId: string;
  applyWorkspaceEffects?: boolean;
  now?: number;
}): CustomTaskExecutionStatusResult {
  const decision = params.tasks.heartbeatTask({ taskId: params.taskId, now: params.now });
  return applyStatusDecision({
    decision,
    successKind: "task-heartbeat",
    applyWorkspaceEffects: params.applyWorkspaceEffects,
    now: params.now,
  });
}

export function completeCustomTaskExecution(params: {
  tasks: CustomTaskSandboxRuntime;
  taskId: string;
  result: string;
  applyWorkspaceEffects?: boolean;
  notifyAudiences?: CustomTaskNotificationAudience[];
  includeWorkspaceInNotification?: boolean;
  maxNotificationResultChars?: number;
  now?: number;
}): CustomTaskExecutionStatusResult {
  const decision = params.tasks.completeTask({
    taskId: params.taskId,
    result: params.result,
    now: params.now,
  });
  return applyStatusDecision({
    decision,
    successKind: "task-completed",
    applyWorkspaceEffects: params.applyWorkspaceEffects,
    notifyAudiences: params.notifyAudiences,
    includeWorkspaceInNotification: params.includeWorkspaceInNotification,
    maxNotificationResultChars: params.maxNotificationResultChars,
    now: params.now,
  });
}

export function failCustomTaskExecution(params: {
  tasks: CustomTaskSandboxRuntime;
  taskId: string;
  error: string;
  applyWorkspaceEffects?: boolean;
  notifyAudiences?: CustomTaskNotificationAudience[];
  includeWorkspaceInNotification?: boolean;
  maxNotificationResultChars?: number;
  now?: number;
}): CustomTaskExecutionStatusResult {
  const decision = params.tasks.failTask({
    taskId: params.taskId,
    error: params.error,
    now: params.now,
  });
  return applyStatusDecision({
    decision,
    successKind: "task-failed",
    applyWorkspaceEffects: params.applyWorkspaceEffects,
    notifyAudiences: params.notifyAudiences,
    includeWorkspaceInNotification: params.includeWorkspaceInNotification,
    maxNotificationResultChars: params.maxNotificationResultChars,
    now: params.now,
  });
}

function applyStatusDecision(params: {
  decision: CustomTaskSandboxDecision;
  successKind: Extract<CustomTaskExecutionEffect["kind"], "task-heartbeat" | "task-completed" | "task-failed">;
  applyWorkspaceEffects?: boolean;
  notifyAudiences?: CustomTaskNotificationAudience[];
  includeWorkspaceInNotification?: boolean;
  maxNotificationResultChars?: number;
  now?: number;
}): CustomTaskExecutionStatusResult {
  const effects: CustomTaskExecutionEffect[] = [];
  const task = params.decision.task;
  if (!params.decision.allowed || !task) {
    effects.push({
      kind: "error",
      taskId: task?.id,
      message: `task status update failed: ${params.decision.reason}`,
    });
    return { decision: params.decision, changed: false, effects };
  }

  if (params.applyWorkspaceEffects !== false) {
    writeCustomTaskStatus(task, { now: params.now });
    effects.push({ kind: "workspace-status-written", taskId: task.id });
  }
  effects.push({ kind: params.successKind, taskId: task.id });
  if (params.notifyAudiences?.length) {
    for (const notification of notificationsForCustomTaskStatus({
      task,
      audiences: params.notifyAudiences,
      includeWorkspace: params.includeWorkspaceInNotification,
      maxResultChars: params.maxNotificationResultChars,
    })) {
      effects.push({
        kind: "notify",
        taskId: task.id,
        message: notification.title,
        notification,
      });
    }
  }
  return { decision: params.decision, changed: true, effects };
}
