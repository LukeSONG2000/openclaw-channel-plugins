import type { CustomTaskCommandExecutor } from "./task-command-executor.js";
import type { CustomUnreadScheduler } from "./unread-scheduler.js";

export interface QQBotGatewayRuntimeServiceHandles {
  getTaskExecutor: () => CustomTaskCommandExecutor | null;
  getTaskExecutorOrUndefined: () => CustomTaskCommandExecutor | undefined;
  getUnreadScheduler: () => CustomUnreadScheduler | null;
  setTaskExecutor: (executor: CustomTaskCommandExecutor) => void;
  setUnreadScheduler: (scheduler: CustomUnreadScheduler) => void;
  dispose: () => void;
  snapshot: () => {
    hasTaskExecutor: boolean;
    hasUnreadScheduler: boolean;
  };
}

export function createQQBotGatewayRuntimeServiceHandles(): QQBotGatewayRuntimeServiceHandles {
  let taskExecutor: CustomTaskCommandExecutor | null = null;
  let unreadScheduler: CustomUnreadScheduler | null = null;

  return {
    getTaskExecutor: () => taskExecutor,
    getTaskExecutorOrUndefined: () => taskExecutor ?? undefined,
    getUnreadScheduler: () => unreadScheduler,
    setTaskExecutor: (executor) => { taskExecutor = executor; },
    setUnreadScheduler: (scheduler) => { unreadScheduler = scheduler; },
    dispose: () => {
      const currentUnreadScheduler = unreadScheduler;
      const currentTaskExecutor = taskExecutor;
      unreadScheduler = null;
      taskExecutor = null;

      let firstError: unknown;
      try {
        currentUnreadScheduler?.dispose();
      } catch (err) {
        firstError = err;
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
    }),
  };
}
