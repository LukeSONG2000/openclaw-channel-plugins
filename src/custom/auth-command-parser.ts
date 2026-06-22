import type { CustomGrantUse } from "./types.js";

export type CustomAuthCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "requests"; limit: number }
  | { kind: "grants"; limit: number }
  | {
      kind: "resolve";
      requestId: string;
      approved: boolean;
      grantUse?: CustomGrantUse;
      grantCount?: number;
      grantTtlMs?: number;
    };

export type CustomAuthCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomAuthCommand; error?: string };

export type CustomAuthButtonDecision = "allow-once" | "allow-count" | "allow-timed" | "allow-task" | "deny";

export interface CustomAuthButtonPayload {
  requestId: string;
  decision: CustomAuthButtonDecision;
}

const DEFAULT_AUTH_LIST_LIMIT = 10;
const MAX_AUTH_LIST_LIMIT = 20;

export function parseCustomAuthCommand(rawContent: string): CustomAuthCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };

  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  const name = rawName.toLowerCase();
  if (name !== "bot-auth") return { matched: false };

  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "status") return { matched: true, command: { kind: "status" } };
  if (action === "requests" || action === "request" || action === "pending" || action === "list") {
    const limit = parseListLimit(tokens[0]);
    if (limit === null) return { matched: true, error: `数量需要是 1 到 ${MAX_AUTH_LIST_LIMIT} 的整数` };
    return { matched: true, command: { kind: "requests", limit } };
  }
  if (action === "grants" || action === "grant") {
    const limit = parseListLimit(tokens[0]);
    if (limit === null) return { matched: true, error: `数量需要是 1 到 ${MAX_AUTH_LIST_LIMIT} 的整数` };
    return { matched: true, command: { kind: "grants", limit } };
  }

  if (action === "approve" || action === "allow" || action === "allow-once" || action === "allow-count" || action === "allow-timed") {
    const requestId = tokens.shift();
    if (!requestId) return { matched: true, error: "缺少 requestId" };

    let grantUse: CustomGrantUse | undefined;
    let grantCount: number | undefined;
    let grantTtlMs: number | undefined;

    if (action === "allow-once") grantUse = "once";
    if (action === "allow-count") grantUse = "count";
    if (action === "allow-timed") grantUse = "timed";

    const mode = action === "allow-count" || action === "allow-timed"
      ? undefined
      : tokens.shift()?.toLowerCase();
    if (mode) {
      if (mode === "once") {
        grantUse = "once";
      } else if (mode === "task") {
        grantUse = "task";
      } else if (mode === "count") {
        grantUse = "count";
        const countRaw = tokens.shift();
        const count = countRaw ? Number.parseInt(countRaw, 10) : NaN;
        if (!Number.isFinite(count) || count < 1) {
          return { matched: true, error: "count 需要大于 0 的整数" };
        }
        grantCount = count;
      } else if (mode === "timed") {
        grantUse = "timed";
        const durationRaw = tokens.shift();
        const ttlMs = durationRaw ? parseDurationMs(durationRaw) : null;
        if (!ttlMs) {
          return { matched: true, error: "timed 需要时长，例如 10m、1h、30s" };
        }
        grantTtlMs = ttlMs;
      } else {
        return { matched: true, error: `未知授权方式：${mode}` };
      }
    }

    if (action === "allow-count" && grantCount === undefined) {
      const countRaw = tokens.shift();
      const count = countRaw ? Number.parseInt(countRaw, 10) : NaN;
      if (!Number.isFinite(count) || count < 1) {
        return { matched: true, error: "allow-count 需要次数，例如 /bot-auth allow-count <requestId> 3" };
      }
      grantCount = count;
    }
    if (action === "allow-timed" && grantTtlMs === undefined) {
      const durationRaw = tokens.shift();
      const ttlMs = durationRaw ? parseDurationMs(durationRaw) : null;
      if (!ttlMs) {
        return { matched: true, error: "allow-timed 需要时长，例如 /bot-auth allow-timed <requestId> 10m" };
      }
      grantTtlMs = ttlMs;
    }

    return {
      matched: true,
      command: {
        kind: "resolve",
        requestId,
        approved: true,
        grantUse,
        grantCount,
        grantTtlMs,
      },
    };
  }

  if (action === "deny" || action === "reject") {
    const requestId = tokens.shift();
    if (!requestId) return { matched: true, error: "缺少 requestId" };
    return { matched: true, command: { kind: "resolve", requestId, approved: false } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

export function parseCustomAuthButtonData(buttonData: string): CustomAuthButtonPayload | null {
  const m = buttonData.match(/^custom-auth:([^:]+):(allow-once|allow-count|allow-timed|allow-task|deny)$/i);
  if (!m) return null;
  return {
    requestId: m[1]!,
    decision: m[2]!.toLowerCase() as CustomAuthButtonDecision,
  };
}

function parseListLimit(raw?: string): number | null {
  if (!raw) return DEFAULT_AUTH_LIST_LIMIT;
  if (!/^\d+$/.test(raw.trim())) return null;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_AUTH_LIST_LIMIT) return null;
  return limit;
}

function parseDurationMs(value: string): number | null {
  const m = value.trim().toLowerCase().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) return null;
  const amount = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(amount) || amount < 1) return null;
  const unit = m[2] ?? "m";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "d") return amount * 24 * 60 * 60_000;
  return null;
}
