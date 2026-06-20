import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { getSlashCommandCapability } from "../slash-commands.js";
import { isCustomRuntimeAdmin, type CustomAuthorizationCheckResult, type CustomAuthorizationRuntime } from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import type {
  CustomActor,
  CustomAuthorizationApprovalRequest,
  CustomAuthorizationIntent,
  CustomCapability,
  CustomGrantUse,
  CustomPeer,
} from "./types.js";
import type { InlineKeyboard, KeyboardButton } from "../types.js";

export interface CustomSlashAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "not_custom_command" | "allowed" | "denied";
}

export function toCustomPeerFromQueuedMessage(message: QueuedMessage): CustomPeer {
  if (message.type === "group") {
    return {
      kind: "group",
      id: message.groupOpenid ?? "unknown",
    };
  }
  if (message.type === "guild") {
    return {
      kind: "channel",
      id: message.channelId ?? "unknown",
    };
  }
  if (message.type === "dm") {
    return {
      kind: "dm",
      id: message.senderId,
    };
  }
  return {
    kind: "c2c",
    id: message.senderId,
  };
}

export function toCustomActorFromQueuedMessage(message: QueuedMessage): CustomActor {
  return {
    id: message.senderId,
    label: message.senderName,
    isBot: message.senderIsBot,
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

export type CustomAuthCommand =
  | { kind: "help" }
  | { kind: "status" }
  | {
      kind: "resolve";
      requestId: string;
      approved: boolean;
      grantUse?: CustomGrantUse;
      grantCount?: number;
      grantTtlMs?: number;
    };

export type CustomAuthCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomAuthCommand; error?: string };

export interface CustomAuthCommandResult {
  handled: boolean;
  reply?: string;
  intent?: CustomAuthorizationIntent;
}

export interface CustomAuthInteractionResult {
  handled: boolean;
  reply?: string;
  intent?: CustomAuthorizationIntent;
}

type CustomAuthButtonDecision = "allow-once" | "allow-count" | "allow-timed" | "deny";

export interface CustomAuthButtonPayload {
  requestId: string;
  decision: CustomAuthButtonDecision;
}

export function parseCustomAuthCommand(rawContent: string): CustomAuthCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };

  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  const name = rawName.toLowerCase();
  if (name !== "bot-auth") return { matched: false };

  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "status") return { matched: true, command: { kind: "status" } };

  if (action === "approve" || action === "allow" || action === "allow-once" || action === "allow-count" || action === "allow-timed") {
    const requestId = tokens.shift();
    if (!requestId) return { matched: true, error: "缺少 requestId" };

    let grantUse: CustomGrantUse = "once";
    let grantCount: number | undefined;
    let grantTtlMs: number | undefined;

    if (action === "allow-count") grantUse = "count";
    if (action === "allow-timed") grantUse = "timed";

    const mode = action === "allow-count" || action === "allow-timed"
      ? undefined
      : tokens.shift()?.toLowerCase();
    if (mode) {
      if (mode === "once") {
        grantUse = "once";
      } else if (mode === "count") {
        grantUse = "count";
        const countRaw = tokens.shift();
        const count = countRaw ? Number.parseInt(countRaw, 10) : NaN;
        if (!Number.isFinite(count) || count < 1) {
          return { matched: true, error: "count 需要大于 0 的整数" };
        }
        grantCount = count;
      } else if (mode === "timed") {
        grantUse = "timed";
        const durationRaw = tokens.shift();
        const ttlMs = durationRaw ? parseDurationMs(durationRaw) : null;
        if (!ttlMs) {
          return { matched: true, error: "timed 需要时长，例如 10m、1h、30s" };
        }
        grantTtlMs = ttlMs;
      } else {
        return { matched: true, error: `未知授权方式：${mode}` };
      }
    }

    if (action === "allow-count" && grantCount === undefined) {
      const countRaw = tokens.shift();
      const count = countRaw ? Number.parseInt(countRaw, 10) : NaN;
      if (!Number.isFinite(count) || count < 1) {
        return { matched: true, error: "allow-count 需要次数，例如 /bot-auth allow-count <requestId> 3" };
      }
      grantCount = count;
    }
    if (action === "allow-timed" && grantTtlMs === undefined) {
      const durationRaw = tokens.shift();
      const ttlMs = durationRaw ? parseDurationMs(durationRaw) : null;
      if (!ttlMs) {
        return { matched: true, error: "allow-timed 需要时长，例如 /bot-auth allow-timed <requestId> 10m" };
      }
      grantTtlMs = ttlMs;
    }

    return {
      matched: true,
      command: {
        kind: "resolve",
        requestId,
        approved: true,
        grantUse,
        grantCount,
        grantTtlMs,
      },
    };
  }

  if (action === "deny" || action === "reject") {
    const requestId = tokens.shift();
    if (!requestId) return { matched: true, error: "缺少 requestId" };
    return { matched: true, command: { kind: "resolve", requestId, approved: false } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomAuthCommand(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomAuthCommandResult {
  const parsed = parseCustomAuthCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return {
      handled: true,
      reply: [
        `ℹ️ customRuntime 未启用`,
        ``,
        `请先在 channels.qqbot.customRuntime.enabled=true 后再使用 /bot-auth。`,
      ].join("\n"),
    };
  }

  const actor = toCustomActorFromQueuedMessage(params.message);
  if (!isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      reply: [
        `⛔ 只有 customRuntime.admins 中的管理员可以处理授权申请。`,
        ``,
        `当前用户：${actor.label || actor.id}`,
      ].join("\n"),
    };
  }

  if (parsed.error) {
    return { handled: true, reply: formatCustomAuthHelp(parsed.error) };
  }

  const command = parsed.command ?? { kind: "help" as const };
  if (command.kind === "help") {
    return { handled: true, reply: formatCustomAuthHelp() };
  }

  if (command.kind === "status") {
    return { handled: true, reply: formatCustomAuthStatus(params.auth) };
  }

  const state = params.auth.getState();
  const requestId = findPendingRequestId(Object.keys(state.requests), command.requestId);
  if (!requestId) {
    return {
      handled: true,
      reply: `⚠️ 未找到待处理授权申请：${command.requestId}`,
    };
  }

  const intent = params.auth.resolveApproval({
    requestId,
    approved: command.approved,
    resolvedBy: actor.id,
    now: params.now,
    grantUse: command.grantUse,
    grantCount: command.grantCount,
    grantTtlMs: command.grantTtlMs,
  });
  if (!intent || intent.kind !== "approval-resolved") {
    return {
      handled: true,
      reply: `⚠️ 授权申请已不存在或不再是 pending：${requestId}`,
    };
  }

  return {
    handled: true,
    intent,
    reply: formatApprovalResolution(intent),
  };
}

export function buildCustomAuthApprovalText(request: CustomAuthorizationApprovalRequest): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
  const lines = [
    `🔐 自定义权限申请`,
    ``,
    `用户：${request.actor.label || request.actor.id}`,
    `会话：${request.peer.label || request.peer.id}`,
    `能力：${request.capability}`,
    `场景：${request.sceneLabel || request.scene}`,
    `申请：${request.id}`,
    ``,
    `超时：${expiresInSec} 秒`,
    `也可回复 /bot-auth approve ${request.id} once`,
  ];
  return lines.join("\n");
}

export function buildCustomAuthApprovalKeyboard(requestId: string): InlineKeyboard {
  const makeBtn = (
    id: string,
    label: string,
    visitedLabel: string,
    data: string,
    style: 0 | 1 | 3,
  ): KeyboardButton => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "custom-auth",
  });
  return {
    content: {
      rows: [
        {
          buttons: [
            makeBtn("allow_once", "允许一次", "已允许一次", `custom-auth:${requestId}:allow-once`, 1),
            makeBtn("allow_count", "允许3次", "已允许3次", `custom-auth:${requestId}:allow-count`, 1),
            makeBtn("deny", "拒绝", "已拒绝", `custom-auth:${requestId}:deny`, 3),
          ],
        },
      ],
    },
  };
}

export function parseCustomAuthButtonData(buttonData: string): CustomAuthButtonPayload | null {
  const m = buttonData.match(/^custom-auth:([^:]+):(allow-once|allow-count|allow-timed|deny)$/i);
  if (!m) return null;
  return {
    requestId: m[1]!,
    decision: m[2]!.toLowerCase() as CustomAuthButtonDecision,
  };
}

export function handleCustomAuthInteraction(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  buttonData: string;
  actorId: string;
  actorLabel?: string;
  now?: number;
}): CustomAuthInteractionResult {
  const payload = parseCustomAuthButtonData(params.buttonData);
  if (!payload) return { handled: false };

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return { handled: true, reply: `ℹ️ customRuntime 未启用，无法处理授权按钮。` };
  }

  const actor: CustomActor = { id: params.actorId, label: params.actorLabel };
  if (!isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      reply: [
        `⛔ 只有 customRuntime.admins 中的管理员可以处理授权按钮。`,
        ``,
        `当前用户：${actor.label || actor.id}`,
      ].join("\n"),
    };
  }

  const command: CustomAuthCommand = payload.decision === "deny"
    ? { kind: "resolve", requestId: payload.requestId, approved: false }
    : payload.decision === "allow-count"
      ? { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "count", grantCount: 3 }
      : payload.decision === "allow-timed"
        ? { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "timed", grantTtlMs: 10 * 60_000 }
        : { kind: "resolve", requestId: payload.requestId, approved: true, grantUse: "once" };

  return resolveCustomAuthRequest({
    auth: params.auth,
    actor,
    command,
    now: params.now,
  });
}

export function describeCustomAuthorizationIntents(intents: CustomAuthorizationIntent[]): string[] {
  return intents.map((intent) => {
    if (intent.kind === "request-approval") {
      return `request-approval id=${intent.request.id} capability=${intent.request.capability} actor=${intent.request.actor.id} peer=${intent.request.peer.id} deduped=${intent.deduped}`;
    }
    if (intent.kind === "approval-resolved") {
      return `approval-resolved id=${intent.request.id} approved=${intent.approved}`;
    }
    if (intent.kind === "grant-consumed") {
      return `grant-consumed id=${intent.grantId} remainingUses=${intent.remainingUses ?? "unlimited"}`;
    }
    return `grant-expired id=${intent.grantId}`;
  });
}

export function firstCustomAuthApprovalRequest(intents: CustomAuthorizationIntent[]): CustomAuthorizationApprovalRequest | null {
  for (const intent of intents) {
    if (intent.kind === "request-approval" && !intent.deduped) return intent.request;
  }
  return null;
}

function formatCustomAuthHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🔐 自定义授权命令`,
    ``,
    `/bot-auth status`,
    `/bot-auth approve <requestId> once`,
    `/bot-auth approve <requestId> count 3`,
    `/bot-auth approve <requestId> timed 10m`,
    `/bot-auth deny <requestId>`,
  );
  return lines.join("\n");
}

function formatCustomAuthStatus(auth: CustomAuthorizationRuntime): string {
  const state = auth.getState();
  const requests = Object.values(state.requests).filter((request) => request.status === "pending");
  const grants = Object.values(state.grants);
  const lines = [
    `🔐 自定义授权状态`,
    ``,
    `待审批：${requests.length}`,
    `临时授权：${grants.length}`,
  ];

  for (const request of requests.slice(0, 5)) {
    lines.push(
      ``,
      `- ${request.id}`,
      `  用户：${request.actor.label || request.actor.id}`,
      `  能力：${request.capability}`,
      `  会话：${request.peer.label || request.peer.id}`,
    );
  }
  if (requests.length > 5) {
    lines.push(``, `还有 ${requests.length - 5} 条待审批未显示。`);
  }

  return lines.join("\n");
}

function formatApprovalResolution(intent: Extract<CustomAuthorizationIntent, { kind: "approval-resolved" }>): string {
  const request = intent.request;
  if (!intent.approved) {
    return [
      `✅ 已拒绝授权申请`,
      ``,
      `申请：${request.id}`,
      `用户：${request.actor.label || request.actor.id}`,
      `能力：${request.capability}`,
    ].join("\n");
  }

  const grant = intent.grant;
  const grantDesc = grant
    ? grant.remainingUses !== undefined
      ? `可用次数：${grant.remainingUses}`
      : grant.expiresAt
        ? `有效至：${new Date(grant.expiresAt).toISOString()}`
        : `授权已生效`
    : `授权已生效`;
  return [
    `✅ 已批准临时授权`,
    ``,
    `申请：${request.id}`,
    `用户：${request.actor.label || request.actor.id}`,
    `能力：${request.capability}`,
    grantDesc,
  ].join("\n");
}

function resolveCustomAuthRequest(params: {
  auth: CustomAuthorizationRuntime;
  actor: CustomActor;
  command: Extract<CustomAuthCommand, { kind: "resolve" }>;
  now?: number;
}): CustomAuthCommandResult {
  const state = params.auth.getState();
  const requestId = findPendingRequestId(Object.keys(state.requests), params.command.requestId);
  if (!requestId) {
    return {
      handled: true,
      reply: `⚠️ 未找到待处理授权申请：${params.command.requestId}`,
    };
  }

  const intent = params.auth.resolveApproval({
    requestId,
    approved: params.command.approved,
    resolvedBy: params.actor.id,
    now: params.now,
    grantUse: params.command.grantUse,
    grantCount: params.command.grantCount,
    grantTtlMs: params.command.grantTtlMs,
  });
  if (!intent || intent.kind !== "approval-resolved") {
    return {
      handled: true,
      reply: `⚠️ 授权申请已不存在或不再是 pending：${requestId}`,
    };
  }

  return {
    handled: true,
    intent,
    reply: formatApprovalResolution(intent),
  };
}

function findPendingRequestId(requestIds: string[], input: string): string | null {
  if (requestIds.includes(input)) return input;
  const matches = requestIds.filter((id) => id.startsWith(input) || id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function parseDurationMs(value: string): number | null {
  const m = value.trim().toLowerCase().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) return null;
  const amount = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(amount) || amount < 1) return null;
  const unit = m[2] ?? "m";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "d") return amount * 24 * 60 * 60_000;
  return null;
}
