import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "../group-history.js";
import type { ProcessedAttachments, RawAttachment } from "../inbound-attachments.js";
import type { QueuedMessage } from "../message-queue.js";
import type { RefIndexEntry } from "../ref-index-store.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { applyCustomAgentContextGateway } from "./agent-context-gateway-adapter.js";
import { applyCustomGroupDispatchGateway, type ApplyCustomGroupDispatchGatewayParams } from "./group-dispatch-gateway-adapter.js";
import { prepareCustomInboundMessageGateway } from "./inbound-preparation-gateway-adapter.js";
import type { CustomMergedEnvelopeInput } from "./agent-message-body-context.js";
import type { CustomGatewayMessageRouteContext } from "./gateway-message-routing.js";
import type { CustomInboundContextPayload } from "./inbound-context-payload.js";
import type { CustomC2CInputNotifyKeepAliveSession } from "./typing-keepalive-gateway-adapter.js";
import type { ResolvedCustomUnreadConfig } from "./runtime.js";
import type { CustomUnreadHistoryEnvelopeEntry } from "./unread-context.js";
import type { CustomUnreadRuntime } from "./unread-runtime.js";

export interface CustomMessageContextGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomMessageContextIngress<TEnvelopeOptions = unknown> {
  typing: CustomC2CInputNotifyKeepAliveSession;
  messageRoute: CustomGatewayMessageRouteContext;
  route: {
    agentId: string;
    sessionKey: string;
    accountId: string;
  };
  envelopeOptions: TEnvelopeOptions;
  systemPrompts: string[];
}

export interface RunCustomMessageContextGatewayParams<TConfig extends OpenClawConfig = OpenClawConfig, TEnvelopeOptions = unknown> {
  cfg: TConfig;
  account: Pick<ResolvedQQBotAccount, "accountId" | "appId" | "config">;
  event: QueuedMessage;
  ingress: CustomMessageContextIngress<TEnvelopeOptions>;
  unread: CustomUnreadRuntime;
  groupHistories: Map<string, HistoryEntry[]>;
  initialCustomUnreadCfg?: ResolvedCustomUnreadConfig | null;
  hasTTS: boolean;
  processAttachments: (
    attachments: RawAttachment[] | undefined,
    ctx: { appId: string; peerId?: string; cfg: TConfig; log?: { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } },
  ) => Promise<ProcessedAttachments>;
  formatVoiceText: (voiceTranscripts: string[]) => string;
  parseFaceTags: (content: string) => string;
  stripMentionText: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
  getRefEntry: (refIdx: string) => RefIndexEntry | null | undefined;
  setRefEntry: (refIdx: string, entry: RefIndexEntry) => void;
  formatRefEntry: (entry: RefIndexEntry) => string;
  formatMessageReference: (ref: { content: string; attachments?: QueuedMessage["attachments"] }) => Promise<string>;
  formatInboundEnvelope: (params: {
    channel: "qqbot";
    from: string;
    timestamp: number;
    body: string;
    chatType: "group" | "direct";
    sender: { id: string; name?: string };
    envelope: unknown;
    imageUrls?: string[];
  }) => string;
  groupDispatch: Omit<ApplyCustomGroupDispatchGatewayParams<TConfig>, "cfg" | "accountId" | "route" | "unread" | "event" | "content" | "commandAuthorized" | "groupHistories" | "initialCustomUnreadCfg" | "log">;
  resolveHistoryLimit: (groupOpenid: string, accountId: string) => number;
  formatSubMessageContent: (message: QueuedMessage) => string;
  formatMergedEnvelope: (input: CustomMergedEnvelopeInput) => string;
  formatHistoryEnvelope: (entry: CustomUnreadHistoryEnvelopeEntry) => string;
  finalizeInboundContext: (payload: CustomInboundContextPayload) => unknown;
  log?: CustomMessageContextGatewayLogger;
}

export type RunCustomMessageContextGatewayResult =
  | {
      action: "stop";
      reason: string | undefined;
      userContent: string;
      commandAuthorized: boolean;
      wasMentioned: boolean;
      shouldCatchUpUnreadAfterReply: boolean;
      customUnreadCfgForEvent: ResolvedCustomUnreadConfig | null;
    }
  | {
      action: "continue";
      ctxPayload: unknown;
      userContent: string;
      commandAuthorized: boolean;
      wasMentioned: boolean;
      shouldCatchUpUnreadAfterReply: boolean;
      customUnreadCfgForEvent: ResolvedCustomUnreadConfig | null;
    };

export async function runCustomMessageContextGateway<TConfig extends OpenClawConfig = OpenClawConfig, TEnvelopeOptions = unknown>(
  params: RunCustomMessageContextGatewayParams<TConfig, TEnvelopeOptions>,
): Promise<RunCustomMessageContextGatewayResult> {
  const { account, event, ingress } = params;
  const messageRoute = ingress.messageRoute;
  const inboundPrepared = await prepareCustomInboundMessageGateway({
    cfg: params.cfg,
    account: {
      accountId: account.accountId,
      appId: account.appId,
    },
    event,
    peerId: messageRoute.peerId,
    isGroupChat: messageRoute.isGroupChat,
    envelopeOptions: ingress.envelopeOptions,
    inputNotifyRefIdx: ingress.typing.inputNotifyRefIdx,
    processAttachments: params.processAttachments,
    formatVoiceText: params.formatVoiceText,
    parseFaceTags: params.parseFaceTags,
    stripMentionText: params.stripMentionText,
    getRefEntry: params.getRefEntry,
    setRefEntry: params.setRefEntry,
    formatRefEntry: params.formatRefEntry,
    formatMessageReference: params.formatMessageReference,
    formatInboundEnvelope: params.formatInboundEnvelope,
    log: params.log,
  });

  const systemPrompts = ingress.systemPrompts.slice();
  if (params.hasTTS) {
    systemPrompts.unshift("语音合成已启用");
  }

  const commandAuthorized = resolveCommandAuthorized(account.config?.allowFrom, event.senderId);
  const groupDispatch = applyCustomGroupDispatchGateway({
    cfg: params.cfg,
    accountId: account.accountId,
    route: {
      agentId: ingress.route.agentId,
      sessionKey: ingress.route.sessionKey,
    },
    unread: params.unread,
    event,
    content: inboundPrepared.userContent,
    commandAuthorized,
    groupHistories: params.groupHistories,
    initialCustomUnreadCfg: params.initialCustomUnreadCfg,
    ...params.groupDispatch,
    log: params.log,
  });

  if (groupDispatch.action === "stop") {
    return {
      action: "stop",
      reason: groupDispatch.reason,
      userContent: inboundPrepared.userContent,
      commandAuthorized,
      wasMentioned: groupDispatch.wasMentioned,
      shouldCatchUpUnreadAfterReply: groupDispatch.shouldCatchUpUnreadAfterReply,
      customUnreadCfgForEvent: groupDispatch.customUnreadCfgForEvent,
    };
  }

  const historyLimitForAgentBody = event.type === "group" && event.groupOpenid
    ? params.resolveHistoryLimit(event.groupOpenid, account.accountId)
    : 0;
  const agentContext = applyCustomAgentContextGateway({
    accountId: account.accountId,
    event,
    body: inboundPrepared.body,
    userContent: inboundPrepared.userContent,
    quotePart: inboundPrepared.quoteRef.quotePart,
    dynamicContext: inboundPrepared.inboundMedia.dynamicContext,
    wasMentioned: groupDispatch.wasMentioned,
    groupHistories: params.groupHistories,
    mentionHistory: groupDispatch.customUnreadHistoryForEvent,
    historyLimit: historyLimitForAgentBody,
    formatSubMessageContent: params.formatSubMessageContent,
    formatMergedEnvelope: params.formatMergedEnvelope,
    formatHistoryEnvelope: params.formatHistoryEnvelope,
    finalizeInboundContext: params.finalizeInboundContext,
    fromAddress: messageRoute.fromAddress,
    toAddress: messageRoute.toAddress,
    sessionKey: ingress.route.sessionKey,
    routeAccountId: ingress.route.accountId,
    isGroupChat: messageRoute.isGroupChat,
    staticSystemPrompts: systemPrompts,
    groupSystemPrompt: groupDispatch.groupSystemPrompt,
    senderLabel: groupDispatch.senderLabel,
    groupSubject: groupDispatch.groupSubject,
    hasAsrReferFallback: inboundPrepared.inboundMedia.hasAsrReferFallback,
    voiceTranscriptSources: inboundPrepared.processed.voiceTranscriptSources,
    uniqueVoicePaths: inboundPrepared.inboundMedia.uniqueVoicePaths,
    uniqueVoiceUrls: inboundPrepared.inboundMedia.uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: inboundPrepared.inboundMedia.uniqueVoiceAsrReferTexts,
    commandAuthorized,
    media: {
      localMediaPaths: inboundPrepared.inboundMedia.localMediaPaths,
      localMediaTypes: inboundPrepared.inboundMedia.localMediaTypes,
      remoteMediaUrls: inboundPrepared.inboundMedia.remoteMediaUrls,
    },
    quote: inboundPrepared.quoteRef,
    log: params.log,
  });

  return {
    action: "continue",
    ctxPayload: agentContext.ctxPayload,
    userContent: inboundPrepared.userContent,
    commandAuthorized,
    wasMentioned: groupDispatch.wasMentioned,
    shouldCatchUpUnreadAfterReply: groupDispatch.shouldCatchUpUnreadAfterReply,
    customUnreadCfgForEvent: groupDispatch.customUnreadCfgForEvent,
  };
}

export function resolveCommandAuthorized(allowFrom: string[] | undefined, senderId: string): boolean {
  const allowFromList = allowFrom ?? [];
  const allowAll = allowFromList.length === 0 || allowFromList.some((entry) => entry === "*");
  return allowAll || allowFromList.some((entry) => entry.toUpperCase() === senderId.toUpperCase());
}
