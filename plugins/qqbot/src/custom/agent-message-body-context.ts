import { buildMergedMessageContext } from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";

export interface CustomMergedEnvelopeInput {
  message: QueuedMessage;
  sender: string;
  timestampMs: number;
  body: string;
}

export interface CustomAgentMessageBodyContextParams {
  event: Pick<QueuedMessage, "type" | "senderId" | "senderName" | "_mergedCount" | "_mergedMessages">;
  userContent: string;
  quotePart?: string;
  dynamicContext?: string;
  wasMentioned?: boolean;
  formatSubMessageContent: (message: QueuedMessage) => string;
  formatMergedEnvelope: (input: CustomMergedEnvelopeInput) => string;
}

export interface CustomAgentMessageBodyContext {
  userMessage: string;
  agentBody: string;
  isMergedMessage: boolean;
  senderPrefix: string;
  mentionTag: string;
}

export function buildCustomAgentMessageBodyContext(
  params: CustomAgentMessageBodyContextParams,
): CustomAgentMessageBodyContext {
  const isMergedMessage = Boolean(params.event._mergedCount && params.event._mergedCount > 1);
  const mentionTag = params.event.type === "group" && params.wasMentioned ? " (@你)" : "";
  const senderPrefix = params.event.type === "group" && !isMergedMessage
    ? `[${formatSingleSenderLabel(params.event)}] `
    : "";

  const userMessage = buildUserMessage({
    ...params,
    isMergedMessage,
    mentionTag,
    senderPrefix,
  });
  return {
    userMessage,
    agentBody: params.userContent.startsWith("/")
      ? params.userContent
      : `${params.dynamicContext ?? ""}${userMessage}`,
    isMergedMessage,
    senderPrefix,
    mentionTag,
  };
}

export function formatSingleSenderLabel(params: {
  senderId: string;
  senderName?: string;
}): string {
  return params.senderName ? `${params.senderName} (${params.senderId})` : params.senderId;
}

export function formatMergedSenderLabel(params: {
  senderId: string;
  senderName?: string;
}): string {
  if (!params.senderName) return params.senderId;
  return params.senderName.includes(params.senderId)
    ? params.senderName
    : `${params.senderName} (${params.senderId})`;
}

function buildUserMessage(params: CustomAgentMessageBodyContextParams & {
  isMergedMessage: boolean;
  mentionTag: string;
  senderPrefix: string;
}): string {
  const mergedMessages = params.event._mergedMessages;
  if (params.isMergedMessage && mergedMessages?.length) {
    const preceding = mergedMessages.slice(0, -1);
    const lastMsg = mergedMessages[mergedMessages.length - 1];
    const precedingParts = preceding.map((message) => {
      const body = params.formatSubMessageContent(message);
      const sender = formatMergedSenderLabel(message);
      return params.formatMergedEnvelope({
        message,
        sender,
        timestampMs: new Date(message.timestamp).getTime(),
        body,
      });
    });
    const lastContent = params.formatSubMessageContent(lastMsg);
    const lastSender = formatMergedSenderLabel(lastMsg);
    return buildMergedMessageContext({
      precedingParts,
      currentMessage: `[${lastSender}] ${lastContent}${params.mentionTag}`,
    });
  }

  const quotePart = params.quotePart ?? "";
  return params.senderPrefix
    ? `${params.senderPrefix}${quotePart}${params.userContent}${params.mentionTag}`
    : `${quotePart}${params.userContent}`;
}
