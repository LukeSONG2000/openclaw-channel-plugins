import type { QueuedMessage } from "../message-queue.js";

export type CustomSlashReplyTarget =
  | { kind: "c2c"; userOpenid: string; msgId: string }
  | { kind: "group"; groupOpenid: string; msgId: string }
  | { kind: "channel"; channelId: string; msgId: string }
  | { kind: "dm"; guildId: string; msgId: string };

export function resolveCustomSlashReplyTarget(msg: QueuedMessage): CustomSlashReplyTarget | null {
  if (msg.type === "c2c") {
    return { kind: "c2c", userOpenid: msg.senderId, msgId: msg.messageId };
  }
  if (msg.type === "group" && msg.groupOpenid) {
    return { kind: "group", groupOpenid: msg.groupOpenid, msgId: msg.messageId };
  }
  if (msg.type === "guild" && msg.channelId) {
    return { kind: "channel", channelId: msg.channelId, msgId: msg.messageId };
  }
  if (msg.type === "dm" && msg.guildId) {
    return { kind: "dm", guildId: msg.guildId, msgId: msg.messageId };
  }
  return null;
}

export function resolveCustomSlashReplyMediaTarget(msg: QueuedMessage): { targetType: "c2c" | "group" | "channel"; targetId: string } | null {
  if (msg.type === "group" && msg.groupOpenid) return { targetType: "group", targetId: msg.groupOpenid };
  if (msg.type === "c2c") return { targetType: "c2c", targetId: msg.senderId };
  if (msg.type === "guild" && msg.channelId) return { targetType: "channel", targetId: msg.channelId };
  return null;
}
