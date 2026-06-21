import type {
  C2CMessageEvent,
  GroupMessageEvent,
  GuildMessageEvent,
} from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import { parseRefIndices } from "../utils/text-parsing.js";

export interface CustomInboundKnownUserRecord {
  openid: string;
  type: "c2c" | "group";
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
}

export type CustomInboundNormalizationResult =
  | {
      kind: "message";
      message: QueuedMessage;
      knownUsers: CustomInboundKnownUserRecord[];
    }
  | {
      kind: "proactive-acceptance";
      peer: { kind: "c2c" | "group"; id: string };
      accepted: boolean;
      updatedBy?: string;
      timestampMs: number;
      logMessage: string;
    }
  | {
      kind: "group-robot";
      action: "add" | "del";
      groupOpenid: string;
      operatorOpenid: string;
      knownUsers: CustomInboundKnownUserRecord[];
      logMessage: string;
    }
  | { kind: "unsupported" };

export function normalizeQQBotInboundEvent(params: {
  eventType: string;
  data: unknown;
  accountId: string;
}): CustomInboundNormalizationResult {
  const { eventType, data, accountId } = params;
  if (eventType === "C2C_MESSAGE_CREATE") {
    return normalizeC2CMessage(data as C2CMessageEvent, accountId);
  }
  if (eventType === "AT_MESSAGE_CREATE") {
    return normalizeGuildMessage(data as GuildMessageEvent, accountId, "guild");
  }
  if (eventType === "DIRECT_MESSAGE_CREATE") {
    return normalizeGuildMessage(data as GuildMessageEvent, accountId, "dm");
  }
  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    return normalizeGroupMessage(eventType, data as GroupMessageEvent, accountId);
  }
  if (eventType === "C2C_MSG_REJECT" || eventType === "C2C_MSG_RECEIVE") {
    const ev = data as { timestamp: number | string; openid: string };
    const accepted = eventType === "C2C_MSG_RECEIVE";
    return {
      kind: "proactive-acceptance",
      peer: { kind: "c2c", id: ev.openid },
      accepted,
      timestampMs: normalizePlatformTimestampMs(ev.timestamp),
      logMessage: `C2C user ${ev.openid} ${accepted ? "accepted" : "rejected"} bot proactive messages`,
    };
  }
  if (eventType === "GROUP_MSG_REJECT" || eventType === "GROUP_MSG_RECEIVE") {
    const ev = data as { timestamp: number | string; group_openid: string; op_member_openid: string };
    const accepted = eventType === "GROUP_MSG_RECEIVE";
    return {
      kind: "proactive-acceptance",
      peer: { kind: "group", id: ev.group_openid },
      accepted,
      updatedBy: ev.op_member_openid,
      timestampMs: normalizePlatformTimestampMs(ev.timestamp),
      logMessage: `Group ${ev.group_openid} ${accepted ? "accepted" : "rejected"} bot proactive messages (by ${ev.op_member_openid})`,
    };
  }
  if (eventType === "GROUP_ADD_ROBOT" || eventType === "GROUP_DEL_ROBOT") {
    const ev = data as { timestamp: string; group_openid: string; op_member_openid: string };
    const action = eventType === "GROUP_ADD_ROBOT" ? "add" : "del";
    return {
      kind: "group-robot",
      action,
      groupOpenid: ev.group_openid,
      operatorOpenid: ev.op_member_openid,
      knownUsers: action === "add"
        ? [{
            openid: ev.op_member_openid,
            type: "group",
            groupOpenid: ev.group_openid,
            accountId,
          }]
        : [],
      logMessage: `Bot ${action === "add" ? "added to" : "removed from"} group: ${ev.group_openid} by ${ev.op_member_openid}`,
    };
  }
  return { kind: "unsupported" };
}

export function normalizePlatformTimestampMs(timestamp: unknown): number {
  const n = typeof timestamp === "number"
    ? timestamp
    : typeof timestamp === "string"
      ? Number(timestamp)
      : NaN;
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 10_000_000_000 ? n * 1000 : n;
}

function normalizeC2CMessage(
  ev: C2CMessageEvent,
  accountId: string,
): CustomInboundNormalizationResult {
  const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
  return {
    kind: "message",
    knownUsers: [{
      openid: ev.author.user_openid,
      type: "c2c",
      accountId,
    }],
    message: {
      type: "c2c",
      senderId: ev.author.user_openid,
      content: ev.content,
      messageId: ev.id,
      timestamp: ev.timestamp,
      attachments: ev.attachments,
      refMsgIdx: refs.refMsgIdx,
      msgIdx: refs.msgIdx,
      msgElements: ev.msg_elements,
      msgType: ev.message_type,
    },
  };
}

function normalizeGuildMessage(
  ev: GuildMessageEvent & {
    message_scene?: { source?: string; ext?: string[] };
    message_type?: number;
    msg_elements?: QueuedMessage["msgElements"];
  },
  accountId: string,
  type: "guild" | "dm",
): CustomInboundNormalizationResult {
  const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
  return {
    kind: "message",
    knownUsers: [{
      openid: ev.author.id,
      type: "c2c",
      nickname: ev.author.username,
      accountId,
    }],
    message: {
      type,
      senderId: ev.author.id,
      senderName: ev.author.username,
      content: ev.content,
      messageId: ev.id,
      timestamp: ev.timestamp,
      channelId: type === "guild" ? ev.channel_id : undefined,
      guildId: ev.guild_id,
      attachments: ev.attachments,
      refMsgIdx: refs.refMsgIdx,
      msgIdx: refs.msgIdx,
      msgType: ev.message_type,
    },
  };
}

function normalizeGroupMessage(
  eventType: string,
  ev: GroupMessageEvent,
  accountId: string,
): CustomInboundNormalizationResult {
  const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
  return {
    kind: "message",
    knownUsers: [{
      openid: ev.author.member_openid,
      type: "group",
      nickname: ev.author.username,
      groupOpenid: ev.group_openid,
      accountId,
    }],
    message: {
      type: "group",
      senderId: ev.author.member_openid,
      senderName: ev.author.username,
      senderIsBot: ev.author.bot,
      content: ev.content,
      messageId: ev.id,
      timestamp: ev.timestamp,
      groupOpenid: ev.group_openid,
      attachments: ev.attachments,
      refMsgIdx: refs.refMsgIdx,
      msgIdx: refs.msgIdx,
      eventType,
      mentions: ev.mentions?.map((mention) => ({
        ...mention,
        username: (mention as { username?: string }).username ?? mention.nickname,
      })),
      messageScene: ev.message_scene,
      msgElements: ev.msg_elements,
      msgType: ev.message_type,
    },
  };
}
