import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CustomInteractionGatewayResult } from "./interaction-gateway-adapter.js";
import type { CustomInteractionReplyTarget } from "./interaction-event-normalizer.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { upsertCustomSceneConfig } from "./scene-gateway-adapter.js";

export type CustomInteractionGatewayHandledResult = Extract<CustomInteractionGatewayResult, { handled: true }>;

export interface CustomInteractionGatewayEffectsLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomInteractionGatewayConfigApi {
  loadConfig?: () => Record<string, unknown>;
  writeConfigFile: (cfg: unknown) => Promise<void>;
}

export interface ApplyCustomInteractionGatewayEffectsParams {
  accountId: string;
  result: CustomInteractionGatewayHandledResult;
  cfg?: OpenClawConfig;
  getConfigApi?: () => CustomInteractionGatewayConfigApi;
  replyTarget?: CustomInteractionReplyTarget;
  persistAuthState?: () => void;
  persistPollState?: () => void;
  persistGameState?: () => void;
  persistDeployConfirmationState?: () => void;
  sendReply?: (target: CustomInteractionReplyTarget, text: string) => Promise<void> | void;
  log?: CustomInteractionGatewayEffectsLogger;
}

export interface ApplyCustomInteractionGatewayEffectsResult {
  authPersisted: boolean;
  configPersisted: boolean;
  pollsPersisted: boolean;
  gamesPersisted: boolean;
  deployConfirmationsPersisted: boolean;
  replyDelivered: boolean;
  replySkipped: boolean;
  replyFailed: boolean;
}

export async function applyCustomInteractionGatewayEffects(
  params: ApplyCustomInteractionGatewayEffectsParams,
): Promise<ApplyCustomInteractionGatewayEffectsResult> {
  const result: ApplyCustomInteractionGatewayEffectsResult = {
    authPersisted: false,
    configPersisted: false,
    pollsPersisted: false,
    gamesPersisted: false,
    deployConfirmationsPersisted: false,
    replyDelivered: false,
    replySkipped: false,
    replyFailed: false,
  };

  logCustomInteractionGatewayResult(params);

  const persist = params.result.persist;
  if (persist?.auth) {
    params.persistAuthState?.();
    result.authPersisted = Boolean(params.persistAuthState);
  }
  if (persist?.config) {
    await persistCustomInteractionConfig(params);
    result.configPersisted = true;
  }
  if (persist?.polls) {
    params.persistPollState?.();
    result.pollsPersisted = Boolean(params.persistPollState);
  }
  if (persist?.games) {
    params.persistGameState?.();
    result.gamesPersisted = Boolean(params.persistGameState);
  }
  if (persist?.deployConfirmations) {
    params.persistDeployConfirmationState?.();
    result.deployConfirmationsPersisted = Boolean(params.persistDeployConfirmationState);
  }

  if (params.result.reply) {
    if (!params.replyTarget || !params.sendReply) {
      result.replySkipped = true;
      return result;
    }
    try {
      await params.sendReply(params.replyTarget, params.result.reply);
      result.replyDelivered = true;
    } catch (sendErr) {
      result.replyFailed = true;
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom interaction reply: ${sendErr}`);
    }
  }

  return result;
}

function logCustomInteractionGatewayResult(params: ApplyCustomInteractionGatewayEffectsParams): void {
  for (const item of params.result.logs ?? []) {
    if (item.level === "error") {
      params.log?.error?.(`[qqbot:${params.accountId}] ${item.message}`);
    } else {
      params.log?.info?.(`[qqbot:${params.accountId}] ${item.message}`);
    }
  }
}

async function persistCustomInteractionConfig(params: ApplyCustomInteractionGatewayEffectsParams): Promise<void> {
  const configPersist = params.result.persist?.config;
  if (!configPersist) return;
  const configApi = params.getConfigApi?.();
  if (!configApi) throw new Error("getConfigApi is required to persist custom interaction config changes");

  const currentCfg = typeof configApi.loadConfig === "function"
    ? structuredClone(configApi.loadConfig()) as OpenClawConfig
    : structuredClone(params.cfg ?? {}) as OpenClawConfig;
  upsertCustomSceneConfig(
    currentCfg,
    configPersist.sceneKey,
    configPersist.sceneConfig,
    resolveCustomRuntimeConfig(currentCfg as any),
  );
  await configApi.writeConfigFile(currentCfg);
  params.log?.info?.(`[qqbot:${params.accountId}] custom interaction config persisted: key=${configPersist.sceneKey} scene=${configPersist.sceneConfig.scene}`);
}
