import type { QueuedMessage } from "../message-queue.js";
import { mergeCustomSystemPromptParts } from "./group-prompt-context.js";

export interface CustomInboundContextMediaFields {
  localMediaPaths?: readonly string[];
  localMediaTypes?: readonly string[];
  remoteMediaUrls?: readonly string[];
}

export interface CustomInboundContextQuoteFields {
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
}

export interface CustomInboundContextPayloadParams {
  event: Pick<QueuedMessage, "type" | "content" | "senderId" | "senderName" | "messageId" | "timestamp" | "channelId" | "guildId" | "groupOpenid">;
  body: string;
  agentBody: string;
  fromAddress: string;
  toAddress: string;
  sessionKey: string;
  accountId: string;
  isGroupChat: boolean;
  staticSystemPrompts?: readonly string[];
  groupSystemPrompt?: string;
  wasMentioned?: boolean;
  senderLabel?: string;
  groupSubject?: string;
  hasAsrReferFallback: boolean;
  voiceTranscriptSources?: readonly string[];
  uniqueVoicePaths?: readonly string[];
  uniqueVoiceUrls?: readonly string[];
  uniqueVoiceAsrReferTexts?: readonly string[];
  commandAuthorized: boolean;
  media?: CustomInboundContextMediaFields;
  quote?: CustomInboundContextQuoteFields;
}

export type CustomInboundContextPayload = Record<string, unknown>;

export function buildCustomInboundContextPayload(
  params: CustomInboundContextPayloadParams,
): CustomInboundContextPayload {
  const localMediaPaths = [...(params.media?.localMediaPaths ?? [])];
  const localMediaTypes = [...(params.media?.localMediaTypes ?? [])];
  const remoteMediaUrls = [...(params.media?.remoteMediaUrls ?? [])];
  const groupSystemPrompt = mergeCustomSystemPromptParts([
    ...(params.staticSystemPrompts ?? []),
    params.groupSystemPrompt,
  ]);

  return {
    Body: params.body,
    BodyForAgent: params.agentBody,
    RawBody: params.event.content,
    CommandBody: params.event.content,
    From: params.fromAddress,
    To: params.toAddress,
    SessionKey: params.sessionKey,
    AccountId: params.accountId,
    ChatType: params.isGroupChat ? "group" : "direct",
    GroupSystemPrompt: groupSystemPrompt,
    WasMentioned: params.isGroupChat ? params.wasMentioned : undefined,
    SenderLabel: params.isGroupChat ? params.senderLabel : undefined,
    GroupSubject: params.isGroupChat ? params.groupSubject : undefined,
    SenderId: params.event.senderId,
    SenderName: params.event.senderName,
    Provider: "qqbot",
    Surface: "qqbot",
    MessageSid: params.event.messageId,
    Timestamp: new Date(params.event.timestamp).getTime(),
    OriginatingChannel: "qqbot",
    OriginatingTo: params.toAddress,
    QQChannelId: params.event.channelId,
    QQGuildId: params.event.guildId,
    QQGroupOpenid: params.event.groupOpenid,
    QQVoiceAsrReferAvailable: params.hasAsrReferFallback,
    QQVoiceTranscriptSources: params.voiceTranscriptSources,
    QQVoiceAttachmentPaths: params.uniqueVoicePaths,
    QQVoiceAttachmentUrls: params.uniqueVoiceUrls,
    QQVoiceAsrReferTexts: params.uniqueVoiceAsrReferTexts,
    QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
    CommandAuthorized: params.commandAuthorized,
    ...(localMediaPaths.length > 0 ? {
      MediaPaths: localMediaPaths,
      MediaPath: localMediaPaths[0],
      MediaTypes: localMediaTypes,
      MediaType: localMediaTypes[0],
    } : {}),
    ...(remoteMediaUrls.length > 0 ? {
      MediaUrls: remoteMediaUrls,
      MediaUrl: remoteMediaUrls[0],
    } : {}),
    ...(params.quote?.replyToId ? {
      ReplyToId: params.quote.replyToId,
      ReplyToBody: params.quote.replyToBody,
      ReplyToSender: params.quote.replyToSender,
      ReplyToIsQuote: params.quote.replyToIsQuote,
    } : {}),
  };
}
