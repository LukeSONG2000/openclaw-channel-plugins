export const CUSTOM_RESPONSE_TIMEOUT_MS = 300_000;
export const CUSTOM_TOOL_ONLY_TIMEOUT_MS = 90_000;
export const CUSTOM_TOOL_ONLY_MAX_RENEWALS = 3;
export const CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS = 45_000;

export const CUSTOM_RESPONSE_TIMEOUT_NOTICE = "这轮处理超时了，我先不挡队列，后面的消息会继续处理。";
export const CUSTOM_TOOL_NO_OUTPUT_NOTICE = "工具这轮没产出能发的内容，我先不挡队列，后面的消息会继续处理。";
export const CUSTOM_CONTEXT_TOO_LONG_NOTICE = "这轮上下文太长了，模型没法继续接收。我先释放队列；请先发送 /compact 压缩上下文，必要时发送 /new 开新会话后再重试。";

export type CustomDispatchFailureKind = "response-timeout" | "context-too-long" | "other";

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

export function formatCustomContextTooLongNotice(): string {
  return CUSTOM_CONTEXT_TOO_LONG_NOTICE;
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
  const errText = formatCustomErrorForMatch(err);
  if (errText.includes("Response timeout")) {
    return "response-timeout";
  }
  if (isCustomContextTooLongErrorText(errText)) {
    return "context-too-long";
  }
  return "other";
}

function normalizePositiveInteger(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(1, Math.floor(raw));
}

function formatCustomErrorForMatch(err: unknown): string {
  const parts = [String(err)];
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    for (const key of ["name", "message", "code", "type", "status", "statusCode"]) {
      const value = record[key];
      if (value !== undefined && value !== null) {
        parts.push(String(value));
      }
    }
    const cause = record.cause;
    if (cause && cause !== err) {
      parts.push(formatCustomErrorForMatch(cause));
    }
  }
  return parts.join(" ");
}

function isCustomContextTooLongErrorText(errText: string): boolean {
  const normalized = errText.toLowerCase();
  return [
    /context[_\s-]*length[_\s-]*exceeded/,
    /maximum context length/,
    /context window/,
    /context.*too long/,
    /prompt.*too long/,
    /input.*too long/,
    /too many tokens/,
    /tokens?.*exceed/,
    /exceed.*tokens?/,
    /tokens?.*limit/,
    /limit.*tokens?/,
    /reduce.*context/,
    /上下文.*(过长|超长|太长)/,
  ].some((pattern) => pattern.test(normalized));
}
