import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import {
  inspectCustomAdminBindings,
  type CustomAuthorizationRuntime,
} from "./auth.js";
import {
  formatCustomActorIdentity,
  formatCustomAdminGroupIdentity,
  formatCustomPeerIdentity,
} from "./identity-presentation.js";
import {
  formatCapabilityForDisplay,
  formatDurationZh,
  formatSceneKind,
} from "./presentation-labels.js";
import type {
  CustomAuthorizationApprovalRequest,
  CustomAuthorizationGrant,
  CustomAuthorizationIntent,
  CustomAuthorizationRuntimeState,
  CustomPeer,
  CustomRuntimeConfig,
} from "./types.js";

export interface CustomAuthAdminGroupNotification {
  groupOpenid: string;
  text: string;
  keyboard?: InlineKeyboard;
  requestId: string;
}

export function buildCustomAuthApprovalText(request: CustomAuthorizationApprovalRequest, cfg?: OpenClawConfig): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
  const lines = [
    `🔐 自定义权限申请`,
    ``,
    `用户：${formatCustomActorIdentity(request.actor, { idLabel: request.peer.kind === "group" ? "member_openid" : "user_openid" })}`,
    `会话：${formatCustomPeerIdentity(request.peer, cfg)}`,
    `能力：${formatCapabilityForDisplay(request.capability)}`,
    `场景：${request.sceneLabel || formatSceneKind(request.scene)}`,
    ...(request.taskId ? [`任务：${request.taskId}`] : []),
    `申请：${request.id}`,
    ...(request.adminGroup ? [`管理群：${formatCustomAdminGroupIdentity(request.adminGroup, cfg)}`] : []),
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
              `custom-auth:${requestId}:${isTaskRequest ? "allow-task" : "allow-once"}`,
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

export function formatCustomAuthHelp(error?: string): string {
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

export function formatCustomAuthStatus(
  auth: CustomAuthorizationRuntime,
  runtime?: CustomRuntimeConfig,
  now: number = Date.now(),
  cfg?: OpenClawConfig,
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
      `管理群：${formatCustomAdminGroupIdentity(adminBindings.adminGroup, cfg) ?? "未绑定"}`,
      `初始化：${adminBindings.ready ? "完整" : `缺少 ${formatAdminBindingMissing(adminBindings.missing).join(", ")}`}`,
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
      `  用户：${formatCustomActorIdentity(request.actor, { idLabel: request.peer.kind === "group" ? "member_openid" : "user_openid" })}`,
      `  能力：${formatCapabilityForDisplay(request.capability)}`,
      `  会话：${formatCustomPeerIdentity(request.peer, cfg)}`,
    );
  }
  if (requests.length > 5) {
    lines.push(``, `还有 ${requests.length - 5} 条待审批未显示。`);
  }

  return lines.join("\n");
}

export function formatCustomAuthRequests(auth: CustomAuthorizationRuntime, limit: number, now: number = Date.now(), cfg?: OpenClawConfig): string {
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
      `  用户：${formatCustomActorIdentity(request.actor, { idLabel: request.peer.kind === "group" ? "member_openid" : "user_openid" })}`,
      `  会话：${formatCustomPeerIdentity(request.peer, cfg)}`,
      `  能力：${formatCapabilityForDisplay(request.capability)}`,
      `  场景：${request.sceneLabel || formatSceneKind(request.scene)}`,
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

export function formatCustomAuthGrants(auth: CustomAuthorizationRuntime, limit: number, now: number = Date.now(), cfg?: OpenClawConfig): string {
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
      `  用户：${formatCustomActorIdentity({ id: grant.actorId }, { idLabel: "openid" })}`,
      `  会话：${formatCustomStoredPeerId(grant.peerId, cfg)}`,
      `  能力：${formatCapabilityForDisplay(grant.capability)}`,
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

export function formatApprovalResolution(intent: Extract<CustomAuthorizationIntent, { kind: "approval-resolved" }>, cfg?: OpenClawConfig): string {
  const request = intent.request;
  if (!intent.approved) {
    return [
      `✅ 已拒绝授权申请`,
      ``,
      `申请：${request.id}`,
      `用户：${formatCustomActorIdentity(request.actor, { idLabel: request.peer.kind === "group" ? "member_openid" : "user_openid" })}`,
      `会话：${formatCustomPeerIdentity(request.peer, cfg)}`,
      `能力：${formatCapabilityForDisplay(request.capability)}`,
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
    `用户：${formatCustomActorIdentity(request.actor, { idLabel: request.peer.kind === "group" ? "member_openid" : "user_openid" })}`,
    `会话：${formatCustomPeerIdentity(request.peer, cfg)}`,
    `能力：${formatCapabilityForDisplay(request.capability)}`,
    grantDesc,
  ].join("\n");
}

function parseAdminGroupOpenid(adminGroup?: string): string | null {
  const value = String(adminGroup ?? "").trim();
  if (!value.startsWith("qqbot:group:")) return null;
  const groupOpenid = value.slice("qqbot:group:".length).trim();
  return groupOpenid || null;
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

function formatCustomStoredPeerId(peerId: string, cfg?: OpenClawConfig): string {
  if (peerId.startsWith("qqbot:group:")) {
    return formatCustomPeerIdentity({ kind: "group", id: peerId.slice("qqbot:group:".length) }, cfg);
  }
  if (peerId.startsWith("group:")) {
    return formatCustomPeerIdentity({ kind: "group", id: peerId.slice("group:".length) }, cfg);
  }
  return peerId;
}

function formatCustomAuthTime(ms: number): string {
  return new Date(ms).toISOString();
}

function formatRemainingMs(ms: number): string {
  return formatDurationZh(ms, "0秒");
}

function formatAdminBindingMissing(missing: string[]): string[] {
  return missing.map((item) => {
    if (item === "admins") return "管理员";
    if (item === "adminGroup") return "管理群";
    return item;
  });
}
