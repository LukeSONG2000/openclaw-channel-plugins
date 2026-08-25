import type { DingTalkMessageData } from "./types.js";

export const DEFAULT_DINGTALK_ADMIN_ID = "51135122";

interface AuthorizationRequest {
  id: string;
  createdAt: number;
  data: DingTalkMessageData;
}

export class DingTalkAuthorizationRuntime {
  private readonly requests = new Map<string, AuthorizationRequest>();

  constructor(readonly adminId = DEFAULT_DINGTALK_ADMIN_ID) {}

  isAdmin(senderId: string): boolean {
    return senderId === this.adminId;
  }

  isRestrictedCommand(data: DingTalkMessageData): boolean {
    return /^\s*\/[a-z0-9][\w-]*/i.test(data.text?.content ?? "") && !this.isAdmin(data.senderStaffId);
  }

  create(data: DingTalkMessageData): AuthorizationRequest {
    this.prune();
    const id = Math.random().toString(36).slice(2, 8).toUpperCase();
    const request = { id, createdAt: Date.now(), data };
    this.requests.set(id, request);
    return request;
  }

  take(id: string): AuthorizationRequest | undefined {
    const key = id.trim().toUpperCase();
    const request = this.requests.get(key);
    if (request) this.requests.delete(key);
    return request;
  }

  deny(id: string): AuthorizationRequest | undefined {
    return this.take(id);
  }

  private prune(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, request] of this.requests) {
      if (request.createdAt < cutoff) this.requests.delete(id);
    }
  }
}

export function formatAuthorizationRequest(request: { id: string; data: DingTalkMessageData }): string {
  const data = request.data;
  const location = data.conversationType === "2"
    ? `${data.conversationTitle ?? "群聊"} (${data.openConversationId ?? data.conversationId})`
    : "私聊";
  const command = data.text?.content?.trim().split(/\s+/)[0] ?? "未知命令";
  return [
    "授权申请",
    `位置：${location}`,
    `用户：${data.senderNick} (${data.senderStaffId})`,
    `权限：执行 ${command}`,
    `批准：/ding-auth approve ${request.id}`,
    `拒绝：/ding-auth deny ${request.id}`,
  ].join("\n");
}
