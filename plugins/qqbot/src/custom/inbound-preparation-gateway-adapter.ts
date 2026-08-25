import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ProcessedAttachments, RawAttachment } from "../inbound-attachments.js";
import type { QueuedMessage } from "../message-queue.js";
import type { RefIndexEntry } from "../ref-index-store.js";
import {
  buildCustomInboundMediaContext,
  formatCustomInboundVoiceSummary,
  type CustomInboundMediaContext,
} from "./inbound-media-context.js";
import {
  buildCustomCurrentRefIndexRecord,
  resolveCustomQuoteReferenceContext,
  type CustomCurrentRefIndexRecord,
  type CustomQuoteReferenceContext,
} from "./message-reference-context.js";

export interface CustomInboundPreparationLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomInboundPreparationProcessLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomInboundPreparationAccountContext {
  accountId: string;
  appId: string;
}

export interface PrepareCustomInboundMessageGatewayParams<TConfig = OpenClawConfig> {
  cfg: TConfig;
  account: CustomInboundPreparationAccountContext;
  event: QueuedMessage;
  peerId: string;
  isGroupChat: boolean;
  envelopeOptions: unknown;
  inputNotifyRefIdx?: Promise<string | undefined>;
  processAttachments: (
    attachments: RawAttachment[] | undefined,
    ctx: { appId: string; peerId?: string; cfg: TConfig; log?: CustomInboundPreparationProcessLogger },
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
  log?: CustomInboundPreparationLogger;
}

export interface PrepareCustomInboundMessageGatewayResult {
  processed: ProcessedAttachments;
  inboundMedia: CustomInboundMediaContext;
  parsedContent: string;
  userContent: string;
  body: string;
  quoteRef: CustomQuoteReferenceContext;
  currentRefRecord: CustomCurrentRefIndexRecord | null;
  voiceText: string;
  voiceSummary: string | null;
}

export async function prepareCustomInboundMessageGateway<TConfig = OpenClawConfig>(
  params: PrepareCustomInboundMessageGatewayParams<TConfig>,
): Promise<PrepareCustomInboundMessageGatewayResult> {
  const processed = await params.processAttachments(params.event.attachments, {
    appId: params.account.appId,
    peerId: params.peerId,
    cfg: params.cfg,
    log: asProcessLogger(params.log),
  });
  const inboundMedia = buildCustomInboundMediaContext(processed);
  const voiceText = params.formatVoiceText(processed.voiceTranscripts);
  const parsedContent = params.parseFaceTags(params.event.content);
  const userContent = normalizeCustomInboundUserContent({
    event: params.event,
    parsedContent,
    attachmentInfo: processed.attachmentInfo,
    voiceText,
    stripMentionText: params.stripMentionText,
  });

  const quoteRef = await resolveCustomQuoteReferenceContext({
    event: params.event,
    getRefEntry: params.getRefEntry,
    formatRefEntry: params.formatRefEntry,
    formatMessageReference: params.formatMessageReference,
  });
  for (const quoteLog of quoteRef.logs) {
    params.log?.info?.(`[qqbot:${params.account.accountId}] ${quoteLog}`);
  }

  const inputNotifyRefIdx = await params.inputNotifyRefIdx;
  const currentRefRecord = buildCustomCurrentRefIndexRecord({
    event: params.event,
    inputNotifyRefIdx,
    parsedContent,
    attachmentLocalPaths: processed.attachmentLocalPaths,
    voiceTranscripts: processed.voiceTranscripts,
    voiceTranscriptSources: processed.voiceTranscriptSources,
  });
  if (currentRefRecord) {
    params.setRefEntry(currentRefRecord.refIdx, currentRefRecord.entry);
    params.log?.info?.(`[qqbot:${params.account.accountId}] Cached msgIdx=${currentRefRecord.refIdx} for future reference (source: ${currentRefRecord.source})`);
  }

  const body = params.formatInboundEnvelope({
    channel: "qqbot",
    from: params.event.senderName ?? params.event.senderId,
    timestamp: new Date(params.event.timestamp).getTime(),
    body: userContent,
    chatType: params.isGroupChat ? "group" : "direct",
    sender: {
      id: params.event.senderId,
      name: params.event.senderName,
    },
    envelope: params.envelopeOptions,
    ...(processed.imageUrls.length > 0 ? { imageUrls: processed.imageUrls } : {}),
  });

  const voiceSummary = formatCustomInboundVoiceSummary({
    media: inboundMedia,
    voiceAttachmentPaths: processed.voiceAttachmentPaths,
    voiceAttachmentUrls: processed.voiceAttachmentUrls,
    voiceTranscriptCount: processed.voiceTranscripts.length,
  });
  if (voiceSummary) {
    params.log?.info?.(`[qqbot:${params.account.accountId}] ${voiceSummary}`);
  }

  return {
    processed,
    inboundMedia,
    parsedContent,
    userContent,
    body,
    quoteRef,
    currentRefRecord,
    voiceText,
    voiceSummary,
  };
}

function asProcessLogger(
  log: CustomInboundPreparationLogger | undefined,
): CustomInboundPreparationProcessLogger | undefined {
  if (!log?.info || !log.error) return undefined;
  return {
    info: log.info,
    error: log.error,
    debug: log.debug,
  };
}

export function normalizeCustomInboundUserContent(params: {
  event: Pick<QueuedMessage, "type" | "mentions">;
  parsedContent: string;
  attachmentInfo: string;
  voiceText: string;
  stripMentionText: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
}): string {
  let userContent = params.voiceText
    ? (params.parsedContent.trim() ? `${params.parsedContent}\n${params.voiceText}` : params.voiceText) + params.attachmentInfo
    : params.parsedContent + params.attachmentInfo;

  if (params.event.type === "group" && params.event.mentions?.length) {
    return params.stripMentionText(userContent, params.event.mentions) ?? userContent;
  }
  if (params.event.mentions?.length) {
    for (const mention of params.event.mentions) {
      if (mention.member_openid && mention.username) {
        userContent = userContent.replace(new RegExp(`<@${mention.member_openid}>`, "g"), `@${mention.username}`);
      }
    }
  }
  return userContent;
}
