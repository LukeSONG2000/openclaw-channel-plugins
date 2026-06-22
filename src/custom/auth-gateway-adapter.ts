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
import {
  formatCustomActorIdentity,
  formatCustomPeerIdentity,
} from "./identity-presentation.js";
import { slashCommandInput } from "./command-link.js";
import { formatCapabilityForUser } from "./presentation-labels.js";
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
  cfg?: OpenClawConfig;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "not_custom_command" | "allowed" | "denied";
}

export interface CustomDispatchAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  cfg?: OpenClawConfig;
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

  if (detectCustomRuleWriteIntent(content)) return "config.write";

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

export function detectCustomRuleWriteIntent(content: string): boolean {
  const text = content.replace(/<@[^>]+>/g, " ").trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  if (/(agents?\.md|memory\.md|soul\.md|tools\.md|heartbeat\.md|bootstrap\.md)/i.test(text)) {
    return /(写入|写进|写到|保存|追加|新增|添加|修改|改成|删除|移除|更新|规则|记忆|指令)/.test(text);
  }

  if (/(保存到记忆|存到记忆|写入记忆|写进记忆|保存进记忆|记到记忆|记下来|记住)/.test(text)) return true;
  if (/(新增|添加|修改|改成|删除|移除|更新).{0,12}(规则|指令|提示词|prompt)/i.test(text)) return true;
  if (/(规则|指令|提示词|prompt).{0,12}(新增|添加|修改|改成|删除|移除|更新|写入|保存)/i.test(text)) return true;
  if (/以后.{0,24}(有人|群里|大家|谁|用户).{0,24}(说|发|问|询问|提到|触发).{0,32}(回复|回答|回|说|输出)/.test(text)) return true;
  if (/(当|如果|若|只要|遇到|看到|收到).{0,40}(用户|有人|群里|大家|谁|成员|对方)?.{0,24}(说|发|发送|问|询问|提到|触发|输入|出现|包含).{0,48}(回复|回答|回|说|输出)/.test(text)) return true;
  if (/(说|发|发送|问|询问|提到|触发|输入|出现|包含).{0,40}(时|的时候|后|就|则|，|,).{0,32}(回复|回答|回|说|输出)/.test(text)
    && /(当|如果|若|只要|遇到|看到|收到|用户|有人|群里|大家|谁|成员|对方)/.test(text)) return true;
  if (/以后.{0,24}(回复|回答|回|说|输出).{0,32}(规则|记忆)/.test(text)) return true;

  return lower.includes("agent.md") && /(写|改|删|规则|记忆)/.test(text);
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
    return { enabled: false, allowed: true, cfg: params.cfg, reason: "runtime_disabled" };
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
    cfg: params.cfg,
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
    return { enabled: false, allowed: true, cfg: params.cfg, reason: "runtime_disabled" };
  }

  const capability = getSlashCommandCapability(params.rawContent);
  if (!capability) {
    return { enabled: true, allowed: true, cfg: params.cfg, reason: "not_custom_command" };
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
    cfg: params.cfg,
    capability,
    peer,
    actor,
    result,
    reason: result.decision.allowed ? "allowed" : "denied",
  };
}

export function formatCustomDispatchAuthorizationDeniedMessage(decision: CustomDispatchAuthorizationDecision): string {
  return formatCustomAuthorizationDeniedCore({
    title: "⛔ 需要授权",
    capability: decision.capability,
    actor: decision.actor,
    peer: decision.peer,
    cfg: decision.cfg,
    requestId: decision.result?.decision.requestId,
  });
}

export function formatCustomAuthorizationDeniedMessage(decision: CustomSlashAuthorizationDecision): string {
  return formatCustomAuthorizationDeniedCore({
    title: "⛔ 需要授权",
    capability: decision.capability,
    actor: decision.actor,
    peer: decision.peer,
    cfg: decision.cfg,
    requestId: decision.result?.decision.requestId,
  });
}

function formatCustomAuthorizationDeniedCore(params: {
  title: string;
  capability?: Exclude<CustomCapability, "*">;
  actor?: CustomActor;
  peer?: CustomPeer;
  cfg?: OpenClawConfig;
  requestId?: string;
}): string {
  const capability = params.capability ? formatCapabilityForUser(params.capability) : "未知";
  const actor = params.actor
    ? formatCustomActorIdentity(params.actor, { idLabel: params.peer?.kind === "group" ? "member_openid" : "user_openid" })
    : "当前用户";
  const peer = params.peer ? formatCustomPeerIdentity(params.peer, params.cfg) : "当前会话";
  const lines = [
    params.title,
    `位置：${peer}`,
    `用户：${actor}`,
    `权限：${capability}`,
  ];

  if (params.requestId) {
    lines.push(`操作：${slashCommandInput(`/bot-auth approve ${params.requestId} once`, "允许一次")} ${slashCommandInput(`/bot-auth deny ${params.requestId}`, "拒绝")}`);
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
