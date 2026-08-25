import type {
  CustomProactiveAcceptanceEntry,
  CustomPeer,
  CustomProactiveBudgetEntry,
  CustomProactiveBudgetRuntimeState,
  CustomProactiveConfig,
  CustomRuntimeConfig,
  CustomSceneConfig,
} from "./types.js";

export const DEFAULT_PROACTIVE_MONTHLY_LIMIT = 4;
export const DEFAULT_PROACTIVE_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_PROACTIVE_RATE_LIMIT_MAX = 1;

export interface ResolvedCustomProactiveConfig {
  enabled: boolean;
  monthlyLimit: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export interface CustomProactiveBudgetDecision {
  allowed: boolean;
  reason: "allowed" | "disabled" | "rejected" | "monthly_limit" | "rate_limit";
  key: string;
  period: string;
  used: number;
  monthlyLimit: number;
  recentCount: number;
  rateLimitMax: number;
  accepted?: boolean;
  acceptanceUpdatedAt?: number;
  retryAfterMs?: number;
}

export function resolveCustomProactiveConfig(params: {
  runtime?: CustomRuntimeConfig | null;
  scene?: CustomSceneConfig | null;
}): ResolvedCustomProactiveConfig {
  const runtimeCfg = params.runtime?.proactive ?? {};
  const sceneCfg = params.scene?.proactive ?? {};
  return {
    enabled: sceneCfg.enabled ?? runtimeCfg.enabled ?? true,
    monthlyLimit: normalizeNonNegativeInt(
      sceneCfg.monthlyLimit ?? runtimeCfg.monthlyLimit,
      DEFAULT_PROACTIVE_MONTHLY_LIMIT,
    ),
    rateLimitWindowMs: normalizePositiveInt(
      sceneCfg.rateLimitWindowMs ?? runtimeCfg.rateLimitWindowMs,
      DEFAULT_PROACTIVE_RATE_LIMIT_WINDOW_MS,
    ),
    rateLimitMax: normalizeNonNegativeInt(
      sceneCfg.rateLimitMax ?? runtimeCfg.rateLimitMax,
      DEFAULT_PROACTIVE_RATE_LIMIT_MAX,
    ),
  };
}

export function customProactiveBudgetKey(accountId: string, peer: CustomPeer): string {
  return `${accountId}:${peer.kind}:${peer.id}`;
}

export class CustomProactiveBudgetRuntime {
  private readonly entries = new Map<string, CustomProactiveBudgetEntry>();
  private readonly acceptance = new Map<string, CustomProactiveAcceptanceEntry>();

  check(params: {
    accountId: string;
    peer: CustomPeer;
    cfg: ResolvedCustomProactiveConfig;
    now?: number;
  }): CustomProactiveBudgetDecision {
    const now = params.now ?? Date.now();
    const period = monthPeriod(now);
    const key = customProactiveBudgetKey(params.accountId, params.peer);
    if (!params.cfg.enabled) {
      return decision({ allowed: false, reason: "disabled", key, period, entry: emptyEntry(period, now), cfg: params.cfg });
    }

    const acceptance = this.acceptance.get(key);
    if (acceptance && acceptance.accepted === false) {
      return decision({ allowed: false, reason: "rejected", key, period, entry: this.getEntry(key, period, now), cfg: params.cfg, acceptance });
    }

    const entry = this.getEntry(key, period, now);
    pruneRecent(entry, now, params.cfg.rateLimitWindowMs);

    if (params.cfg.monthlyLimit <= 0 || entry.count >= params.cfg.monthlyLimit) {
      return decision({ allowed: false, reason: "monthly_limit", key, period, entry, cfg: params.cfg });
    }

    if (params.cfg.rateLimitMax <= 0 || entry.recent.length >= params.cfg.rateLimitMax) {
      const oldest = entry.recent[0] ?? now;
      const retryAfterMs = Math.max(1, oldest + params.cfg.rateLimitWindowMs - now);
      return decision({ allowed: false, reason: "rate_limit", key, period, entry, cfg: params.cfg, retryAfterMs });
    }

    return decision({ allowed: true, reason: "allowed", key, period, entry, cfg: params.cfg });
  }

  record(params: {
    accountId: string;
    peer: CustomPeer;
    cfg: ResolvedCustomProactiveConfig;
    now?: number;
  }): CustomProactiveBudgetDecision {
    const now = params.now ?? Date.now();
    const checked = this.check({ ...params, now });
    if (!checked.allowed) return checked;

    const entry = this.getEntry(checked.key, checked.period, now);
    pruneRecent(entry, now, params.cfg.rateLimitWindowMs);
    entry.count += 1;
    entry.recent.push(now);
    entry.updatedAt = now;
    return decision({ allowed: true, reason: "allowed", key: checked.key, period: checked.period, entry, cfg: params.cfg });
  }

  getState(): CustomProactiveBudgetRuntimeState {
    const entries: CustomProactiveBudgetRuntimeState["entries"] = {};
    for (const [key, entry] of this.entries) {
      entries[key] = cloneEntry(entry);
    }
    const acceptance: CustomProactiveBudgetRuntimeState["acceptance"] = {};
    for (const [key, entry] of this.acceptance) {
      acceptance[key] = { ...entry };
    }
    return { entries, acceptance };
  }

  loadState(state: CustomProactiveBudgetRuntimeState, options?: { now?: number; pruneOldPeriods?: boolean }): void {
    this.clear();
    const now = options?.now ?? Date.now();
    const currentPeriod = monthPeriod(now);
    for (const [key, entry] of Object.entries(state.entries ?? {})) {
      if (options?.pruneOldPeriods !== false && entry.period !== currentPeriod) continue;
      this.entries.set(key, cloneEntry(entry));
    }
    for (const [key, entry] of Object.entries(state.acceptance ?? {})) {
      this.acceptance.set(key, { ...entry });
    }
  }

  clear(): void {
    this.entries.clear();
    this.acceptance.clear();
  }

  setAcceptance(params: {
    accountId: string;
    peer: CustomPeer;
    accepted: boolean;
    updatedBy?: string;
    now?: number;
  }): CustomProactiveAcceptanceEntry {
    const key = customProactiveBudgetKey(params.accountId, params.peer);
    const entry: CustomProactiveAcceptanceEntry = {
      accepted: params.accepted,
      updatedAt: params.now ?? Date.now(),
      updatedBy: params.updatedBy,
    };
    this.acceptance.set(key, entry);
    return { ...entry };
  }

  private getEntry(key: string, period: string, now: number): CustomProactiveBudgetEntry {
    const existing = this.entries.get(key);
    if (existing && existing.period === period) return existing;
    const entry = emptyEntry(period, now);
    this.entries.set(key, entry);
    return entry;
  }
}

function decision(params: {
  allowed: boolean;
  reason: CustomProactiveBudgetDecision["reason"];
  key: string;
  period: string;
  entry: CustomProactiveBudgetEntry;
  cfg: ResolvedCustomProactiveConfig;
  retryAfterMs?: number;
  acceptance?: CustomProactiveAcceptanceEntry;
}): CustomProactiveBudgetDecision {
  return {
    allowed: params.allowed,
    reason: params.reason,
    key: params.key,
    period: params.period,
    used: params.entry.count,
    monthlyLimit: params.cfg.monthlyLimit,
    recentCount: params.entry.recent.length,
    rateLimitMax: params.cfg.rateLimitMax,
    accepted: params.acceptance?.accepted,
    acceptanceUpdatedAt: params.acceptance?.updatedAt,
    retryAfterMs: params.retryAfterMs,
  };
}

function emptyEntry(period: string, now: number): CustomProactiveBudgetEntry {
  return { period, count: 0, recent: [], updatedAt: now };
}

function pruneRecent(entry: CustomProactiveBudgetEntry, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  entry.recent = entry.recent.filter((ts) => ts > cutoff);
}

function monthPeriod(now: number): string {
  const date = new Date(now);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function cloneEntry(entry: CustomProactiveBudgetEntry): CustomProactiveBudgetEntry {
  return {
    ...entry,
    recent: entry.recent.slice(),
  };
}
