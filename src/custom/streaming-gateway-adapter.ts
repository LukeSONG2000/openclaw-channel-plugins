import type { CustomFallbackDeliverPayload } from "./fallback-dispatch-state.js";

export interface CustomStreamingGatewayLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomStreamingGatewayController {
  readonly isTerminalPhase: boolean;
  readonly shouldFallbackToStatic: boolean;
  readonly currentPhase?: unknown;
  readonly sentChunkCount_debug?: number;
  onDeliver(payload: CustomFallbackDeliverPayload): Promise<void>;
  onError(err: unknown): Promise<void>;
  onPartialReply(payload: { text?: string }): Promise<void>;
  markFullyComplete(): void;
  onIdle(): Promise<void>;
  abortStreaming(): Promise<void>;
}

export type CustomStreamingDeliverResult =
  | { kind: "no-controller" }
  | { kind: "fallback-static" }
  | { kind: "handled" };

export type CustomStreamingErrorResult =
  | { kind: "no-controller" }
  | { kind: "fallback-static" }
  | { kind: "handled" };

export type CustomStreamingPartialResult =
  | { kind: "no-controller" }
  | { kind: "handled" };

export type CustomStreamingFinalizeResult =
  | { kind: "no-controller" }
  | { kind: "finalized"; fallbackToStatic: boolean }
  | { kind: "already-terminal"; fallbackToStatic: boolean };

export async function handleCustomStreamingDeliver(params: {
  accountId: string;
  controller: CustomStreamingGatewayController | null | undefined;
  payload: CustomFallbackDeliverPayload;
  recordOutboundActivity: () => void;
  log?: CustomStreamingGatewayLogger;
}): Promise<CustomStreamingDeliverResult> {
  const controller = params.controller;
  if (!controller || controller.isTerminalPhase) return { kind: "no-controller" };

  const deliverTextLen = (params.payload.text ?? "").length;
  const deliverPreview = (params.payload.text ?? "").slice(0, 40).replace(/\n/g, "\\n");
  params.log?.debug?.(`[qqbot:${params.accountId}] Streaming deliver entry, textLen=${deliverTextLen}, phase=${controller.currentPhase}, sentChunks=${controller.sentChunkCount_debug}, preview="${deliverPreview}"`);
  try {
    await controller.onDeliver(params.payload);
    params.log?.debug?.(`[qqbot:${params.accountId}] Streaming deliver done, phase=${controller.currentPhase}`);
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.accountId}] Streaming deliver error: ${err}`);
  }

  if (controller.shouldFallbackToStatic) {
    params.log?.info?.(`[qqbot:${params.accountId}] Streaming API unavailable, falling back to static for this deliver`);
    return { kind: "fallback-static" };
  }

  params.recordOutboundActivity();
  return { kind: "handled" };
}

export async function handleCustomStreamingError(params: {
  accountId: string;
  controller: CustomStreamingGatewayController | null | undefined;
  err: unknown;
  log?: CustomStreamingGatewayLogger;
}): Promise<CustomStreamingErrorResult> {
  const controller = params.controller;
  if (!controller || controller.isTerminalPhase) return { kind: "no-controller" };

  try {
    await controller.onError(params.err);
  } catch (streamErr) {
    params.log?.error?.(`[qqbot:${params.accountId}] Streaming onError failed: ${streamErr}`);
  }

  if (controller.shouldFallbackToStatic) {
    params.log?.info?.(`[qqbot:${params.accountId}] Streaming onError: no chunk sent, falling back to static error handling`);
    return { kind: "fallback-static" };
  }

  return { kind: "handled" };
}

export async function handleCustomStreamingPartialReply(params: {
  accountId: string;
  controller: CustomStreamingGatewayController | null | undefined;
  payload: { text?: string };
  log?: CustomStreamingGatewayLogger;
}): Promise<CustomStreamingPartialResult> {
  const controller = params.controller;
  if (!controller) return { kind: "no-controller" };

  const textLen = params.payload.text?.length ?? 0;
  const preview = (params.payload.text ?? "").slice(0, 40).replace(/\n/g, "\\n");
  params.log?.debug?.(`[qqbot:${params.accountId}] onPartialReply called, textLen=${textLen}, phase=${controller.currentPhase}, isTerminal=${controller.isTerminalPhase}, preview="${preview}"`);
  try {
    await controller.onPartialReply(params.payload);
    params.log?.debug?.(`[qqbot:${params.accountId}] onPartialReply done, phase=${controller.currentPhase}`);
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.accountId}] Streaming onPartialReply error: ${err}`);
  }
  return { kind: "handled" };
}

export async function finalizeCustomStreamingController(params: {
  accountId: string;
  controller: CustomStreamingGatewayController | null | undefined;
  log?: CustomStreamingGatewayLogger;
}): Promise<CustomStreamingFinalizeResult> {
  const controller = params.controller;
  if (!controller) return { kind: "no-controller" };

  if (!controller.isTerminalPhase) {
    try {
      controller.markFullyComplete();
      await controller.onIdle();
      params.log?.debug?.(`[qqbot:${params.accountId}] Streaming controller finalized`);
    } catch (err) {
      params.log?.error?.(`[qqbot:${params.accountId}] Streaming finalization error: ${err}`);
      try {
        await controller.abortStreaming();
      } catch {
        // Best-effort cleanup only; the original error has already been logged.
      }
    }
    if (controller.shouldFallbackToStatic) {
      params.log?.debug?.(`[qqbot:${params.accountId}] Streaming was degraded to static mode (no chunk sent successfully)`);
    }
    return { kind: "finalized", fallbackToStatic: controller.shouldFallbackToStatic };
  }

  if (controller.shouldFallbackToStatic) {
    params.log?.debug?.(`[qqbot:${params.accountId}] Streaming was degraded to static mode (no chunk sent successfully)`);
  }
  return { kind: "already-terminal", fallbackToStatic: controller.shouldFallbackToStatic };
}
