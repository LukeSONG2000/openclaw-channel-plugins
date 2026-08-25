import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getQQBotRuntime } from "../runtime.js";
import { inferScheduledTaskCapabilities, parseCustomScheduledTaskIntent } from "./scheduled-task.js";
import type { CustomActor, CustomScheduledTaskActionKind } from "./types.js";

export interface CustomScheduledTaskLlmCompleteParams {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  purpose?: string;
  agentId?: string;
  signal?: AbortSignal;
}

export type CustomScheduledTaskLlmComplete = (params: CustomScheduledTaskLlmCompleteParams) => Promise<{ text: string }>;

export interface CustomScheduledTaskLlmParseResult {
  handled: boolean;
  parsed?: {
    intervalMs: number;
    durationMs?: number;
    prompt: string;
    targetActors: CustomActor[];
    requiredCapabilities: ReturnType<typeof inferScheduledTaskCapabilities>;
    actionKind: CustomScheduledTaskActionKind;
  };
  error?: string;
}

interface ScheduledTaskParseJson {
  ok?: unknown;
  missing?: unknown;
  intervalMs?: unknown;
  durationMs?: unknown;
  messageText?: unknown;
  actionKind?: unknown;
}

const SCHEDULED_TASK_PARSE_TIMEOUT_MS = 8_000;
const SCHEDULED_TASK_PARSE_MAX_RETRIES = 2;
const SCHEDULED_TASK_PARSE_RETRY_BASE_DELAY_MS = 600;

export async function resolveCustomScheduledTaskCreateWithModel(params: {
  cfg: OpenClawConfig;
  rawContent: string;
  targetActors: CustomActor[];
  agentId?: string;
  complete?: CustomScheduledTaskLlmComplete;
}): Promise<CustomScheduledTaskLlmParseResult> {
  const complete = params.complete ?? resolveRuntimeComplete();
  if (!complete) return { handled: false };

  try {
    const signal = AbortSignal.timeout(SCHEDULED_TASK_PARSE_TIMEOUT_MS);
    const completion = await completeWithRetry({
      complete,
      requestText: params.rawContent,
      agentId: params.agentId,
      signal,
    });
    const parsed = scheduledTaskJsonToParsed(parseScheduledTaskJson(completion.text), params.targetActors);
    if (!parsed) return { handled: false };
    return { handled: true, parsed };
  } catch (error) {
    return { handled: false, error: String(error) };
  }
}

function buildScheduledTaskParseSystemPrompt(): string {
  return [
    "你是 QQ 群自然语言定时任务解析器，只输出严格 JSON，不要 Markdown，不要解释。",
    "任务：把用户的自然语言解析为定时任务字段。重点是理解真实要发送/执行的内容，而不是照搬原句。",
    "输出 schema：{\"ok\":boolean,\"missing\":string[],\"intervalMs\":number|null,\"durationMs\":number|null,\"messageText\":string|null,\"actionKind\":\"message\"|\"agent\"}",
    "字段含义：intervalMs 是每隔多久执行；durationMs 是总持续时长，未指定填 null；messageText 是每次实际要发送或执行的核心内容。",
    "规则：",
    "1. 必需字段是 intervalMs 和 messageText。缺少时 ok=false，并在 missing 写 interval/messageText。",
    "2. 不要把调度词复制进 messageText，例如 每隔、每分钟、发、发送、说、问、给、持续五分钟 都不是实际内容。",
    "3. 如果用户说“每隔一分钟发：玩大乱斗给@某人”，messageText 必须是“玩大乱斗”。",
    "4. 如果用户说“每隔半小时 @某人 问他醒了没”，messageText 是“醒了没”或“你醒了没”。",
    "5. 如果目标用户通过 @ 提到，不要把 @目标 写进 messageText；目标会由外层 mentions 字段处理。",
    "6. 默认 actionKind=message；只有明确要求查询日志、运行命令、调用工具、联网搜索、修改配置/部署等才填 agent。",
    "7. 时间支持分钟/小时/天；intervalMs 范围 60000 到 2592000000；durationMs 未指定为 null。",
  ].join("\n");
}

function parseScheduledTaskJson(text: string): ScheduledTaskParseJson | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ScheduledTaskParseJson : null;
  } catch {
    return null;
  }
}

function scheduledTaskJsonToParsed(
  parsed: ScheduledTaskParseJson | null,
  targetActors: CustomActor[],
): CustomScheduledTaskLlmParseResult["parsed"] | null {
  if (!parsed || parsed.ok === false) return null;
  const intervalMs = normalizeMs(parsed.intervalMs);
  const durationMs = normalizeOptionalMs(parsed.durationMs);
  const prompt = typeof parsed.messageText === "string" ? cleanMessageText(parsed.messageText) : "";
  if (!intervalMs || !prompt) return null;
  const requiredCapabilities = inferScheduledTaskCapabilities(prompt);
  const actionKind = parsed.actionKind === "agent" || requiredCapabilities.some((cap) => cap !== "schedule.run" && cap !== "proactive.send")
    ? "agent"
    : "message";
  return { intervalMs, durationMs, prompt, targetActors, requiredCapabilities, actionKind };
}

function cleanMessageText(text: string): string {
  return text
    .replace(/<@[^>]+>/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/^(发|发送|发消息|说|问|提醒)(一下|他|她|它|ta|TA|大家)?\s*[:：,， ]*/i, "")
    .replace(/\s*(给|发给)\s*$/i, "")
    .replace(/[。；;，, ]+$/g, "")
    .trim();
}

function normalizeMs(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.round(n), 60_000), 30 * 24 * 60 * 60 * 1000);
}

function normalizeOptionalMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return normalizeMs(value) ?? undefined;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}

function resolveRuntimeComplete(): CustomScheduledTaskLlmComplete | null {
  try {
    const runtime = getQQBotRuntime() as unknown as { llm?: { complete?: CustomScheduledTaskLlmComplete } };
    return typeof runtime.llm?.complete === "function" ? runtime.llm.complete.bind(runtime.llm) : null;
  } catch {
    return null;
  }
}

async function completeWithRetry(params: {
  complete: CustomScheduledTaskLlmComplete;
  requestText: string;
  agentId?: string;
  signal: AbortSignal;
}): Promise<{ text: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SCHEDULED_TASK_PARSE_MAX_RETRIES; attempt += 1) {
    try {
      return await params.complete({
        ...(params.agentId ? { agentId: params.agentId } : {}),
        purpose: "qqbot.scheduled_task.parse",
        maxTokens: 500,
        temperature: 0,
        signal: params.signal,
        messages: [
          { role: "system", content: buildScheduledTaskParseSystemPrompt() },
          { role: "user", content: params.requestText },
        ],
      });
    } catch (error) {
      lastError = error;
      if (attempt >= SCHEDULED_TASK_PARSE_MAX_RETRIES || !isRetryableScheduledTaskParseError(error)) throw error;
      await sleep(SCHEDULED_TASK_PARSE_RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableScheduledTaskParseError(error: unknown): boolean {
  if (!error) return false;
  return /overload|429|rate limit|rate-limit|too many requests|service unavailable|temporarily unavailable|timeout|timed out|503|502|504/i.test(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveCustomScheduledTaskCreateWithRules(rawContent: string, targetActors: CustomActor[]): CustomScheduledTaskLlmParseResult["parsed"] | null {
  const parsed = parseCustomScheduledTaskIntent(rawContent, { mentions: targetActors.map((actor) => ({ member_openid: actor.id, username: actor.label })) });
  return parsed ? { ...parsed, targetActors } : null;
}
