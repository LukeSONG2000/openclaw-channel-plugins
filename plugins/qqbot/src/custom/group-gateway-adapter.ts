import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { slashCommandInput } from "./command-link.js";
import { isCustomRuntimeAdmin } from "./auth-admin.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { formatCustomActorIdentity, formatCustomPeerIdentity } from "./identity-presentation.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";

export interface CustomGroupNamePersist {
  groupOpenid: string;
  name: string;
}

export interface CustomGroupCommandResult {
  handled: boolean;
  reply?: string;
  persist?: CustomGroupNamePersist;
}

type CustomGroupCommand =
  | { kind: "help" }
  | { kind: "rename"; name: string };

export function handleCustomGroupCommand(params: {
  cfg: OpenClawConfig;
  message: QueuedMessage;
  rawContent: string;
}): CustomGroupCommandResult {
  const parsed = parseCustomGroupCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatCustomGroupHelp(parsed.error) };
  const command = parsed.command ?? { kind: "help" as const };
  if (command.kind === "help") return { handled: true, reply: formatCustomGroupHelp() };

  const peer = toCustomPeerFromQueuedMessage(params.message);
  if (peer.kind !== "group") {
    return { handled: true, reply: "⚠️ 群改名只能在 QQ 群聊内使用。" };
  }

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const actor = toCustomActorFromQueuedMessage(params.message);
  if (runtime.enabled === true && !isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      reply: [
        "⛔ 只有 customRuntime.admins 中的管理员可以修改群名称。",
        "",
        `当前用户：${formatCustomActorIdentity(actor, { idLabel: "member_openid" })}`,
      ].join("\n"),
    };
  }

  return {
    handled: true,
    persist: { groupOpenid: peer.id, name: command.name },
    reply: [
      "✅ 群名称已更新",
      "",
      `群聊：${formatCustomPeerIdentity(peer, params.cfg)}`,
      `新名称：${command.name}`,
    ].join("\n"),
  };
}

function parseCustomGroupCommand(rawContent: string): { matched: false } | { matched: true; command?: CustomGroupCommand; error?: string } {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-group") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "rename" || action === "name" || action === "set-name") {
    const name = tokens.join(" ").trim();
    if (!name) return { matched: true, error: "缺少群名称" };
    if (name.length > 30) return { matched: true, error: "群名称不能超过 30 个字符" };
    return { matched: true, command: { kind: "rename", name } };
  }
  return { matched: true, error: `未知子命令：${action}` };
}

function formatCustomGroupHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, "");
  lines.push(
    "👥 QQ 群管理命令",
    "",
    slashCommandInput("/bot-group rename friends-main", "/bot-group rename <群名称>"),
    "",
    "用于给当前 QQ 群绑定易读名称，后续授权、状态、日志展示会优先显示该名称。",
  );
  return lines.join("\n");
}
