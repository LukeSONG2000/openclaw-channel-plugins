import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import {
  normalizeCustomRuntimeAdminGroup,
  normalizeCustomRuntimeAdminList,
  resolveCustomRuntimeConfig,
} from "./config.js";
import {
  formatCustomActorIdentity,
  formatCustomPeerIdentity,
} from "./identity-presentation.js";
import { slashCommandInput } from "./command-link.js";

export interface CustomInitBindConfigPersist {
  admins: string[];
  adminGroup?: string;
  clearInitBind?: boolean;
  enableRuntime?: boolean;
}

export type CustomInitBindCommandResult =
  | { handled: false }
  | {
      handled: true;
      reply: string;
      changed: boolean;
      persist?: CustomInitBindConfigPersist;
      log?: string;
    };

export function handleCustomInitBindCommand(params: {
  cfg: OpenClawConfig;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomInitBindCommandResult {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const challenge = runtime.initBind;
  let parsed = parseCustomInitBindCommand(params.rawContent);
  if (!parsed.matched) {
    const bareCode = normalizeBareInitBindCode(params.rawContent);
    if (!challenge?.code || !bareCode || bareCode !== challenge.code) return { handled: false };
    parsed = { matched: true, code: bareCode };
  }
  if (!parsed.code) {
    return {
      handled: true,
      changed: false,
      reply: `用法：${slashCommandInput("/bot-init-bind <一次性绑定码>")}，或直接发送一次性绑定码。请在控制台生成绑定码后，在目标管理群中发送。`,
    };
  }

  if (!challenge?.code) {
    return {
      handled: true,
      changed: false,
      reply: "当前没有启用对话式初始化绑定。请先在控制台/配置中生成 customRuntime.initBind.code。",
    };
  }

  const now = params.now ?? Date.now();
  if (challenge.expiresAt !== undefined && challenge.expiresAt <= now) {
    return {
      handled: true,
      changed: true,
      persist: {
        admins: normalizeCustomRuntimeAdminList(runtime.admins),
        adminGroup: normalizeCustomRuntimeAdminGroup(runtime.adminGroup),
        clearInitBind: true,
      },
      reply: "初始化绑定码已过期，请在控制台重新生成。",
      log: "custom init bind expired",
    };
  }

  if (parsed.code !== challenge.code) {
    return {
      handled: true,
      changed: false,
      reply: "初始化绑定码不匹配，请检查控制台显示的一次性 code。",
    };
  }

  if (params.message.type !== "c2c" && params.message.type !== "group") {
    return {
      handled: true,
      changed: false,
      reply: "初始化绑定只支持 QQ 单聊或 QQ 群聊。请在目标管理员私聊或管理群发送该命令。",
    };
  }

  const currentAdmins = normalizeCustomRuntimeAdminList(runtime.admins);
  const currentAdminGroup = normalizeCustomRuntimeAdminGroup(runtime.adminGroup);
  if (params.message.type === "group") {
    if (!params.message.groupOpenid) {
      return {
        handled: true,
        changed: false,
        reply: "当前群消息缺少 group_openid，无法绑定管理群。请确认 QQBot 事件字段完整。",
      };
    }
    const adminGroup = normalizeCustomRuntimeAdminGroup(params.message.groupOpenid);
    if (currentAdminGroup && currentAdminGroup !== adminGroup) {
      return {
        handled: true,
        changed: false,
        reply: [
          "⚠️ 已绑定管理群，不能通过一次性码直接切换到其他群。",
          `当前管理群：${formatCustomPeerIdentity({ kind: "group", id: currentAdminGroup.slice("qqbot:group:".length) }, params.cfg)}`,
          `本次发送群：${formatCustomPeerIdentity({ kind: "group", id: params.message.groupOpenid }, params.cfg)}`,
          "如需迁移管理群，请先在服务器配置中显式迁移并备份，避免出现没有管理群的状态。",
        ].join("\n"),
        log: `custom init bind refused admin group switch current=${currentAdminGroup} requested=${adminGroup}`,
      };
    }
    const admins = normalizeCustomRuntimeAdminList([...currentAdmins, params.message.senderId]);
    return {
      handled: true,
      changed: true,
      persist: {
        admins,
        adminGroup,
        clearInitBind: true,
        enableRuntime: challenge.enableRuntimeOnComplete === true,
      },
      reply: [
        "✅ 初始化绑定完成。",
        `管理员：${formatCustomActorIdentity({ id: params.message.senderId, label: params.message.senderName, isBot: params.message.senderIsBot }, { idLabel: "member_openid" })}`,
        `管理群：${formatCustomPeerIdentity({ kind: "group", id: params.message.groupOpenid }, params.cfg)}`,
        "已写入 customRuntime.admins / customRuntime.adminGroup，并将管理群默认绑定到 system-admin 场景。",
      ].join("\n"),
      log: `custom init bind completed via group group=${params.message.groupOpenid} admin=${params.message.senderId}`,
    };
  }

  const admins = normalizeCustomRuntimeAdminList([...currentAdmins, params.message.senderId]);
  const complete = Boolean(currentAdminGroup);
  return {
    handled: true,
    changed: true,
    persist: {
      admins,
      adminGroup: currentAdminGroup,
      clearInitBind: complete,
      enableRuntime: complete && challenge.enableRuntimeOnComplete === true,
    },
    reply: [
      "✅ 已绑定管理员单聊 openid。",
      `管理员：${formatCustomActorIdentity({ id: params.message.senderId, label: params.message.senderName }, { idLabel: "user_openid" })}`,
      complete
        ? `管理群已存在：${formatCustomPeerIdentity({ kind: "group", id: currentAdminGroup!.slice("qqbot:group:".length) }, params.cfg)}。初始化绑定已完成。`
        : `还需要在目标管理群发送同一个 ${slashCommandInput("/bot-init-bind <一次性绑定码>")} 命令，以绑定 group_openid。`,
    ].join("\n"),
    log: `custom init bind admin captured via c2c admin=${params.message.senderId} complete=${complete}`,
  };
}

export function parseCustomInitBindCommand(rawContent: string): { matched: boolean; code?: string } {
  const parts = rawContent.trim().split(/\s+/g).filter(Boolean);
  const command = parts[0]?.toLowerCase();
  if (command !== "/bot-init-bind") return { matched: false };
  return { matched: true, code: parts[1] };
}

function normalizeBareInitBindCode(rawContent: string): string | undefined {
  const text = rawContent.trim();
  if (!text || text.startsWith("/")) return undefined;
  if (/\s/.test(text)) return undefined;
  return text;
}
