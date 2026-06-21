import type { CustomActor, CustomPeer } from "./types.js";

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

export type CustomFallbackEventKind =
  | "response-timeout"
  | "context-too-long"
  | "late-deliver-after-timeout"
  | "tool-only-timeout"
  | "tool-only-complete-no-block"
  | "tool-fallback-media"
  | "tool-fallback-text"
  | "tool-fallback-no-output"
  | "urgent-queue-bypass";

export interface CustomFallbackEvent {
  type: "custom-fallback";
  kind: CustomFallbackEventKind;
  accountId: string;
  peer?: CustomPeer;
  actor?: CustomActor;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  reason?: string;
  at: number;
  toolDeliverCount?: number;
  toolTextCount?: number;
  toolMediaCount?: number;
  hasResponse?: boolean;
  hasBlockResponse?: boolean;
  timeoutMs?: number;
  details?: Record<string, string | number | boolean | null>;
}

export type CustomFallbackEventDetails = Record<string, string | number | boolean | null>;
export type CustomFallbackEventInputDetails = Record<string, string | number | boolean | null | undefined>;

export interface BuildCustomFallbackEventParams extends Omit<CustomFallbackEvent, "type" | "at" | "details"> {
  at?: number;
  details?: CustomFallbackEventInputDetails;
}

export function isCustomModelSkipOutput(text: string | null | undefined): boolean {
  const normalized = (text ?? "").trim();
  return normalized === "NO_REPLY" || normalized === "[SKIP]";
}

export function formatCustomResponseTimeoutNotice(): string {
  return [
    CUSTOM_RESPONSE_TIMEOUT_NOTICE,
    "",
    "可直接点下面的恢复命令：",
    commandInput("/bot-fallback summary 20", "查看兜底摘要"),
    commandInput("/compact", "压缩上下文"),
    commandInput("/new", "新会话"),
  ].join("\n");
}

export function formatCustomToolNoOutputNotice(): string {
  return [
    CUSTOM_TOOL_NO_OUTPUT_NOTICE,
    "",
    "可直接点下面的恢复命令：",
    commandInput("/bot-fallback summary 20", "查看兜底摘要"),
    commandInput("/compact", "压缩上下文"),
  ].join("\n");
}

export function formatCustomContextTooLongNotice(): string {
  return [
    CUSTOM_CONTEXT_TOO_LONG_NOTICE,
    "",
    "建议先压缩；如果仍失败，再开新会话：",
    commandInput("/compact", "压缩上下文"),
    commandInput("/new", "新会话"),
    commandInput("/bot-fallback summary 20", "查看兜底摘要"),
  ].join("\n");
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

export function buildCustomFallbackEvent(params: BuildCustomFallbackEventParams): CustomFallbackEvent {
  const event = pruneUndefinedDeep({
    type: "custom-fallback" as const,
    ...params,
    at: params.at ?? Date.now(),
    details: params.details,
  });
  return event as CustomFallbackEvent;
}

export function formatCustomFallbackEventLog(event: CustomFallbackEvent): string {
  return `custom fallback event: ${JSON.stringify(event)}`;
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

function commandInput(text: string, show: string): string {
  return `<qqbot-cmd-input text="${escapeCommandInputAttr(text)}" show="${escapeCommandInputAttr(show)}"/>`;
}

function escapeCommandInputAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pruneUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefinedDeep(item)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return pruneUndefined(value as Record<string, unknown>) as T;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const pruned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      pruned[key] = pruneUndefinedDeep(item);
    }
  }
  return pruned as T;
}
