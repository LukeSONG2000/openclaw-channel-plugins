import path from "node:path";
import { onMessageSent as defaultOnMessageSent, type OutboundMeta } from "../api.js";
import type { RefAttachmentSummary, RefIndexEntry } from "../ref-index-store.js";

export interface CustomOutboundRefIndexGatewayLogger {
  info?: (msg: string) => void;
}

export interface RegisterCustomOutboundRefIndexGatewayParams {
  accountId: string;
  onMessageSent?: (callback: (refIdx: string, meta: OutboundMeta) => void) => void;
  setRefEntry: (refIdx: string, entry: RefIndexEntry) => void;
  now?: () => number;
  log?: CustomOutboundRefIndexGatewayLogger;
}

export function registerCustomOutboundRefIndexGateway(
  params: RegisterCustomOutboundRefIndexGatewayParams,
): void {
  (params.onMessageSent ?? defaultOnMessageSent)((refIdx, meta) => {
    params.log?.info?.(`[qqbot:${params.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`);
    const attachments = buildCustomOutboundRefAttachments(meta, params.log, params.accountId);
    params.setRefEntry(refIdx, {
      content: meta.text ?? "",
      senderId: params.accountId,
      senderName: params.accountId,
      timestamp: params.now?.() ?? Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    params.log?.info?.(`[qqbot:${params.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`);
  });
}

export function buildCustomOutboundRefAttachments(
  meta: OutboundMeta,
  log?: CustomOutboundRefIndexGatewayLogger,
  accountId = "default",
): RefAttachmentSummary[] {
  if (!meta.mediaType) return [];

  const filename = meta.mediaLocalPath ? path.basename(meta.mediaLocalPath) : undefined;
  const attachment: RefAttachmentSummary = {
    type: meta.mediaType,
    ...(meta.mediaLocalPath ? { localPath: meta.mediaLocalPath } : {}),
    ...(filename ? { filename } : {}),
    ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
  };
  if (meta.mediaType === "voice" && meta.ttsText) {
    attachment.transcript = meta.ttsText;
    attachment.transcriptSource = "tts";
    log?.info?.(`[qqbot:${accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`);
  }
  return [attachment];
}
