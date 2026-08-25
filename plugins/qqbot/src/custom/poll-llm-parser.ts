import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getQQBotRuntime } from "../runtime.js";
import {
  encodeCustomPollCreateCommand,
  formatMissingCreateFields,
  normalizeCustomPollCreateCommand,
  type CustomPollCommand,
} from "./poll-command-parser.js";

export interface CustomPollLlmCompleteParams {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  purpose?: string;
  agentId?: string;
  signal?: AbortSignal;
}

export type CustomPollLlmComplete = (params: CustomPollLlmCompleteParams) => Promise<{ text: string }>;

export interface CustomPollLlmParseResult {
  handled: boolean;
  content?: string;
  reply?: string;
  error?: string;
}

interface PollParseJson {
  ok?: unknown;
  missing?: unknown;
  question?: unknown;
  options?: unknown;
  multiple?: unknown;
  anonymous?: unknown;
  durationMs?: unknown;
  durationMinutes?: unknown;
}

const POLL_PARSE_TIMEOUT_MS = 8_000;
const POLL_PARSE_MAX_RETRIES = 2;
const POLL_PARSE_RETRY_BASE_DELAY_MS = 600;

export function isCustomPollNaturalLanguageCreate(rawContent: string): boolean {
  const content = rawContent.trim();
  if (!content || content.startsWith("/")) return false;
  if (!/投票/.test(content)) return false;
  if (/^(查询|查看|列出|打开|结束|关闭)投票/.test(content)) return false;
  return /(?:创建|发起|新建|开|搞|来(?:一|1)?个|做|单选|多选|匿名|实名|收票|收集结果|结束|截止).*投票/.test(content)
    || /投票.*(?:创建|发起|新建|单选|多选|匿名|实名|选项|收票|收集结果|结束|截止)/.test(content);
}

export function isCustomPollCreateNeedingModel(rawContent: string): boolean {
  const parsed = splitBotPollCommand(rawContent);
  if (!parsed) return false;
  const action = parsed.action.toLowerCase();
  if (!action) return false;
  return !new Set(["help", "?", "list", "ls", "status", "show", "close", "end", "__create"]).has(action);
}

export async function resolveCustomPollCreateWithModel(params: {
  cfg: OpenClawConfig;
  rawContent: string;
  agentId?: string;
  complete?: CustomPollLlmComplete;
}): Promise<CustomPollLlmParseResult> {
  const requestText = extractPollRequestText(params.rawContent);
  if (!requestText) {
    return { handled: true, reply: formatMissingCreateFields() };
  }

  const complete = params.complete ?? resolveRuntimeComplete();
  if (!complete) return { handled: false };

  try {
    const signal = AbortSignal.timeout(POLL_PARSE_TIMEOUT_MS);
    const completion = await completeWithRetry({
      complete,
      requestText,
      agentId: params.agentId,
      signal,
    });
    const parsed = parsePollJson(completion.text);
    const command = pollJsonToCommand(parsed);
    if (!command) {
      return { handled: true, reply: formatMissingCreateFields() };
    }
    return { handled: true, content: encodeCustomPollCreateCommand(command) };
  } catch (error) {
    return { handled: false, error: String(error) };
  }
}

export function extractPollRequestText(rawContent: string): string {
  const parsed = splitBotPollCommand(rawContent);
  if (!parsed) return "";
  const action = parsed.action;
  const normalizedAction = action.toLowerCase();
  const rest = parsed.rest.trim();
  if (!action) return "";
  if (normalizedAction === "create" || normalizedAction === "new") return rest;
  return [action, rest].filter(Boolean).join(" ").trim();
}

function splitBotPollCommand(rawContent: string): { action: string; rest: string } | null {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return null;
  const match = content.match(/^\/bot-po(?:l|o)l(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const args = (match[1] ?? "").trim();
  const [action = "", ...rest] = args.split(/\s+/).filter(Boolean);
  return { action, rest: rest.join(" ") };
}

function buildPollParseSystemPrompt(): string {
  return [
    "你是 QQ 群投票创建参数解析器，只输出严格 JSON，不要 Markdown，不要解释。",
    "任务：把用户的自然语言投票需求解析为创建投票所需字段。用户不需要按固定格式书写。",
    "输出 schema：{\"ok\":boolean,\"missing\":string[],\"question\":string|null,\"options\":string[],\"multiple\":boolean,\"anonymous\":boolean,\"durationMs\":number}",
    "规则：",
    "1. 必需字段是 question 和至少 2 个 options。缺少时 ok=false，并在 missing 写 question/options。",
    "2. 标题未显式指定但可以从语义总结时，自行总结为简短 question。",
    "3. 用户表达二选一/是否/要不要时，可以生成两个自然选项，例如 是/否 或 去/不去。不要凭空扩展无依据的多个选项。",
    "4. 默认单选 multiple=false；看到多选/复选/可多选才 multiple=true。",
    "5. 默认不匿名 anonymous=false；看到匿名才 true；看到实名/不匿名则 false。",
    "6. 默认持续 10 分钟 durationMs=600000；支持分钟/小时/天，范围 60000 到 2592000000。",
    "7. options 最多 10 个，每个选项不超过 30 字，去重，保留用户原意。",
  ].join("\n");
}

function parsePollJson(text: string): PollParseJson | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PollParseJson : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}

function pollJsonToCommand(parsed: PollParseJson | null): Extract<CustomPollCommand, { kind: "create" }> | null {
  if (!parsed || parsed.ok === false) return null;
  const durationMs = normalizeDurationMs(parsed.durationMs ?? parsed.durationMinutes);
  const command = normalizeCustomPollCreateCommand({
    question: typeof parsed.question === "string" ? parsed.question : "",
    options: Array.isArray(parsed.options) ? parsed.options.filter((item): item is string => typeof item === "string") : [],
    multiple: typeof parsed.multiple === "boolean" ? parsed.multiple : false,
    anonymous: typeof parsed.anonymous === "boolean" ? parsed.anonymous : false,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  return command;
}

function normalizeDurationMs(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Backward-compatible tolerance: values <= 43200 are probably minutes.
  const ms = n <= 43_200 ? n * 60_000 : n;
  return Math.min(Math.max(Math.round(ms), 60_000), 30 * 24 * 60 * 60 * 1000);
}

function resolveRuntimeComplete(): CustomPollLlmComplete | null {
  try {
    const runtime = getQQBotRuntime() as unknown as { llm?: { complete?: CustomPollLlmComplete } };
    return typeof runtime.llm?.complete === "function" ? runtime.llm.complete.bind(runtime.llm) : null;
  } catch {
    return null;
  }
}

async function completeWithRetry(params: {
  complete: CustomPollLlmComplete;
  requestText: string;
  agentId?: string;
  signal: AbortSignal;
}): Promise<{ text: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= POLL_PARSE_MAX_RETRIES; attempt += 1) {
    try {
      return await params.complete({
        ...(params.agentId ? { agentId: params.agentId } : {}),
        purpose: "qqbot.poll.parse",
        maxTokens: 600,
        temperature: 0,
        signal: params.signal,
        messages: [
          { role: "system", content: buildPollParseSystemPrompt() },
          { role: "user", content: params.requestText },
        ],
      });
    } catch (error) {
      lastError = error;
      if (attempt >= POLL_PARSE_MAX_RETRIES || !isRetryablePollParseError(error)) {
        throw error;
      }
      await sleep(POLL_PARSE_RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryablePollParseError(error: unknown): boolean {
  if (!error) return false;
  const text = String(error);
  return /overload|429|rate limit|rate-limit|too many requests|service unavailable|temporarily unavailable|timeout|timed out|503|502|504/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
