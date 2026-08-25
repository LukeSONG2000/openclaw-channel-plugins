import type { CustomFallbackDeliverPayload } from "./fallback-dispatch-state.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import { isCustomModelSkipOutput } from "./fallbacks.js";
import type { CustomToolFallbackLogger } from "./tool-fallback-gateway-adapter.js";
import { isCustomUnreadSilentDecisionOutput } from "./unread-output.js";

export interface CustomDispatchDeliverInfo {
  kind: string;
}

export interface CustomDispatchBlockDeliverState {
  readonly toolDeliverCount: number;
  markBlockResponse(): void;
  markModelSkipOutput?: () => void;
}

export interface HandleCustomLateDispatchDeliverParams {
  accountId: string;
  dispatchTimedOut: boolean;
  payload: CustomFallbackDeliverPayload;
  info: CustomDispatchDeliverInfo;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  log?: CustomToolFallbackLogger;
}

export interface PrepareCustomBlockDeliverParams {
  accountId: string;
  payload: CustomFallbackDeliverPayload;
  event: {
    type: string;
    senderId?: string;
    content?: string;
    customUnreadSnapshotId?: string;
  };
  state: CustomDispatchBlockDeliverState;
  stopTyping: () => void;
  clearResponseTimeout: () => void;
  clearToolOnlyTimeout: () => void;
  log?: CustomToolFallbackLogger;
}

export type HandleCustomLateDispatchDeliverResult =
  | {
      kind: "late-ignored";
    }
  | {
      kind: "continue";
    };

export type PrepareCustomBlockDeliverResult =
  | {
      kind: "model-skip";
      token: string;
    }
  | {
      kind: "ready";
      toolDeliverCount: number;
    };

export function handleCustomLateDispatchDeliver(
  params: HandleCustomLateDispatchDeliverParams,
): HandleCustomLateDispatchDeliverResult {
  if (!params.dispatchTimedOut) {
    return { kind: "continue" };
  }

  params.recordFallbackEvent({
    kind: "late-deliver-after-timeout",
    reason: "deliver callback arrived after response timeout",
    details: {
      deliverKind: params.info.kind,
      textChars: params.payload.text?.length ?? 0,
      mediaCount: (params.payload.mediaUrls?.length ?? 0) + (params.payload.mediaUrl ? 1 : 0),
    },
  });
  params.log?.info?.(`[qqbot:${params.accountId}] Late deliver ignored after response timeout, kind: ${params.info.kind}`);
  return { kind: "late-ignored" };
}

export function prepareCustomBlockDeliver(
  params: PrepareCustomBlockDeliverParams,
): PrepareCustomBlockDeliverResult {
  const blockReplyText = (params.payload.text ?? "").trim();
  const explicitModelSkip = params.event.type === "group" && isCustomModelSkipOutput(blockReplyText);
  const unreadDecisionSkip = isCustomUnreadSilentDecisionOutput(blockReplyText, params.event);
  if (explicitModelSkip || unreadDecisionSkip) {
    params.state.markModelSkipOutput?.();
    params.log?.info?.(`[qqbot:${params.accountId}] Model decided to skip group message (token=${blockReplyText}) from ${params.event.senderId ?? ""}: ${params.event.content?.slice(0, 50) ?? ""}`);
    return {
      kind: "model-skip",
      token: explicitModelSkip ? blockReplyText : "CUSTOM_UNREAD_SILENT",
    };
  }

  params.state.markBlockResponse();
  params.stopTyping();
  params.clearResponseTimeout();
  params.clearToolOnlyTimeout();

  const toolDeliverCount = params.state.toolDeliverCount;
  if (toolDeliverCount > 0) {
    params.log?.info?.(`[qqbot:${params.accountId}] Block deliver after ${toolDeliverCount} tool deliver(s)`);
  }

  return {
    kind: "ready",
    toolDeliverCount,
  };
}
