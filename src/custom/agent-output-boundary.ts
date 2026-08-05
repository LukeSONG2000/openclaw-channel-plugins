const FINAL_OUTPUT_TTL_MS = 10 * 60 * 1000;
const FINAL_OUTPUT_MAX_ENTRIES = 2048;

export interface CustomAgentOutputEvent {
  runId?: string;
  assistantTexts?: unknown;
  lastAssistant?: unknown;
}

export interface CustomAgentFinalOutput {
  runId: string;
  capturedAt: number;
  finalText: string;
  silent: boolean;
  hasThinkingBlocks: boolean;
}

interface CustomReplyPayloadSendingEvent {
  payload?: {
    text?: string;
    isReasoning?: boolean;
    [key: string]: unknown;
  };
  kind?: string;
  channel?: string;
  runId?: string;
}

interface CustomAgentOutputHookApi {
  on?: (
    hookName: string,
    handler: (event: any, ctx?: unknown) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

const finalOutputsByRunId = new Map<string, CustomAgentFinalOutput>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readLastAssistantContent(event: CustomAgentOutputEvent): {
  text: string;
  hasThinkingBlocks: boolean;
} {
  if (isRecord(event.lastAssistant) && Array.isArray(event.lastAssistant.content)) {
    const textBlocks: string[] = [];
    let hasThinkingBlocks = false;
    for (const block of event.lastAssistant.content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking") {
        hasThinkingBlocks = true;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        textBlocks.push(block.text);
      }
    }
    if (textBlocks.length > 0 || hasThinkingBlocks) {
      return {
        text: textBlocks.join("\n\n").trim(),
        hasThinkingBlocks,
      };
    }
  }

  const assistantTexts = Array.isArray(event.assistantTexts)
    ? event.assistantTexts.filter((item): item is string => typeof item === "string")
    : [];
  return {
    text: (assistantTexts.at(-1) ?? "").trim(),
    hasThinkingBlocks: false,
  };
}

function hasTerminalSilentFinal(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const finalLine = lines.at(-1);
  if (!finalLine) return false;
  return /^(?:[*_`~]+\s*)?NO_REPLY(?:\s*[*_`~]+)?$/i.test(finalLine);
}

function pruneFinalOutputs(now: number): void {
  for (const [runId, output] of finalOutputsByRunId) {
    if (now - output.capturedAt > FINAL_OUTPUT_TTL_MS) {
      finalOutputsByRunId.delete(runId);
    }
  }
  while (finalOutputsByRunId.size > FINAL_OUTPUT_MAX_ENTRIES) {
    const oldestRunId = finalOutputsByRunId.keys().next().value;
    if (typeof oldestRunId !== "string") break;
    finalOutputsByRunId.delete(oldestRunId);
  }
}

export function captureCustomAgentFinalOutput(
  event: CustomAgentOutputEvent,
  now = Date.now(),
): CustomAgentFinalOutput | null {
  const runId = typeof event.runId === "string" ? event.runId.trim() : "";
  if (!runId) return null;

  const content = readLastAssistantContent(event);
  const output: CustomAgentFinalOutput = {
    runId,
    capturedAt: now,
    finalText: content.text,
    silent: hasTerminalSilentFinal(content.text),
    hasThinkingBlocks: content.hasThinkingBlocks,
  };
  finalOutputsByRunId.set(runId, output);
  pruneFinalOutputs(now);
  return output;
}

export function peekCustomAgentFinalOutput(runId: string | undefined): CustomAgentFinalOutput | undefined {
  if (!runId) return undefined;
  const output = finalOutputsByRunId.get(runId);
  if (!output) return undefined;
  if (Date.now() - output.capturedAt > FINAL_OUTPUT_TTL_MS) {
    finalOutputsByRunId.delete(runId);
    return undefined;
  }
  return output;
}

export function consumeCustomAgentFinalOutput(runId: string | undefined): CustomAgentFinalOutput | undefined {
  const output = peekCustomAgentFinalOutput(runId);
  if (runId) finalOutputsByRunId.delete(runId);
  return output;
}

export function isCustomFinalDeliverKind(kind: string | undefined): boolean {
  return kind === "final" || kind === "block";
}

export function isCustomReasoningDeliver(
  payload: { isReasoning?: boolean } | undefined,
  kind: string | undefined,
): boolean {
  return payload?.isReasoning === true || kind === "reasoning" || kind === "thinking";
}

export function registerCustomAgentOutputBoundary(api: CustomAgentOutputHookApi): void {
  if (typeof api.on !== "function") {
    api.logger?.warn?.("[qqbot] OpenClaw hook API unavailable; structured thinking/final boundary disabled");
    return;
  }

  api.on("llm_output", (event: CustomAgentOutputEvent) => {
    const output = captureCustomAgentFinalOutput(event);
    if (output?.silent) {
      api.logger?.info?.(`[qqbot] Captured terminal silent final for runId=${output.runId}`);
    }
  });

  api.on("reply_payload_sending", (event: CustomReplyPayloadSendingEvent) => {
    if (isCustomReasoningDeliver(event.payload, event.kind)) {
      return {
        cancel: true,
        reason: "reasoning payload is not user-visible final output",
      };
    }

    if (!isCustomFinalDeliverKind(event.kind)) return;
    const output = peekCustomAgentFinalOutput(event.runId);
    if (!output?.silent) return;

    const channel = event.channel?.trim().toLowerCase();
    if (channel === "qqbot" || channel?.startsWith("qqbot:")) {
      return {
        payload: { text: "NO_REPLY" },
        reason: "terminal NO_REPLY is the final decision for the whole model output",
      };
    }
    return {
      cancel: true,
      reason: "terminal NO_REPLY is the final decision for the whole model output",
    };
  });
}

export function resetCustomAgentOutputBoundaryForTests(): void {
  finalOutputsByRunId.clear();
}
