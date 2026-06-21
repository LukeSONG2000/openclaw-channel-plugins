import { sendStartupGreetings as defaultSendStartupGreetings, type AdminResolverContext } from "../admin-resolver.js";
import type { MessageQueue, QueuedMessage } from "../message-queue.js";
import type { ResolvedQQBotAccount, TransportMode } from "../types.js";
import type { QQBotGatewayLifecycleController } from "./gateway-lifecycle-gateway-adapter.js";
import {
  startQQBotWebhookTransportGateway as defaultStartQQBotWebhookTransportGateway,
  type StartQQBotWebhookTransportGatewayParams,
} from "./webhook-transport-gateway-adapter.js";
import {
  startQQBotWebSocketConnectionGateway as defaultStartQQBotWebSocketConnectionGateway,
  type StartQQBotWebSocketConnectionGatewayParams,
} from "./websocket-connection-gateway-adapter.js";

export interface QQBotGatewayTransportRunnerLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface StartQQBotGatewayTransportRunnerParams {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  transportMode: TransportMode;
  lifecycle: Pick<QQBotGatewayLifecycleController,
    | "isAborted"
    | "getSessionState"
    | "setLastSeq"
    | "setSessionId"
    | "setShouldRefreshToken"
    | "setCurrentWebSocket"
    | "setConnecting"
    | "setReconnectAttempts"
    | "setLastConnectTime"
    | "getLastConnectTime"
    | "getQuickDisconnectCount"
    | "setQuickDisconnectCount"
    | "resetHeartbeat"
    | "cleanup"
  >;
  messageQueue: Pick<MessageQueue, "startProcessor">;
  handleMessage: (message: QueuedMessage) => Promise<void>;
  dispatchInboundEvent: (eventType: string, data: unknown) => Promise<void> | void;
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
  log?: QQBotGatewayTransportRunnerLogger;
  sendStartupGreeting?: typeof defaultSendStartupGreetings;
  startWebhookTransport?: typeof defaultStartQQBotWebhookTransportGateway;
  startWebSocketConnection?: typeof defaultStartQQBotWebSocketConnectionGateway;
}

export type QQBotGatewayTransportRunnerResult =
  | { transport: "webhook"; result: Awaited<ReturnType<typeof defaultStartQQBotWebhookTransportGateway>> }
  | { transport: "websocket"; result: Awaited<ReturnType<typeof defaultStartQQBotWebSocketConnectionGateway>> };

export async function startQQBotGatewayTransportRunner(
  params: StartQQBotGatewayTransportRunnerParams,
): Promise<QQBotGatewayTransportRunnerResult> {
  const account = params.account;
  const startMessageProcessor = () => params.messageQueue.startProcessor(params.handleMessage);
  const sendStartupGreeting = (event: "READY" | "RESUMED") => {
    (params.sendStartupGreeting ?? defaultSendStartupGreetings)(params.adminContext, event);
  };

  if (params.transportMode === "webhook") {
    params.lifecycle.setConnecting(false);
    const result = await (params.startWebhookTransport ?? defaultStartQQBotWebhookTransportGateway)({
      account,
      abortSignal: params.abortSignal,
      startMessageProcessor,
      dispatchInboundEvent: params.dispatchInboundEvent,
      onReady: params.onReady,
      onError: params.onError,
      isPendingFirstReady: params.isPendingFirstReady,
      markFirstReadyConsumed: params.markFirstReadyConsumed,
      sendStartupGreeting: (event) => sendStartupGreeting(event),
      unregisterApprovalHandler: params.unregisterApprovalHandler,
      log: params.log,
    } satisfies StartQQBotWebhookTransportGatewayParams);
    return { transport: "webhook", result };
  }

  const result = await (params.startWebSocketConnection ?? defaultStartQQBotWebSocketConnectionGateway)({
    accountId: account.accountId,
    appId: account.appId,
    clientSecret: account.clientSecret,
    intents: params.intents,
    intentsDesc: params.intentsDesc,
    isAborted: params.lifecycle.isAborted,
    getSessionState: params.lifecycle.getSessionState,
    setLastSeq: params.lifecycle.setLastSeq,
    setSessionId: params.lifecycle.setSessionId,
    setShouldRefreshToken: params.lifecycle.setShouldRefreshToken,
    setCurrentWebSocket: params.lifecycle.setCurrentWebSocket,
    setConnecting: params.lifecycle.setConnecting,
    setReconnectAttempts: params.lifecycle.setReconnectAttempts,
    setLastConnectTime: params.lifecycle.setLastConnectTime,
    getLastConnectTime: params.lifecycle.getLastConnectTime,
    getQuickDisconnectCount: params.lifecycle.getQuickDisconnectCount,
    setQuickDisconnectCount: params.lifecycle.setQuickDisconnectCount,
    quickDisconnectThresholdMs: params.quickDisconnectThresholdMs,
    maxQuickDisconnectCount: params.maxQuickDisconnectCount,
    rateLimitDelayMs: params.rateLimitDelayMs,
    startMessageProcessor,
    resetHeartbeat: params.lifecycle.resetHeartbeat,
    isPendingFirstReady: params.isPendingFirstReady,
    markFirstReadyConsumed: params.markFirstReadyConsumed,
    onReady: params.onReady,
    sendStartupGreeting,
    dispatchInboundEvent: params.dispatchInboundEvent,
    cleanup: params.lifecycle.cleanup,
    scheduleReconnect: params.scheduleReconnect,
    onError: params.onError,
    log: params.log,
  } satisfies StartQQBotWebSocketConnectionGatewayParams);
  return { transport: "websocket", result };
}
