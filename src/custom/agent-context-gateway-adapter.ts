import type { HistoryEntry } from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";
import {
  buildCustomAgentMessageBodyContext,
  type CustomMergedEnvelopeInput,
} from "./agent-message-body-context.js";
import { buildCustomInboundContextPayload, type CustomInboundContextPayload } from "./inbound-context-payload.js";
import { applyCustomUnreadHistoryContextToAgentBody, type CustomUnreadHistoryEnvelopeEntry } from "./unread-context.js";

export interface CustomAgentContextGatewayLogger {
  info?: (msg: string) => void;
}

export interface ApplyCustomAgentContextGatewayParams {
  accountId: string;
  event: QueuedMessage;
  body: string;
  userContent: string;
  quotePart: string;
  dynamicContext: string;
  wasMentioned: boolean;
  groupHistories: Map<string, HistoryEntry[]>;
  mentionHistory?: HistoryEntry[];
  historyLimit: number;
  formatSubMessageContent: (message: QueuedMessage) => string;
  formatMergedEnvelope: (input: CustomMergedEnvelopeInput) => string;
  formatHistoryEnvelope: (entry: CustomUnreadHistoryEnvelopeEntry) => string;
  finalizeInboundContext: (payload: CustomInboundContextPayload) => unknown;
  fromAddress: string;
  toAddress: string;
  sessionKey: string;
  routeAccountId: string;
  isGroupChat: boolean;
  staticSystemPrompts: readonly string[];
  groupSystemPrompt: string;
  senderLabel: string;
  groupSubject: string;
  hasAsrReferFallback: boolean;
  voiceTranscriptSources: readonly string[];
  uniqueVoicePaths: readonly string[];
  uniqueVoiceUrls: readonly string[];
  uniqueVoiceAsrReferTexts: readonly string[];
  commandAuthorized: boolean;
  media: {
    localMediaPaths: readonly string[];
    localMediaTypes: readonly string[];
    remoteMediaUrls: readonly string[];
  };
  quote: {
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  };
  log?: CustomAgentContextGatewayLogger;
}

export interface ApplyCustomAgentContextGatewayResult {
  agentBody: string;
  ctxPayload: unknown;
  historyApplied: boolean;
  historySource: "snapshot" | "mention" | "legacy";
}

export function applyCustomAgentContextGateway(
  params: ApplyCustomAgentContextGatewayParams,
): ApplyCustomAgentContextGatewayResult {
  const initialAgentBody = buildCustomAgentMessageBodyContext({
    event: params.event,
    userContent: params.userContent,
    quotePart: params.quotePart,
    dynamicContext: params.dynamicContext,
    wasMentioned: params.wasMentioned,
    formatSubMessageContent: params.formatSubMessageContent,
    formatMergedEnvelope: params.formatMergedEnvelope,
  }).agentBody;

  const history = applyCustomUnreadHistoryContextToAgentBody({
    event: params.event,
    groupHistories: params.groupHistories,
    mentionHistory: params.mentionHistory,
    historyLimit: params.historyLimit,
    currentMessage: initialAgentBody,
    formatEnvelope: params.formatHistoryEnvelope,
  });
  const agentBody = history.body;
  params.log?.info?.(`[qqbot:${params.accountId}] agentBody length: ${agentBody.length}`);

  const ctxPayload = params.finalizeInboundContext(buildCustomInboundContextPayload({
    event: params.event,
    body: params.body,
    agentBody,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
    sessionKey: params.sessionKey,
    accountId: params.routeAccountId,
    isGroupChat: params.isGroupChat,
    staticSystemPrompts: params.staticSystemPrompts,
    groupSystemPrompt: params.groupSystemPrompt,
    wasMentioned: params.wasMentioned,
    senderLabel: params.senderLabel,
    groupSubject: params.groupSubject,
    hasAsrReferFallback: params.hasAsrReferFallback,
    voiceTranscriptSources: params.voiceTranscriptSources,
    uniqueVoicePaths: params.uniqueVoicePaths,
    uniqueVoiceUrls: params.uniqueVoiceUrls,
    uniqueVoiceAsrReferTexts: params.uniqueVoiceAsrReferTexts,
    commandAuthorized: params.commandAuthorized,
    media: params.media,
    quote: params.quote,
  }));

  return {
    agentBody,
    ctxPayload,
    historyApplied: history.applied,
    historySource: history.source,
  };
}
