import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard } from "../types.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { isCustomRuntimeAdmin } from "./auth-admin.js";
import { CustomDeployConfirmationRuntime } from "./deploy-confirmation.js";
import { slashCommandInput } from "./command-link.js";
import {
  buildCustomDeployPreflightKeyboard,
  buildCustomDeployPreflightSummary,
  formatCustomDeployPreflightSummary,
} from "./deploy-preflight.js";
import { parseCustomDeployButtonData, parseCustomDeployCommand } from "./deploy-command-parser.js";
import {
  buildCustomDeployConfirmationKeyboard,
  formatCustomDeployHelp,
  formatDeployConfirmationCreated,
  formatDeployConfirmationList,
  formatDeployConfirmationResolved,
  formatDeployConfirmationStatus,
  formatDeployDecision,
} from "./deploy-presentation.js";
import type { CustomActor, CustomDeployConfirmation, CustomPeer } from "./types.js";

export {
  parseCustomDeployButtonData,
  parseCustomDeployCommand,
  type CustomDeployButtonDecision,
  type CustomDeployButtonPayload,
  type CustomDeployCommand,
  type CustomDeployCommandParseResult,
} from "./deploy-command-parser.js";

export {
  buildCustomDeployConfirmationKeyboard,
  formatCustomDeployHelp,
  formatDeployConfirmationCreated,
  formatDeployConfirmationList,
  formatDeployConfirmationResolved,
  formatDeployConfirmationStatus,
  formatDeployDecision,
} from "./deploy-presentation.js";

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
  if (!runtime.enabled) return { handled: true, reply: `ℹ️ customRuntime 未启用，无法使用 ${slashCommandInput("/bot-deploy")}。` };
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
    const summary = buildCustomDeployPreflightSummary(params.cfg);
    return {
      handled: true,
      reply: formatCustomDeployPreflightSummary(summary),
      keyboard: buildCustomDeployPreflightKeyboard(summary),
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

export function handleCustomDeployInteraction(params: {
  cfg: OpenClawConfig;
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
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (runtime.enabled === true && !isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      changed: false,
      reply: [
        "⛔ 只有 customRuntime.admins 中的管理员可以处理部署确认按钮。",
        "",
        `当前用户：${actor.label ? `${actor.label}（openid：${actor.id}）` : `openid：${actor.id}`}`,
      ].join("\n"),
    };
  }
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
