import {
  CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS,
  formatCustomToolNoOutputNotice,
  selectCustomToolFallbackText,
} from "./fallbacks.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";

export interface CustomToolFallbackLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomToolFallbackStateView {
  toolMediaUrls: readonly string[];
  toolTexts: readonly string[];
  toolDeliverCount: number;
}

export interface CustomToolFallbackMediaSendResult {
  channel: string;
  error?: string;
}

export interface CustomToolFallbackMediaResult extends CustomToolFallbackMediaSendResult {
  mediaUrl: string;
}

export type CustomToolFallbackSendMedia = (
  mediaUrl: string,
  label: string,
) => Promise<CustomToolFallbackMediaSendResult>;

export type CustomToolFallbackSendText = (text: string) => Promise<void>;

export interface SendCustomToolFallbackParams {
  accountId: string;
  state: CustomToolFallbackStateView;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendGuardedMediaAuto: CustomToolFallbackSendMedia;
  sendErrorMessage: CustomToolFallbackSendText;
  log?: CustomToolFallbackLogger;
  mediaTimeoutMs?: number;
}

export type SendCustomToolFallbackResult =
  | {
      kind: "media";
      mediaCount: number;
      mediaResults: CustomToolFallbackMediaResult[];
    }
  | {
      kind: "text";
      textChars: number;
    }
  | {
      kind: "no-output";
    };

export async function sendCustomToolFallback(
  params: SendCustomToolFallbackParams,
): Promise<SendCustomToolFallbackResult> {
  const mediaUrls = [...params.state.toolMediaUrls];
  if (mediaUrls.length > 0) {
    params.recordFallbackEvent({
      kind: "tool-fallback-media",
      reason: "tool produced media but no block deliver was available",
    });
    params.log?.info?.(`[qqbot:${params.accountId}] Tool fallback: forwarding ${mediaUrls.length} media URL(s) from tool deliver(s)`);

    const mediaTimeoutMs = params.mediaTimeoutMs ?? CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS;
    const mediaResults: CustomToolFallbackMediaResult[] = [];
    for (const mediaUrl of mediaUrls) {
      try {
        const result = await sendMediaWithTimeout(
          params.sendGuardedMediaAuto(mediaUrl, "Tool fallback media"),
          mediaTimeoutMs,
        );
        mediaResults.push({ mediaUrl, ...result });
        if (result.error) {
          params.log?.error?.(`[qqbot:${params.accountId}] Tool fallback sendMedia error: ${result.error}`);
        }
      } catch (err) {
        const error = String(err);
        mediaResults.push({ mediaUrl, channel: "qqbot", error });
        params.log?.error?.(`[qqbot:${params.accountId}] Tool fallback sendMedia failed: ${err}`);
      }
    }
    return {
      kind: "media",
      mediaCount: mediaUrls.length,
      mediaResults,
    };
  }

  const text = selectCustomToolFallbackText(params.state.toolTexts) ?? "";
  if (text) {
    params.recordFallbackEvent({
      kind: "tool-fallback-text",
      reason: "tool produced text but no block deliver was available",
      details: { fallbackTextChars: text.length },
    });
    params.log?.info?.(`[qqbot:${params.accountId}] Tool fallback: forwarding tool text (${text.length} chars)`);
    await params.sendErrorMessage(text);
    return {
      kind: "text",
      textChars: text.length,
    };
  }

  params.recordFallbackEvent({
    kind: "tool-fallback-no-output",
    reason: "tool-only run produced no user-sendable media or text",
  });
  params.log?.info?.(`[qqbot:${params.accountId}] Tool fallback: no media or text collected from ${params.state.toolDeliverCount} tool deliver(s), sending timeout notice`);
  await params.sendErrorMessage(formatCustomToolNoOutputNotice());
  return { kind: "no-output" };
}

async function sendMediaWithTimeout(
  promise: Promise<CustomToolFallbackMediaSendResult>,
  mediaTimeoutMs: number,
): Promise<CustomToolFallbackMediaSendResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<CustomToolFallbackMediaSendResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            channel: "qqbot",
            error: `Tool fallback media send timeout (${mediaTimeoutMs / 1000}s)`,
          });
        }, mediaTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
