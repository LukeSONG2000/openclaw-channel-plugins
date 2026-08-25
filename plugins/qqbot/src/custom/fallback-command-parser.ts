export const CUSTOM_FALLBACK_DEFAULT_LIST_LIMIT = 5;
export const CUSTOM_FALLBACK_MAX_LIST_LIMIT = 20;
export const CUSTOM_FALLBACK_DEFAULT_SUMMARY_LIMIT = 20;
export const CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT = 100;

export type CustomFallbackCommand =
  | { kind: "help" }
  | { kind: "list"; limit: number }
  | { kind: "summary"; limit: number }
  | { kind: "clear"; force: boolean };

export type CustomFallbackCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomFallbackCommand; error?: string };

export function parseCustomFallbackCommand(rawContent: string): CustomFallbackCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-fallback") return { matched: false };

  const action = (tokens.shift() ?? "list").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls" || action === "status" || action === "show") {
    const parsedLimit = parseLimit(tokens[0], CUSTOM_FALLBACK_DEFAULT_LIST_LIMIT, CUSTOM_FALLBACK_MAX_LIST_LIMIT);
    if (parsedLimit === null) {
      return { matched: true, error: `数量需要是 1 到 ${CUSTOM_FALLBACK_MAX_LIST_LIMIT} 的整数` };
    }
    return { matched: true, command: { kind: "list", limit: parsedLimit } };
  }
  if (action === "summary" || action === "stats") {
    const parsedLimit = parseLimit(tokens[0], CUSTOM_FALLBACK_DEFAULT_SUMMARY_LIMIT, CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT);
    if (parsedLimit === null) {
      return { matched: true, error: `统计数量需要是 1 到 ${CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT} 的整数` };
    }
    return { matched: true, command: { kind: "summary", limit: parsedLimit } };
  }
  if (action === "clear" || action === "reset") {
    return { matched: true, command: { kind: "clear", force: tokens.some((token) => token.toLowerCase() === "--force") } };
  }

  const parsedLimit = parseLimit(action, CUSTOM_FALLBACK_DEFAULT_LIST_LIMIT, CUSTOM_FALLBACK_MAX_LIST_LIMIT);
  if (parsedLimit !== null) {
    return { matched: true, command: { kind: "list", limit: parsedLimit } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number | null {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw || value < 1 || value > max) return null;
  return value;
}
