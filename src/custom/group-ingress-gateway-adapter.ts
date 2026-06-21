import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";
import type { CustomUnreadRuntime } from "./unread-runtime.js";
import type { ResolvedCustomUnreadConfig } from "./runtime.js";
import type { CustomUnreadGatewayEffect } from "./unread-gateway-adapter.js";
import {
  observeCustomUnreadMentionBeforeDispatch,
  recordCustomUnreadNonMentionBeforeDispatch,
} from "./unread-ingress.js";
import { recordLegacyGroupHistoryBeforeDispatch } from "./unread-context.js";

export interface CustomGroupIngressLogger {
  info?: (msg: string) => void;
}

export type CustomGroupSkippedIngressReason = "drop_other_mention" | "skip_no_mention";

export interface ApplyCustomGroupSkippedMessageIngressParams {
  accountId: string;
  cfg: OpenClawConfig;
  unread: CustomUnreadRuntime;
  event: QueuedMessage;
  content: string;
  mentionedBot: boolean;
  implicitMention?: boolean;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  reason: CustomGroupSkippedIngressReason;
  activation?: string;
  configRequireMention?: boolean;
  applySchedulerEffects?: (effects: CustomUnreadGatewayEffect[], cfg: ResolvedCustomUnreadConfig) => void;
  persistCustomUnreadState?: () => void;
  log?: CustomGroupIngressLogger;
}

export type ApplyCustomGroupSkippedMessageIngressResult =
  | {
      kind: "custom-unread";
      pendingCount: number;
      recorded: boolean;
      persist: boolean;
    }
  | {
      kind: "legacy-history";
      pendingCount: number;
      attachmentCount: number;
      recorded: boolean;
    };

export interface ApplyCustomGroupMentionIngressParams {
  accountId: string;
  cfg: OpenClawConfig;
  unread: CustomUnreadRuntime;
  event: QueuedMessage;
  content: string;
  mentionedBot: boolean;
  implicitMention?: boolean;
  applySchedulerEffects?: (effects: CustomUnreadGatewayEffect[], cfg: ResolvedCustomUnreadConfig) => void;
  persistCustomUnreadState?: () => void;
  log?: CustomGroupIngressLogger;
}

export interface ApplyCustomGroupMentionIngressResult {
  handled: boolean;
  cfg: ResolvedCustomUnreadConfig | null;
  pendingCount: number;
  shouldCatchUpAfterReply: boolean;
  history?: HistoryEntry[];
  persist: boolean;
}

export function applyCustomGroupSkippedMessageIngress(
  params: ApplyCustomGroupSkippedMessageIngressParams,
): ApplyCustomGroupSkippedMessageIngressResult {
  const custom = recordCustomUnreadNonMentionBeforeDispatch({
    cfg: params.cfg,
    accountId: params.accountId,
    unread: params.unread,
    event: params.event,
    content: params.content,
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
  });
  if (custom.handled) {
    if (custom.effects.length && custom.cfg) {
      params.applySchedulerEffects?.(custom.effects, custom.cfg);
    }
    if (custom.persist) params.persistCustomUnreadState?.();
    params.log?.info?.(formatSkippedCustomUnreadLog(params, custom.pendingCount));
    return {
      kind: "custom-unread",
      pendingCount: custom.pendingCount,
      recorded: custom.recorded,
      persist: custom.persist,
    };
  }

  const legacy = recordLegacyGroupHistoryBeforeDispatch({
    event: params.event,
    groupHistories: params.groupHistories,
    historyLimit: params.historyLimit,
    content: params.content,
  });
  params.log?.info?.(formatSkippedLegacyHistoryLog(params, legacy.pendingCount, legacy.attachmentCount));
  return {
    kind: "legacy-history",
    pendingCount: legacy.pendingCount,
    attachmentCount: legacy.attachmentCount,
    recorded: legacy.recorded,
  };
}

export function applyCustomGroupMentionIngress(
  params: ApplyCustomGroupMentionIngressParams,
): ApplyCustomGroupMentionIngressResult {
  const mention = observeCustomUnreadMentionBeforeDispatch({
    cfg: params.cfg,
    accountId: params.accountId,
    unread: params.unread,
    event: params.event,
    content: params.content,
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
  });
  if (!mention.handled) {
    return {
      handled: false,
      cfg: null,
      pendingCount: 0,
      shouldCatchUpAfterReply: false,
      persist: false,
    };
  }

  if (mention.effects.length && mention.cfg) {
    params.applySchedulerEffects?.(mention.effects, mention.cfg);
  }
  if (mention.persist) params.persistCustomUnreadState?.();
  if (mention.shouldCatchUpAfterReply && params.event.groupOpenid) {
    params.log?.info?.(`[qqbot:${params.accountId}] Group ${params.event.groupOpenid}: mention with ${mention.pendingCount} custom unread message(s); will catch up after reply`);
  }

  return {
    handled: true,
    cfg: mention.cfg ?? null,
    pendingCount: mention.pendingCount,
    shouldCatchUpAfterReply: mention.shouldCatchUpAfterReply,
    history: mention.history,
    persist: mention.persist,
  };
}

function formatSkippedCustomUnreadLog(
  params: ApplyCustomGroupSkippedMessageIngressParams,
  pendingCount: number,
): string {
  const groupOpenid = params.event.groupOpenid ?? "unknown";
  if (params.reason === "drop_other_mention") {
    return `[qqbot:${params.accountId}] Group ${groupOpenid}: drop other mention, recorded by custom unread runtime (cached=${pendingCount})`;
  }
  return `[qqbot:${params.accountId}] Group ${groupOpenid}: activation=${params.activation ?? "unknown"} not mentioned, recorded by custom unread runtime (cached=${pendingCount})`;
}

function formatSkippedLegacyHistoryLog(
  params: ApplyCustomGroupSkippedMessageIngressParams,
  pendingCount: number,
  attachmentCount: number,
): string {
  const groupOpenid = params.event.groupOpenid ?? "unknown";
  const attachmentSuffix = attachmentCount ? `, attachments=${attachmentCount}` : "";
  if (params.reason === "drop_other_mention") {
    return `[qqbot:${params.accountId}] Group ${groupOpenid}: drop other mention, recorded to legacy history (cached=${pendingCount}${attachmentSuffix})`;
  }
  return `[qqbot:${params.accountId}] Group ${groupOpenid}: activation=${params.activation ?? "unknown"} (configRequireMention=${params.configRequireMention}) not mentioned, recorded to history (limit=${params.historyLimit}, cached=${pendingCount}${attachmentSuffix})`;
}
