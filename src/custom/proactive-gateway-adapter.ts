import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveCustomRuntimeConfig } from "./config.js";
import {
  inspectCustomProactiveConfig,
  type CustomProactiveBudgetDecision,
  type CustomProactiveBudgetRuntime,
} from "./runtime.js";
import type { CustomProactiveSendGuard, CustomProactiveSendGuardDecision } from "./proactive-send-guard.js";
import type { CustomActor, CustomPeer } from "./types.js";

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
  return ({ targetType, targetId, text }): CustomProactiveSendGuardDecision => {
    if (resolveCustomRuntimeConfig(params.cfg).enabled !== true) {
      return { allowed: true };
    }

    const now = params.clock?.() ?? Date.now();
    const peer: CustomPeer = { kind: targetType, id: targetId };
    const proactiveCfg = inspectCustomProactiveConfig({
      cfg: params.cfg,
      message: {
        accountId: params.accountId,
        peer,
        actor: params.actor ?? {
          id: params.accountId,
          label: params.accountId,
          isBot: true,
        },
        content: text,
        messageId: params.sourceMessageId ?? `custom-proactive-${now}`,
        timestamp: params.sourceTimestamp ?? now,
        mentionedBot: false,
      },
    });

    const check = params.budget.check({
      accountId: params.accountId,
      peer,
      cfg: proactiveCfg,
      now,
    });
    if (!check.allowed) {
      return {
        allowed: false,
        reason: formatCustomProactiveBudgetBlockReason(check),
      };
    }

    return {
      allowed: true,
      commit: () => {
        const recorded = params.budget.record({
          accountId: params.accountId,
          peer,
          cfg: proactiveCfg,
          now: params.clock?.() ?? Date.now(),
        });
        if (!recorded.allowed) {
          params.log?.warn?.(`[qqbot:${params.accountId}] Custom proactive budget record skipped for ${recorded.key}: reason=${recorded.reason}`);
          return;
        }
        params.log?.info?.(`[qqbot:${params.accountId}] Custom proactive budget recorded for ${recorded.key}: used=${recorded.used}/${recorded.monthlyLimit}, recent=${recorded.recentCount}/${recorded.rateLimitMax}`);
        params.persistBudgetState?.();
      },
    };
  };
}

export function formatCustomProactiveBudgetBlockReason(check: CustomProactiveBudgetDecision): string {
  const retry = check.retryAfterMs ? ` retryAfterMs=${check.retryAfterMs}` : "";
  return `custom proactive budget blocked: reason=${check.reason} used=${check.used}/${check.monthlyLimit} recent=${check.recentCount}/${check.rateLimitMax}${retry}`;
}
