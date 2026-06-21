import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./auth-gateway-adapter.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { CustomDeployConfirmationRuntime, normalizeDeployCommand } from "./deploy-confirmation.js";
import { buildCustomDeployPreflightSummary, formatCustomDeployPreflightSummary } from "./deploy-preflight.js";
import type { CustomActor, CustomDeployConfirmation, CustomPeer } from "./types.js";

export type CustomDeployCommand =
  | { kind: "help" }
  | { kind: "confirm"; command: string }
  | { kind: "list" }
  | { kind: "status"; confirmationId: string }
  | { kind: "preflight" };

export type CustomDeployCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomDeployCommand; error?: string };

export interface CustomDeployCommandResult {
  handled: boolean;
  reply?: string;
  keyboard?: InlineKeyboard;
  changed?: boolean;
}

export interface CustomDeployInteractionResult {
  handled: boolean;
  reply?: string;
  changed?: boolean;
}

export function parseCustomDeployCommand(rawContent: string): CustomDeployCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-deploy") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "preflight" || action === "check" || action === "safety") return { matched: true, command: { kind: "preflight" } };
  if (action === "status" || action === "show") {
    const confirmationId = tokens.shift();
    if (!confirmationId) return { matched: true, error: "缺少 confirmationId" };
    return { matched: true, command: { kind: "status", confirmationId } };
  }
  if (action === "confirm" || action === "plan") {
    const command = tokens.join(" ").trim();
    if (!command) return { matched: true, error: "缺少需要确认的升级命令，例如 /bot-deploy confirm /bot-upgrade --latest" };
    if (!normalizeDeployCommand(command)) return { matched: true, error: "当前只支持确认 /bot-upgrade 的带参数命令" };
    return { matched: true, command: { kind: "confirm", command } };
  }
  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomDeployCommand(params: {
  cfg: OpenClawConfig;
  accountId: string;
  confirmations: CustomDeployConfirmationRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomDeployCommandResult {
  const parsed = parseCustomDeployCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) return { handled: true, reply: "ℹ️ customRuntime 未启用，无法使用 /bot-deploy。" };
  if (parsed.error) return { handled: true, reply: formatCustomDeployHelp(parsed.error) };
  const command = parsed.command ?? { kind: "help" as const };
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);

  if (command.kind === "help") return { handled: true, reply: formatCustomDeployHelp() };
  if (command.kind === "list") {
    return {
      handled: true,
      reply: formatDeployConfirmationList(params.confirmations.list({ accountId: params.accountId, peer, limit: 8, now: params.now })),
    };
  }
  if (command.kind === "preflight") {
    return {
      handled: true,
      reply: formatCustomDeployPreflightSummary(buildCustomDeployPreflightSummary(params.cfg)),
    };
  }
  if (command.kind === "status") {
    const confirmation = resolveDeployConfirmation(params.confirmations, command.confirmationId);
    if (!confirmation || !canReadDeployConfirmation(confirmation, params.accountId, peer, actor)) {
      return { handled: true, reply: `⚠️ 未找到部署确认，或该确认不属于当前会话：${command.confirmationId}` };
    }
    return {
      handled: true,
      reply: formatDeployConfirmationStatus(confirmation, params.now),
      keyboard: confirmation.status === "pending" ? buildCustomDeployConfirmationKeyboard(confirmation) : undefined,
    };
  }
  if (command.kind === "confirm") {
    const result = params.confirmations.create({
      accountId: params.accountId,
      peer,
      creator: actor,
      command: command.command,
      now: params.now,
    });
    if (!result.allowed || !result.confirmation) return { handled: true, reply: formatDeployDecision(result.reason) };
    return {
      handled: true,
      changed: true,
      reply: formatDeployConfirmationCreated(result.confirmation),
      keyboard: buildCustomDeployConfirmationKeyboard(result.confirmation),
    };
  }
  return { handled: true, reply: formatCustomDeployHelp() };
}

export function parseCustomDeployButtonData(buttonData: string): { confirmationId: string; decision: "confirm" | "cancel" } | null {
  const m = buttonData.match(/^custom-deploy:([^:]+):(confirm|cancel)$/i);
  if (!m) return null;
  return { confirmationId: m[1]!, decision: m[2]!.toLowerCase() as "confirm" | "cancel" };
}

export function handleCustomDeployInteraction(params: {
  accountId?: string;
  confirmations: CustomDeployConfirmationRuntime;
  buttonData: string;
  actorId: string;
  actorLabel?: string;
  sourcePeer?: CustomPeer;
  now?: number;
}): CustomDeployInteractionResult {
  const payload = parseCustomDeployButtonData(params.buttonData);
  if (!payload) return { handled: false };
  const actor: CustomActor = { id: params.actorId, label: params.actorLabel };
  const confirmation = params.confirmations.get(payload.confirmationId);
  if (!canInteractWithDeployConfirmation({
    confirmation,
    accountId: params.accountId,
    sourcePeer: params.sourcePeer,
    actor,
  })) {
    return {
      handled: true,
      changed: false,
      reply: "⚠️ 部署确认不存在，或该确认不属于当前会话。",
    };
  }
  const result = params.confirmations.resolve({
    confirmationId: payload.confirmationId,
    actor,
    approved: payload.decision === "confirm",
    now: params.now,
  });
  return {
    handled: true,
    changed: result.allowed || result.reason === "expired",
    reply: result.confirmation ? formatDeployConfirmationResolved(result.confirmation, result.reason) : formatDeployDecision(result.reason),
  };
}

export function buildCustomDeployConfirmationKeyboard(confirmation: CustomDeployConfirmation): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            makeDeployButton({
              id: "confirm",
              label: "确认",
              visitedLabel: "已确认",
              data: `custom-deploy:${confirmation.id}:confirm`,
              style: 1,
            }),
            makeDeployButton({
              id: "cancel",
              label: "取消",
              visitedLabel: "已取消",
              data: `custom-deploy:${confirmation.id}:cancel`,
              style: 3,
            }),
          ],
        },
      ],
    },
  };
}

function makeDeployButton(params: {
  id: string;
  label: string;
  visitedLabel: string;
  data: string;
  style: 0 | 1 | 3;
}): KeyboardButton {
  return {
    id: `deploy_${params.id}`,
    render_data: { label: params.label, visited_label: params.visitedLabel, style: params.style },
    action: {
      type: 1,
      data: params.data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "custom-deploy",
  };
}

function formatCustomDeployHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🚀 自定义部署确认命令`,
    ``,
    `/bot-deploy confirm /bot-upgrade --latest`,
    `/bot-deploy confirm /bot-upgrade --version <version>`,
    `/bot-deploy list`,
    `/bot-deploy status <confirmationId>`,
    `/bot-deploy preflight`,
    ``,
    `当前只创建确认卡，不自动执行升级。确认后仍需管理员手动发送确认中的升级命令。`,
  );
  return lines.join("\n");
}

function formatDeployConfirmationCreated(confirmation: CustomDeployConfirmation): string {
  return [
    `🚀 部署确认已创建`,
    ``,
    `确认：${confirmation.id}`,
    `命令：${confirmation.command}`,
    `发起人：${confirmation.creator.label || confirmation.creator.id}`,
    `过期：${formatExpiresIn(confirmation.expiresAt)}`,
    ``,
    `点击确认只会记录确认状态，不会自动执行热更新。`,
    `确认后请在管理员私聊中手动发送：${confirmation.command}`,
  ].join("\n");
}

function formatDeployConfirmationList(confirmations: CustomDeployConfirmation[]): string {
  if (confirmations.length === 0) return "🚀 当前会话暂无部署确认。";
  const lines = ["🚀 当前会话部署确认", ""];
  for (const confirmation of confirmations) {
    lines.push(`- ${confirmation.id} [${confirmation.status}] ${confirmation.command}`);
  }
  return lines.join("\n");
}

function formatDeployConfirmationStatus(confirmation: CustomDeployConfirmation, now?: number): string {
  return [
    `🚀 部署确认状态`,
    ``,
    `确认：${confirmation.id}`,
    `状态：${confirmation.status}`,
    `命令：${confirmation.command}`,
    `发起人：${confirmation.creator.label || confirmation.creator.id}`,
    `过期：${formatExpiresIn(confirmation.expiresAt, now)}`,
    ...(confirmation.resolvedBy ? [`处理人：${confirmation.resolvedBy.label || confirmation.resolvedBy.id}`] : []),
  ].join("\n");
}

function formatDeployConfirmationResolved(confirmation: CustomDeployConfirmation, reason: string): string {
  if (reason === "expired") {
    return [
      `⚠️ 部署确认已过期`,
      ``,
      `确认：${confirmation.id}`,
      `命令：${confirmation.command}`,
    ].join("\n");
  }
  if (reason === "not_pending") {
    return [
      `⚠️ 部署确认已处理`,
      ``,
      `确认：${confirmation.id}`,
      `状态：${confirmation.status}`,
      `命令：${confirmation.command}`,
    ].join("\n");
  }
  if (confirmation.status === "confirmed") {
    return [
      `✅ 已确认部署操作`,
      ``,
      `确认：${confirmation.id}`,
      `命令：${confirmation.command}`,
      ``,
      `安全起见，本卡片不会自动执行热更新。`,
      `请管理员在私聊中手动发送该命令，并确保已完成服务器备份。`,
    ].join("\n");
  }
  if (confirmation.status === "cancelled") {
    return [
      `✅ 已取消部署操作`,
      ``,
      `确认：${confirmation.id}`,
      `命令：${confirmation.command}`,
    ].join("\n");
  }
  return formatDeployDecision(reason);
}

function formatDeployDecision(reason: string): string {
  if (reason === "invalid_command") return "⚠️ 当前只支持确认 /bot-upgrade 的带参数命令。";
  if (reason === "not_found") return "⚠️ 部署确认不存在。";
  if (reason === "not_pending") return "⚠️ 部署确认已处理。";
  if (reason === "expired") return "⚠️ 部署确认已过期。";
  return `⚠️ 操作失败：${reason}`;
}

function resolveDeployConfirmation(
  confirmations: CustomDeployConfirmationRuntime,
  input: string,
): CustomDeployConfirmation | null {
  const exact = confirmations.get(input);
  if (exact) return exact;
  const matches = confirmations.list({ limit: Number.MAX_SAFE_INTEGER })
    .filter((confirmation) => confirmation.id.startsWith(input) || confirmation.id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function canReadDeployConfirmation(
  confirmation: CustomDeployConfirmation,
  accountId: string,
  peer: ReturnType<typeof toCustomPeerFromQueuedMessage>,
  actor: ReturnType<typeof toCustomActorFromQueuedMessage>,
): boolean {
  if (confirmation.accountId !== accountId) return false;
  if (confirmation.creator.id.toUpperCase() === actor.id.toUpperCase()) return true;
  return confirmation.peer.kind === peer.kind && confirmation.peer.id === peer.id;
}

function canInteractWithDeployConfirmation(params: {
  confirmation: CustomDeployConfirmation | null;
  accountId?: string;
  sourcePeer?: CustomPeer;
  actor: CustomActor;
}): boolean {
  const { confirmation } = params;
  if (!confirmation) return false;
  if (params.accountId && confirmation.accountId !== params.accountId) return false;
  if (confirmation.creator.id.toUpperCase() === params.actor.id.toUpperCase()) return true;
  if (!params.sourcePeer) return true;
  return confirmation.peer.kind === params.sourcePeer.kind && confirmation.peer.id === params.sourcePeer.id;
}

function formatExpiresIn(expiresAt: number, now: number = Date.now()): string {
  return `${Math.max(0, Math.ceil((expiresAt - now) / 1000))} 秒后`;
}
