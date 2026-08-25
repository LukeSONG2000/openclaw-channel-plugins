import type { QQBotGatewayWebSocketLike } from "./websocket-connection-gateway-adapter.js";

export interface QQBotGatewayLifecycleLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotGatewayLifecycleSessionState {
  sessionId: string | null;
  lastSeq: number | null;
  lastConnectTime: number;
}

export interface CreateQQBotGatewayLifecycleParams {
  accountId: string;
  reconnectDelays: number[];
  maxReconnectAttempts: number;
  isWebSocketClosable: (ws: QQBotGatewayWebSocketLike) => boolean;
  disposeRuntimeServices?: () => void;
  log?: QQBotGatewayLifecycleLogger;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
  setIntervalFn?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface QQBotGatewayLifecycleController {
  isAborted: () => boolean;
  setAborted: () => void;
  registerAbort: (abortSignal: AbortSignal, onAbort: () => void) => void;
  cleanup: () => void;
  beginConnect: () => boolean;
  prepareConnection: (params?: { clearTokenCache?: () => void }) => void;
  scheduleReconnect: (connect: () => void | Promise<void>, customDelay?: number) => void;
  waitForAbort: (abortSignal: AbortSignal) => Promise<void>;
  restoreSession: (savedSession: { sessionId: string | null; lastSeq: number | null } | null | undefined) => void;
  getSessionState: () => QQBotGatewayLifecycleSessionState;
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
  resetHeartbeat: (
    intervalMs: number,
    onHeartbeat: () => void,
    isSocketOpen: () => boolean,
  ) => void;
  snapshot: () => {
    reconnectAttempts: number;
    isAborted: boolean;
    isConnecting: boolean;
    reconnectTimerActive: boolean;
    heartbeatActive: boolean;
    shouldRefreshToken: boolean;
    currentWebSocket: QQBotGatewayWebSocketLike | null;
  } & QQBotGatewayLifecycleSessionState & { quickDisconnectCount: number };
}

export function createQQBotGatewayLifecycle(
  params: CreateQQBotGatewayLifecycleParams,
): QQBotGatewayLifecycleController {
  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: QQBotGatewayWebSocketLike | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime = 0;
  let quickDisconnectCount = 0;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldRefreshToken = false;

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    (params.clearTimeoutFn ?? clearTimeout)(reconnectTimer);
    reconnectTimer = null;
  };

  const cleanup = () => {
    params.disposeRuntimeServices?.();
    if (heartbeatInterval) {
      (params.clearIntervalFn ?? clearInterval)(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && params.isWebSocketClosable(currentWs)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, params.reconnectDelays.length - 1);
    return params.reconnectDelays[idx] ?? 0;
  };

  return {
    isAborted: () => isAborted,
    setAborted: () => {
      isAborted = true;
      clearReconnectTimer();
      cleanup();
    },
    registerAbort: (abortSignal, onAbort) => {
      abortSignal.addEventListener("abort", () => {
        isAborted = true;
        clearReconnectTimer();
        cleanup();
        onAbort();
      }, { once: true });
    },
    cleanup,
    beginConnect: () => {
      if (isConnecting) {
        params.log?.debug?.(`[qqbot:${params.accountId}] Already connecting, skip`);
        return false;
      }
      isConnecting = true;
      return true;
    },
    prepareConnection: (input) => {
      cleanup();
      if (shouldRefreshToken) {
        params.log?.info?.(`[qqbot:${params.accountId}] Refreshing token...`);
        input?.clearTokenCache?.();
        shouldRefreshToken = false;
      }
    },
    scheduleReconnect: (connect, customDelay) => {
      if (isAborted || reconnectAttempts >= params.maxReconnectAttempts) {
        params.log?.error?.(`[qqbot:${params.accountId}] Max reconnect attempts reached or aborted`);
        return;
      }

      clearReconnectTimer();

      const delay = customDelay ?? getReconnectDelay();
      reconnectAttempts++;
      params.log?.info?.(`[qqbot:${params.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

      reconnectTimer = (params.setTimeoutFn ?? setTimeout)(() => {
        reconnectTimer = null;
        if (!isAborted) {
          void connect();
        }
      }, delay);
    },
    waitForAbort: (abortSignal) => {
      if (abortSignal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    restoreSession: (savedSession) => {
      if (!savedSession) return;
      sessionId = savedSession.sessionId;
      lastSeq = savedSession.lastSeq;
      params.log?.info?.(`[qqbot:${params.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}`);
    },
    getSessionState: () => ({ sessionId, lastSeq, lastConnectTime }),
    setLastSeq: (nextLastSeq) => { lastSeq = nextLastSeq; },
    setSessionId: (nextSessionId) => { sessionId = nextSessionId; },
    setShouldRefreshToken: (nextShouldRefreshToken) => { shouldRefreshToken = nextShouldRefreshToken; },
    setCurrentWebSocket: (ws) => { currentWs = ws; },
    setConnecting: (nextIsConnecting) => { isConnecting = nextIsConnecting; },
    setReconnectAttempts: (nextReconnectAttempts) => { reconnectAttempts = nextReconnectAttempts; },
    setLastConnectTime: (nextLastConnectTime) => { lastConnectTime = nextLastConnectTime; },
    getLastConnectTime: () => lastConnectTime,
    getQuickDisconnectCount: () => quickDisconnectCount,
    setQuickDisconnectCount: (nextQuickDisconnectCount) => { quickDisconnectCount = nextQuickDisconnectCount; },
    resetHeartbeat: (intervalMs, onHeartbeat, isSocketOpen) => {
      if (heartbeatInterval) (params.clearIntervalFn ?? clearInterval)(heartbeatInterval);
      heartbeatInterval = (params.setIntervalFn ?? setInterval)(() => {
        if (isSocketOpen()) {
          onHeartbeat();
        }
      }, intervalMs);
    },
    snapshot: () => ({
      reconnectAttempts,
      isAborted,
      isConnecting,
      reconnectTimerActive: Boolean(reconnectTimer),
      heartbeatActive: Boolean(heartbeatInterval),
      shouldRefreshToken,
      currentWebSocket: currentWs,
      sessionId,
      lastSeq,
      lastConnectTime,
      quickDisconnectCount,
    }),
  };
}
