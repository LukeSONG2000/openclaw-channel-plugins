import {
  parseCustomTaskCleanupDuration,
  parseCustomTaskCleanupLimit,
} from "./task-cleanup.js";

export type CustomTaskCommand =
  | { kind: "help" }
  | { kind: "create"; prompt: string }
  | { kind: "list" }
  | { kind: "status"; taskId: string }
  | { kind: "add"; taskId: string; content: string }
  | { kind: "cancel"; taskId: string }
  | { kind: "cleanup-plan"; olderThanMs?: number; limit?: number };

export type CustomTaskCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomTaskCommand; error?: string };

export function parseCustomTaskCommand(rawContent: string): CustomTaskCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-task") return { matched: false };

  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "create" || action === "new" || action === "start") {
    const prompt = tokens.join(" ").trim();
    if (!prompt) return { matched: true, error: "缺少任务描述" };
    return { matched: true, command: { kind: "create", prompt } };
  }
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "cleanup" || action === "cleanup-plan" || action === "prune" || action === "prune-plan") {
    const parsed = parseCleanupPlanOptions(tokens);
    return parsed.error
      ? { matched: true, error: parsed.error }
      : { matched: true, command: { kind: "cleanup-plan", olderThanMs: parsed.olderThanMs, limit: parsed.limit } };
  }
  if (action === "status" || action === "show") {
    const taskId = tokens.shift();
    if (!taskId) return { matched: true, error: "缺少 taskId" };
    return { matched: true, command: { kind: "status", taskId } };
  }
  if (action === "add" || action === "append") {
    const taskId = tokens.shift();
    const text = tokens.join(" ").trim();
    if (!taskId) return { matched: true, error: "缺少 taskId" };
    if (!text) return { matched: true, error: "缺少追加需求内容" };
    return { matched: true, command: { kind: "add", taskId, content: text } };
  }
  if (action === "cancel" || action === "stop") {
    const taskId = tokens.shift();
    if (!taskId) return { matched: true, error: "缺少 taskId" };
    return { matched: true, command: { kind: "cancel", taskId } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

function parseCleanupPlanOptions(tokens: string[]): { olderThanMs?: number; limit?: number; error?: string } {
  const result: { olderThanMs?: number; limit?: number; error?: string } = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const readValue = () => {
      if (i + 1 >= tokens.length) return undefined;
      i += 1;
      return tokens[i];
    };
    if (token === "--older-than" || token === "--age") {
      const value = readValue();
      const duration = parseCustomTaskCleanupDuration(value);
      if (!duration) return { error: "--older-than 需要正数时长，例如 7d、12h、30m" };
      result.olderThanMs = duration;
    } else if (token.startsWith("--older-than=")) {
      const duration = parseCustomTaskCleanupDuration(token.slice("--older-than=".length));
      if (!duration) return { error: "--older-than 需要正数时长，例如 7d、12h、30m" };
      result.olderThanMs = duration;
    } else if (token.startsWith("--age=")) {
      const duration = parseCustomTaskCleanupDuration(token.slice("--age=".length));
      if (!duration) return { error: "--age 需要正数时长，例如 7d、12h、30m" };
      result.olderThanMs = duration;
    } else if (token === "--limit") {
      const value = readValue();
      const limit = parseCustomTaskCleanupLimit(value);
      if (!limit) return { error: "--limit 需要 1-50 之间的整数" };
      result.limit = limit;
    } else if (token.startsWith("--limit=")) {
      const limit = parseCustomTaskCleanupLimit(token.slice("--limit=".length));
      if (!limit) return { error: "--limit 需要 1-50 之间的整数" };
      result.limit = limit;
    } else {
      return { error: `未知 cleanup 参数：${token}` };
    }
  }
  return result;
}
