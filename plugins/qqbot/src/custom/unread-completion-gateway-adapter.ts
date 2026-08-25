import type { HistoryEntry } from "../group-history.js";
import { clearLegacyGroupHistoryAfterDispatch } from "./unread-context.js";
import {
  completeCustomUnreadAfterDispatch,
  type CustomUnreadCompletionResult,
} from "./unread-completion.js";
import type { CustomUnreadGatewayEffect } from "./unread-gateway-adapter.js";
import type { CustomUnreadRuntime, ResolvedCustomUnreadConfig } from "./unread-runtime.js";

export interface CustomUnreadCompletionGatewayLogger {
  info?: (msg: string) => void;
}

export interface ApplyCustomUnreadCompletionGatewayParams {
  accountId: string;
  unread: CustomUnreadRuntime;
  groupOpenid?: string;
  cfg?: ResolvedCustomUnreadConfig | null;
  snapshotId?: string;
  hasModelBlockOutput: boolean;
  hasModelSkipOutput?: boolean;
  shouldCatchUpAfterReply: boolean;
  wasMentioned: boolean;
  groupHistories: Map<string, HistoryEntry[]>;
  resolveHistoryLimit: (groupOpenid: string, accountId: string) => number;
  persistCustomUnreadState: () => void;
  applySchedulerEffects?: (
    effects: CustomUnreadGatewayEffect[],
    cfg?: ResolvedCustomUnreadConfig,
  ) => void;
  log?: CustomUnreadCompletionGatewayLogger;
}

export type ApplyCustomUnreadCompletionGatewayResult =
  | {
      kind: "non-group";
    }
  | {
      kind: "custom-handled";
      completion: CustomUnreadCompletionResult;
    }
  | {
      kind: "legacy-cleared";
      historyLimit: number;
    };

export function applyCustomUnreadCompletionGateway(
  params: ApplyCustomUnreadCompletionGatewayParams,
): ApplyCustomUnreadCompletionGatewayResult {
  if (!params.groupOpenid) {
    return { kind: "non-group" };
  }

  const completion = completeCustomUnreadAfterDispatch({
    accountId: params.accountId,
    unread: params.unread,
    groupOpenid: params.groupOpenid,
    cfg: params.cfg,
    snapshotId: params.snapshotId,
    hasModelBlockOutput: params.hasModelBlockOutput,
    hasModelSkipOutput: params.hasModelSkipOutput,
    shouldCatchUpAfterReply: params.shouldCatchUpAfterReply,
    wasMentioned: params.wasMentioned,
  });

  if (completion.handled) {
    for (const item of completion.logs) {
      params.log?.info?.(`[qqbot:${params.accountId}] ${item.message}`);
    }
    if (completion.persist) {
      params.persistCustomUnreadState();
    }
    params.applySchedulerEffects?.(completion.effects, params.cfg ?? undefined);
    return { kind: "custom-handled", completion };
  }

  const historyLimit = params.resolveHistoryLimit(params.groupOpenid, params.accountId);
  clearLegacyGroupHistoryAfterDispatch({
    groupHistories: params.groupHistories,
    groupOpenid: params.groupOpenid,
    historyLimit,
  });
  return { kind: "legacy-cleared", historyLimit };
}
