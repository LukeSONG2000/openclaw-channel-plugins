import { clearTokenCache as defaultClearTokenCache } from "../api.js";
import type { AdminResolverContext } from "../admin-resolver.js";
import type { MessageQueue } from "../message-queue.js";
import type { ResolvedQQBotAccount, TransportMode } from "../types.js";
import type { CustomAdminGroupNotificationService } from "./admin-group-notification-service-gateway-adapter.js";
import {
  createCustomConnectionHandlersGateway as defaultCreateCustomConnectionHandlersGateway,
  type CreateCustomConnectionHandlersGatewayParams,
} from "./connection-handlers-gateway-adapter.js";
import type { QQBotGatewayLifecycleController } from "./gateway-lifecycle-gateway-adapter.js";
import {
  startQQBotGatewayTransportRunner as defaultStartQQBotGatewayTransportRunner,
  type StartQQBotGatewayTransportRunnerParams,
} from "./gateway-transport-runner-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import type { CustomTaskCommandExecutor } from "./task-command-executor.js";
import type { CustomTaskNotificationSendText } from "./task-notification-gateway-adapter.js";
import type { CustomUnreadScheduler } from "./unread-scheduler.js";
import {
  handleQQBotWebSocketConnectionFailureGateway as defaultHandleQQBotWebSocketConnectionFailureGateway,
} from "./websocket-close-gateway-adapter.js";

export interface QQBotGatewayConnectAttemptLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface RunQQBotGatewayConnectAttemptParams {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  transportMode: TransportMode;
  abortSignal: AbortSignal;
  lifecycle: QQBotGatewayLifecycleController;
  messageQueue: MessageQueue;
  runtime: CustomMessageFlowRuntime;
  getPreviousTaskExecutor: () => CustomTaskCommandExecutor | null;
  setTaskExecutor: (executor: CustomTaskCommandExecutor) => void;
  setUnreadScheduler: (scheduler: CustomUnreadScheduler) => void;
  enqueueMessage: CreateCustomConnectionHandlersGatewayParams["enqueueMessage"];
  getQueueSnapshot: CreateCustomConnectionHandlersGatewayParams["getQueueSnapshot"];
  persistAuthState: () => void;
  persistProactiveBudgetState: () => void;
  persistTaskState: () => void;
  persistPollState: () => void;
  persistGameState: () => void;
  persistDeployConfirmationState: () => void;
  persistUnreadState: () => void;
  sendTaskStatusText: CustomTaskNotificationSendText;
  buildProactiveGuard: CreateCustomConnectionHandlersGatewayParams["buildProactiveGuard"];
  sendMedia: CreateCustomConnectionHandlersGatewayParams["sendMedia"];
  createDebouncer: CreateCustomConnectionHandlersGatewayParams["createDebouncer"];
  parseAndSendMediaTags: CreateCustomConnectionHandlersGatewayParams["parseAndSendMediaTags"];
  handleStructuredPayload: CreateCustomConnectionHandlersGatewayParams["handleStructuredPayload"];
  sendPlainReply: CreateCustomConnectionHandlersGatewayParams["sendPlainReply"];
  adminGroupNotifications: Pick<
    CustomAdminGroupNotificationService,
    "sendFallbackAdminGroupAlert" | "sendAuthAdminGroupNotification"
  >;
  isCustomRuntimeEnabled: () => boolean;
  isControlCommand: (text: string) => boolean;
  stripMentionText: CreateCustomConnectionHandlersGatewayParams["stripMentionText"];
  detectWasMentioned: CreateCustomConnectionHandlersGatewayParams["detectWasMentioned"];
  resolveRequireMention: CreateCustomConnectionHandlersGatewayParams["resolveRequireMention"];
  resolveGroupIntroHint?: CreateCustomConnectionHandlersGatewayParams["resolveGroupIntroHint"];
  getConfigApi: CreateCustomConnectionHandlersGatewayParams["getConfigApi"];
  getRouting?: CreateCustomConnectionHandlersGatewayParams["getRouting"];
  getLegacyApprovalHandler?: CreateCustomConnectionHandlersGatewayParams["getLegacyApprovalHandler"];
  adminContext: AdminResolverContext;
  isPendingFirstReady: () => boolean;
  markFirstReadyConsumed: () => void;
  unregisterApprovalHandler: (accountId: string) => void;
  scheduleReconnect: (delayMs?: number) => void;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  intents: number;
  intentsDesc: string;
  quickDisconnectThresholdMs: number;
  maxQuickDisconnectCount: number;
  rateLimitDelayMs: number;
  getRuntime: () => unknown;
  log?: QQBotGatewayConnectAttemptLogger;
  clearTokenCache?: typeof defaultClearTokenCache;
  createConnectionHandlers?: typeof defaultCreateCustomConnectionHandlersGateway;
  startTransportRunner?: typeof defaultStartQQBotGatewayTransportRunner;
  handleConnectionFailure?: typeof defaultHandleQQBotWebSocketConnectionFailureGateway;
}

export type QQBotGatewayConnectAttemptResult =
  | { action: "skipped" }
  | { action: "completed" }
  | { action: "failed"; error: unknown };

export async function runQQBotGatewayConnectAttempt(
  params: RunQQBotGatewayConnectAttemptParams,
): Promise<QQBotGatewayConnectAttemptResult> {
  if (!params.lifecycle.beginConnect()) return { action: "skipped" };

  try {
    params.lifecycle.prepareConnection({
      clearTokenCache: () => (params.clearTokenCache ?? defaultClearTokenCache)(params.account.appId),
    });

    const pluginRuntime = params.getRuntime();
    const connectionHandlers = (params.createConnectionHandlers ?? defaultCreateCustomConnectionHandlersGateway)({
      account: params.account,
      cfg: params.cfg,
      pluginRuntime,
      runtime: params.runtime,
      previousTaskExecutor: params.getPreviousTaskExecutor(),
      enqueueMessage: params.enqueueMessage,
      getQueueSnapshot: params.getQueueSnapshot,
      persistAuthState: params.persistAuthState,
      persistProactiveBudgetState: params.persistProactiveBudgetState,
      persistTaskState: params.persistTaskState,
      persistPollState: params.persistPollState,
      persistGameState: params.persistGameState,
      persistDeployConfirmationState: params.persistDeployConfirmationState,
      persistUnreadState: params.persistUnreadState,
      sendTaskStatusText: params.sendTaskStatusText,
      buildProactiveGuard: params.buildProactiveGuard,
      sendMedia: params.sendMedia,
      createDebouncer: params.createDebouncer,
      parseAndSendMediaTags: params.parseAndSendMediaTags,
      handleStructuredPayload: params.handleStructuredPayload,
      sendPlainReply: params.sendPlainReply,
      adminGroupNotifications: params.adminGroupNotifications,
      isCustomRuntimeEnabled: params.isCustomRuntimeEnabled,
      isControlCommand: params.isControlCommand,
      stripMentionText: params.stripMentionText,
      detectWasMentioned: params.detectWasMentioned,
      resolveRequireMention: params.resolveRequireMention,
      resolveGroupIntroHint: params.resolveGroupIntroHint,
      getConfigApi: params.getConfigApi,
      getRouting: params.getRouting,
      getLegacyApprovalHandler: params.getLegacyApprovalHandler,
      log: params.log,
    });
    params.setTaskExecutor(connectionHandlers.taskExecutor);
    params.setUnreadScheduler(connectionHandlers.unreadScheduler);

    await (params.startTransportRunner ?? defaultStartQQBotGatewayTransportRunner)({
      account: params.account,
      abortSignal: params.abortSignal,
      transportMode: params.transportMode,
      lifecycle: params.lifecycle,
      messageQueue: params.messageQueue,
      handleMessage: connectionHandlers.handleMessage,
      dispatchInboundEvent: connectionHandlers.dispatchInboundEvent,
      adminContext: params.adminContext,
      isPendingFirstReady: params.isPendingFirstReady,
      markFirstReadyConsumed: params.markFirstReadyConsumed,
      unregisterApprovalHandler: params.unregisterApprovalHandler,
      scheduleReconnect: params.scheduleReconnect,
      onReady: params.onReady,
      onError: params.onError,
      intents: params.intents,
      intentsDesc: params.intentsDesc,
      quickDisconnectThresholdMs: params.quickDisconnectThresholdMs,
      maxQuickDisconnectCount: params.maxQuickDisconnectCount,
      rateLimitDelayMs: params.rateLimitDelayMs,
      log: params.log,
    } satisfies StartQQBotGatewayTransportRunnerParams);
    return { action: "completed" };
  } catch (err) {
    params.lifecycle.setConnecting(false);
    (params.handleConnectionFailure ?? defaultHandleQQBotWebSocketConnectionFailureGateway)({
      accountId: params.account.accountId,
      err,
      rateLimitDelayMs: params.rateLimitDelayMs,
      scheduleReconnect: params.scheduleReconnect,
      log: params.log,
    });
    return { action: "failed", error: err };
  }
}
