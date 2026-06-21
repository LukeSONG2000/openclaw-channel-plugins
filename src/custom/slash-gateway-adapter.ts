import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard } from "../types.js";
import {
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthApprovalText,
  checkCustomSlashAuthorization,
  describeCustomAuthorizationIntents,
  firstCustomAuthApprovalRequest,
  formatCustomAuthorizationDeniedMessage,
  handleCustomAuthCommand,
} from "./auth-gateway-adapter.js";
import { handleCustomPollCommand } from "./poll-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import { handleCustomSceneCommand } from "./scene-gateway-adapter.js";
import { checkCustomTaskCommandAuthorization } from "./task-auth-gateway-adapter.js";
import { handleCustomTaskCommand } from "./task-gateway-adapter.js";
import {
  applyCustomTaskExecutionIntents,
  type CustomTaskExecutor,
} from "./task-executor-adapter.js";
import {
  deliveriesFromCustomTaskNotifications,
  type CustomTaskNotificationDelivery,
} from "./task-notification-gateway-adapter.js";
import type { CustomSceneConfig } from "./types.js";

export type CustomSlashGatewayReply =
  | { kind: "text"; text: string }
  | { kind: "keyboard"; text: string; keyboard: InlineKeyboard }
  | { kind: "auth-approval"; denialText: string; approvalText?: string; keyboard?: InlineKeyboard };

export interface CustomSlashGatewayPersist {
  auth?: boolean;
  config?: { sceneKey: string; sceneConfig: CustomSceneConfig };
  tasks?: boolean;
  polls?: boolean;
}

export interface CustomSlashGatewayLog {
  level: "info" | "error";
  message: string;
}

export type CustomSlashGatewayResult =
  | { handled: false }
  | {
      handled: true;
      reply?: CustomSlashGatewayReply;
      persist?: CustomSlashGatewayPersist;
      taskNotificationDeliveries?: CustomTaskNotificationDelivery[];
      logs?: CustomSlashGatewayLog[];
    };

export function handleCustomSlashGatewayCommand(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: CustomMessageFlowRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
  applyTaskWorkspaceEffects?: boolean;
  taskExecutor?: CustomTaskExecutor;
}): CustomSlashGatewayResult {
  const logs: CustomSlashGatewayLog[] = [];
  const persist: CustomSlashGatewayPersist = {};
  const taskNotificationDeliveries: CustomTaskNotificationDelivery[] = [];
  const applyTaskWorkspaceEffects = params.applyTaskWorkspaceEffects !== false;

  const customAuthCommand = handleCustomAuthCommand({
    cfg: params.cfg,
    auth: params.runtime.auth,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
  });
  if (customAuthCommand.handled) {
    if (customAuthCommand.intent) {
      logs.push(...logAuthIntents([customAuthCommand.intent]));
      persist.auth = true;
    }
    return handled({
      reply: customAuthCommand.reply ? { kind: "text", text: customAuthCommand.reply } : undefined,
      persist,
      logs,
    });
  }

  const authDecision = checkCustomSlashAuthorization({
    cfg: params.cfg,
    auth: params.runtime.auth,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
  });
  if (authDecision.enabled && authDecision.result?.intents.length) {
    logs.push(...logAuthIntents(authDecision.result.intents));
    persist.auth = true;
  }
  if (authDecision.enabled && authDecision.reason === "denied") {
    logs.push({
      level: "info",
      message: `Slash command denied by custom auth: capability=${authDecision.capability} sender=${params.message.senderId} content=${params.rawContent.slice(0, 80)}`,
    });
    const request = authDecision.result?.intents
      ? firstCustomAuthApprovalRequest(authDecision.result.intents)
      : null;
    return handled({
      reply: {
        kind: "auth-approval",
        denialText: formatCustomAuthorizationDeniedMessage(authDecision),
        ...(request && (params.message.type === "c2c" || params.message.type === "group")
          ? {
              approvalText: buildCustomAuthApprovalText(request),
              keyboard: buildCustomAuthApprovalKeyboard(request),
            }
          : {}),
      },
      persist,
      logs,
    });
  }

  const customSceneCommand = handleCustomSceneCommand({
    cfg: params.cfg,
    message: params.message,
    rawContent: params.rawContent,
  });
  if (customSceneCommand.handled) {
    if (customSceneCommand.changed && customSceneCommand.sceneKey && customSceneCommand.sceneConfig) {
      persist.config = {
        sceneKey: customSceneCommand.sceneKey,
        sceneConfig: customSceneCommand.sceneConfig,
      };
      logs.push({
        level: "info",
        message: `custom scene updated: key=${customSceneCommand.sceneKey} scene=${customSceneCommand.sceneConfig?.scene}`,
      });
    }
    return handled({
      reply: customSceneCommand.reply ? { kind: "text", text: customSceneCommand.reply } : undefined,
      persist,
      logs,
    });
  }

  const taskAuthorization = checkCustomTaskCommandAuthorization({
    cfg: params.cfg,
    auth: params.runtime.auth,
    tasks: params.runtime.tasks,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
  });
  if (taskAuthorization.handled) {
    if (taskAuthorization.result?.intents.length) {
      logs.push(...logAuthIntents(taskAuthorization.result.intents));
      persist.auth = true;
    }
    if (!taskAuthorization.allowed) {
      logs.push({
        level: "info",
        message: `Custom task command denied by task auth: task=${taskAuthorization.taskId} sender=${params.message.senderId} content=${params.rawContent.slice(0, 80)}`,
      });
      const request = taskAuthorization.result?.intents
        ? firstCustomAuthApprovalRequest(taskAuthorization.result.intents)
        : null;
      return handled({
        reply: {
          kind: "auth-approval",
          denialText: formatCustomAuthorizationDeniedMessage({
            enabled: true,
            allowed: false,
            capability: "codex.longTask",
            peer: taskAuthorization.peer,
            actor: taskAuthorization.actor,
            result: taskAuthorization.result,
            reason: "denied",
          }),
          ...(request && (params.message.type === "c2c" || params.message.type === "group")
            ? {
                approvalText: buildCustomAuthApprovalText(request),
                keyboard: buildCustomAuthApprovalKeyboard(request),
              }
            : {}),
        },
        persist,
        logs,
      });
    }
  }

  const customTaskCommand = handleCustomTaskCommand({
    accountId: params.accountId,
    tasks: params.runtime.tasks,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
  });
  if (customTaskCommand.handled) {
    if (customTaskCommand.changed) {
      persist.tasks = true;
      const execution = applyCustomTaskExecutionIntents({
        tasks: params.runtime.tasks,
        intents: customTaskCommand.intents,
        executor: params.taskExecutor,
        applyWorkspaceEffects: applyTaskWorkspaceEffects,
        notifyAudiences: customTaskCommand.change === "cancelled" ? ["peer"] : undefined,
        now: params.now,
      });
      if (execution.changed) {
        persist.tasks = true;
      }
      for (const effect of execution.effects) {
        logs.push({
          level: effect.kind === "error" ? "error" : "info",
          message: `custom task execution: kind=${effect.kind}${effect.taskId ? ` task=${effect.taskId}` : ""}${effect.runId ? ` run=${effect.runId}` : ""}${effect.message ? ` message=${effect.message}` : ""}`,
        });
        if (effect.kind === "notify" && effect.notification && customTaskCommand.task) {
          taskNotificationDeliveries.push(...deliveriesFromCustomTaskNotifications({
            task: customTaskCommand.task,
            notifications: [effect.notification],
            passiveMessageId: params.message.messageId,
          }));
        }
      }
    }
    return handled({
      reply: customTaskCommand.reply ? { kind: "text", text: customTaskCommand.reply } : undefined,
      persist,
      taskNotificationDeliveries,
      logs,
    });
  }

  const customPollCommand = handleCustomPollCommand({
    cfg: params.cfg,
    accountId: params.accountId,
    polls: params.runtime.polls,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
  });
  if (customPollCommand.handled) {
    if (customPollCommand.changed) {
      persist.polls = true;
    }
    return handled({
      reply: customPollCommand.reply
        ? customPollCommand.keyboard
          ? { kind: "keyboard", text: customPollCommand.reply, keyboard: customPollCommand.keyboard }
          : { kind: "text", text: customPollCommand.reply }
        : undefined,
      persist,
      logs,
    });
  }

  return { handled: false };
}

function logAuthIntents(intents: Parameters<typeof describeCustomAuthorizationIntents>[0]): CustomSlashGatewayLog[] {
  return describeCustomAuthorizationIntents(intents).map((message) => ({
    level: "info" as const,
    message: `custom auth: ${message}`,
  }));
}

function handled(params: {
  reply?: CustomSlashGatewayReply;
  persist?: CustomSlashGatewayPersist;
  taskNotificationDeliveries?: CustomTaskNotificationDelivery[];
  logs?: CustomSlashGatewayLog[];
}): CustomSlashGatewayResult {
  return {
    handled: true,
    ...(params.reply ? { reply: params.reply } : {}),
    ...(hasPersist(params.persist) ? { persist: params.persist } : {}),
    ...(params.taskNotificationDeliveries?.length ? { taskNotificationDeliveries: params.taskNotificationDeliveries } : {}),
    ...(params.logs?.length ? { logs: params.logs } : {}),
  };
}

function hasPersist(persist?: CustomSlashGatewayPersist): boolean {
  return Boolean(persist?.auth || persist?.config || persist?.tasks || persist?.polls);
}
