import type { CustomAgentRoute } from "./route.js";
import type { CustomRuntimeConfig } from "./types.js";

const DEFAULT_MAX_SESSION_TURNS = 16;
const MIN_MAX_SESSION_TURNS = 4;
const MAX_MAX_SESSION_TURNS = 50;

interface PeerSessionWindowState {
  generation: number;
  turns: number;
}

const peerWindows = new Map<string, PeerSessionWindowState>();

export interface ApplyCustomSessionContextWindowResult {
  route: CustomAgentRoute;
  generation: number;
  turns: number;
  rotated: boolean;
  reason?: "manual-new" | "turn-limit";
}

export function applyCustomSessionContextWindow(params: {
  route: CustomAgentRoute;
  peerId: string;
  content: string;
  runtime?: CustomRuntimeConfig | null;
}): ApplyCustomSessionContextWindowResult {
  const maxTurns = resolveMaxSessionTurns(params.runtime);
  const key = `${params.route.agentId}:${params.peerId}`;
  // Start from a suffixed generation so a plugin restart can escape an already-bloated
  // legacy OpenClaw session instead of reusing the old base session key.
  const state = peerWindows.get(key) ?? { generation: 1, turns: 0 };
  const command = firstSlashCommandToken(params.content);
  let rotated = false;
  let reason: ApplyCustomSessionContextWindowResult["reason"];

  if (command === "/new") {
    state.generation += 1;
    state.turns = 0;
    rotated = true;
    reason = "manual-new";
  } else {
    state.turns += 1;
    if (state.turns > maxTurns) {
      state.generation += 1;
      state.turns = 1;
      rotated = true;
      reason = "turn-limit";
    }
  }

  peerWindows.set(key, state);
  return {
    route: withSessionGeneration(params.route, state.generation),
    generation: state.generation,
    turns: state.turns,
    rotated,
    reason,
  };
}

export function resetCustomSessionContextWindowForTests(): void {
  peerWindows.clear();
}

function withSessionGeneration(route: CustomAgentRoute, generation: number): CustomAgentRoute {
  const suffix = `:qqctx:${generation}`;
  return {
    ...route,
    sessionKey: route.sessionKey.endsWith(suffix) ? route.sessionKey : `${stripSessionGeneration(route.sessionKey)}${suffix}`,
    lastRoutePolicy: "session",
  };
}

function stripSessionGeneration(sessionKey: string): string {
  return sessionKey.replace(/:qqctx:\d+$/u, "");
}

function resolveMaxSessionTurns(runtime?: CustomRuntimeConfig | null): number {
  const raw = runtime?.context?.maxSessionTurns;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SESSION_TURNS;
  return Math.max(MIN_MAX_SESSION_TURNS, Math.min(MAX_MAX_SESSION_TURNS, Math.floor(n)));
}

function firstSlashCommandToken(content: string | null | undefined): string | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}
