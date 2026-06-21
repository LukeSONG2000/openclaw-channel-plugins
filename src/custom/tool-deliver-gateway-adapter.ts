import type {
  CustomFallbackDeliverPayload,
  CustomFallbackToolDeliverObservation,
} from "./fallback-dispatch-state.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import type {
  CustomToolFallbackLogger,
  CustomToolFallbackSendMedia,
} from "./tool-fallback-gateway-adapter.js";

export type CustomToolOnlyTimerHandle = ReturnType<typeof setTimeout>;
export type CustomToolOnlyTimerScheduler = (
  callback: () => void,
  delayMs: number,
) => CustomToolOnlyTimerHandle;
export type CustomToolOnlyTimerClearer = (timer: CustomToolOnlyTimerHandle) => void;

export interface CustomToolDeliverGatewayState {
  readonly hasBlockResponse: boolean;
  readonly toolMediaUrls: readonly string[];
  readonly toolFallbackSent: boolean;
  readonly toolDeliverCount: number;
  observeToolDeliver(payload: CustomFallbackDeliverPayload): CustomFallbackToolDeliverObservation;
  consumeToolMediaForImmediateForward(): { urlsToSend: string[]; skippedCount: number };
  shouldRenewToolOnlyTimer(maxRenewals: number): { renew: boolean; renewalCount: number };
  markToolFallbackSent(): void;
}

export interface HandleCustomToolDeliverGatewayParams {
  accountId: string;
  payload: CustomFallbackDeliverPayload;
  state: CustomToolDeliverGatewayState;
  currentTimer: CustomToolOnlyTimerHandle | null;
  setTimer: (timer: CustomToolOnlyTimerHandle | null) => void;
  toolOnlyTimeoutMs: number;
  maxToolRenewals: number;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendGuardedMediaAuto: CustomToolFallbackSendMedia;
  sendToolFallback: () => Promise<void>;
  log?: CustomToolFallbackLogger;
  scheduleTimer?: CustomToolOnlyTimerScheduler;
  clearTimer?: CustomToolOnlyTimerClearer;
}

export type HandleCustomToolDeliverGatewayResult =
  | {
      kind: "immediate-media-forward";
      observation: CustomFallbackToolDeliverObservation;
      forwardedCount: number;
      skippedCount: number;
    }
  | {
      kind: "immediate-media-skipped";
      observation: CustomFallbackToolDeliverObservation;
      skippedCount: number;
    }
  | {
      kind: "fallback-already-sent";
      observation: CustomFallbackToolDeliverObservation;
    }
  | {
      kind: "timer-renewal-limit";
      observation: CustomFallbackToolDeliverObservation;
      renewalCount: number;
    }
  | {
      kind: "timer-started";
      observation: CustomFallbackToolDeliverObservation;
      timer: CustomToolOnlyTimerHandle;
      renewed: boolean;
      renewalCount: number;
    };

export async function handleCustomToolDeliverGateway(
  params: HandleCustomToolDeliverGatewayParams,
): Promise<HandleCustomToolDeliverGatewayResult> {
  const observation = params.state.observeToolDeliver(params.payload);
  params.log?.info?.(`[qqbot:${params.accountId}] Collected tool deliver #${observation.toolDeliverCount}: text=${observation.toolTextChars} chars, media=${observation.toolMediaCount} URLs`);

  if (params.state.hasBlockResponse && params.state.toolMediaUrls.length > 0) {
    return forwardPostBlockToolMedia(params, observation);
  }

  if (params.state.toolFallbackSent) {
    return { kind: "fallback-already-sent", observation };
  }

  let renewed = false;
  let renewalCount = 0;
  if (params.currentTimer) {
    const renewal = params.state.shouldRenewToolOnlyTimer(params.maxToolRenewals);
    renewalCount = renewal.renewalCount;
    if (!renewal.renew) {
      params.log?.info?.(`[qqbot:${params.accountId}] Tool-only timer renewal limit reached (${params.maxToolRenewals}), waiting for timeout`);
      return { kind: "timer-renewal-limit", observation, renewalCount };
    }
    (params.clearTimer ?? clearTimeout)(params.currentTimer);
    params.setTimer(null);
    renewed = true;
    params.log?.info?.(`[qqbot:${params.accountId}] Tool-only timer renewed (${renewal.renewalCount}/${params.maxToolRenewals})`);
  }

  const scheduleTimer = params.scheduleTimer ?? setTimeout;
  const timer = scheduleTimer(() => {
    void triggerToolOnlyFallbackAfterTimeout(params);
  }, params.toolOnlyTimeoutMs);
  params.setTimer(timer);

  return {
    kind: "timer-started",
    observation,
    timer,
    renewed,
    renewalCount,
  };
}

async function forwardPostBlockToolMedia(
  params: HandleCustomToolDeliverGatewayParams,
  observation: CustomFallbackToolDeliverObservation,
): Promise<HandleCustomToolDeliverGatewayResult> {
  const { urlsToSend, skippedCount } = params.state.consumeToolMediaForImmediateForward();
  if (urlsToSend.length === 0) {
    params.log?.info?.(`[qqbot:${params.accountId}] All ${skippedCount} tool media URL(s) already handled by block deliver, skipping`);
    return {
      kind: "immediate-media-skipped",
      observation,
      skippedCount,
    };
  }

  params.log?.info?.(`[qqbot:${params.accountId}] Block already sent, immediately forwarding ${urlsToSend.length} tool media URL(s) (deduped from block deliver)`);
  for (const mediaUrl of urlsToSend) {
    try {
      const result = await params.sendGuardedMediaAuto(mediaUrl, "Tool media immediate forward");
      if (result.error) {
        params.log?.error?.(`[qqbot:${params.accountId}] Tool media immediate forward error: ${result.error}`);
      } else {
        params.log?.info?.(`[qqbot:${params.accountId}] Forwarded tool media (post-block): ${mediaUrl.slice(0, 80)}...`);
      }
    } catch (err) {
      params.log?.error?.(`[qqbot:${params.accountId}] Tool media immediate forward failed: ${err}`);
    }
  }

  return {
    kind: "immediate-media-forward",
    observation,
    forwardedCount: urlsToSend.length,
    skippedCount,
  };
}

async function triggerToolOnlyFallbackAfterTimeout(
  params: HandleCustomToolDeliverGatewayParams,
): Promise<void> {
  if (params.state.hasBlockResponse || params.state.toolFallbackSent) return;

  params.state.markToolFallbackSent();
  params.recordFallbackEvent({
    kind: "tool-only-timeout",
    reason: "tool deliver callbacks arrived but no block deliver before timeout",
    timeoutMs: params.toolOnlyTimeoutMs,
  });
  params.log?.error?.(`[qqbot:${params.accountId}] Tool-only timeout: ${params.state.toolDeliverCount} tool deliver(s) but no block within ${params.toolOnlyTimeoutMs / 1000}s, sending fallback`);
  try {
    await params.sendToolFallback();
  } catch (sendErr) {
    params.log?.error?.(`[qqbot:${params.accountId}] Failed to send tool-only fallback: ${sendErr}`);
  }
}
