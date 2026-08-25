import {
  resolveQQBotConnectionFailureReconnectDelay,
  resolveQQBotWebSocketCloseDecision,
  type QQBotWebSocketReconnectLogEntry,
} from "./websocket-reconnect-policy.js";

export interface QQBotWebSocketCloseGatewayLogger {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface HandleQQBotWebSocketCloseGatewayResult {
  shouldRefreshToken: boolean;
  shouldClearSession: boolean;
  nextQuickDisconnectCount: number;
  cleanupCalled: boolean;
  reconnectScheduled: boolean;
  reconnectDelayMs?: number;
}

export interface HandleQQBotWebSocketConnectionFailureGatewayResult {
  reconnectDelayMs?: number;
  rateLimited: boolean;
}

export function handleQQBotWebSocketCloseGateway(params: {
  accountId: string;
  code: number;
  reason: string;
  isAborted: boolean;
  lastConnectTime: number;
  quickDisconnectCount: number;
  quickDisconnectThresholdMs: number;
  maxQuickDisconnectCount: number;
  rateLimitDelayMs: number;
  setSessionId: (sessionId: string | null) => void;
  setLastSeq: (lastSeq: number | null) => void;
  setShouldRefreshToken: (value: boolean) => void;
  setQuickDisconnectCount: (value: number) => void;
  clearSession: (accountId: string) => void;
  cleanup: () => void;
  scheduleReconnect: (delayMs?: number) => void;
  now?: number;
  log?: QQBotWebSocketCloseGatewayLogger;
}): HandleQQBotWebSocketCloseGatewayResult {
  params.log?.info?.(`[qqbot:${params.accountId}] WebSocket closed: ${params.code} ${params.reason}`);
  const closeDecision = resolveQQBotWebSocketCloseDecision({
    code: params.code,
    isAborted: params.isAborted,
    lastConnectTime: params.lastConnectTime,
    quickDisconnectCount: params.quickDisconnectCount,
    quickDisconnectThresholdMs: params.quickDisconnectThresholdMs,
    maxQuickDisconnectCount: params.maxQuickDisconnectCount,
    rateLimitDelayMs: params.rateLimitDelayMs,
    now: params.now,
  });
  logReconnectDecisionEntries(params.log, params.accountId, closeDecision.logs);

  if (closeDecision.shouldClearSession) {
    params.setSessionId(null);
    params.setLastSeq(null);
    params.clearSession(params.accountId);
  }
  if (closeDecision.shouldRefreshToken) {
    params.setShouldRefreshToken(true);
  }
  params.setQuickDisconnectCount(closeDecision.nextQuickDisconnectCount);
  if (closeDecision.cleanup) {
    params.cleanup();
  }
  if (closeDecision.reconnect) {
    params.scheduleReconnect(closeDecision.reconnectDelayMs);
  }

  return {
    shouldRefreshToken: closeDecision.shouldRefreshToken,
    shouldClearSession: closeDecision.shouldClearSession,
    nextQuickDisconnectCount: closeDecision.nextQuickDisconnectCount,
    cleanupCalled: closeDecision.cleanup,
    reconnectScheduled: closeDecision.reconnect,
    reconnectDelayMs: closeDecision.reconnectDelayMs,
  };
}

export function handleQQBotWebSocketConnectionFailureGateway(params: {
  accountId: string;
  err: unknown;
  rateLimitDelayMs: number;
  scheduleReconnect: (delayMs?: number) => void;
  log?: QQBotWebSocketCloseGatewayLogger;
}): HandleQQBotWebSocketConnectionFailureGatewayResult {
  params.log?.error?.(`[qqbot:${params.accountId}] Connection failed: ${params.err}`);
  const reconnectDelay = resolveQQBotConnectionFailureReconnectDelay(params.err, params.rateLimitDelayMs);
  if (reconnectDelay !== undefined) {
    params.log?.info?.(`[qqbot:${params.accountId}] Rate limited, waiting ${params.rateLimitDelayMs}ms before retry`);
    params.scheduleReconnect(reconnectDelay);
    return { reconnectDelayMs: reconnectDelay, rateLimited: true };
  }
  params.scheduleReconnect();
  return { rateLimited: false };
}

function logReconnectDecisionEntries(
  log: QQBotWebSocketCloseGatewayLogger | undefined,
  accountId: string,
  entries: QQBotWebSocketReconnectLogEntry[],
): void {
  for (const item of entries) {
    const line = `[qqbot:${accountId}] ${item.message}`;
    if (item.level === "error") log?.error?.(line);
    else log?.info?.(line);
  }
}
