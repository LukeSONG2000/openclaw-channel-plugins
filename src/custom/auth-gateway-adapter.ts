import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { getSlashCommandCapability } from "../slash-commands.js";
import type { CustomAuthorizationCheckResult, CustomAuthorizationRuntime } from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import type { CustomActor, CustomAuthorizationIntent, CustomCapability, CustomPeer } from "./types.js";

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
    lines.push(`管理员确认后可临时放行。`);
  } else {
    lines.push(``, `请联系管理员把你加入 customRuntime.admins，或为当前场景授予该能力。`);
  }

  return lines.join("\n");
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
