import {
  getAccessToken as defaultGetAccessToken,
  sendC2CMessage as defaultSendC2CMessage,
  sendGroupMessage as defaultSendGroupMessage,
  sendGroupMessageWithInlineKeyboard as defaultSendGroupMessageWithInlineKeyboard,
} from "../api.js";
import {
  createMessageQueue as defaultCreateMessageQueue,
  type MessageQueue,
  type QueuedMessage,
} from "../message-queue.js";
import type { InlineKeyboard, ResolvedQQBotAccount } from "../types.js";
import { describeCustomAuthorizationIntents as defaultDescribeCustomAuthorizationIntents } from "./auth-gateway-adapter.js";
import {
  createCustomAdminGroupNotificationServiceGateway as defaultCreateCustomAdminGroupNotificationServiceGateway,
  type CustomAdminGroupNotificationService,
} from "./admin-group-notification-service-gateway-adapter.js";
import {
  createCustomMessageFlowStateController as defaultCreateCustomMessageFlowStateController,
  type CustomMessageFlowStateController,
} from "./message-flow-state.js";
import {
  createCustomProactiveGatewayGuard as defaultCreateCustomProactiveGatewayGuard,
} from "./proactive-gateway-adapter.js";
import { resolveCustomRuntimeConfig as defaultResolveCustomRuntimeConfig } from "./config.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import type { CustomProactiveSendGuard } from "./proactive-send-guard.js";
import {
  startCustomUpdateCheckLoop as defaultStartCustomUpdateCheckLoop,
  type CustomUpdateCheckController,
} from "./update-check.js";
import {
  createCustomSlashPrequeueHandlerGateway as defaultCreateCustomSlashPrequeueHandlerGateway,
  type CustomSlashPrequeueHandlerGateway,
} from "./slash-prequeue-handler-gateway-adapter.js";
import type { CustomTaskExecutor } from "./task-executor-adapter.js";

export interface CustomGatewayAccountServicesLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomGatewayAccountServicesResult {
  queue: MessageQueue;
  state: CustomMessageFlowStateController;
  runtime: CustomMessageFlowRuntime;
  adminGroupNotifications: CustomAdminGroupNotificationService;
  updateCheck: CustomUpdateCheckController;
  trySlashCommandOrEnqueue: (message: QueuedMessage) => Promise<void>;
  isCustomRuntimeEnabled: () => boolean;
  buildProactiveGuard: (source?: {
    actor?: { id: string; label?: string; isBot?: boolean };
    messageId?: string;
    timestamp?: number;
  }) => { proactiveGuard: CustomProactiveSendGuard };
}

export interface CreateCustomGatewayAccountServicesParams {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  isAborted: () => boolean;
  getTaskExecutor?: () => CustomTaskExecutor | undefined;
  stripMentionText?: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
  getConfigApi: () => {
    loadConfig?: () => Record<string, unknown>;
    writeConfigFile: (cfg: unknown) => Promise<void>;
  };
  log?: CustomGatewayAccountServicesLogger;
  getAccessToken?: typeof defaultGetAccessToken;
  sendGroupMessage?: typeof defaultSendGroupMessage;
  sendC2CMessage?: typeof defaultSendC2CMessage;
  sendGroupMessageWithInlineKeyboard?: typeof defaultSendGroupMessageWithInlineKeyboard;
  createMessageQueue?: typeof defaultCreateMessageQueue;
  createStateController?: typeof defaultCreateCustomMessageFlowStateController;
  describeAuthorizationIntents?: typeof defaultDescribeCustomAuthorizationIntents;
  createProactiveGatewayGuard?: typeof defaultCreateCustomProactiveGatewayGuard;
  resolveCustomRuntimeConfig?: typeof defaultResolveCustomRuntimeConfig;
  createAdminGroupNotificationService?: typeof defaultCreateCustomAdminGroupNotificationServiceGateway;
  startUpdateCheckLoop?: typeof defaultStartCustomUpdateCheckLoop;
  createSlashPrequeueHandler?: typeof defaultCreateCustomSlashPrequeueHandlerGateway;
}

export function createCustomGatewayAccountServices(
  params: CreateCustomGatewayAccountServicesParams,
): CustomGatewayAccountServicesResult {
  const account = params.account;
  const queue = (params.createMessageQueue ?? defaultCreateMessageQueue)({
    accountId: account.accountId,
    log: params.log as Parameters<typeof defaultCreateMessageQueue>[0]["log"],
    isAborted: params.isAborted,
  });

  const state = (params.createStateController ?? defaultCreateCustomMessageFlowStateController)({
    accountId: account.accountId,
    log: params.log as Parameters<typeof defaultCreateCustomMessageFlowStateController>[0]["log"],
  });
  const runtime = state.runtime;

  for (const item of (params.describeAuthorizationIntents ?? defaultDescribeCustomAuthorizationIntents)(state.restoredAuthIntents)) {
    params.log?.info?.(`[qqbot:${account.accountId}] custom auth restore: ${item}`);
  }

  const resolveRuntime = () => (params.resolveCustomRuntimeConfig ?? defaultResolveCustomRuntimeConfig)(params.cfg as any);
  const isCustomRuntimeEnabled = (): boolean => resolveRuntime().enabled === true;
  const buildProactiveGuard = (source?: {
    actor?: { id: string; label?: string; isBot?: boolean };
    messageId?: string;
    timestamp?: number;
  }) => ({
    proactiveGuard: (params.createProactiveGatewayGuard ?? defaultCreateCustomProactiveGatewayGuard)({
      cfg: params.cfg as any,
      accountId: account.accountId,
      budget: runtime.proactiveBudget,
      persistBudgetState: state.persistProactiveBudgetState,
      log: params.log,
      actor: source?.actor,
      sourceMessageId: source?.messageId,
      sourceTimestamp: source?.timestamp,
    }),
  });

  const getAccessToken = params.getAccessToken ?? defaultGetAccessToken;
  const sendGroupMessage = params.sendGroupMessage ?? defaultSendGroupMessage;
  const sendC2CMessage = params.sendC2CMessage ?? defaultSendC2CMessage;
  const sendGroupMessageWithInlineKeyboard = params.sendGroupMessageWithInlineKeyboard ?? defaultSendGroupMessageWithInlineKeyboard;
  const adminGroupNotifications = (params.createAdminGroupNotificationService ?? defaultCreateCustomAdminGroupNotificationServiceGateway)({
    accountId: account.accountId,
    getRuntime: resolveRuntime,
    buildProactiveGuard: () => buildProactiveGuard().proactiveGuard,
    log: params.log,
    sendText: async (groupOpenid, text) => {
      const token = await getAccessToken(account.appId, account.clientSecret);
      await sendGroupMessage(token, groupOpenid, text);
    },
    sendDirectText: async (userOpenid, text) => {
      const token = await getAccessToken(account.appId, account.clientSecret);
      await sendC2CMessage(token, userOpenid, text);
    },
    sendKeyboard: async (groupOpenid, text, keyboard: InlineKeyboard) => {
      const token = await getAccessToken(account.appId, account.clientSecret);
      await sendGroupMessageWithInlineKeyboard(token, groupOpenid, text, keyboard);
    },
  });

  const updateCheck = (params.startUpdateCheckLoop ?? defaultStartCustomUpdateCheckLoop)({
    accountId: account.accountId,
    accountConfig: account.config,
    log: params.log,
    onUpdateAvailable: adminGroupNotifications.sendUpdateAvailableNotification,
  });

  const slashPrequeueHandler: CustomSlashPrequeueHandlerGateway = (params.createSlashPrequeueHandler ?? defaultCreateCustomSlashPrequeueHandlerGateway)({
    cfg: params.cfg as any,
    account,
    runtime,
    queue,
    getTaskExecutor: params.getTaskExecutor,
    stripMentionText: params.stripMentionText,
    getConfigApi: params.getConfigApi,
    persistAuthState: state.persistAuthState,
    persistTaskState: state.persistTaskState,
    persistPollState: state.persistPollState,
    persistGameState: state.persistGameState,
    persistDeployConfirmationState: state.persistDeployConfirmationState,
    sendAdminGroupNotification: async (notification) => {
      await adminGroupNotifications.sendAuthAdminGroupNotification({ ...notification, source: "slash" });
    },
    log: params.log,
  });

  return {
    queue,
    state,
    runtime,
    adminGroupNotifications,
    updateCheck,
    trySlashCommandOrEnqueue: async (message) => {
      await slashPrequeueHandler(message);
    },
    isCustomRuntimeEnabled,
    buildProactiveGuard,
  };
}
