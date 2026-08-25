import WebSocket from "ws";
import {
  getAccessToken as defaultGetAccessToken,
  getGatewayUrl as defaultGetGatewayUrl,
  getPluginUserAgent as defaultGetPluginUserAgent,
  startBackgroundTokenRefresh as defaultStartBackgroundTokenRefresh,
} from "../api.js";
import { clearSession as defaultClearSession, saveSession as defaultSaveSession } from "../session-store.js";
import {
  handleQQBotWebSocketCloseGateway as defaultHandleQQBotWebSocketCloseGateway,
  handleQQBotWebSocketConnectionFailureGateway as defaultHandleQQBotWebSocketConnectionFailureGateway,
} from "./websocket-close-gateway-adapter.js";
import { handleQQBotWebSocketMessageGateway as defaultHandleQQBotWebSocketMessageGateway } from "./websocket-message-gateway-adapter.js";

export interface QQBotGatewayWebSocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
}

export interface QQBotWebSocketConnectionGatewayLogger {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface StartQQBotWebSocketConnectionGatewayParams {
  accountId: string;
  appId: string;
  clientSecret: string;
  intents: number;
  intentsDesc: string;
  isAborted: () => boolean;
  getSessionState: () => {
    sessionId: string | null;
    lastSeq: number | null;
    lastConnectTime: number;
  };
  setLastSeq: (lastSeq: number | null) => void;
  setSessionId: (sessionId: string | null) => void;
  setShouldRefreshToken: (value: boolean) => void;
  setCurrentWebSocket: (ws: QQBotGatewayWebSocketLike | null) => void;
  setConnecting: (value: boolean) => void;
  setReconnectAttempts: (value: number) => void;
  setLastConnectTime: (value: number) => void;
  getLastConnectTime: () => number;
  getQuickDisconnectCount: () => number;
  setQuickDisconnectCount: (value: number) => void;
  quickDisconnectThresholdMs: number;
  maxQuickDisconnectCount: number;
  rateLimitDelayMs: number;
  startMessageProcessor: () => void;
  resetHeartbeat: (
    intervalMs: number,
    onHeartbeat: () => void,
    isSocketOpen: () => boolean,
  ) => void;
  isPendingFirstReady: () => boolean;
  markFirstReadyConsumed: () => void;
  onReady?: (data: unknown) => void;
  sendStartupGreeting: (event: "READY" | "RESUMED") => void;
  dispatchInboundEvent: (eventType: string, data: unknown) => Promise<void> | void;
  cleanup: () => void;
  scheduleReconnect: (delayMs?: number) => void;
  onError?: (error: Error) => void;
  now?: () => number;
  log?: QQBotWebSocketConnectionGatewayLogger;
  getAccessToken?: typeof defaultGetAccessToken;
  getGatewayUrl?: typeof defaultGetGatewayUrl;
  getPluginUserAgent?: typeof defaultGetPluginUserAgent;
  createWebSocket?: (url: string, options: { headers: Record<string, string> }) => QQBotGatewayWebSocketLike;
  startBackgroundTokenRefresh?: typeof defaultStartBackgroundTokenRefresh;
  saveSession?: typeof defaultSaveSession;
  clearSession?: typeof defaultClearSession;
  handleWebSocketMessage?: typeof defaultHandleQQBotWebSocketMessageGateway;
  handleWebSocketClose?: typeof defaultHandleQQBotWebSocketCloseGateway;
  handleWebSocketConnectionFailure?: typeof defaultHandleQQBotWebSocketConnectionFailureGateway;
}

export type StartQQBotWebSocketConnectionGatewayResult =
  | {
      action: "started";
      accessToken: string;
      gatewayUrl: string;
      ws: QQBotGatewayWebSocketLike;
    }
  | {
      action: "failed";
      error: unknown;
    };

export async function startQQBotWebSocketConnectionGateway(
  params: StartQQBotWebSocketConnectionGatewayParams,
): Promise<StartQQBotWebSocketConnectionGatewayResult> {
  try {
    const getAccessToken = params.getAccessToken ?? defaultGetAccessToken;
    const getGatewayUrl = params.getGatewayUrl ?? defaultGetGatewayUrl;
    const getPluginUserAgent = params.getPluginUserAgent ?? defaultGetPluginUserAgent;
    const accessToken = await getAccessToken(params.appId, params.clientSecret);
    params.log?.info?.(`[qqbot:${params.accountId}] ✅ Access token obtained successfully`);
    const gatewayUrl = await getGatewayUrl(accessToken);

    params.log?.info?.(`[qqbot:${params.accountId}] Connecting to ${gatewayUrl}`);
    const ws = (params.createWebSocket ?? createDefaultWebSocket)(gatewayUrl, {
      headers: { "User-Agent": getPluginUserAgent() },
    });
    params.setCurrentWebSocket(ws);

    ws.on("open", () => {
      params.log?.info?.(`[qqbot:${params.accountId}] WebSocket connected`);
      params.setConnecting(false);
      params.setReconnectAttempts(0);
      params.setLastConnectTime(params.now?.() ?? Date.now());
      params.startMessageProcessor();
      (params.startBackgroundTokenRefresh ?? defaultStartBackgroundTokenRefresh)(
        params.appId,
        params.clientSecret,
        { log: params.log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } | undefined },
      );
    });

    ws.on("message", async (data: unknown) => {
      await (params.handleWebSocketMessage ?? defaultHandleQQBotWebSocketMessageGateway)({
        accountId: params.accountId,
        appId: params.appId,
        accessToken,
        intents: params.intents,
        intentsDesc: params.intentsDesc,
        rawData: dataToString(data),
        getSessionState: params.getSessionState,
        setLastSeq: params.setLastSeq,
        setSessionId: params.setSessionId,
        setShouldRefreshToken: params.setShouldRefreshToken,
        saveSession: params.saveSession ?? defaultSaveSession,
        clearSession: params.clearSession ?? defaultClearSession,
        sendJson: (payload) => ws.send(JSON.stringify(payload)),
        resetHeartbeat: (intervalMs, onHeartbeat) =>
          params.resetHeartbeat(intervalMs, onHeartbeat, () => isQQBotGatewayWebSocketOpen(ws)),
        isPendingFirstReady: params.isPendingFirstReady,
        markFirstReadyConsumed: params.markFirstReadyConsumed,
        onReady: params.onReady,
        sendStartupGreeting: params.sendStartupGreeting,
        dispatchInboundEvent: params.dispatchInboundEvent,
        cleanup: params.cleanup,
        scheduleReconnect: params.scheduleReconnect,
        log: params.log,
      });
    });

    ws.on("close", (code: number, reason: unknown) => {
      params.setConnecting(false);
      (params.handleWebSocketClose ?? defaultHandleQQBotWebSocketCloseGateway)({
        accountId: params.accountId,
        code,
        reason: dataToString(reason),
        isAborted: params.isAborted(),
        lastConnectTime: params.getLastConnectTime(),
        quickDisconnectCount: params.getQuickDisconnectCount(),
        quickDisconnectThresholdMs: params.quickDisconnectThresholdMs,
        maxQuickDisconnectCount: params.maxQuickDisconnectCount,
        rateLimitDelayMs: params.rateLimitDelayMs,
        setSessionId: params.setSessionId,
        setLastSeq: params.setLastSeq,
        setShouldRefreshToken: params.setShouldRefreshToken,
        setQuickDisconnectCount: params.setQuickDisconnectCount,
        clearSession: params.clearSession ?? defaultClearSession,
        cleanup: params.cleanup,
        scheduleReconnect: params.scheduleReconnect,
        now: params.now?.(),
        log: params.log,
      });
    });

    ws.on("error", (err: Error) => {
      params.log?.error?.(`[qqbot:${params.accountId}] WebSocket error: ${err.message}`);
      params.onError?.(err);
    });

    return { action: "started", accessToken, gatewayUrl, ws };
  } catch (err) {
    params.setConnecting(false);
    (params.handleWebSocketConnectionFailure ?? defaultHandleQQBotWebSocketConnectionFailureGateway)({
      accountId: params.accountId,
      err,
      rateLimitDelayMs: params.rateLimitDelayMs,
      scheduleReconnect: params.scheduleReconnect,
      log: params.log,
    });
    return { action: "failed", error: err };
  }
}

export function isQQBotGatewayWebSocketClosable(ws: QQBotGatewayWebSocketLike): boolean {
  return ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING;
}

function isQQBotGatewayWebSocketOpen(ws: QQBotGatewayWebSocketLike): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function createDefaultWebSocket(
  url: string,
  options: { headers: Record<string, string> },
): QQBotGatewayWebSocketLike {
  return new WebSocket(url, options);
}

function dataToString(data: unknown): string {
  return typeof data === "string" ? data : String(data);
}
