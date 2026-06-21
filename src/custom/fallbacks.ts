export const CUSTOM_RESPONSE_TIMEOUT_MS = 300_000;
export const CUSTOM_TOOL_ONLY_TIMEOUT_MS = 90_000;
export const CUSTOM_TOOL_ONLY_MAX_RENEWALS = 3;
export const CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS = 45_000;

export const CUSTOM_RESPONSE_TIMEOUT_NOTICE = "这轮处理超时了，我先不挡队列，后面的消息会继续处理。";
export const CUSTOM_TOOL_NO_OUTPUT_NOTICE = "工具这轮没产出能发的内容，我先不挡队列，后面的消息会继续处理。";

export type CustomDispatchFailureKind = "response-timeout" | "other";

export interface CustomToolFallbackTextOptions {
  maxItems?: number;
  maxChars?: number;
  separator?: string;
}

export function isCustomModelSkipOutput(text: string | null | undefined): boolean {
  const normalized = (text ?? "").trim();
  return normalized === "NO_REPLY" || normalized === "[SKIP]";
}

export function formatCustomResponseTimeoutNotice(): string {
  return CUSTOM_RESPONSE_TIMEOUT_NOTICE;
}

export function formatCustomToolNoOutputNotice(): string {
  return CUSTOM_TOOL_NO_OUTPUT_NOTICE;
}

export function selectCustomToolFallbackText(
  texts: readonly string[],
  options: CustomToolFallbackTextOptions = {},
): string | null {
  const maxItems = normalizePositiveInteger(options.maxItems, 3);
  const maxChars = normalizePositiveInteger(options.maxChars, 2_000);
  const separator = options.separator ?? "\n---\n";
  const selected = texts
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(-maxItems);

  if (selected.length === 0) {
    return null;
  }

  return selected.join(separator).slice(0, maxChars);
}

export function classifyCustomDispatchFailure(err: unknown): CustomDispatchFailureKind {
  return String(err).includes("Response timeout") ? "response-timeout" : "other";
}

function normalizePositiveInteger(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(1, Math.floor(raw));
}
