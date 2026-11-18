import type { QueuedMessage } from "../message-queue.js";

export function buildQQImagenInput(
  event: QueuedMessage,
  localImagePaths: readonly string[],
) {
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
  if (!match) return;
  const expectedImages = (event.attachments ?? []).filter((item) => item.content_type?.startsWith("image/")).length;
  return { args: match[1] ?? "", images: [...localImagePaths], expectedImages };
}
