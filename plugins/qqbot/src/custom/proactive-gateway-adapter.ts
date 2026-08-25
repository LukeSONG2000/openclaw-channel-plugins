import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  type CustomProactiveBudgetDecision,
  type CustomProactiveBudgetRuntime,
} from "./runtime.js";
import type { CustomProactiveSendGuard, CustomProactiveSendGuardDecision } from "./proactive-send-guard.js";
import type { CustomActor } from "./types.js";

export interface CustomProactiveGatewayLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface CustomProactiveGatewayGuardParams {
  cfg: OpenClawConfig;
  accountId: string;
  budget: CustomProactiveBudgetRuntime;
  persistBudgetState?: () => void;
  log?: CustomProactiveGatewayLogger;
  actor?: CustomActor;
  sourceMessageId?: string;
  sourceTimestamp?: number;
  clock?: () => number;
}

export function createCustomProactiveGatewayGuard(
  params: CustomProactiveGatewayGuardParams,
): CustomProactiveSendGuard {
  // 本地主动发送保护已关闭：不再受 monthlyLimit / rateLimitMax 拦截。
  // 仍保留 commit 钩子与可观测日志，保持调用链稳定。
  return ({ targetType, targetId, text }): CustomProactiveSendGuardDecision => {
    const now = params.clock?.() ?? Date.now();
    return {
      allowed: true,
      commit: () => {
        params.log?.info?.(`[qqbot:${params.accountId}] Custom proactive send allowed (protection disabled) for ${targetType}:${targetId} text="${text.slice(0, 40)}" now=${now}`);
        params.persistBudgetState?.();
      },
    };
  };
}

export function formatCustomProactiveBudgetBlockReason(check: CustomProactiveBudgetDecision): string {
  const retry = check.retryAfterMs ? ` retryAfterMs=${check.retryAfterMs}` : "";
  return `custom proactive budget blocked: reason=${check.reason} used=${check.used}/${check.monthlyLimit} recent=${check.recentCount}/${check.rateLimitMax}${retry}`;
}
