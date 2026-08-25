import type { ResolvedQQBotAccount } from "../types.js";
import type { CreateCustomConnectionHandlersGatewayParams } from "./connection-handlers-gateway-adapter.js";
import type { CustomTaskNotificationSendText } from "./task-notification-gateway-adapter.js";

export interface QQBotGatewayPlatformServicesLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotGatewayPlatformRuntime {
  channel?: {
    text?: {
      hasControlCommand?: (text: string) => boolean;
    };
    routing?: unknown;
  };
  config?: {
    loadConfig?: () => Record<string, unknown>;
    writeConfigFile: (cfg: unknown) => Promise<void>;
  };
}

export interface QQBotGatewayPluginGroups {
  resolveRequireMention?: (params: { cfg: any; accountId?: string; groupId: string }) => boolean | undefined;
  resolveGroupIntroHint?: (params: { cfg: any; accountId?: string; groupId: string }) => string | undefined;
}

export interface QQBotGatewayPluginLike {
  groups?: QQBotGatewayPluginGroups;
}

export interface QQBotGatewayPlatformServices {
  getRuntime: () => QQBotGatewayPlatformRuntime;
  getConfigApi: CreateCustomConnectionHandlersGatewayParams["getConfigApi"];
  getRouting: CreateCustomConnectionHandlersGatewayParams["getRouting"];
  getLegacyApprovalHandler: NonNullable<CreateCustomConnectionHandlersGatewayParams["getLegacyApprovalHandler"]>;
  stripMentionText: CreateCustomConnectionHandlersGatewayParams["stripMentionText"];
  detectWasMentioned: CreateCustomConnectionHandlersGatewayParams["detectWasMentioned"];
  isControlCommand: CreateCustomConnectionHandlersGatewayParams["isControlCommand"];
  resolveRequireMention: CreateCustomConnectionHandlersGatewayParams["resolveRequireMention"];
  resolveGroupIntroHint: NonNullable<CreateCustomConnectionHandlersGatewayParams["resolveGroupIntroHint"]>;
  createTaskStatusTextSender: (
    buildProactiveGuard: () => { proactiveGuard: unknown },
  ) => CustomTaskNotificationSendText;
}

export type QQBotGatewayStripMentionText = (
  text: string,
  mentions?: Array<{
    member_openid?: string;
    id?: string;
    user_openid?: string;
    is_you?: boolean;
    nickname?: string;
    username?: string;
  }>,
) => string | undefined;

export type QQBotGatewayDetectWasMentioned = (input: {
  eventType?: string;
  mentions?: Array<{ is_you?: boolean }>;
  content?: string;
  mentionPatterns?: string[];
}) => boolean;

export type QQBotGatewaySendTextToTarget = (
  context: {
    target: unknown;
    account: ResolvedQQBotAccount;
    cfg: unknown;
    log?: QQBotGatewayPlatformServicesLogger;
    prepareUnanchoredTextSend?: unknown;
  },
  text: string,
) => Promise<void> | void;

export interface CreateQQBotGatewayPlatformServicesParams {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  log?: QQBotGatewayPlatformServicesLogger;
  getRuntime?: () => QQBotGatewayPlatformRuntime;
  plugin?: QQBotGatewayPluginLike;
  stripMentionText?: QQBotGatewayStripMentionText;
  detectWasMentioned?: QQBotGatewayDetectWasMentioned;
  getLegacyApprovalHandler?: NonNullable<CreateCustomConnectionHandlersGatewayParams["getLegacyApprovalHandler"]>;
  sendTextToTarget?: QQBotGatewaySendTextToTarget;
}

export function isQQBotGatewayControlCommand(
  text: string,
  getRuntime: () => QQBotGatewayPlatformRuntime = () => ({}),
): boolean {
  if (!text || !text.startsWith("/")) return false;
  try {
    const runtimeHasControlCommand = getRuntime()?.channel?.text?.hasControlCommand;
    if (typeof runtimeHasControlCommand === "function") {
      return runtimeHasControlCommand(text);
    }
  } catch {
    // Runtime may be unavailable during early startup; keep the safe slash fallback.
  }
  return /^\/[a-z][a-z0-9_-]*/i.test(text);
}

export function createQQBotGatewayPlatformServices(
  params: CreateQQBotGatewayPlatformServicesParams,
): QQBotGatewayPlatformServices {
  const getRuntime: () => QQBotGatewayPlatformRuntime = params.getRuntime ?? (() => ({}));
  const plugin = params.plugin ?? {};
  const stripMentionText = params.stripMentionText ?? ((text: string) => text);
  const detectWasMentioned = params.detectWasMentioned ?? (() => false);
  const getLegacyApprovalHandler: NonNullable<CreateCustomConnectionHandlersGatewayParams["getLegacyApprovalHandler"]> =
    params.getLegacyApprovalHandler ?? (() => undefined);
  const sendTextToTarget = params.sendTextToTarget ?? (() => {
    throw new Error("QQBot gateway platform sendTextToTarget dependency is not configured");
  });

  return {
    getRuntime,
    getConfigApi: () => getRuntime().config as ReturnType<QQBotGatewayPlatformServices["getConfigApi"]>,
    getRouting: () =>
      getRuntime().channel?.routing as ReturnType<NonNullable<QQBotGatewayPlatformServices["getRouting"]>>,
    getLegacyApprovalHandler,
    stripMentionText: (text, mentions) => stripMentionText(text, mentions as any) ?? text,
    detectWasMentioned: (input) => detectWasMentioned(input),
    isControlCommand: (text) => isQQBotGatewayControlCommand(text, getRuntime),
    resolveRequireMention: ({ cfg, accountId, groupOpenid }) =>
      plugin.groups?.resolveRequireMention?.({
        cfg,
        accountId,
        groupId: groupOpenid,
      }) ?? true,
    resolveGroupIntroHint: ({ cfg, accountId, groupOpenid }) =>
      plugin.groups?.resolveGroupIntroHint?.({
        cfg,
        accountId,
        groupId: groupOpenid,
      }),
    createTaskStatusTextSender: (buildProactiveGuard) => async (delivery) => {
      const proactive = buildProactiveGuard();
      await sendTextToTarget({
        target: delivery.target,
        account: params.account,
        cfg: params.cfg,
        log: params.log,
        prepareUnanchoredTextSend: proactive.proactiveGuard as any,
      }, delivery.text);
    },
  };
}
