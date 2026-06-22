import type { CustomRuntimeConfig, CustomSceneConfig } from "./types.js";

export const DEFAULT_UNREAD_FOLLOWUP_DELAY_MS = 60_000;
export const DEFAULT_UNREAD_SLEEP_DELAY_MS = 10 * 60_000;
export const DEFAULT_UNREAD_HISTORY_LIMIT = 50;

export interface ResolvedCustomUnreadConfig {
  enabled: boolean;
  historyLimit: number;
  followupDelayMs: number;
  sleepDelayMs: number;
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
  const historyLimit = normalizePositiveInt(
    sceneUnread.historyLimit ?? runtimeUnread.historyLimit,
    DEFAULT_UNREAD_HISTORY_LIMIT,
  );
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
