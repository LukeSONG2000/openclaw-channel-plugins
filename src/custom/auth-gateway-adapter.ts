import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { getSlashCommandCapability } from "../slash-commands.js";
import {
  inspectCustomAdminBindings,
  isCustomRuntimeAdmin,
  type CustomAuthorizationCheckResult,
  type CustomAuthorizationRuntime,
} from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import type {
  CustomActor,
  CustomAuthorizationApprovalRequest,
  CustomAuthorizationGrant,
  CustomAuthorizationIntent,
  CustomAuthorizationRuntimeState,
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

export interface CustomDispatchAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "allowed" | "denied";
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

export type CustomAuthCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "requests"; limit: number }
  | { kind: "grants"; limit: number }
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

export interface CustomAuthAdminGroupNotification {
  groupOpenid: string;
  text: string;
  keyboard?: InlineKeyboard;
  requestId: string;
}

type CustomAuthButtonDecision = "allow-once" | "allow-count" | "allow-timed" | "deny";

export interface CustomAuthButtonPayload {
  requestId: string;
  decision: CustomAuthButtonDecision;
}

const DEFAULT_AUTH_LIST_LIMIT = 10;
const MAX_AUTH_LIST_LIMIT = 20;

export function parseCustomAuthCommand(rawContent: string): CustomAuthCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };

  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  const name = rawName.toLowerCase();
  if (name !== "bot-auth") return { matched: false };

  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "status") return { matched: true, command: { kind: "status" } };
  if (action === "requests" || action === "request" || action === "pending" || action === "list") {
    const limit = parseListLimit(tokens[0]);
    if (limit === null) return { matched: true, error: `数量需要是 1 到 ${MAX_AUTH_LIST_LIMIT} 的整数` };
    return { matched: true, command: { kind: "requests", limit } };
  }
  if (action === "grants" || action === "grant") {
    const limit = parseListLimit(tokens[0]);
    if (limit === null) return { matched: true, error: `数量需要是 1 到 ${MAX_AUTH_LIST_LIMIT} 的整数` };
    return { matched: true, command: { kind: "grants", limit } };
  }

  if (action === "approve" || action === "allow" || action === "allow-once" || action === "allow-count" || action === "allow-timed") {
    const requestId = tokens.shift();
    if (!requestId) return { matched: true, error: "缺少 requestId" };

    let grantUse: CustomGrantUse | undefined;
    let grantCount: number | undefined;
    let grantTtlMs: number | undefined;

    if (action === "allow-once") grantUse = "once";
    if (action === "allow-count") grantUse = "count";
    if (action === "allow-timed") grantUse = "timed";

    const mode = action === "allow-count" || action === "allow-timed"
      ? undefined
      : tokens.shift()?.toLowerCase();
    if (mode) {
      if (mode === "once") {
        grantUse = "once";
      } else if (mode === "task") {
        grantUse = "task";
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
    return { handled: true, reply: formatCustomAuthStatus(params.auth, runtime, params.now) };
  }

  if (command.kind === "requests") {
    return { handled: true, reply: formatCustomAuthRequests(params.auth, command.limit, params.now) };
  }

  if (command.kind === "grants") {
    return { handled: true, reply: formatCustomAuthGrants(params.auth, command.limit, params.now) };
  }

  return resolveCustomAuthRequest({
    auth: params.auth,
    actor,
    command,
    now: params.now,
  });
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
    ...(request.taskId ? [`任务：${request.taskId}`] : []),
    `申请：${request.id}`,
    ...(request.adminGroup ? [`管理群：${request.adminGroup}`] : []),
    ``,
    `超时：${expiresInSec} 秒`,
    request.taskId
      ? `也可回复 /bot-auth approve ${request.id}`
      : `也可回复 /bot-auth approve ${request.id} once`,
  ];
  return lines.join("\n");
}

export function buildCustomAuthApprovalKeyboard(request: CustomAuthorizationApprovalRequest | string): InlineKeyboard {
  const requestId = typeof request === "string" ? request : request.id;
  const isTaskRequest = typeof request !== "string" && Boolean(request.taskId);
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
            makeBtn(
              "allow_once",
              isTaskRequest ? "允许此任务" : "允许一次",
              isTaskRequest ? "已允许此任务" : "已允许一次",
              `custom-auth:${requestId}:allow-once`,
              1,
            ),
            makeBtn("allow_count", "允许3次", "已允许3次", `custom-auth:${requestId}:allow-count`, 1),
            makeBtn("allow_timed", "允许10分钟", "已允许10分钟", `custom-auth:${requestId}:allow-timed`, 1),
          ],
        },
        {
          buttons: [
            makeBtn("deny", "拒绝", "已拒绝", `custom-auth:${requestId}:deny`, 3),
          ],
        },
      ],
    },
  };
}

export function buildCustomAuthAdminGroupNotification(params: {
  request: CustomAuthorizationApprovalRequest;
  sourcePeer?: CustomPeer;
  text: string;
  keyboard?: InlineKeyboard;
}): CustomAuthAdminGroupNotification | null {
  const groupOpenid = parseAdminGroupOpenid(params.request.adminGroup);
  if (!groupOpenid) return null;
  if (params.sourcePeer?.kind === "group" && params.sourcePeer.id === groupOpenid) return null;
  return {
    groupOpenid,
    text: params.text,
    keyboard: params.keyboard,
    requestId: params.request.id,
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

function parseAdminGroupOpenid(adminGroup?: string): string | null {
  const value = String(adminGroup ?? "").trim();
  if (!value.startsWith("qqbot:group:")) return null;
  const groupOpenid = value.slice("qqbot:group:".length).trim();
  return groupOpenid || null;
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
    `/bot-auth requests [数量]`,
    `/bot-auth grants [数量]`,
    `/bot-auth approve <requestId> once`,
    `/bot-auth approve <requestId> task`,
    `/bot-auth approve <requestId> count 3`,
    `/bot-auth approve <requestId> timed 10m`,
    `/bot-auth deny <requestId>`,
  );
  return lines.join("\n");
}

function formatCustomAuthStatus(
  auth: CustomAuthorizationRuntime,
  runtime?: ReturnType<typeof resolveCustomRuntimeConfig>,
  now: number = Date.now(),
): string {
  const state = auth.getState();
  const requests = activePendingRequests(state, now);
  const grants = activeGrants(state, now);
  const adminBindings = runtime ? inspectCustomAdminBindings(runtime) : null;
  const lines = [
    `🔐 自定义授权状态`,
    ``,
    ...(adminBindings ? [
      `管理员：${adminBindings.admins.length ? adminBindings.admins.join(", ") : "未绑定"}`,
      `管理群：${adminBindings.adminGroup ?? "未绑定"}`,
      `初始化：${adminBindings.ready ? "完整" : `缺少 ${adminBindings.missing.join(", ")}`}`,
      ``,
    ] : []),
    `待审批：${requests.length}`,
    `临时授权：${grants.length}`,
    ``,
    `查看详情：/bot-auth requests 或 /bot-auth grants`,
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

function formatCustomAuthRequests(auth: CustomAuthorizationRuntime, limit: number, now: number = Date.now()): string {
  const state = auth.getState();
  const requests = activePendingRequests(state, now)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .slice(0, limit);
  const total = activePendingRequests(state, now).length;
  const lines = [
    `🔐 待审批授权申请`,
    ``,
    `显示：${requests.length}/${total}`,
  ];

  if (requests.length === 0) {
    lines.push(``, `暂无待审批授权申请。`);
    return lines.join("\n");
  }

  for (const request of requests) {
    lines.push(
      ``,
      `- ${request.id}`,
      `  用户：${request.actor.label || request.actor.id}`,
      `  会话：${formatCustomAuthPeer(request.peer)}`,
      `  能力：${request.capability}`,
      `  场景：${request.sceneLabel || request.scene}`,
      ...(request.taskId ? [`  任务：${request.taskId}`] : []),
      `  过期：${formatCustomAuthTime(request.expiresAt)}（剩余 ${formatRemainingMs(request.expiresAt - now)}）`,
      `  操作：/bot-auth approve ${request.id} once 或 /bot-auth deny ${request.id}`,
    );
  }

  if (total > requests.length) {
    lines.push(``, `还有 ${total - requests.length} 条待审批未显示。`);
  }
  return lines.join("\n");
}

function formatCustomAuthGrants(auth: CustomAuthorizationRuntime, limit: number, now: number = Date.now()): string {
  const state = auth.getState();
  const allGrants = activeGrants(state, now)
    .sort((a, b) => b.createdAt - a.createdAt);
  const grants = allGrants.slice(0, limit);
  const lines = [
    `🔐 临时授权列表`,
    ``,
    `显示：${grants.length}/${allGrants.length}`,
  ];

  if (grants.length === 0) {
    lines.push(``, `暂无有效临时授权。`);
    return lines.join("\n");
  }

  for (const grant of grants) {
    lines.push(
      ``,
      `- ${grant.id}`,
      `  用户：${grant.actorId}`,
      `  会话：${grant.peerId}`,
      `  能力：${grant.capability}`,
      `  授权人：${grant.grantedBy}`,
      ...(grant.taskId ? [`  任务：${grant.taskId}`] : []),
      `  剩余：${grant.remainingUses === undefined ? "不限次数" : `${grant.remainingUses} 次`}`,
      `  过期：${grant.expiresAt ? `${formatCustomAuthTime(grant.expiresAt)}（剩余 ${formatRemainingMs(grant.expiresAt - now)}）` : "不过期"}`,
    );
  }

  if (allGrants.length > grants.length) {
    lines.push(``, `还有 ${allGrants.length - grants.length} 条临时授权未显示。`);
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
    grantUse: params.command.grantUse ?? (state.requests[requestId]?.taskId ? "task" : undefined),
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

function parseListLimit(raw?: string): number | null {
  if (!raw) return DEFAULT_AUTH_LIST_LIMIT;
  if (!/^\d+$/.test(raw.trim())) return null;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_AUTH_LIST_LIMIT) return null;
  return limit;
}

function activePendingRequests(
  state: CustomAuthorizationRuntimeState,
  now: number,
): CustomAuthorizationApprovalRequest[] {
  return Object.values(state.requests ?? {})
    .filter((request) => request.status === "pending" && request.expiresAt > now);
}

function activeGrants(
  state: CustomAuthorizationRuntimeState,
  now: number,
): CustomAuthorizationGrant[] {
  return Object.values(state.grants ?? {})
    .filter((grant) => {
      if (grant.expiresAt !== undefined && grant.expiresAt <= now) return false;
      if (grant.remainingUses !== undefined && grant.remainingUses <= 0) return false;
      return true;
    });
}

function formatCustomAuthPeer(peer: CustomPeer): string {
  const key = `${peer.kind}:${peer.id}`;
  return peer.label ? `${key} (${peer.label})` : key;
}

function formatCustomAuthTime(ms: number): string {
  return new Date(ms).toISOString();
}

function formatRemainingMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
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
