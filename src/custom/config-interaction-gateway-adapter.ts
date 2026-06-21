import { resolveGroupConfig, resolveGroupPolicy, resolveMentionPatterns } from "../config.js";
import { parseFrameworkDateVersion } from "../slash-commands.js";
import { applyCustomSceneAgentRoute, type CustomAgentRoute, type CustomRoutePeer } from "./route.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneState } from "./config.js";
import type { CustomNormalizedInteractionEvent } from "./interaction-event-normalizer.js";

export const CUSTOM_INTERACTION_TYPE_CONFIG_QUERY = 2001;
export const CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE = 2002;

export interface CustomConfigInteractionGatewayLogger {
  info?: (msg: string) => void;
}

export interface CustomConfigInteractionConfigApi {
  loadConfig: () => Record<string, unknown>;
  writeConfigFile: (cfg: unknown) => Promise<void>;
}

export interface CustomConfigInteractionRoutingApi {
  resolveAgentRoute?: (params: {
    cfg: unknown;
    channel: "qqbot";
    accountId: string;
    peer: CustomRoutePeer;
  }) => CustomAgentRoute | undefined;
}

export interface HandleCustomConfigInteractionParams {
  accountId: string;
  interaction: CustomNormalizedInteractionEvent;
  getConfigApi: () => CustomConfigInteractionConfigApi;
  routing?: CustomConfigInteractionRoutingApi;
  acknowledge: (code: 0, payload: { claw_cfg: Record<string, unknown> }) => Promise<void>;
  pluginVersion: string;
  frameworkVersion: string;
  log?: CustomConfigInteractionGatewayLogger;
}

export type HandleCustomConfigInteractionResult =
  | { handled: false }
  | {
      handled: true;
      kind: "query" | "update";
      changed: boolean;
      clawCfg: Record<string, unknown>;
    };

export async function handleCustomConfigInteractionGateway(
  params: HandleCustomConfigInteractionParams,
): Promise<HandleCustomConfigInteractionResult> {
  if (params.interaction.dataType === CUSTOM_INTERACTION_TYPE_CONFIG_QUERY) {
    return handleConfigQueryInteraction(params);
  }
  if (params.interaction.dataType === CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE) {
    return handleConfigUpdateInteraction(params);
  }
  return { handled: false };
}

async function handleConfigQueryInteraction(
  params: HandleCustomConfigInteractionParams,
): Promise<HandleCustomConfigInteractionResult> {
  const configApi = params.getConfigApi();
  const latestCfg = configApi.loadConfig();
  const clawCfg = buildConfigQueryClawCfg({
    cfg: latestCfg,
    accountId: params.accountId,
    groupOpenid: params.interaction.groupOpenid ?? "",
    routing: params.routing,
    pluginVersion: params.pluginVersion,
    frameworkVersion: params.frameworkVersion,
  });

  await params.acknowledge(0, { claw_cfg: clawCfg });
  params.log?.info?.(`[qqbot:${params.accountId}] Interaction ACK (type=${CUSTOM_INTERACTION_TYPE_CONFIG_QUERY}) sent: ${params.interaction.id}, claw_cfg=${JSON.stringify(clawCfg)}`);
  return { handled: true, kind: "query", changed: false, clawCfg };
}

async function handleConfigUpdateInteraction(
  params: HandleCustomConfigInteractionParams,
): Promise<HandleCustomConfigInteractionResult> {
  const configApi = params.getConfigApi();
  const clawCfgUpdate = params.interaction.resolved?.claw_cfg as Record<string, unknown> | undefined;
  const groupOpenid = params.interaction.groupOpenid ?? "";
  const currentCfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
  const qqbot = objectOrUndefined(objectOrUndefined(currentCfg.channels)?.qqbot);

  const changed = applyRequireMentionUpdate({
    cfg: currentCfg,
    qqbot,
    accountId: params.accountId,
    groupOpenid,
    requireMention: clawCfgUpdate?.require_mention,
  });

  if (changed) {
    await configApi.writeConfigFile(currentCfg);
    params.log?.info?.(`[qqbot:${params.accountId}] Config updated via interaction ${params.interaction.id}: ${JSON.stringify({
      require_mention: clawCfgUpdate?.require_mention,
      group_openid: groupOpenid || undefined,
    })}`);
  }

  const latestCfg = changed ? configApi.loadConfig() : currentCfg;
  const clawCfg = buildConfigUpdateAckClawCfg({
    cfg: latestCfg,
    accountId: params.accountId,
    groupOpenid,
    pluginVersion: params.pluginVersion,
    frameworkVersion: params.frameworkVersion,
  });

  await params.acknowledge(0, { claw_cfg: clawCfg });
  params.log?.info?.(`[qqbot:${params.accountId}] Interaction ACK (type=${CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE}) sent: ${params.interaction.id}, claw_cfg=${JSON.stringify(clawCfg)}`);
  return { handled: true, kind: "update", changed, clawCfg };
}

export function buildConfigQueryClawCfg(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  groupOpenid: string;
  routing?: CustomConfigInteractionRoutingApi;
  pluginVersion: string;
  frameworkVersion: string;
}): Record<string, unknown> {
  const groupCfg = params.groupOpenid ? resolveGroupConfig(params.cfg as any, params.groupOpenid, params.accountId) : null;
  const groupPolicy = resolveGroupPolicy(params.cfg as any, params.accountId);
  const requireMentionMode = (groupCfg?.requireMention ?? true) ? "mention" : "always";
  const agentId = resolveInteractionAgentId({
    cfg: params.cfg,
    accountId: params.accountId,
    groupOpenid: params.groupOpenid,
    routing: params.routing,
  });
  const mentionPatterns = resolveMentionPatterns(params.cfg as any, agentId).join(",");

  return {
    channel_type: "qqbot",
    channel_ver: params.pluginVersion,
    claw_type: "openclaw",
    claw_ver: parseFrameworkDateVersion(params.frameworkVersion) ?? params.frameworkVersion,
    require_mention: requireMentionMode,
    group_policy: groupPolicy,
    mention_patterns: mentionPatterns,
    online_state: "online",
  };
}

export function buildConfigUpdateAckClawCfg(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  groupOpenid: string;
  pluginVersion: string;
  frameworkVersion: string;
}): Record<string, unknown> {
  const groupCfg = params.groupOpenid ? resolveGroupConfig(params.cfg as any, params.groupOpenid, params.accountId) : null;
  const requireMentionMode = (groupCfg?.requireMention ?? true) ? "mention" : "always";
  return {
    channel_type: "qqbot",
    channel_ver: params.pluginVersion,
    claw_type: "openclaw",
    claw_ver: parseFrameworkDateVersion(params.frameworkVersion) ?? params.frameworkVersion,
    require_mention: requireMentionMode,
    online_state: "online",
  };
}

function applyRequireMentionUpdate(params: {
  cfg: Record<string, unknown>;
  qqbot?: Record<string, unknown>;
  accountId: string;
  groupOpenid: string;
  requireMention: unknown;
}): boolean {
  if (params.requireMention === undefined || !params.groupOpenid || !params.qqbot) return false;
  const requireMentionBool = params.requireMention === "mention";
  const isNamedAccount = params.accountId !== "default" && Boolean(objectOrUndefined(params.qqbot.accounts)?.[params.accountId]);

  if (isNamedAccount) {
    const accounts = objectOrUndefined(params.qqbot.accounts) as Record<string, Record<string, unknown>>;
    const acct = objectOrUndefined(accounts[params.accountId]) ?? {};
    const groups = objectOrUndefined(acct.groups) ?? {};
    groups[params.groupOpenid] = { ...objectOrUndefined(groups[params.groupOpenid]), requireMention: requireMentionBool };
    acct.groups = groups;
    accounts[params.accountId] = acct;
    params.qqbot.accounts = accounts;
    return true;
  }

  const groups = objectOrUndefined(params.qqbot.groups) ?? {};
  groups[params.groupOpenid] = { ...objectOrUndefined(groups[params.groupOpenid]), requireMention: requireMentionBool };
  params.qqbot.groups = groups;
  return true;
}

function resolveInteractionAgentId(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  groupOpenid: string;
  routing?: CustomConfigInteractionRoutingApi;
}): string | undefined {
  if (!params.groupOpenid) return undefined;
  const peer: CustomRoutePeer = { kind: "group", id: params.groupOpenid };
  const route = params.routing?.resolveAgentRoute?.({
    cfg: params.cfg,
    channel: "qqbot",
    accountId: params.accountId,
    peer,
  });
  if (!route) return undefined;
  const scene = resolveCustomRuntimeConfig(params.cfg as any).enabled
    ? resolveCustomSceneState(params.cfg as any, { kind: "group", id: params.groupOpenid })
    : null;
  return applyCustomSceneAgentRoute({
    route,
    scene,
    routing: params.routing as any,
    peer,
    cfg: params.cfg,
  }).agentId;
}

function objectOrUndefined(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
