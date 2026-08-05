import type { HistoryEntry } from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";
import type { SendWithRetryFn } from "../outbound-deliver.js";
import { runWithRequestContext as defaultRunWithRequestContext } from "../request-context.js";
import type { QueueSnapshot } from "../slash-commands.js";
import type { ResolvedQQBotAccount } from "../types.js";
import type { InlineKeyboard } from "../types.js";
import type { CustomDispatchAuthorizationDecision } from "./auth-gateway-adapter.js";
import { applyCustomDispatchAuthorizationGateway } from "./dispatch-authorization-gateway-adapter.js";
import type { CustomDispatchAuthApprovalCardTarget } from "./dispatch-auth-delivery-gateway-adapter.js";
import { createCustomDispatchFallbackSession } from "./dispatch-fallback-session-gateway-adapter.js";
import type { CustomDispatchReplyDispatcher } from "./dispatch-reply-gateway-adapter.js";
import { runCustomDispatchReplyGateway } from "./dispatch-reply-gateway-adapter.js";
import {
  applyCustomDispatchSetupGateway,
  type ApplyCustomDispatchSetupGatewayParams,
} from "./dispatch-setup-gateway-adapter.js";
import type { CustomAuthAdminGroupNotification } from "./auth-gateway-adapter.js";
import type { CustomAuthorizationRuntime } from "./auth.js";
import type { CustomFallbackAlertDelivery } from "./fallback-record-gateway-adapter.js";
import type { CustomRuntimeConfig } from "./types.js";
import { applyCustomUnreadCompletionGateway } from "./unread-completion-gateway-adapter.js";
import type { CustomUnreadGatewayEffect } from "./unread-gateway-adapter.js";
import type { ResolvedCustomUnreadConfig } from "./unread-runtime.js";
import type { CustomUnreadRuntime } from "./unread-runtime.js";

export interface CustomMessageDispatchGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface RunCustomMessageDispatchGatewayParams {
  account: ResolvedQQBotAccount;
  event: QueuedMessage;
  cfg: unknown;
  route: {
    agentId: string;
    sessionKey: string;
  };
  qualifiedTarget: string;
  ctxPayload: unknown;
  userContent: string;
  wasMentioned: boolean;
  shouldCatchUpUnreadAfterReply: boolean;
  customUnreadCfgForEvent: ResolvedCustomUnreadConfig | null;
  runtime: {
    auth: CustomAuthorizationRuntime;
    unread: CustomUnreadRuntime;
  };
  groupHistories: Map<string, HistoryEntry[]>;
  persistAuthState: () => void;
  persistCustomUnreadState: () => void;
  applyUnreadSchedulerEffects?: (
    effects: CustomUnreadGatewayEffect[],
    cfg?: ResolvedCustomUnreadConfig,
  ) => void;
  buildProactiveGuard: ApplyCustomDispatchSetupGatewayParams["buildProactiveGuard"];
  sendMedia: ApplyCustomDispatchSetupGatewayParams["sendMedia"];
  getRuntime: () => CustomRuntimeConfig;
  getQueueSnapshot: () => QueueSnapshot;
  sendFallbackAdminGroupAlert?: (alert: CustomFallbackAlertDelivery) => void | Promise<void>;
  notifyAuthAdminGroup?: (notification: CustomAuthAdminGroupNotification & { source: "dispatch" }) => Promise<void>;
  sendApprovalCardWithRetry?: (
    sendWithRetry: SendWithRetryFn,
    target: CustomDispatchAuthApprovalCardTarget,
    text: string,
    keyboard: InlineKeyboard,
  ) => Promise<void>;
  createDebouncer: Parameters<typeof runCustomDispatchReplyGateway>[0]["createDebouncer"];
  recordOutboundActivity: () => void;
  parseAndSendMediaTags: Parameters<typeof runCustomDispatchReplyGateway>[0]["parseAndSendMediaTags"];
  handleStructuredPayload: Parameters<typeof runCustomDispatchReplyGateway>[0]["handleStructuredPayload"];
  sendPlainReply: Parameters<typeof runCustomDispatchReplyGateway>[0]["sendPlainReply"];
  stopTyping: () => void;
  resolveEffectiveMessagesConfig: Parameters<typeof runCustomDispatchReplyGateway>[0]["resolveEffectiveMessagesConfig"];
  dispatchReply: CustomDispatchReplyDispatcher;
  resolveHistoryLimit: (groupOpenid: string, accountId: string) => number;
  log?: CustomMessageDispatchGatewayLogger;
  runWithRequestContext?: typeof defaultRunWithRequestContext;
  setupGateway?: typeof applyCustomDispatchSetupGateway;
  authorizeGateway?: typeof applyCustomDispatchAuthorizationGateway;
  createFallbackSession?: typeof createCustomDispatchFallbackSession;
  dispatchReplyGateway?: typeof runCustomDispatchReplyGateway;
  completeUnreadGateway?: typeof applyCustomUnreadCompletionGateway;
}

export type RunCustomMessageDispatchGatewayResult =
  | {
      action: "stopped";
      reason: "auth_denied";
    }
  | {
      action: "completed";
    };

export async function runCustomMessageDispatchGateway(
  params: RunCustomMessageDispatchGatewayParams,
): Promise<RunCustomMessageDispatchGatewayResult> {
  const setup = (params.setupGateway ?? applyCustomDispatchSetupGateway)({
    event: params.event,
    account: params.account,
    cfg: params.cfg,
    qualifiedTarget: params.qualifiedTarget,
    buildProactiveGuard: params.buildProactiveGuard,
    sendMedia: params.sendMedia,
    log: params.log as Parameters<typeof applyCustomDispatchSetupGateway>[0]["log"],
  });

  const dispatchAuth = await (params.authorizeGateway ?? applyCustomDispatchAuthorizationGateway)({
    cfg: params.cfg,
    auth: params.runtime.auth,
    message: params.event,
    rawContent: params.userContent,
    accountId: params.account.accountId,
    persistAuthState: params.persistAuthState,
    sendText: setup.sendErrorMessage,
    sendApprovalCard: params.sendApprovalCardWithRetry
      ? (target, text, keyboard) => params.sendApprovalCardWithRetry!(setup.sendWithRetry, target, text, keyboard)
      : undefined,
    notifyAdminGroup: params.notifyAuthAdminGroup,
    log: params.log,
  });
  if (dispatchAuth.shouldStop) {
    params.stopTyping();
    return { action: "stopped", reason: "auth_denied" };
  }
  applyCustomAuthorizationContextToPayload(params.ctxPayload, dispatchAuth.decision);

  await (params.runWithRequestContext ?? defaultRunWithRequestContext)({
    target: params.qualifiedTarget,
    accountId: params.account.accountId,
  }, async () => {
    const fallbackSession = (params.createFallbackSession ?? createCustomDispatchFallbackSession)({
      accountId: params.account.accountId,
      message: params.event,
      sessionKey: params.route.sessionKey,
      getRuntime: params.getRuntime,
      getQueueSnapshot: params.getQueueSnapshot,
      log: params.log,
      sendAlert: params.sendFallbackAdminGroupAlert,
      sendGuardedMediaAuto: setup.sendGuardedMediaAuto,
      sendErrorMessage: setup.sendErrorMessage,
    });

    await (params.dispatchReplyGateway ?? runCustomDispatchReplyGateway)({
      account: params.account,
      event: params.event,
      cfg: params.cfg,
      routeAgentId: params.route.agentId,
      ctxPayload: params.ctxPayload,
      replyAnchorId: setup.replyAnchorId,
      fallbackSession,
      sendErrorMessage: setup.sendErrorMessage,
      replyContext: setup.replyContext,
      deliverEvent: setup.deliverEvent,
      deliverAccountContext: setup.deliverAccountContext,
      sendWithRetry: setup.sendWithRetry,
      sendGuardedMediaAuto: setup.sendGuardedMediaAuto,
      debounceConfig: params.account.config?.deliverDebounce,
      createDebouncer: params.createDebouncer,
      recordOutboundActivity: params.recordOutboundActivity,
      parseAndSendMediaTags: params.parseAndSendMediaTags,
      handleStructuredPayload: params.handleStructuredPayload,
      sendPlainReply: params.sendPlainReply,
      stopTyping: params.stopTyping,
      resolveEffectiveMessagesConfig: params.resolveEffectiveMessagesConfig,
      dispatchReply: params.dispatchReply,
      log: params.log,
      onAfterFinalize: ({ hasModelBlockOutput, hasModelSkipOutput }) => {
        (params.completeUnreadGateway ?? applyCustomUnreadCompletionGateway)({
          accountId: params.account.accountId,
          unread: params.runtime.unread,
          groupOpenid: params.event.type === "group" ? params.event.groupOpenid : undefined,
          cfg: params.customUnreadCfgForEvent,
          snapshotId: params.event._customUnreadSnapshotId,
          hasModelBlockOutput,
          hasModelSkipOutput,
          shouldCatchUpAfterReply: params.shouldCatchUpUnreadAfterReply,
          wasMentioned: params.wasMentioned,
          groupHistories: params.groupHistories,
          resolveHistoryLimit: params.resolveHistoryLimit,
          persistCustomUnreadState: params.persistCustomUnreadState,
          applySchedulerEffects: params.applyUnreadSchedulerEffects,
          log: params.log,
        });
      },
    });
  });

  return { action: "completed" };
}

function applyCustomAuthorizationContextToPayload(
  payload: unknown,
  decision: CustomDispatchAuthorizationDecision,
): void {
  if (!decision.enabled || !decision.allowed || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const source = decision.result?.decision.source ?? decision.reason;
  const privileged = source === "admin" || source === "temporary-grant" || (decision.reason === "slash_authorized" && decision.capability === "schedule.run");
  record.CommandAuthorized = privileged;

  const prompt = buildCustomAuthorizationContextPrompt(decision, privileged);
  const current = typeof record.GroupSystemPrompt === "string" ? record.GroupSystemPrompt.trim() : "";
  record.GroupSystemPrompt = current ? `${current}\n${prompt}` : prompt;
}

function buildCustomAuthorizationContextPrompt(
  decision: CustomDispatchAuthorizationDecision,
  privileged: boolean,
): string {
  const capability = decision.capability ?? "chat.send";
  const source = decision.result?.decision.source ?? decision.reason ?? "unknown";
  if (capability === "web.search") {
    return [
      "QQBot 自定义权限状态：当前消息按低风险联网搜索放行。",
      `本次授权能力：${capability}；来源：${source}。`,
      "可以使用联网搜索/网页提取类工具回答当前问题，但不要运行命令、读写文件、读取配置/日志/环境/密钥、改配置、部署/升级/重启或写入记忆/规则。",
    ].join("\n");
  }
  if (capability === "schedule.run") {
    return [
      "QQBot 自定义权限状态：当前消息来自已授权的内部定时任务。",
      `本次授权能力：${capability}；来源：${source}。`,
      "只能执行定时任务中已经授权的动作，不要扩大到其他无关配置、部署、文件或记忆操作。",
    ].join("\n");
  }
  if (privileged) {
    return [
      "QQBot 自定义权限状态：当前消息已通过管理员身份或一次性临时授权。",
      `本次授权能力：${capability}；来源：${source}。`,
      "只能执行与本次用户请求直接相关的动作，不要扩大到其他配置、部署、文件或记忆操作。",
    ].join("\n");
  }
  return [
    "QQBot 自定义权限状态：当前发送者不是 customRuntime.admins 管理员，且没有本次高风险临时授权。",
    `本次仅按低风险能力放行：${capability}；来源：${source}。`,
    "只能进行普通对话或明确无副作用的轻量状态反馈。",
    "不要运行命令、读写文件、读取配置/日志/环境/密钥、写入或删除记忆/规则、改配置、部署/升级/重启、创建长任务或主动发送消息。",
    "如果用户要求上述高风险动作，应说明需要管理员授权；不要自行变通执行。",
  ].join("\n");
}
