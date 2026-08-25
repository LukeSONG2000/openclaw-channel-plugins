import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import {
  parseCustomAuthButtonData,
  parseCustomAuthCommand,
  type CustomAuthCommand,
} from "./auth-command-parser.js";
import {
  isCustomRuntimeAdmin,
  type CustomAuthorizationRuntime,
} from "./auth.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { slashCommandInput } from "./command-link.js";
import {
  formatApprovalResolution,
  formatCustomAuthGrants,
  formatCustomAuthHelp,
  formatCustomAuthRequests,
  formatCustomAuthStatus,
} from "./auth-presentation.js";
import { formatCustomActorIdentity } from "./identity-presentation.js";
import { toCustomActorFromQueuedMessage } from "./queued-message-context.js";
import type {
  CustomActor,
  CustomAuthorizationIntent,
} from "./types.js";

export {
  buildCustomAuthAdminGroupNotification,
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthApprovalText,
  describeCustomAuthorizationIntents,
  firstCustomAuthApprovalRequest,
  type CustomAuthAdminGroupNotification,
} from "./auth-presentation.js";

export {
  parseCustomAuthButtonData,
  parseCustomAuthCommand,
  type CustomAuthButtonDecision,
  type CustomAuthButtonPayload,
  type CustomAuthCommand,
  type CustomAuthCommandParseResult,
} from "./auth-command-parser.js";

export interface CustomAuthCommandResult {
  handled: boolean;
  reply?: string;
  intent?: CustomAuthorizationIntent;
  config?: {
    authCopyRequestsToAdminGroup: boolean;
  };
}

export interface CustomAuthInteractionResult {
  handled: boolean;
  reply?: string;
  intent?: CustomAuthorizationIntent;
}

export function handleCustomAuthCommand(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomAuthCommandResult {
  const parsed = parseCustomAuthCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return {
      handled: true,
      reply: [
        `ℹ️ customRuntime 未启用`,
        ``,
        `请先开启 channels.qqbot.customRuntime.enabled 后再使用 ${slashCommandInput("/bot-auth")}。`,
      ].join("\n"),
    };
  }

  const actor = toCustomActorFromQueuedMessage(params.message);
  if (!isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      reply: [
        `⛔ 只有 customRuntime.admins 中的管理员可以处理授权申请。`,
        ``,
        `当前用户：${formatCustomActorIdentity(actor, { idLabel: params.message.type === "group" ? "member_openid" : "user_openid" })}`,
      ].join("\n"),
    };
  }

  if (parsed.error) {
    return { handled: true, reply: formatCustomAuthHelp(parsed.error) };
  }

  const command = parsed.command ?? { kind: "help" as const };
  if (command.kind === "help") {
    return { handled: true, reply: formatCustomAuthHelp() };
  }

  if (command.kind === "status") {
    return { handled: true, reply: formatCustomAuthStatus(params.auth, runtime, params.now, params.cfg) };
  }

  if (command.kind === "admin-copy") {
    const current = runtime.auth?.copyRequestsToAdminGroup !== false;
    if (typeof command.enabled !== "boolean") {
      return {
        handled: true,
        reply: [
          `🔐 授权抄送设置`,
          ``,
          `当前：${current ? "开启" : "关闭"}`,
          `说明：开启时，其他群/私聊产生的授权卡片会额外抄送管理群；关闭时只在申请人所在会话发卡。`,
          ``,
          `切换：${slashCommandInput("/bot-auth admin-copy on")} 或 ${slashCommandInput("/bot-auth admin-copy off")}`,
        ].join("\n"),
      };
    }
    return {
      handled: true,
      config: { authCopyRequestsToAdminGroup: command.enabled },
      reply: [
        `✅ 授权抄送已${command.enabled ? "开启" : "关闭"}`,
        ``,
        command.enabled
          ? `其他群/私聊产生的授权卡片会额外抄送到管理群。`
          : `授权卡片只会发送在申请人所在会话，不再抄送管理群。`,
      ].join("\n"),
    };
  }

  if (command.kind === "requests") {
    return { handled: true, reply: formatCustomAuthRequests(params.auth, command.limit, params.now, params.cfg) };
  }

  if (command.kind === "grants") {
    return { handled: true, reply: formatCustomAuthGrants(params.auth, command.limit, params.now, params.cfg) };
  }

  return resolveCustomAuthRequest({
    auth: params.auth,
    actor,
    command,
    now: params.now,
    cfg: params.cfg,
  });
}

export function handleCustomAuthInteraction(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  buttonData: string;
  actorId: string;
  actorLabel?: string;
  sourcePeer?: { kind: string };
  now?: number;
}): CustomAuthInteractionResult {
  const payload = parseCustomAuthButtonData(params.buttonData);
  if (!payload) return { handled: false };

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return { handled: true, reply: `ℹ️ customRuntime 未启用，无法处理授权按钮。` };
  }

  const actor: CustomActor = { id: params.actorId, label: params.actorLabel };
  if (!isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      reply: [
        `⛔ 只有 customRuntime.admins 中的管理员可以处理授权按钮。`,
        ``,
        `当前用户：${formatCustomActorIdentity(actor, { idLabel: params.sourcePeer?.kind === "group" ? "member_openid" : "user_openid" })}`,
      ].join("\n"),
    };
  }

  if (payload.decision === "allow-task") {
    const state = params.auth.getState();
    const requestId = findPendingRequestId(Object.keys(state.requests), payload.requestId);
    if (requestId && !state.requests[requestId]?.taskId) {
      return {
        handled: true,
        reply: `⚠️ 授权申请不是任务级申请，不能按任务授权：${requestId}`,
      };
    }
  }

  const command: CustomAuthCommand = payload.decision === "deny"
    ? { kind: "resolve", requestId: payload.requestId, approved: false }
    : payload.decision === "allow-task"
      ? { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "task" }
    : payload.decision === "allow-count"
      ? { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "count", grantCount: 3 }
      : payload.decision === "allow-timed"
        ? { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "timed", grantTtlMs: 10 * 60_000 }
        : { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "once" };

  return resolveCustomAuthRequest({
    auth: params.auth,
    actor,
    command,
    now: params.now,
    cfg: params.cfg,
  });
}

function resolveCustomAuthRequest(params: {
  auth: CustomAuthorizationRuntime;
  actor: CustomActor;
  command: Extract<CustomAuthCommand, { kind: "resolve" }>;
  now?: number;
  cfg?: OpenClawConfig;
}): CustomAuthCommandResult {
  const state = params.auth.getState();
  const requestId = findPendingRequestId(Object.keys(state.requests), params.command.requestId);
  if (!requestId) {
    return {
      handled: true,
      reply: `⚠️ 未找到待处理授权申请：${params.command.requestId}`,
    };
  }

  const intent = params.auth.resolveApproval({
    requestId,
    approved: params.command.approved,
    resolvedBy: params.actor.id,
    now: params.now,
    grantUse: params.command.grantUse ?? (state.requests[requestId]?.taskId ? "task" : undefined),
    grantCount: params.command.grantCount,
    grantTtlMs: params.command.grantTtlMs,
  });
  if (!intent || intent.kind !== "approval-resolved") {
    return {
      handled: true,
      reply: `⚠️ 授权申请已不存在或不再处于待审批状态：${requestId}`,
    };
  }

  return {
    handled: true,
    intent,
    reply: formatApprovalResolution(intent, params.cfg),
  };
}

function findPendingRequestId(requestIds: string[], input: string): string | null {
  if (requestIds.includes(input)) return input;
  const matches = requestIds.filter((id) => id.startsWith(input) || id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}
