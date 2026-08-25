import type { QueuedMessage } from "../message-queue.js";
import type { RefAttachmentSummary, RefIndexEntry } from "../ref-index-store.js";
import { MSG_TYPE_QUOTE } from "../types.js";
import { buildAttachmentSummaries } from "../utils/text-parsing.js";

export interface CustomQuoteReferenceContext {
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote: boolean;
  quotePart: string;
  logs: string[];
}

export interface CustomCurrentRefIndexRecord {
  refIdx: string;
  source: "message_scene.ext" | "InputNotify";
  entry: RefIndexEntry;
}

export async function resolveCustomQuoteReferenceContext(params: {
  event: Pick<QueuedMessage, "refMsgIdx" | "msgType" | "msgElements">;
  getRefEntry: (refIdx: string) => RefIndexEntry | null | undefined;
  formatRefEntry: (entry: RefIndexEntry) => string;
  formatMessageReference: (ref: { content: string; attachments?: QueuedMessage["attachments"] }) => Promise<string>;
}): Promise<CustomQuoteReferenceContext> {
  const refMsgIdx = params.event.refMsgIdx;
  if (!refMsgIdx) {
    return { replyToIsQuote: false, quotePart: "", logs: [] };
  }

  let replyToBody: string | undefined;
  let replyToSender: string | undefined;
  const logs: string[] = [];
  const refEntry = params.getRefEntry(refMsgIdx);
  if (refEntry) {
    replyToBody = params.formatRefEntry(refEntry);
    replyToSender = refEntry.senderName ?? refEntry.senderId;
    logs.push(`Quote detected via refMsgIdx cache: refMsgIdx=${refMsgIdx}, sender=${replyToSender}, content="${replyToBody.slice(0, 80)}..."`);
  } else if (params.event.msgType === MSG_TYPE_QUOTE) {
    const refElement = params.event.msgElements?.[0];
    if (refElement) {
      replyToBody = await params.formatMessageReference({
        content: refElement.content ?? "",
        attachments: refElement.attachments,
      });
      logs.push(`Quote detected via msg_elements[0] (cache miss): id=${refMsgIdx}, sender=${replyToSender ?? "unknown"}, content="${(replyToBody ?? "").slice(0, 80)}..."`);
    } else {
      logs.push(`Quote detected (MSG_TYPE_QUOTE) but no msg_elements: refMsgIdx=${refMsgIdx}`);
    }
  } else {
    logs.push(`Quote detected but no cache and msgType=${params.event.msgType} (not quote): refMsgIdx=${refMsgIdx}`);
  }

  return {
    replyToId: refMsgIdx,
    replyToBody,
    replyToSender,
    replyToIsQuote: true,
    quotePart: formatQuotePart(replyToBody),
    logs,
  };
}

export function buildCustomCurrentRefIndexRecord(params: {
  event: Pick<QueuedMessage, "msgIdx" | "attachments" | "senderId" | "senderName" | "timestamp">;
  inputNotifyRefIdx?: string;
  parsedContent: string;
  attachmentLocalPaths?: readonly (string | null)[];
  voiceTranscripts?: readonly string[];
  voiceTranscriptSources?: readonly string[];
}): CustomCurrentRefIndexRecord | null {
  const refIdx = params.event.msgIdx ?? params.inputNotifyRefIdx;
  if (!refIdx) return null;

  const attachments = buildAttachmentSummaries(
    params.event.attachments,
    params.attachmentLocalPaths as Array<string | null> | undefined,
  );
  attachVoiceTranscripts({
    attachments,
    voiceTranscripts: params.voiceTranscripts,
    voiceTranscriptSources: params.voiceTranscriptSources,
  });

  return {
    refIdx,
    source: params.event.msgIdx ? "message_scene.ext" : "InputNotify",
    entry: {
      content: params.parsedContent,
      senderId: params.event.senderId,
      senderName: params.event.senderName,
      timestamp: new Date(params.event.timestamp).getTime(),
      attachments,
    },
  };
}

function formatQuotePart(replyToBody?: string): string {
  return replyToBody
    ? `[引用消息开始]\n${replyToBody}\n[引用消息结束]\n`
    : `[引用消息开始]\n原始内容不可用\n[引用消息结束]\n`;
}

function attachVoiceTranscripts(params: {
  attachments?: RefAttachmentSummary[];
  voiceTranscripts?: readonly string[];
  voiceTranscriptSources?: readonly string[];
}): void {
  if (!params.attachments?.length || !params.voiceTranscripts?.length) return;
  let voiceIdx = 0;
  for (const attachment of params.attachments) {
    if (attachment.type !== "voice" || voiceIdx >= params.voiceTranscripts.length) continue;
    attachment.transcript = params.voiceTranscripts[voiceIdx];
    const source = params.voiceTranscriptSources?.[voiceIdx];
    if (source === "stt" || source === "asr" || source === "tts" || source === "fallback") {
      attachment.transcriptSource = source;
    }
    voiceIdx += 1;
  }
}
