import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { KnownUser } from "../known-users.js";
import type { CustomActor, CustomPeer } from "./types.js";

export function formatCustomActorIdentity(actor: Pick<CustomActor, "id" | "label" | "isBot"> | undefined, params: {
  idLabel?: string;
  fallback?: string;
} = {}): string {
  if (!actor?.id) return params.fallback ?? "未知用户";
  const idLabel = params.idLabel ?? "openid";
  const label = normalizeDisplayLabel(actor.label, actor.id);
  const suffix = actor.isBot ? "，机器人" : "";
  return label ? `${label}（${idLabel}：${actor.id}${suffix}）` : `${idLabel}：${actor.id}${suffix}`;
}

export function formatCustomPeerIdentity(peer: CustomPeer | undefined, cfg?: OpenClawConfig): string {
  if (!peer?.id) return "未知会话";
  if (peer.kind === "group") {
    const groupOpenid = stripPeerPrefix(peer.id, "qqbot:group:");
    const label = normalizeDisplayLabel(peer.label ?? resolveConfiguredGroupName(cfg, groupOpenid), groupOpenid);
    return label ? `群聊：${label}（group_openid：${groupOpenid}）` : `群聊（group_openid：${groupOpenid}）`;
  }
  if (peer.kind === "c2c") {
    const label = normalizeDisplayLabel(peer.label, peer.id);
    return label ? `私聊：${label}（user_openid：${peer.id}）` : `私聊（user_openid：${peer.id}）`;
  }
  if (peer.kind === "channel") {
    const label = normalizeDisplayLabel(peer.label, peer.id);
    return label ? `频道：${label}（channel_id：${peer.id}）` : `频道（channel_id：${peer.id}）`;
  }
  if (peer.kind === "dm") {
    const label = normalizeDisplayLabel(peer.label, peer.id);
    return label ? `频道私信：${label}（guild_id：${peer.id}）` : `频道私信（guild_id：${peer.id}）`;
  }
  return `${peer.kind}：${peer.id}`;
}

export function formatCustomAdminGroupIdentity(adminGroup: string | undefined, cfg?: OpenClawConfig): string | undefined {
  const groupOpenid = parseGroupOpenid(adminGroup);
  if (!groupOpenid) return adminGroup;
  return formatCustomPeerIdentity({ kind: "group", id: groupOpenid }, cfg);
}

export function resolveKnownCustomActorLabel(params: {
  accountId: string;
  actorId: string;
  peer?: CustomPeer;
  getKnownUser?: (accountId: string, openid: string, type?: "c2c" | "group", groupOpenid?: string) => KnownUser | undefined;
}): string | undefined {
  const type = params.peer?.kind === "group" ? "group" : "c2c";
  const groupOpenid = params.peer?.kind === "group" ? stripPeerPrefix(params.peer.id, "qqbot:group:") : undefined;
  return params.getKnownUser?.(params.accountId, params.actorId, type, groupOpenid)?.nickname;
}

export function resolveConfiguredGroupName(cfg: OpenClawConfig | undefined, groupOpenid: string): string | undefined {
  const groups = (cfg as any)?.channels?.qqbot?.groups as Record<string, { name?: unknown }> | undefined;
  const name = groups?.[groupOpenid]?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function parseGroupOpenid(value: string | undefined): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (raw.startsWith("qqbot:group:")) return raw.slice("qqbot:group:".length).trim() || undefined;
  if (raw.startsWith("group:")) return raw.slice("group:".length).trim() || undefined;
  if (raw.startsWith("qqbot:")) return undefined;
  return raw;
}

function stripPeerPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function normalizeDisplayLabel(label: unknown, id: string): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  if (!trimmed || trimmed === id) return undefined;
  return trimmed;
}
