import type { CustomRuntimeConfig, CustomSceneConfig } from "./types.js";

export const DEFAULT_UNREAD_FOLLOWUP_DELAY_MS = 60_000;
export const DEFAULT_UNREAD_SLEEP_DELAY_MS = 10 * 60_000;
export const DEFAULT_UNREAD_HISTORY_LIMIT = 12;
export const DEFAULT_UNREAD_POLL_INTERVALS_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
] as const;
const MAX_UNREAD_HISTORY_LIMIT = 12;

export interface ResolvedCustomUnreadConfig {
  enabled: boolean;
  historyLimit: number;
  followupDelayMs: number;
  sleepDelayMs: number;
  pollIntervalsMs: number[];
  allowAutonomousReply: boolean;
  allowProactiveSend: boolean;
}

export function resolveCustomUnreadConfig(params: {
  runtime?: CustomRuntimeConfig | null;
  scene?: CustomSceneConfig | null;
}): ResolvedCustomUnreadConfig {
  const runtimeUnread = params.runtime?.unread ?? {};
  const sceneUnread = params.scene?.unread ?? {};
  const enabled = sceneUnread.enabled ?? runtimeUnread.enabled ?? true;
  const historyLimit = Math.min(MAX_UNREAD_HISTORY_LIMIT, normalizePositiveInt(
    sceneUnread.historyLimit ?? runtimeUnread.historyLimit,
    DEFAULT_UNREAD_HISTORY_LIMIT,
  ));
  return {
    enabled,
    historyLimit,
    followupDelayMs: normalizePositiveInt(
      sceneUnread.followupDelayMs ?? runtimeUnread.followupDelayMs,
      DEFAULT_UNREAD_FOLLOWUP_DELAY_MS,
    ),
    sleepDelayMs: normalizePositiveInt(
      sceneUnread.sleepDelayMs ?? runtimeUnread.sleepDelayMs,
      DEFAULT_UNREAD_SLEEP_DELAY_MS,
    ),
    pollIntervalsMs: normalizePollIntervals(
      sceneUnread.pollIntervalsMs ?? runtimeUnread.pollIntervalsMs,
    ),
    allowAutonomousReply:
      sceneUnread.allowAutonomousReply
      ?? params.scene?.allowAutonomousReply
      ?? runtimeUnread.allowAutonomousReply
      ?? false,
    allowProactiveSend:
      sceneUnread.allowProactiveSend
      ?? params.scene?.allowProactiveSend
      ?? runtimeUnread.allowProactiveSend
      ?? false,
  };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizePollIntervals(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_UNREAD_POLL_INTERVALS_MS];
  const normalized = value
    .map((entry) => normalizePositiveInt(entry, 0))
    .filter((entry) => entry >= 60_000)
    .sort((a, b) => a - b);
  return normalized.length ? normalized : [...DEFAULT_UNREAD_POLL_INTERVALS_MS];
}
