import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import {
  inspectCustomUnreadConfig,
  type ResolvedCustomUnreadConfig,
} from "./runtime.js";
import {
  effectsFromCustomUnreadIntents,
  historyEntriesFromCustomUnread,
  toCustomInboundGroupMessage,
  type CustomUnreadGatewayEffect,
} from "./unread-gateway-adapter.js";
import type { CustomUnreadRuntime } from "./unread-runtime.js";

export interface CustomUnreadIngressResult {
  handled: boolean;
  cfg?: ResolvedCustomUnreadConfig;
  effects: CustomUnreadGatewayEffect[];
  persist: boolean;
}

export interface CustomUnreadRecordIngressResult extends CustomUnreadIngressResult {
  pendingCount: number;
  recorded: boolean;
}

export interface CustomUnreadMentionIngressResult extends CustomUnreadIngressResult {
  pendingCount: number;
  shouldCatchUpAfterReply: boolean;
  history?: HistoryEntry[];
}

export function resolveCustomUnreadForQueuedGroupMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  event: QueuedMessage;
  content?: string;
  mentionedBot?: boolean;
  implicitMention?: boolean;
}): ResolvedCustomUnreadConfig | null {
  if (resolveCustomRuntimeConfig(params.cfg).enabled !== true) return null;
  if (params.event.type !== "group" || !params.event.groupOpenid) return null;

  const unreadCfg = inspectCustomUnreadConfig({
    cfg: params.cfg,
    message: toCustomInboundGroupMessage({
      accountId: params.accountId,
      groupOpenid: params.event.groupOpenid,
      senderId: params.event.senderId,
      senderName: params.event.senderName,
      senderIsBot: params.event.senderIsBot,
      content: params.content ?? params.event.content,
      messageId: params.event.messageId,
      timestamp: params.event.timestamp,
      mentionedBot: params.mentionedBot ?? false,
      implicitMention: params.implicitMention,
      attachments: params.event.attachments,
    }),
  });
  return unreadCfg.enabled ? unreadCfg : null;
}

export function recordCustomUnreadNonMentionBeforeDispatch(params: {
  accountId: string;
  cfg: OpenClawConfig;
  unread: CustomUnreadRuntime;
  event: QueuedMessage;
  content: string;
  mentionedBot: boolean;
  implicitMention?: boolean;
}): CustomUnreadRecordIngressResult {
  const unreadCfg = resolveCustomUnreadForQueuedGroupMessage({
    cfg: params.cfg,
    accountId: params.accountId,
    event: params.event,
    content: params.content,
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
  });
  if (!unreadCfg || params.event.type !== "group" || !params.event.groupOpenid) {
    return { handled: false, pendingCount: 0, recorded: false, effects: [], persist: false };
  }

  const message = toCustomInboundGroupMessage({
    accountId: params.accountId,
    groupOpenid: params.event.groupOpenid,
    senderId: params.event.senderId,
    senderName: params.event.senderName,
    senderIsBot: params.event.senderIsBot,
    content: params.content,
    messageId: params.event.messageId,
    timestamp: params.event.timestamp,
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
    attachments: params.event.attachments,
  });
  const result = params.unread.recordNonMention({ message, cfg: unreadCfg });
  return {
    handled: true,
    cfg: unreadCfg,
    pendingCount: result.pendingCount,
    recorded: result.recorded,
    effects: effectsFromCustomUnreadIntents({
      accountId: params.accountId,
      peer: message.peer,
      intents: result.intents,
    }),
    persist: result.recorded,
  };
}

export function observeCustomUnreadMentionBeforeDispatch(params: {
  accountId: string;
  cfg: OpenClawConfig;
  unread: CustomUnreadRuntime;
  event: QueuedMessage;
  content: string;
  mentionedBot: boolean;
  implicitMention?: boolean;
}): CustomUnreadMentionIngressResult {
  const unreadCfg = resolveCustomUnreadForQueuedGroupMessage({
    cfg: params.cfg,
    accountId: params.accountId,
    event: params.event,
    content: params.content,
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
  });
  if (!unreadCfg || params.event.type !== "group" || !params.event.groupOpenid) {
    return {
      handled: false,
      pendingCount: 0,
      shouldCatchUpAfterReply: false,
      effects: [],
      persist: false,
    };
  }

  const message = toCustomInboundGroupMessage({
    accountId: params.accountId,
    groupOpenid: params.event.groupOpenid,
    senderId: params.event.senderId,
    senderName: params.event.senderName,
    senderIsBot: params.event.senderIsBot,
    content: params.content,
    messageId: params.event.messageId,
    timestamp: params.event.timestamp,
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
    attachments: params.event.attachments,
  });
  const result = params.unread.observeMention({ message, cfg: unreadCfg });
  return {
    handled: true,
    cfg: unreadCfg,
    pendingCount: result.pendingCount,
    shouldCatchUpAfterReply: result.shouldCatchUpAfterReply,
    history: result.history.length > 0
      ? historyEntriesFromCustomUnread(result.history)
      : undefined,
    effects: effectsFromCustomUnreadIntents({
      accountId: params.accountId,
      peer: message.peer,
      intents: result.intents,
    }),
    persist: true,
  };
}
