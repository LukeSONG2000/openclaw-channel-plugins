import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { applyCustomTaskAsyncStatusGateway } from "./task-execution-effects-gateway-adapter.js";
import {
  completeCustomTaskExecution,
  failCustomTaskExecution,
  heartbeatCustomTaskExecution,
  progressCustomTaskExecution,
  type CustomTaskExecutionEffect,
} from "./task-executor-adapter.js";
import type { CustomTaskNotificationAudience } from "./task-notification-adapter.js";
import type { CustomTaskNotificationSendText } from "./task-notification-gateway-adapter.js";
import {
  CustomTaskCommandExecutor,
  type CustomTaskCommandExecutorCallbacks,
  type CustomTaskCommandExecutorLogger,
} from "./task-command-executor.js";
import {
  CUSTOM_UNREAD_ACTOR_ID,
  type CustomMessageFlowRuntime,
  type ResolvedCustomUnreadConfig,
} from "./runtime.js";
import { resolveCustomUnreadForQueuedGroupMessage } from "./unread-ingress.js";
import {
  CustomUnreadScheduler,
  type CustomUnreadSchedulerOptions,
} from "./unread-scheduler.js";
import type { CustomTaskCommandExecutorConfig } from "./types.js";

export interface CustomRuntimeServicesGatewayLogger {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomRuntimeServicesTaskExecutor {
  notifyAudiences?: CustomTaskNotificationAudience[];
  dispose?: () => void;
}

export interface CustomRuntimeServicesUnreadScheduler {
  restore: CustomUnreadScheduler["restore"];
  apply: CustomUnreadScheduler["apply"];
  dispose?: () => void;
}

export interface CustomRuntimeServicesTaskExecutorFactoryParams {
  config?: CustomTaskCommandExecutorConfig;
  callbacks: CustomTaskCommandExecutorCallbacks;
  log?: CustomTaskCommandExecutorLogger;
}

export interface CreateCustomRuntimeServicesGatewayParams<
  TTaskExecutor extends CustomRuntimeServicesTaskExecutor = CustomTaskCommandExecutor,
  TUnreadScheduler extends CustomRuntimeServicesUnreadScheduler = CustomUnreadScheduler,
> {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: CustomMessageFlowRuntime;
  previousTaskExecutor?: CustomRuntimeServicesTaskExecutor | null;
  enqueueMessage: (message: QueuedMessage) => void | Promise<void>;
  persistTaskState: () => void;
  persistUnreadState: () => void;
  sendTaskStatusText: CustomTaskNotificationSendText;
  log?: CustomRuntimeServicesGatewayLogger;
  taskExecutorFactory?: (params: CustomRuntimeServicesTaskExecutorFactoryParams) => TTaskExecutor;
  unreadSchedulerFactory?: (options: CustomUnreadSchedulerOptions) => TUnreadScheduler;
  applyAsyncTaskStatus?: typeof applyCustomTaskAsyncStatusGateway;
}

export interface CustomRuntimeServicesGatewayResult<
  TTaskExecutor extends CustomRuntimeServicesTaskExecutor = CustomTaskCommandExecutor,
  TUnreadScheduler extends CustomRuntimeServicesUnreadScheduler = CustomUnreadScheduler,
> {
  taskExecutor: TTaskExecutor;
  unreadScheduler: TUnreadScheduler;
  resolveUnreadForEvent: (event: QueuedMessage) => ResolvedCustomUnreadConfig | null;
  resolveUnreadForPeer: (peerId: string) => ResolvedCustomUnreadConfig | null;
}

export function createCustomRuntimeServicesGateway<
  TTaskExecutor extends CustomRuntimeServicesTaskExecutor = CustomTaskCommandExecutor,
  TUnreadScheduler extends CustomRuntimeServicesUnreadScheduler = CustomUnreadScheduler,
>(
  params: CreateCustomRuntimeServicesGatewayParams<TTaskExecutor, TUnreadScheduler>,
): CustomRuntimeServicesGatewayResult<TTaskExecutor, TUnreadScheduler> {
  params.previousTaskExecutor?.dispose?.();

  const applyAsyncTaskStatus = async (effects: CustomTaskExecutionEffect[]): Promise<void> => {
    await (params.applyAsyncTaskStatus ?? applyCustomTaskAsyncStatusGateway)({
      accountId: params.accountId,
      tasks: params.runtime.tasks,
      effects,
      persistTaskState: params.persistTaskState,
      allowUnanchored: true,
      sendText: params.sendTaskStatusText,
      log: params.log,
    });
  };

  let taskExecutor: TTaskExecutor | null = null;
  const currentNotifyAudiences = (): CustomTaskNotificationAudience[] =>
    taskExecutor?.notifyAudiences ?? ["peer"];
  const taskExecutorFactory = params.taskExecutorFactory
    ?? ((factoryParams: CustomRuntimeServicesTaskExecutorFactoryParams) =>
      new CustomTaskCommandExecutor(factoryParams) as unknown as TTaskExecutor);

  taskExecutor = taskExecutorFactory({
    config: resolveCustomRuntimeConfig(params.cfg).tasks?.commandExecutor,
    callbacks: {
      complete: ({ taskId, result, now }) => {
        const applied = completeCustomTaskExecution({
          tasks: params.runtime.tasks,
          taskId,
          result,
          notifyAudiences: currentNotifyAudiences(),
          applyWorkspaceEffects: true,
          now,
        });
        void applyAsyncTaskStatus(applied.effects);
      },
      fail: ({ taskId, error, now }) => {
        const applied = failCustomTaskExecution({
          tasks: params.runtime.tasks,
          taskId,
          error,
          notifyAudiences: currentNotifyAudiences(),
          applyWorkspaceEffects: true,
          now,
        });
        void applyAsyncTaskStatus(applied.effects);
      },
      heartbeat: ({ taskId, now }) => {
        const applied = heartbeatCustomTaskExecution({
          tasks: params.runtime.tasks,
          taskId,
          applyWorkspaceEffects: true,
          now,
        });
        if (applied.changed) params.persistTaskState();
      },
      progress: ({ taskId, phase, message, percent, now }) => {
        const applied = progressCustomTaskExecution({
          tasks: params.runtime.tasks,
          taskId,
          phase,
          message,
          percent,
          applyWorkspaceEffects: true,
          now,
        });
        if (applied.changed) params.persistTaskState();
      },
    },
    log: {
      info: (msg) => params.log?.info?.(`[qqbot:${params.accountId}] ${msg}`),
      error: (msg) => params.log?.error?.(`[qqbot:${params.accountId}] ${msg}`),
    },
  });

  const resolveUnreadForEvent = (event: QueuedMessage): ResolvedCustomUnreadConfig | null => {
    return resolveCustomUnreadForQueuedGroupMessage({
      cfg: params.cfg,
      accountId: params.accountId,
      event,
    });
  };

  const resolveUnreadForPeer = (peerId: string): ResolvedCustomUnreadConfig | null =>
    resolveUnreadForEvent({
      type: "group",
      senderId: CUSTOM_UNREAD_ACTOR_ID,
      senderIsBot: true,
      content: "",
      messageId: `custom-unread-restore-${peerId}`,
      timestamp: new Date().toISOString(),
      groupOpenid: peerId,
    });

  const unreadSchedulerFactory = params.unreadSchedulerFactory
    ?? ((options: CustomUnreadSchedulerOptions) => new CustomUnreadScheduler(options) as unknown as TUnreadScheduler);
  const unreadScheduler = unreadSchedulerFactory({
    accountId: params.accountId,
    unread: params.runtime.unread,
    enqueue: params.enqueueMessage,
    persist: params.persistUnreadState,
    resolveConfigForPeer: resolveUnreadForPeer,
    log: {
      info: (msg) => params.log?.info?.(`[qqbot:${params.accountId}] ${msg}`),
      debug: (msg) => params.log?.debug?.(`[qqbot:${params.accountId}] ${msg}`),
      error: (msg) => params.log?.error?.(`[qqbot:${params.accountId}] ${msg}`),
    },
  });
  unreadScheduler.restore(params.runtime.unread.getState());

  return {
    taskExecutor,
    unreadScheduler,
    resolveUnreadForEvent,
    resolveUnreadForPeer,
  };
}
