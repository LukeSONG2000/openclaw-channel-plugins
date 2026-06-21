import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { getSlashCommandCapability } from "../slash-commands.js";
import {
  type CustomAuthorizationCheckResult,
  type CustomAuthorizationRuntime,
} from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import {
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "./queued-message-context.js";
import type {
  CustomActor,
  CustomCapability,
  CustomPeer,
} from "./types.js";

export {
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "./queued-message-context.js";

export interface CustomSlashAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "not_custom_command" | "allowed" | "denied";
}

export interface CustomDispatchAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "allowed" | "denied";
}

export function resolveCustomDispatchCapability(params: {
  cfg: OpenClawConfig;
  message: QueuedMessage;
  rawContent: string;
}): Exclude<CustomCapability, "*"> {
  const content = params.rawContent.trim();
  if (content.startsWith("/")) return "codex.run";

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const capabilities = scene.capabilities ?? [];
  if (!capabilities.includes("chat.send") && capabilities.includes("codex.run")) {
    return "codex.run";
  }
  if (!capabilities.includes("chat.send") && capabilities.includes("system.status")) {
    return "system.status";
  }
  if (runtime.enabled && runtime.defaultScene === "default-dm" && params.message.type !== "group" && !capabilities.includes("chat.send")) {
    return "codex.run";
  }
  return "chat.send";
}

export function checkCustomDispatchAuthorization(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  capability?: Exclude<CustomCapability, "*">;
  now?: number;
}): CustomDispatchAuthorizationDecision {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return { enabled: false, allowed: true, reason: "runtime_disabled" };
  }

  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);
  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const capability = params.capability ?? resolveCustomDispatchCapability({
    cfg: params.cfg,
    message: params.message,
    rawContent: params.rawContent,
  });
  const result = params.auth.check({
    runtime,
    scene,
    peer,
    actor,
    capability,
    now: params.now,
  });

  return {
    enabled: true,
    allowed: result.decision.allowed,
    capability,
    peer,
    actor,
    result,
    reason: result.decision.allowed ? "allowed" : "denied",
  };
}

export function checkCustomSlashAuthorization(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomSlashAuthorizationDecision {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return { enabled: false, allowed: true, reason: "runtime_disabled" };
  }

  const capability = getSlashCommandCapability(params.rawContent);
  if (!capability) {
    return { enabled: true, allowed: true, reason: "not_custom_command" };
  }

  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);
  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const result = params.auth.check({
    runtime,
    scene,
    peer,
    actor,
    capability,
    now: params.now,
  });

  return {
    enabled: true,
    allowed: result.decision.allowed,
    capability,
    peer,
    actor,
    result,
    reason: result.decision.allowed ? "allowed" : "denied",
  };
}

export function formatCustomDispatchAuthorizationDeniedMessage(decision: CustomDispatchAuthorizationDecision): string {
  const capability = decision.capability ?? "unknown";
  const actor = decision.actor?.label || decision.actor?.id || "当前用户";
  const peer = decision.peer?.label || decision.peer?.id || "当前会话";
  const requestId = decision.result?.decision.requestId;
  const lines = [
    `⛔ 当前场景不允许这类对话或任务`,
    ``,
    `用户：${actor}`,
    `会话：${peer}`,
    `需要能力：${capability}`,
  ];

  if (requestId) {
    lines.push(``, `已创建授权申请：${requestId}`);
    lines.push(`管理员可回复：/bot-auth approve ${requestId} once`);
  } else {
    lines.push(``, `请联系管理员调整 customRuntime 场景能力，或为当前请求授予临时权限。`);
  }

  return lines.join("\n");
}

export function formatCustomAuthorizationDeniedMessage(decision: CustomSlashAuthorizationDecision): string {
  const capability = decision.capability ?? "unknown";
  const actor = decision.actor?.label || decision.actor?.id || "当前用户";
  const peer = decision.peer?.label || decision.peer?.id || "当前会话";
  const requestId = decision.result?.decision.requestId;
  const lines = [
    `⛔ 当前没有执行该插件命令的权限`,
    ``,
    `用户：${actor}`,
    `会话：${peer}`,
    `需要能力：${capability}`,
  ];

  if (requestId) {
    lines.push(``, `已创建授权申请：${requestId}`);
    lines.push(`管理员可回复：/bot-auth approve ${requestId} once`);
  } else {
    lines.push(``, `请联系管理员把你加入 customRuntime.admins，或为当前场景授予该能力。`);
  }

  return lines.join("\n");
}

export {
  buildCustomAuthAdminGroupNotification,
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthApprovalText,
  describeCustomAuthorizationIntents,
  firstCustomAuthApprovalRequest,
  handleCustomAuthCommand,
  handleCustomAuthInteraction,
  parseCustomAuthButtonData,
  parseCustomAuthCommand,
  type CustomAuthAdminGroupNotification,
  type CustomAuthButtonPayload,
  type CustomAuthCommand,
  type CustomAuthCommandParseResult,
  type CustomAuthCommandResult,
  type CustomAuthInteractionResult,
} from "./auth-command-gateway-adapter.js";
