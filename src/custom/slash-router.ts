import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { QueueSnapshot } from "../slash-commands.js";
import type { InlineKeyboard } from "../types.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import { handleCustomDeployCommand } from "./deploy-confirmation-gateway-adapter.js";
import { handleCustomFallbackCommand } from "./fallback-gateway-adapter.js";
import { handleCustomGameCommand } from "./game-gateway-adapter.js";
import { handleCustomPollCommand } from "./poll-gateway-adapter.js";
import { handleCustomQueueStatusCommand } from "./queue-status-gateway-adapter.js";
import { handleCustomSceneCommand } from "./scene-gateway-adapter.js";
import { handleCustomTaskCommand } from "./task-gateway-adapter.js";
import { handleCustomUnreadStatusCommand } from "./unread-status-gateway-adapter.js";
import {
  applyCustomTaskExecutionIntents,
  type CustomTaskExecutor,
} from "./task-executor-adapter.js";
import { buildCustomAuthAdminGroupNotification } from "./auth-gateway-adapter.js";
import { toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import {
  deliveriesFromCustomTaskNotifications,
  type CustomTaskNotificationDelivery,
} from "./task-notification-gateway-adapter.js";
import type { CustomSceneConfig } from "./types.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import { resolveTaskSandboxConfig } from "./task-sandbox.js";

export type CustomSlashGatewayReply =
  | { kind: "text"; text: string }
  | { kind: "keyboard"; text: string; keyboard: InlineKeyboard }
  | {
      kind: "auth-approval";
      denialText: string;
      approvalText?: string;
      keyboard?: InlineKeyboard;
      adminGroupNotification?: ReturnType<typeof buildCustomAuthAdminGroupNotification>;
    };

export interface CustomSlashGatewayPersist {
  auth?: boolean;
  config?: { sceneKey: string; sceneConfig: CustomSceneConfig };
  tasks?: boolean;
  polls?: boolean;
  games?: boolean;
  deployConfirmations?: boolean;
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

export interface CustomSlashRouterContext {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: CustomMessageFlowRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
  queueStatus?: {
    peerId: string;
    snapshot: QueueSnapshot;
  };
  applyTaskWorkspaceEffects?: boolean;
  taskExecutor?: CustomTaskExecutor;
}

export interface CustomSlashRoute {
  name: string;
  handle: (ctx: CustomSlashRouterContext) => CustomSlashGatewayResult;
}

const DEFAULT_CUSTOM_SLASH_ROUTES: readonly CustomSlashRoute[] = [
  { name: "scene", handle: routeCustomSceneCommand },
  { name: "fallback", handle: routeCustomFallbackCommand },
  { name: "queue", handle: routeCustomQueueStatusCommand },
  { name: "unread", handle: routeCustomUnreadStatusCommand },
  { name: "task", handle: routeCustomTaskCommand },
  { name: "poll", handle: routeCustomPollCommand },
  { name: "game", handle: routeCustomGameCommand },
  { name: "deploy", handle: routeCustomDeployCommand },
];

export function getDefaultCustomSlashRoutes(): readonly CustomSlashRoute[] {
  return DEFAULT_CUSTOM_SLASH_ROUTES;
}

export function routeCustomSlashCommand(
  params: CustomSlashRouterContext & { routes?: readonly CustomSlashRoute[] },
): CustomSlashGatewayResult {
  for (const route of params.routes ?? DEFAULT_CUSTOM_SLASH_ROUTES) {
    const result = route.handle(params);
    if (result.handled) return result;
  }
  return { handled: false };
}

function routeCustomSceneCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomSceneCommand({
    cfg: ctx.cfg,
    message: ctx.message,
    rawContent: ctx.rawContent,
  });
  if (!command.handled) return { handled: false };

  const persist: CustomSlashGatewayPersist = {};
  const logs: CustomSlashGatewayLog[] = [];
  if (command.changed && command.sceneKey && command.sceneConfig) {
    persist.config = {
      sceneKey: command.sceneKey,
      sceneConfig: command.sceneConfig,
    };
    logs.push({
      level: "info",
      message: `custom scene updated: key=${command.sceneKey} scene=${command.sceneConfig?.scene}`,
    });
  }
  return handled({
    reply: command.reply ? replyFromTextAndKeyboard(command.reply, command.keyboard) : undefined,
    persist,
    logs,
  });
}

function routeCustomFallbackCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomFallbackCommand({
    accountId: ctx.accountId,
    message: ctx.message,
    rawContent: ctx.rawContent,
  });
  if (!command.handled) return { handled: false };
  return handled({
    reply: command.reply ? { kind: "text", text: command.reply } : undefined,
  });
}

function routeCustomQueueStatusCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomQueueStatusCommand({
    rawContent: ctx.rawContent,
    peerId: ctx.queueStatus?.peerId ?? "unknown",
    snapshot: ctx.queueStatus?.snapshot,
  });
  if (!command.handled) return { handled: false };
  return handled({
    reply: command.reply ? { kind: "text", text: command.reply } : undefined,
  });
}

function routeCustomUnreadStatusCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomUnreadStatusCommand({
    unread: ctx.runtime.unread,
    rawContent: ctx.rawContent,
  });
  if (!command.handled) return { handled: false };
  return handled({
    reply: command.reply ? { kind: "text", text: command.reply } : undefined,
  });
}

function routeCustomTaskCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomTaskCommand({
    accountId: ctx.accountId,
    tasks: ctx.runtime.tasks,
    message: ctx.message,
    rawContent: ctx.rawContent,
    taskConfig: resolveTaskSandboxConfig(
      resolveCustomRuntimeConfig(ctx.cfg).tasks,
      resolveCustomSceneConfig(ctx.cfg, toCustomPeerFromQueuedMessage(ctx.message)).tasks,
    ),
    now: ctx.now,
  });
  if (!command.handled) return { handled: false };

  const persist: CustomSlashGatewayPersist = {};
  const logs: CustomSlashGatewayLog[] = [];
  const taskNotificationDeliveries: CustomTaskNotificationDelivery[] = [];
  if (command.changed) {
    persist.tasks = true;
    const execution = applyCustomTaskExecutionIntents({
      tasks: ctx.runtime.tasks,
      intents: command.intents,
      executor: ctx.taskExecutor,
      applyWorkspaceEffects: ctx.applyTaskWorkspaceEffects !== false,
      notifyAudiences: command.change === "cancelled" ? ["peer"] : undefined,
      now: ctx.now,
    });
    if (execution.changed) {
      persist.tasks = true;
    }
    for (const effect of execution.effects) {
      logs.push({
        level: effect.kind === "error" ? "error" : "info",
        message: `custom task execution: kind=${effect.kind}${effect.taskId ? ` task=${effect.taskId}` : ""}${effect.runId ? ` run=${effect.runId}` : ""}${effect.message ? ` message=${effect.message}` : ""}`,
      });
      if (effect.kind === "notify" && effect.notification && command.task) {
        taskNotificationDeliveries.push(...deliveriesFromCustomTaskNotifications({
          task: command.task,
          notifications: [effect.notification],
          passiveMessageId: ctx.message.messageId,
        }));
      }
    }
  }
  return handled({
    reply: command.reply ? replyFromTextAndKeyboard(command.reply, command.keyboard) : undefined,
    persist,
    taskNotificationDeliveries,
    logs,
  });
}

function routeCustomPollCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomPollCommand({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    polls: ctx.runtime.polls,
    message: ctx.message,
    rawContent: ctx.rawContent,
    now: ctx.now,
  });
  if (!command.handled) return { handled: false };
  return handled({
    reply: command.reply ? replyFromTextAndKeyboard(command.reply, command.keyboard) : undefined,
    persist: command.changed ? { polls: true } : undefined,
  });
}

function routeCustomGameCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomGameCommand({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    games: ctx.runtime.games,
    message: ctx.message,
    rawContent: ctx.rawContent,
    now: ctx.now,
  });
  if (!command.handled) return { handled: false };
  return handled({
    reply: command.reply ? replyFromTextAndKeyboard(command.reply, command.keyboard) : undefined,
    persist: command.changed ? { games: true } : undefined,
  });
}

function routeCustomDeployCommand(ctx: CustomSlashRouterContext): CustomSlashGatewayResult {
  const command = handleCustomDeployCommand({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    confirmations: ctx.runtime.deployConfirmations,
    message: ctx.message,
    rawContent: ctx.rawContent,
    now: ctx.now,
  });
  if (!command.handled) return { handled: false };
  return handled({
    reply: command.reply ? replyFromTextAndKeyboard(command.reply, command.keyboard) : undefined,
    persist: command.changed ? { deployConfirmations: true } : undefined,
  });
}

export function buildCustomSlashHandledResult(params: {
  reply?: CustomSlashGatewayReply;
  persist?: CustomSlashGatewayPersist;
  taskNotificationDeliveries?: CustomTaskNotificationDelivery[];
  logs?: CustomSlashGatewayLog[];
}): CustomSlashGatewayResult {
  return handled(params);
}

function replyFromTextAndKeyboard(text: string, keyboard?: InlineKeyboard): CustomSlashGatewayReply {
  return keyboard ? { kind: "keyboard", text, keyboard } : { kind: "text", text };
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

export function hasCustomSlashPersist(persist?: CustomSlashGatewayPersist): boolean {
  return hasPersist(persist);
}

function hasPersist(persist?: CustomSlashGatewayPersist): boolean {
  return Boolean(persist?.auth || persist?.config || persist?.tasks || persist?.polls || persist?.games || persist?.deployConfirmations);
}
