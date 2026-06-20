import type { ResolvedCustomScene } from "./scenes.js";

export interface CustomAgentRoute {
  agentId: string;
  channel: string;
  accountId: string;
  sessionKey: string;
  mainSessionKey: string;
  lastRoutePolicy: "main" | "session";
  matchedBy: string;
  [key: string]: unknown;
}

export interface CustomRoutePeer {
  kind: string;
  id: string;
}

export interface CustomRoutingRuntime {
  buildAgentSessionKey?: (params: {
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer?: CustomRoutePeer | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    identityLinks?: Record<string, string[]>;
  }) => string;
}

export interface ApplyCustomSceneRouteParams {
  route: CustomAgentRoute;
  scene?: ResolvedCustomScene | null;
  routing?: CustomRoutingRuntime | null;
  peer: CustomRoutePeer;
  cfg?: Record<string, unknown> | null;
}

export function applyCustomSceneAgentRoute(params: ApplyCustomSceneRouteParams): CustomAgentRoute {
  const overrideAgentId = params.scene?.config.agentId?.trim();
  const resolvedAgentId = resolveSceneAgentId(params.cfg, overrideAgentId, params.route.agentId);
  if (!resolvedAgentId || resolvedAgentId === normalizeAgentId(params.route.agentId)) {
    return params.route;
  }

  const buildAgentSessionKey = params.routing?.buildAgentSessionKey;
  const sessionKey = buildAgentSessionKey
    ? buildAgentSessionKey({
        agentId: resolvedAgentId,
        channel: params.route.channel,
        accountId: params.route.accountId,
        peer: params.peer,
        dmScope: readDmScope(params.cfg),
        identityLinks: readIdentityLinks(params.cfg),
      })
    : rewriteAgentSessionKey(params.route.sessionKey, resolvedAgentId);
  const mainSessionKey = rewriteAgentMainSessionKey(params.route.mainSessionKey, resolvedAgentId);

  return {
    ...params.route,
    agentId: resolvedAgentId,
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: sessionKey === mainSessionKey ? "main" : "session",
    matchedBy: `custom.scene.${params.scene?.source ?? "unknown"}`,
    customRouteOverride: {
      sceneKey: params.scene?.key,
      previousAgentId: params.route.agentId,
      previousMatchedBy: params.route.matchedBy,
    },
  };
}

function resolveSceneAgentId(cfg: Record<string, unknown> | null | undefined, requested: string | undefined, fallback: string): string | null {
  if (!requested) return null;
  const normalizedRequested = normalizeAgentId(requested);
  const agents = (cfg?.agents as { list?: Array<{ id?: unknown }> } | undefined)?.list;
  if (!Array.isArray(agents) || agents.length === 0) return normalizedRequested;
  for (const agent of agents) {
    const id = typeof agent.id === "string" ? agent.id : "";
    if (normalizeAgentId(id) === normalizedRequested) return normalizeAgentId(id);
  }
  return normalizeAgentId(fallback);
}

function readDmScope(cfg?: Record<string, unknown> | null): "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer" | undefined {
  const value = (cfg?.session as Record<string, unknown> | undefined)?.dmScope;
  return value === "main" || value === "per-peer" || value === "per-channel-peer" || value === "per-account-channel-peer"
    ? value
    : undefined;
}

function readIdentityLinks(cfg?: Record<string, unknown> | null): Record<string, string[]> | undefined {
  const value = (cfg?.session as Record<string, unknown> | undefined)?.identityLinks;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value)) {
    if (typeof key !== "string" || !Array.isArray(ids)) continue;
    const normalizedIds = ids.filter((id): id is string => typeof id === "string");
    if (normalizedIds.length > 0) out[key] = normalizedIds;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function rewriteAgentSessionKey(sessionKey: string, agentId: string): string {
  if (!sessionKey.startsWith("agent:")) return `agent:${normalizeAgentId(agentId)}:${sessionKey || "main"}`;
  const parts = sessionKey.split(":");
  if (parts.length < 3) return `agent:${normalizeAgentId(agentId)}:main`;
  parts[1] = normalizeAgentId(agentId);
  return parts.join(":");
}

function rewriteAgentMainSessionKey(sessionKey: string, agentId: string): string {
  const parts = sessionKey.startsWith("agent:") ? sessionKey.split(":") : [];
  const mainKey = parts.length >= 3 ? parts.slice(2).join(":") || "main" : "main";
  return `agent:${normalizeAgentId(agentId)}:${normalizeMainKey(mainKey)}`;
}

function normalizeMainKey(value: string): string {
  return normalizeToken(value) || "main";
}

function normalizeAgentId(value: string): string {
  const normalized = normalizeToken(value);
  return normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64) || "main";
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
