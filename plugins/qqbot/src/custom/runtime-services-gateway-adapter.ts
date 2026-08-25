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
import {
  CustomScheduledTaskScheduler,
  type CustomScheduledTaskSchedulerOptions,
  type CustomScheduledTaskSendText,
} from "./scheduled-task-scheduler.js";
import {
  CustomPollExpirationScheduler,
  type CustomPollExpirationSchedulerOptions,
  type CustomPollResultSendText,
} from "./poll-expiration-scheduler.js";
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

export interface CustomRuntimeServicesPollExpirationScheduler {
  tick: CustomPollExpirationScheduler["tick"];
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
  TPollExpirationScheduler extends CustomRuntimeServicesPollExpirationScheduler = CustomPollExpirationScheduler,
  TScheduledTaskScheduler extends { tick: () => Promise<void>; dispose?: () => void } = CustomScheduledTaskScheduler,
> {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: CustomMessageFlowRuntime;
  previousTaskExecutor?: CustomRuntimeServicesTaskExecutor | null;
  enqueueMessage: (message: QueuedMessage) => void | Promise<void>;
  persistTaskState: () => void;
  persistPollState: () => void;
  persistUnreadState: () => void;
  persistScheduledTaskState: () => void;
  sendTaskStatusText: CustomTaskNotificationSendText;
  sendPollResultText?: CustomPollResultSendText;
  sendScheduledTaskText?: CustomScheduledTaskSendText;
  log?: CustomRuntimeServicesGatewayLogger;
  taskExecutorFactory?: (params: CustomRuntimeServicesTaskExecutorFactoryParams) => TTaskExecutor;
  unreadSchedulerFactory?: (options: CustomUnreadSchedulerOptions) => TUnreadScheduler;
  pollExpirationSchedulerFactory?: (options: CustomPollExpirationSchedulerOptions) => TPollExpirationScheduler;
  scheduledTaskSchedulerFactory?: (options: CustomScheduledTaskSchedulerOptions) => TScheduledTaskScheduler;
  applyAsyncTaskStatus?: typeof applyCustomTaskAsyncStatusGateway;
}

export interface CustomRuntimeServicesGatewayResult<
  TTaskExecutor extends CustomRuntimeServicesTaskExecutor = CustomTaskCommandExecutor,
  TUnreadScheduler extends CustomRuntimeServicesUnreadScheduler = CustomUnreadScheduler,
  TPollExpirationScheduler extends CustomRuntimeServicesPollExpirationScheduler = CustomPollExpirationScheduler,
  TScheduledTaskScheduler extends { tick: () => Promise<void>; dispose?: () => void } = CustomScheduledTaskScheduler,
> {
  taskExecutor: TTaskExecutor;
  unreadScheduler: TUnreadScheduler;
  pollExpirationScheduler?: TPollExpirationScheduler;
  scheduledTaskScheduler?: TScheduledTaskScheduler;
  resolveUnreadForEvent: (event: QueuedMessage) => ResolvedCustomUnreadConfig | null;
  resolveUnreadForPeer: (peerId: string) => ResolvedCustomUnreadConfig | null;
}

export function createCustomRuntimeServicesGateway<
  TTaskExecutor extends CustomRuntimeServicesTaskExecutor = CustomTaskCommandExecutor,
  TUnreadScheduler extends CustomRuntimeServicesUnreadScheduler = CustomUnreadScheduler,
  TPollExpirationScheduler extends CustomRuntimeServicesPollExpirationScheduler = CustomPollExpirationScheduler,
  TScheduledTaskScheduler extends { tick: () => Promise<void>; dispose?: () => void } = CustomScheduledTaskScheduler,
>(
  params: CreateCustomRuntimeServicesGatewayParams<TTaskExecutor, TUnreadScheduler, TPollExpirationScheduler, TScheduledTaskScheduler>,
): CustomRuntimeServicesGatewayResult<TTaskExecutor, TUnreadScheduler, TPollExpirationScheduler, TScheduledTaskScheduler> {
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

  const pollExpirationSchedulerFactory = params.pollExpirationSchedulerFactory
    ?? ((options: CustomPollExpirationSchedulerOptions) => new CustomPollExpirationScheduler(options) as unknown as TPollExpirationScheduler);
  const pollExpirationScheduler = params.sendPollResultText
    ? pollExpirationSchedulerFactory({
        accountId: params.accountId,
        polls: params.runtime.polls,
        sendText: params.sendPollResultText,
        persist: params.persistPollState,
        log: {
          info: (msg) => params.log?.info?.(`[qqbot:${params.accountId}] ${msg}`),
          debug: (msg) => params.log?.debug?.(`[qqbot:${params.accountId}] ${msg}`),
          error: (msg) => params.log?.error?.(`[qqbot:${params.accountId}] ${msg}`),
        },
      })
    : undefined;



  const scheduledTaskSchedulerFactory = params.scheduledTaskSchedulerFactory
    ?? ((options: CustomScheduledTaskSchedulerOptions) => new CustomScheduledTaskScheduler(options) as unknown as TScheduledTaskScheduler);
  const scheduledTaskScheduler = (params.sendScheduledTaskText ?? params.sendTaskStatusText)
    ? scheduledTaskSchedulerFactory({
        accountId: params.accountId,
        scheduledTasks: params.runtime.scheduledTasks,
        auth: params.runtime.auth,
        getConfig: () => params.cfg,
        sendText: (params.sendScheduledTaskText ?? params.sendTaskStatusText) as CustomScheduledTaskSendText,
        enqueue: params.enqueueMessage,
        persist: params.persistScheduledTaskState,
        log: {
          info: (msg) => params.log?.info?.(`[qqbot:${params.accountId}] ${msg}`),
          debug: (msg) => params.log?.debug?.(`[qqbot:${params.accountId}] ${msg}`),
          error: (msg) => params.log?.error?.(`[qqbot:${params.accountId}] ${msg}`),
        },
      })
    : undefined;

  return {
    taskExecutor,
    unreadScheduler,
    pollExpirationScheduler,
    scheduledTaskScheduler,
    resolveUnreadForEvent,
    resolveUnreadForPeer,
  };
}
