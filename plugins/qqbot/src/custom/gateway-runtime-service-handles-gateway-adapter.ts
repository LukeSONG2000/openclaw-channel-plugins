import type { CustomTaskCommandExecutor } from "./task-command-executor.js";
import type { CustomUnreadScheduler } from "./unread-scheduler.js";
import type { CustomPollExpirationScheduler } from "./poll-expiration-scheduler.js";
import type { CustomScheduledTaskScheduler } from "./scheduled-task-scheduler.js";

export interface QQBotGatewayRuntimeServiceHandles {
  getTaskExecutor: () => CustomTaskCommandExecutor | null;
  getTaskExecutorOrUndefined: () => CustomTaskCommandExecutor | undefined;
  getUnreadScheduler: () => CustomUnreadScheduler | null;
  getPollExpirationScheduler: () => CustomPollExpirationScheduler | null;
  getScheduledTaskScheduler: () => CustomScheduledTaskScheduler | null;
  setTaskExecutor: (executor: CustomTaskCommandExecutor) => void;
  setUnreadScheduler: (scheduler: CustomUnreadScheduler) => void;
  setPollExpirationScheduler: (scheduler: CustomPollExpirationScheduler | undefined) => void;
  setScheduledTaskScheduler: (scheduler: CustomScheduledTaskScheduler | undefined) => void;
  dispose: () => void;
  snapshot: () => {
    hasTaskExecutor: boolean;
    hasUnreadScheduler: boolean;
    hasPollExpirationScheduler: boolean;
    hasScheduledTaskScheduler: boolean;
  };
}

export function createQQBotGatewayRuntimeServiceHandles(): QQBotGatewayRuntimeServiceHandles {
  let taskExecutor: CustomTaskCommandExecutor | null = null;
  let unreadScheduler: CustomUnreadScheduler | null = null;
  let pollExpirationScheduler: CustomPollExpirationScheduler | null = null;
  let scheduledTaskScheduler: CustomScheduledTaskScheduler | null = null;

  return {
    getTaskExecutor: () => taskExecutor,
    getTaskExecutorOrUndefined: () => taskExecutor ?? undefined,
    getUnreadScheduler: () => unreadScheduler,
    getPollExpirationScheduler: () => pollExpirationScheduler,
    getScheduledTaskScheduler: () => scheduledTaskScheduler,
    setTaskExecutor: (executor) => { taskExecutor = executor; },
    setUnreadScheduler: (scheduler) => { unreadScheduler = scheduler; },
    setPollExpirationScheduler: (scheduler) => { pollExpirationScheduler = scheduler ?? null; },
    setScheduledTaskScheduler: (scheduler) => { scheduledTaskScheduler = scheduler ?? null; },
    dispose: () => {
      const currentUnreadScheduler = unreadScheduler;
      const currentTaskExecutor = taskExecutor;
      const currentPollExpirationScheduler = pollExpirationScheduler;
      const currentScheduledTaskScheduler = scheduledTaskScheduler;
      unreadScheduler = null;
      taskExecutor = null;
      pollExpirationScheduler = null;
      scheduledTaskScheduler = null;

      let firstError: unknown;
      try {
        currentScheduledTaskScheduler?.dispose();
      } catch (err) {
        firstError = err;
      }
      try {
        currentPollExpirationScheduler?.dispose();
      } catch (err) {
        firstError ??= err;
      }
      try {
        currentUnreadScheduler?.dispose();
      } catch (err) {
        firstError ??= err;
      }
      try {
        currentTaskExecutor?.dispose();
      } catch (err) {
        firstError ??= err;
      }
      if (firstError) throw firstError;
    },
    snapshot: () => ({
      hasTaskExecutor: Boolean(taskExecutor),
      hasUnreadScheduler: Boolean(unreadScheduler),
      hasPollExpirationScheduler: Boolean(pollExpirationScheduler),
      hasScheduledTaskScheduler: Boolean(scheduledTaskScheduler),
    }),
  };
}
