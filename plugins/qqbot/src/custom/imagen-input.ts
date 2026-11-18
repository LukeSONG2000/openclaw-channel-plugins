import type { QueuedMessage } from "../message-queue.js";
import { MSG_TYPE_QUOTE } from "../types.js";

const recentImages = new Map<string, { at: number; paths: string[] }>();

export function getRecentQQImagenImages(conversation: string, now = Date.now()): string[] {
  const item = recentImages.get(conversation);
  if (!item || now - item.at > 10 * 60_000) return [];
  return [...item.paths];
}

export function rememberQQImagenImages(
  conversation: string, event: QueuedMessage, paths: readonly string[], now = Date.now(),
): void {
  if (event.senderIsBot || event._customUnreadSnapshotId || event._slashAuthorized || event._mergedMessages?.length ||
      (event.type !== "group" && event.type !== "c2c")) return;
  const count = (event.attachments ?? []).filter((item) => item.content_type?.startsWith("image/")).length;
  if (count < 1 || count > 4 || count !== paths.length) return;
  recentImages.delete(conversation);
  if (recentImages.size >= 128) recentImages.delete(recentImages.keys().next().value!);
  recentImages.set(conversation, { at: now, paths: [...paths] });
}

export function getQQImagenQuotedImages(event: Pick<QueuedMessage, "msgType" | "msgElements" | "refMsgIdx">) {
  const original = event.msgElements?.[0];
  if (event.msgType !== MSG_TYPE_QUOTE || !event.refMsgIdx || original?.msg_idx !== event.refMsgIdx) return [];
  return (original.attachments ?? []).filter((item) => item.content_type?.startsWith("image/"));
}

export function buildQQImagenInput(
  event: QueuedMessage,
  localImagePaths: readonly string[],
): { args?: string; naturalText?: string; images: string[]; expectedImages: number } | undefined {
  if (event.senderIsBot || event._customUnreadSnapshotId || event._slashAuthorized || event._mergedMessages?.length ||
      (event.type !== "c2c" && event.type !== "group")) return;
  const own = new Set(event.mentions?.filter((m) => m.is_you)
    .flatMap((m) => [m.id, m.member_openid, m.user_openid]).filter(Boolean));
  let text = event.content.trim();
  if (event.type === "group") {
    while (true) {
      const prefix = /^<@!?([\w-]+)>\s*/.exec(text);
      if (!prefix || !own.has(prefix[1])) break;
      text = text.slice(prefix[0].length);
    }
  }
  const match = /^\/imagen(?:\s+([\s\S]*))?$/i.exec(text);
  const directRequest = !text.startsWith("/") && !/^<@/u.test(text)
    && (event.type === "c2c" || event.mentions?.some((m) => m.is_you === true));
  if (!match && !directRequest) return;
  const expectedImages = (event.attachments ?? []).filter((item) => item.content_type?.startsWith("image/")).length;
  return {
    ...(match ? { args: match[1] ?? "" } : { naturalText: text }),
    images: [...localImagePaths],
    expectedImages,
  };
}
