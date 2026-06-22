import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { QueueSnapshot } from "../slash-commands.js";
import {
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthAdminGroupNotification,
  buildCustomAuthApprovalText,
  checkCustomSlashAuthorization,
  describeCustomAuthorizationIntents,
  firstCustomAuthApprovalRequest,
  formatCustomAuthorizationDeniedMessage,
  handleCustomAuthCommand,
} from "./auth-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import { checkCustomTaskCommandAuthorization } from "./task-auth-gateway-adapter.js";
import {
  buildCustomSlashHandledResult,
  routeCustomSlashCommand,
  type CustomSlashGatewayLog,
  type CustomSlashGatewayPersist,
  type CustomSlashGatewayReply,
  type CustomSlashGatewayResult,
} from "./slash-router.js";
import type { CustomTaskExecutor } from "./task-executor-adapter.js";

export type {
  CustomSlashGatewayReply,
  CustomSlashGatewayPersist,
  CustomSlashGatewayLog,
  CustomSlashGatewayResult,
};

export function handleCustomSlashGatewayCommand(params: {
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
}): CustomSlashGatewayResult {
  const logs: CustomSlashGatewayLog[] = [];
  const persist: CustomSlashGatewayPersist = {};

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

  const taskAuthorization = checkCustomTaskCommandAuthorization({
    cfg: params.cfg,
    accountId: params.accountId,
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
      if (taskAuthorization.reason === "task_out_of_scope") {
        logs.push({
          level: "info",
          message: `Custom task command out of scope: task=${taskAuthorization.taskId} sender=${params.message.senderId} content=${params.rawContent.slice(0, 80)}`,
        });
        return handled({
          reply: taskAuthorization.blockedReply ? { kind: "text", text: taskAuthorization.blockedReply } : undefined,
          persist,
          logs,
        });
      }
      logs.push({
        level: "info",
        message: `Custom task command denied by task auth: task=${taskAuthorization.taskId} sender=${params.message.senderId} content=${params.rawContent.slice(0, 80)}`,
      });
      const request = taskAuthorization.result?.intents
        ? firstCustomAuthApprovalRequest(taskAuthorization.result.intents)
        : null;
      const approvalText = request ? buildCustomAuthApprovalText(request, params.cfg) : undefined;
      const keyboard = request ? buildCustomAuthApprovalKeyboard(request) : undefined;
      return handled({
        reply: {
          kind: "auth-approval",
          denialText: formatCustomAuthorizationDeniedMessage({
            enabled: true,
            allowed: false,
            cfg: params.cfg,
            capability: "codex.longTask",
            peer: taskAuthorization.peer,
            actor: taskAuthorization.actor,
            result: taskAuthorization.result,
            reason: "denied",
          }),
          ...(approvalText && keyboard && (params.message.type === "c2c" || params.message.type === "group")
            ? {
                approvalText,
                keyboard,
              }
            : {}),
          ...(request && approvalText
            ? {
                adminGroupNotification: buildCustomAuthAdminGroupNotification({
                  request,
                  sourcePeer: taskAuthorization.peer,
                  text: approvalText,
                  keyboard,
                }),
              }
            : {}),
        },
        persist,
        logs,
      });
    }
  }

  if (!taskAuthorization.handled) {
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
      const approvalText = request ? buildCustomAuthApprovalText(request, params.cfg) : undefined;
      const keyboard = request ? buildCustomAuthApprovalKeyboard(request) : undefined;
      return handled({
        reply: {
          kind: "auth-approval",
          denialText: formatCustomAuthorizationDeniedMessage(authDecision),
          ...(approvalText && keyboard && (params.message.type === "c2c" || params.message.type === "group")
            ? {
                approvalText,
                keyboard,
              }
            : {}),
          ...(request && approvalText
            ? {
                adminGroupNotification: buildCustomAuthAdminGroupNotification({
                  request,
                  sourcePeer: authDecision.peer,
                  text: approvalText,
                  keyboard,
                }),
              }
            : {}),
        },
        persist,
        logs,
      });
    }
  }

  const routed = routeCustomSlashCommand({
    cfg: params.cfg,
    accountId: params.accountId,
    runtime: params.runtime,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
    queueStatus: params.queueStatus,
    applyTaskWorkspaceEffects: params.applyTaskWorkspaceEffects,
    taskExecutor: params.taskExecutor,
  });
  if (routed.handled) {
    return mergeHandledResult({ routed, persist, logs });
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
  logs?: CustomSlashGatewayLog[];
}): CustomSlashGatewayResult {
  return buildCustomSlashHandledResult(params);
}

function mergeHandledResult(params: {
  routed: Extract<CustomSlashGatewayResult, { handled: true }>;
  persist: CustomSlashGatewayPersist;
  logs: CustomSlashGatewayLog[];
}): CustomSlashGatewayResult {
  return buildCustomSlashHandledResult({
    reply: params.routed.reply,
    persist: {
      ...params.routed.persist,
      ...params.persist,
    },
    taskNotificationDeliveries: params.routed.taskNotificationDeliveries,
    logs: [
      ...(params.logs.length ? params.logs : []),
      ...(params.routed.logs ?? []),
    ],
  });
}
