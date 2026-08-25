import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";
import type { CustomUnreadRuntime } from "./unread-runtime.js";
import type { ResolvedCustomUnreadConfig } from "./runtime.js";
import type { CustomUnreadGatewayEffect } from "./unread-gateway-adapter.js";
import {
  buildCustomGroupMessageGateContext,
  normalizeGroupMessageContentForCommand,
  resolveCustomGroupImplicitMention,
  shouldHandleCustomTextCommands,
} from "./group-message-gate-context.js";
import { resolveCustomGroupActivation } from "./group-activation.js";
import { buildCustomGroupPromptContext } from "./group-prompt-context.js";
import { isCustomRuntimeAdmin, resolveCustomAdminGroupKey } from "./auth-admin.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { toCustomActorFromQueuedMessage } from "./queued-message-context.js";
import {
  applyCustomGroupMentionIngress,
  applyCustomGroupSkippedMessageIngress,
} from "./group-ingress-gateway-adapter.js";
import { buildMentionReplyScopePrompt } from "./unread-catchup-prompt.js";

export interface CustomGroupDispatchGatewayLogger {
  info?: (msg: string) => void;
}

export interface CustomGroupDispatchRouteContext {
  agentId: string;
  sessionKey: string;
}

export interface ApplyCustomGroupDispatchGatewayParams<TConfig extends OpenClawConfig = OpenClawConfig> {
  cfg: TConfig;
  accountId: string;
  route: CustomGroupDispatchRouteContext;
  unread: CustomUnreadRuntime;
  event: QueuedMessage;
  content: string;
  commandAuthorized: boolean;
  groupHistories: Map<string, HistoryEntry[]>;
  initialCustomUnreadCfg?: ResolvedCustomUnreadConfig | null;
  isGroupAllowed: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => boolean;
  resolveMentionPatterns: (params: { cfg: TConfig; agentId: string; groupOpenid: string; accountId: string }) => string[];
  detectWasMentioned: (params: {
    eventType?: string;
    mentions?: QueuedMessage["mentions"];
    content: string;
    mentionPatterns: string[];
  }) => boolean;
  resolveRequireMention: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => boolean;
  resolveActivation?: (params: { cfg: TConfig; agentId: string; sessionKey: string; configRequireMention: boolean }) => string;
  resolveIgnoreOtherMentions: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => boolean;
  resolveHistoryLimit: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => number;
  resolveGroupName: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => string;
  resolveGroupIntroHint?: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => string | undefined;
  resolveGroupPrompt: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => string | undefined;
  getRefEntry: (idx: string) => { isBot?: boolean } | null | undefined;
  isControlCommand: (text: string) => boolean;
  applySchedulerEffects?: (effects: CustomUnreadGatewayEffect[], cfg: ResolvedCustomUnreadConfig) => void;
  persistCustomUnreadState?: () => void;
  log?: CustomGroupDispatchGatewayLogger;
}

export type ApplyCustomGroupDispatchGatewayStopReason =
  | "non_group"
  | "group_not_allowed"
  | "drop_other_mention"
  | "block_unauthorized_command"
  | "skip_no_mention";

export interface ApplyCustomGroupDispatchGatewayResult {
  action: "continue" | "stop";
  reason?: ApplyCustomGroupDispatchGatewayStopReason;
  wasMentioned: boolean;
  groupSystemPrompt: string;
  groupSubject: string;
  senderLabel: string;
  customUnreadCfgForEvent: ResolvedCustomUnreadConfig | null;
  shouldCatchUpUnreadAfterReply: boolean;
  customUnreadHistoryForEvent?: HistoryEntry[];
}

export function applyCustomGroupDispatchGateway<TConfig extends OpenClawConfig = OpenClawConfig>(
  params: ApplyCustomGroupDispatchGatewayParams<TConfig>,
): ApplyCustomGroupDispatchGatewayResult {
  const base = baseResult(params.initialCustomUnreadCfg ?? null);
  if (params.event.type !== "group" || !params.event.groupOpenid) {
    return { ...base, reason: "non_group" };
  }

  const groupOpenid = params.event.groupOpenid;
  if (!params.isGroupAllowed({ cfg: params.cfg, accountId: params.accountId, groupOpenid })) {
    params.log?.info?.(`[qqbot:${params.accountId}] Group ${groupOpenid} not allowed by groupPolicy, skipping`);
    return { ...base, action: "stop", reason: "group_not_allowed" };
  }

  const isCustomUnreadSynthetic = Boolean(params.event._customUnreadSnapshotId);
  let wasMentioned = params.detectWasMentioned({
    eventType: params.event.eventType,
    mentions: params.event.mentions,
    content: params.event.content,
    mentionPatterns: params.resolveMentionPatterns({
      cfg: params.cfg,
      agentId: params.route.agentId,
      groupOpenid,
      accountId: params.accountId,
    }),
  });

  const configRequireMention = params.resolveRequireMention({
    cfg: params.cfg,
    accountId: params.accountId,
    groupOpenid,
  });
  const activation = (params.resolveActivation ?? resolveCustomGroupActivation)({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    configRequireMention,
  });
  const adminGroupBypass = shouldBypassMentionForCustomAdminGroup({
    cfg: params.cfg,
    event: params.event,
  });
  const implicitMention = adminGroupBypass || resolveCustomGroupImplicitMention({
    refMsgIdx: params.event.refMsgIdx,
    getRefEntry: params.getRefEntry,
  });
  const contentForCommand = normalizeGroupMessageContentForCommand(params.event.content);
  const gateContext = buildCustomGroupMessageGateContext({
    content: params.event.content,
    contentForCommand,
    mentions: params.event.mentions,
    wasMentioned,
    implicitMention,
    isCustomUnreadSynthetic,
    ignoreOtherMentions: isCustomUnreadSynthetic
      ? false
      : params.resolveIgnoreOtherMentions({ cfg: params.cfg, accountId: params.accountId, groupOpenid }),
    allowTextCommands: shouldHandleCustomTextCommands(params.cfg as Record<string, unknown>),
    isControlCommand: params.isControlCommand(contentForCommand),
    commandAuthorized: params.commandAuthorized,
    requireMention: activation === "mention",
    canDetectMention: true,
  });

  if (gateContext.gate.action === "drop_other_mention") {
    applyCustomGroupSkippedMessageIngress({
      accountId: params.accountId,
      cfg: params.cfg,
      unread: params.unread,
      event: params.event,
      content: params.content,
      mentionedBot: wasMentioned,
      implicitMention,
      groupHistories: params.groupHistories,
      historyLimit: params.resolveHistoryLimit({ cfg: params.cfg, accountId: params.accountId, groupOpenid }),
      reason: "drop_other_mention",
      applySchedulerEffects: params.applySchedulerEffects,
      persistCustomUnreadState: params.persistCustomUnreadState,
      log: params.log,
    });
    return { ...base, action: "stop", reason: "drop_other_mention" };
  }

  if (gateContext.gate.action === "block_unauthorized_command") {
    params.log?.info?.(`[qqbot:${params.accountId}] Group ${groupOpenid}: blocked unauthorized control command from ${params.event.senderId}: ${contentForCommand.slice(0, 50)}`);
    return { ...base, action: "stop", reason: "block_unauthorized_command" };
  }

  if (gateContext.gate.action === "skip_no_mention") {
    applyCustomGroupSkippedMessageIngress({
      accountId: params.accountId,
      cfg: params.cfg,
      unread: params.unread,
      event: params.event,
      content: params.content,
      mentionedBot: wasMentioned,
      implicitMention,
      groupHistories: params.groupHistories,
      historyLimit: params.resolveHistoryLimit({ cfg: params.cfg, accountId: params.accountId, groupOpenid }),
      reason: "skip_no_mention",
      activation,
      configRequireMention,
      applySchedulerEffects: params.applySchedulerEffects,
      persistCustomUnreadState: params.persistCustomUnreadState,
      log: params.log,
    });
    return { ...base, action: "stop", reason: "skip_no_mention" };
  }

  wasMentioned = gateContext.gate.effectiveWasMentioned;
  let customUnreadCfgForEvent = params.initialCustomUnreadCfg ?? null;
  let shouldCatchUpUnreadAfterReply = false;
  let customUnreadHistoryForEvent: HistoryEntry[] | undefined;
  if (wasMentioned) {
    const mentionResult = applyCustomGroupMentionIngress({
      cfg: params.cfg,
      accountId: params.accountId,
      unread: params.unread,
      event: params.event,
      content: params.content,
      mentionedBot: wasMentioned,
      implicitMention,
      applySchedulerEffects: params.applySchedulerEffects,
      persistCustomUnreadState: params.persistCustomUnreadState,
      log: params.log,
    });
    if (mentionResult.handled) {
      customUnreadCfgForEvent = mentionResult.cfg;
      shouldCatchUpUnreadAfterReply = mentionResult.shouldCatchUpAfterReply;
      customUnreadHistoryForEvent = mentionResult.history;
    }
  }

  const promptContext = buildCustomGroupPromptContext({
    cfg: params.cfg,
    accountId: params.accountId,
    event: params.event,
    resolveGroupName: params.resolveGroupName,
    resolveGroupIntroHint: params.resolveGroupIntroHint,
    resolveGroupPrompt: params.resolveGroupPrompt,
  });
  const groupSystemPrompt = wasMentioned && customUnreadHistoryForEvent?.length
    ? [promptContext.groupSystemPrompt, buildMentionReplyScopePrompt()].filter(Boolean).join("\n")
    : promptContext.groupSystemPrompt;

  return {
    action: "continue",
    wasMentioned,
    groupSystemPrompt,
    groupSubject: promptContext.groupSubject,
    senderLabel: promptContext.senderLabel,
    customUnreadCfgForEvent,
    shouldCatchUpUnreadAfterReply,
    customUnreadHistoryForEvent,
  };
}

function baseResult(customUnreadCfgForEvent: ResolvedCustomUnreadConfig | null): ApplyCustomGroupDispatchGatewayResult {
  return {
    action: "continue",
    wasMentioned: false,
    groupSystemPrompt: "",
    groupSubject: "",
    senderLabel: "",
    customUnreadCfgForEvent,
    shouldCatchUpUnreadAfterReply: false,
  };
}

function shouldBypassMentionForCustomAdminGroup<TConfig extends OpenClawConfig>(params: {
  cfg: TConfig;
  event: QueuedMessage;
}): boolean {
  if (params.event.type !== "group" || !params.event.groupOpenid) return false;
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (runtime.enabled !== true) return false;
  const adminGroupKey = resolveCustomAdminGroupKey(runtime.adminGroup);
  if (adminGroupKey !== `qqbot:group:${params.event.groupOpenid}`) return false;
  return isCustomRuntimeAdmin(runtime, toCustomActorFromQueuedMessage(params.event));
}
