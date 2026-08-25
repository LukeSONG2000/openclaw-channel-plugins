import type { InteractionEvent } from "../types.js";
import type { CustomPeer } from "./types.js";

export interface CustomNormalizedInteractionEvent {
  id: string;
  dataType?: number;
  sceneDesc: string;
  buttonData: string;
  buttonId?: string;
  actorId: string;
  sourcePeer?: CustomPeer;
  replyTarget?: CustomInteractionReplyTarget;
  groupOpenid?: string;
  userOpenid?: string;
  channelId?: string;
  guildId?: string;
  groupMemberOpenid?: string;
  resolved?: Record<string, unknown>;
}

export type CustomInteractionReplyTarget =
  | { kind: "group"; groupOpenid: string }
  | { kind: "c2c"; userOpenid: string }
  | { kind: "channel"; channelId: string };

export interface CustomLegacyApprovalButton {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
}

export function normalizeQQBotInteractionEvent(event: InteractionEvent): CustomNormalizedInteractionEvent {
  const resolved = event.data?.resolved as Record<string, unknown> | undefined;
  return {
    id: event.id,
    dataType: event.data?.type,
    sceneDesc: event.scene ?? resolveInteractionSceneDesc(event.chat_type),
    buttonData: String(resolved?.button_data ?? ""),
    buttonId: typeof resolved?.button_id === "string" ? resolved.button_id : undefined,
    actorId: event.group_member_openid || event.user_openid || stringValue(resolved?.user_id) || "unknown",
    sourcePeer: resolveCustomInteractionSourcePeer({
      groupOpenid: event.group_openid,
      userOpenid: event.user_openid,
      channelId: event.channel_id,
      guildId: event.guild_id,
    }),
    replyTarget: resolveCustomInteractionReplyTarget(event),
    groupOpenid: event.group_openid,
    userOpenid: event.user_openid,
    channelId: event.channel_id,
    guildId: event.guild_id,
    groupMemberOpenid: event.group_member_openid,
    resolved,
  };
}

export function resolveCustomInteractionSourcePeer(input: {
  groupOpenid?: string;
  userOpenid?: string;
  channelId?: string;
  guildId?: string;
}): CustomPeer | undefined {
  if (input.groupOpenid) return { kind: "group", id: input.groupOpenid };
  if (input.userOpenid) return { kind: "c2c", id: input.userOpenid };
  if (input.channelId) return { kind: "channel", id: input.channelId };
  if (input.guildId) return { kind: "dm", id: input.guildId };
  return undefined;
}

export function resolveCustomInteractionReplyTarget(event: InteractionEvent): CustomInteractionReplyTarget | undefined {
  if (event.group_openid) return { kind: "group", groupOpenid: event.group_openid };
  if (event.user_openid) return { kind: "c2c", userOpenid: event.user_openid };
  if (event.channel_id) return { kind: "channel", channelId: event.channel_id };
  return undefined;
}

export function parseLegacyApprovalInteractionButton(buttonData: string): CustomLegacyApprovalButton | null {
  const match = buttonData.match(/^approve:((?:(?:exec|plugin):)?[0-9a-f-]+):(allow-once|allow-always|deny)$/i);
  if (!match) return null;
  return {
    approvalId: match[1]!,
    decision: match[2] as CustomLegacyApprovalButton["decision"],
  };
}

function resolveInteractionSceneDesc(chatType: unknown): string {
  if (chatType === 0) return "guild";
  if (chatType === 1) return "group";
  if (chatType === 2) return "c2c";
  return "c2c";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
