import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "../group-history.js";
import type { ProcessedAttachments, RawAttachment } from "../inbound-attachments.js";
import type { QueuedMessage } from "../message-queue.js";
import type { RefIndexEntry } from "../ref-index-store.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { applyCustomAgentContextGateway } from "./agent-context-gateway-adapter.js";
import { applyCustomGroupDispatchGateway, type ApplyCustomGroupDispatchGatewayParams } from "./group-dispatch-gateway-adapter.js";
import { prepareCustomInboundMessageGateway } from "./inbound-preparation-gateway-adapter.js";
import { buildCustomInboundMediaContext, type CustomInboundMediaContext } from "./inbound-media-context.js";
import type { CustomMergedEnvelopeInput } from "./agent-message-body-context.js";
import type { CustomGatewayMessageRouteContext } from "./gateway-message-routing.js";
import type { CustomInboundContextPayload } from "./inbound-context-payload.js";
import type { CustomC2CInputNotifyKeepAliveSession } from "./typing-keepalive-gateway-adapter.js";
import type { ResolvedCustomUnreadConfig } from "./runtime.js";
import type { CustomUnreadHistoryEnvelopeEntry } from "./unread-context.js";
import type { CustomUnreadRuntime } from "./unread-runtime.js";
import { isCustomRuntimeAdmin } from "./auth-admin.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { toCustomActorFromQueuedMessage } from "./queued-message-context.js";

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

  const commandAuthorized = resolveCustomCommandAuthorized(params.cfg, account.config?.allowFrom, event);
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

  const historyImageMedia = await prepareCustomUnreadHistoryImageMedia({
    cfg: params.cfg,
    account: { accountId: account.accountId, appId: account.appId },
    peerId: messageRoute.peerId,
    history: groupDispatch.customUnreadHistoryForEvent,
    processAttachments: params.processAttachments,
    log: params.log,
  });
  const inboundMediaForAgent = historyImageMedia
    ? mergeCustomInboundMedia(inboundPrepared.inboundMedia, historyImageMedia)
    : inboundPrepared.inboundMedia;

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
    uniqueVoicePaths: inboundMediaForAgent.uniqueVoicePaths,
    uniqueVoiceUrls: inboundMediaForAgent.uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: inboundMediaForAgent.uniqueVoiceAsrReferTexts,
    commandAuthorized,
    media: {
      localMediaPaths: inboundMediaForAgent.localMediaPaths,
      localMediaTypes: inboundMediaForAgent.localMediaTypes,
      remoteMediaUrls: inboundMediaForAgent.remoteMediaUrls,
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

export function resolveCustomCommandAuthorized(
  cfg: OpenClawConfig,
  allowFrom: string[] | undefined,
  event: QueuedMessage,
): boolean {
  if (resolveCommandAuthorized(allowFrom, event.senderId)) return true;
  const runtime = resolveCustomRuntimeConfig(cfg);
  return runtime.enabled === true && isCustomRuntimeAdmin(runtime, toCustomActorFromQueuedMessage(event));
}

async function prepareCustomUnreadHistoryImageMedia<TConfig extends OpenClawConfig>(params: {
  cfg: TConfig;
  account: Pick<ResolvedQQBotAccount, "accountId" | "appId">;
  peerId: string;
  history?: HistoryEntry[];
  processAttachments: RunCustomMessageContextGatewayParams<TConfig>["processAttachments"];
  log?: CustomMessageContextGatewayLogger;
}): Promise<CustomInboundMediaContext | null> {
  const attachments = rawImageAttachmentsFromHistory(params.history);
  if (attachments.length === 0) return null;
  const processed = await params.processAttachments(attachments, {
    appId: params.account.appId,
    peerId: params.peerId,
    cfg: params.cfg,
    log: asProcessLogger(params.log),
  });
  const media = buildCustomInboundMediaContext(processed);
  params.log?.info?.(`[qqbot:${params.account.accountId}] Custom unread history images attached for model: count=${processed.imageUrls.length}`);
  return media;
}

function rawImageAttachmentsFromHistory(history?: HistoryEntry[]): RawAttachment[] {
  const attachments: RawAttachment[] = [];
  const seen = new Set<string>();
  for (const entry of history ?? []) {
    for (const att of entry.attachments ?? []) {
      if (att.type !== "image") continue;
      const url = att.url || att.localPath;
      if (!url) continue;
      const contentType = att.contentType || inferImageContentType(att.filename || url);
      const key = `${contentType}\n${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push({
        content_type: contentType,
        url,
        filename: att.filename,
      });
    }
  }
  return attachments;
}

function mergeCustomInboundMedia(
  current: CustomInboundMediaContext,
  extra: CustomInboundMediaContext,
): CustomInboundMediaContext {
  return {
    ...current,
    uniqueVoicePaths: uniqueStrings([...current.uniqueVoicePaths, ...extra.uniqueVoicePaths]),
    uniqueVoiceUrls: uniqueStrings([...current.uniqueVoiceUrls, ...extra.uniqueVoiceUrls]),
    uniqueVoiceAsrReferTexts: uniqueStrings([...current.uniqueVoiceAsrReferTexts, ...extra.uniqueVoiceAsrReferTexts]),
    sttTranscriptCount: current.sttTranscriptCount + extra.sttTranscriptCount,
    asrFallbackCount: current.asrFallbackCount + extra.asrFallbackCount,
    fallbackCount: current.fallbackCount + extra.fallbackCount,
    hasAsrReferFallback: current.hasAsrReferFallback || extra.hasAsrReferFallback,
    dynamicContext: `${current.dynamicContext}${extra.dynamicContext}`,
    localMediaPaths: uniqueStrings([...current.localMediaPaths, ...extra.localMediaPaths]),
    localMediaTypes: mergeMediaTypes(current.localMediaPaths, current.localMediaTypes, extra.localMediaPaths, extra.localMediaTypes),
    remoteMediaUrls: uniqueStrings([...current.remoteMediaUrls, ...extra.remoteMediaUrls]),
    remoteMediaTypes: mergeMediaTypes(current.remoteMediaUrls, current.remoteMediaTypes, extra.remoteMediaUrls, extra.remoteMediaTypes),
  };
}

function mergeMediaTypes(
  currentValues: readonly string[],
  currentTypes: readonly string[],
  extraValues: readonly string[],
  extraTypes: readonly string[],
): string[] {
  const map = new Map<string, string>();
  currentValues.forEach((value, index) => map.set(value, currentTypes[index] ?? "image/png"));
  extraValues.forEach((value, index) => {
    if (!map.has(value)) map.set(value, extraTypes[index] ?? "image/png");
  });
  return [...map.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].filter(Boolean);
}

function inferImageContentType(value: string | undefined): string {
  const lower = (value ?? "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function asProcessLogger(
  log: CustomMessageContextGatewayLogger | undefined,
): { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } | undefined {
  if (!log?.info || !log.error) return undefined;
  return {
    info: log.info,
    error: log.error,
    debug: log.debug,
  };
}
