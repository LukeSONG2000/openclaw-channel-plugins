import {
  startBackgroundTokenRefresh as defaultStartBackgroundTokenRefresh,
  stopBackgroundTokenRefresh as defaultStopBackgroundTokenRefresh,
} from "../api.js";
import type { ResolvedQQBotAccount } from "../types.js";

export interface QQBotWebhookTransportGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotWebhookTransportEvent {
  eventType: string;
  data: unknown;
}

export type QQBotWebhookTransportStarter = (params: {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  onEvent: (event: QQBotWebhookTransportEvent) => Promise<void> | void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  log?: QQBotWebhookTransportGatewayLogger;
}) => Promise<void>;

export interface StartQQBotWebhookTransportGatewayParams {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  startMessageProcessor: () => void;
  dispatchInboundEvent: (eventType: string, data: unknown) => Promise<void> | void;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  isPendingFirstReady: () => boolean;
  markFirstReadyConsumed: () => void;
  sendStartupGreeting: (event: "READY") => void;
  unregisterApprovalHandler: (accountId: string) => void;
  log?: QQBotWebhookTransportGatewayLogger;
  startWebhookTransport?: QQBotWebhookTransportStarter;
  startBackgroundTokenRefresh?: typeof defaultStartBackgroundTokenRefresh;
  stopBackgroundTokenRefresh?: typeof defaultStopBackgroundTokenRefresh;
}

export interface StartQQBotWebhookTransportGatewayResult {
  action: "completed";
}

async function defaultStartWebhookTransport(
  params: Parameters<QQBotWebhookTransportStarter>[0],
): Promise<void> {
  const transport = await import("../transport/index.js");
  await transport.startWebhookTransport(params as Parameters<typeof transport.startWebhookTransport>[0]);
}

export async function startQQBotWebhookTransportGateway(
  params: StartQQBotWebhookTransportGatewayParams,
): Promise<StartQQBotWebhookTransportGatewayResult> {
  const { account } = params;
  params.startMessageProcessor();
  (params.startBackgroundTokenRefresh ?? defaultStartBackgroundTokenRefresh)(
    account.appId,
    account.clientSecret,
    { log: params.log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } | undefined },
  );

  await (params.startWebhookTransport ?? defaultStartWebhookTransport)({
    account,
    abortSignal: params.abortSignal,
    onEvent: async (event) => {
      const { eventType, data } = event;
      params.log?.info?.(`[qqbot:${account.accountId}:webhook] 📩 Dispatch event: t=${eventType}, d=${JSON.stringify(data)}`);
      await params.dispatchInboundEvent(eventType, data);
    },
    onReady: () => {
      params.log?.info?.(`[qqbot:${account.accountId}:webhook] Transport ready`);
      params.log?.info?.(`[qqbot:${account.accountId}] ✅ Webhook transport started successfully (path: ${account.config.webhook?.path ?? "/qqbot/webhook"})`);
      params.onReady?.({ transport: "webhook" });
      if (params.isPendingFirstReady()) {
        params.markFirstReadyConsumed();
        params.sendStartupGreeting("READY");
      }
    },
    onError: (error) => {
      params.log?.error?.(`[qqbot:${account.accountId}:webhook] Error: ${error.message}`);
      params.onError?.(error);
    },
    log: params.log,
  });

  (params.stopBackgroundTokenRefresh ?? defaultStopBackgroundTokenRefresh)();
  params.unregisterApprovalHandler(account.accountId);
  return { action: "completed" };
}
