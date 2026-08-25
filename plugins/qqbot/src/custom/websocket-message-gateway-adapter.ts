import type { WSPayload } from "../types.js";
import {
  buildQQBotWebSocketHeartbeatPayload,
  resolveQQBotWebSocketDispatchDecision,
  resolveQQBotWebSocketHelloDecision,
  resolveQQBotWebSocketInvalidSessionDecision,
  type QQBotWebSocketOutboundPayload,
  type QQBotWebSocketPayloadLogEntry,
} from "./websocket-payload-policy.js";

export interface QQBotWebSocketMessageGatewayLogger {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface QQBotWebSocketMessageSessionState {
  sessionId: string | null;
  lastSeq: number | null;
  lastConnectTime: number;
}

export interface QQBotWebSocketSessionSaveInput {
  sessionId: string;
  lastSeq: number | null;
  lastConnectedAt: number;
  intentLevelIndex: number;
  accountId: string;
  savedAt: number;
  appId: string;
}

export type HandleQQBotWebSocketMessageGatewayResult =
  | { kind: "hello" }
  | { kind: "dispatch-ready"; sessionId: string }
  | { kind: "dispatch-resumed" }
  | { kind: "dispatch-event"; eventType: string }
  | { kind: "heartbeat-ack" }
  | { kind: "server-reconnect" }
  | { kind: "invalid-session" }
  | { kind: "ignored"; op: number }
  | { kind: "parse-error"; error: unknown };

export async function handleQQBotWebSocketMessageGateway(params: {
  accountId: string;
  appId: string;
  accessToken: string;
  intents: number;
  intentsDesc: string;
  rawData: string;
  getSessionState: () => QQBotWebSocketMessageSessionState;
  setLastSeq: (lastSeq: number | null) => void;
  setSessionId: (sessionId: string | null) => void;
  setShouldRefreshToken: (value: boolean) => void;
  saveSession: (input: QQBotWebSocketSessionSaveInput) => void;
  clearSession: (accountId: string) => void;
  sendJson: (payload: QQBotWebSocketOutboundPayload) => void;
  resetHeartbeat: (intervalMs: number, onHeartbeat: () => void) => void;
  isPendingFirstReady: () => boolean;
  markFirstReadyConsumed: () => void;
  onReady?: (data: unknown) => void;
  sendStartupGreeting: (event: "READY" | "RESUMED") => void;
  dispatchInboundEvent: (eventType: string, data: unknown) => Promise<void> | void;
  cleanup: () => void;
  scheduleReconnect: (delayMs?: number) => void;
  now?: () => number;
  log?: QQBotWebSocketMessageGatewayLogger;
}): Promise<HandleQQBotWebSocketMessageGatewayResult> {
  try {
    const payload = JSON.parse(params.rawData) as WSPayload;
    const { op, d, s, t } = payload;

    if (s !== undefined) {
      params.setLastSeq(s);
      const state = params.getSessionState();
      if (state.sessionId) {
        saveCurrentSession(params, state.sessionId, state.lastSeq, state.lastConnectTime);
      }
    }

    params.log?.debug?.(`[qqbot:${params.accountId}] Received op=${op} t=${t}`);

    if (op === 10) {
      handleHello(params, d);
      return { kind: "hello" };
    }

    if (op === 0) {
      return handleDispatch(params, t, d);
    }

    if (op === 11) {
      params.log?.debug?.(`[qqbot:${params.accountId}] Heartbeat ACK`);
      return { kind: "heartbeat-ack" };
    }

    if (op === 7) {
      params.log?.info?.(`[qqbot:${params.accountId}] Server requested reconnect`);
      params.cleanup();
      params.scheduleReconnect();
      return { kind: "server-reconnect" };
    }

    if (op === 9) {
      handleInvalidSession(params, d, params.rawData);
      return { kind: "invalid-session" };
    }

    return { kind: "ignored", op };
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.accountId}] Message parse error: ${err}`);
    return { kind: "parse-error", error: err };
  }
}

function handleHello(
  params: Parameters<typeof handleQQBotWebSocketMessageGateway>[0],
  data: unknown,
): void {
  const state = params.getSessionState();
  const helloDecision = resolveQQBotWebSocketHelloDecision({
    accessToken: params.accessToken,
    sessionId: state.sessionId,
    lastSeq: state.lastSeq,
    intents: params.intents,
    intentsDesc: params.intentsDesc,
    heartbeatInterval: (data as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval,
  });
  logDecisionEntries(params.log, params.accountId, helloDecision.logs);
  params.sendJson(helloDecision.outbound);
  params.resetHeartbeat(helloDecision.heartbeatIntervalMs, () => {
    params.sendJson(buildQQBotWebSocketHeartbeatPayload(params.getSessionState().lastSeq));
    params.log?.debug?.(`[qqbot:${params.accountId}] Heartbeat sent`);
  });
}

function handleDispatch(
  params: Parameters<typeof handleQQBotWebSocketMessageGateway>[0],
  eventType: string | undefined,
  data: unknown,
): HandleQQBotWebSocketMessageGatewayResult {
  params.log?.info?.(`[qqbot:${params.accountId}] 📩 Dispatch event: t=${eventType}, d=${JSON.stringify(data)}`);
  const dispatchDecision = resolveQQBotWebSocketDispatchDecision({
    eventType,
    data,
    pendingFirstReady: params.isPendingFirstReady(),
    intentsDesc: params.intentsDesc,
  });
  logDecisionEntries(params.log, params.accountId, dispatchDecision.logs);

  if (dispatchDecision.kind === "ready") {
    params.setSessionId(dispatchDecision.sessionId);
    const state = params.getSessionState();
    saveCurrentSession(params, dispatchDecision.sessionId, state.lastSeq, params.now?.() ?? Date.now());
    params.onReady?.(data);
    if (dispatchDecision.startupGreeting) {
      params.markFirstReadyConsumed();
      params.sendStartupGreeting(dispatchDecision.startupGreeting);
    }
    return { kind: "dispatch-ready", sessionId: dispatchDecision.sessionId };
  }

  if (dispatchDecision.kind === "resumed") {
    params.onReady?.(data);
    if (dispatchDecision.startupGreeting) {
      params.markFirstReadyConsumed();
      params.sendStartupGreeting(dispatchDecision.startupGreeting);
    }
    const state = params.getSessionState();
    if (state.sessionId) {
      saveCurrentSession(params, state.sessionId, state.lastSeq, params.now?.() ?? Date.now());
    }
    return { kind: "dispatch-resumed" };
  }

  void Promise.resolve(params.dispatchInboundEvent(dispatchDecision.eventType, dispatchDecision.data)).catch((err) => {
    params.log?.error?.(`[qqbot:${params.accountId}] Event dispatch error (t=${dispatchDecision.eventType}): ${err}`);
  });
  return { kind: "dispatch-event", eventType: dispatchDecision.eventType };
}

function handleInvalidSession(
  params: Parameters<typeof handleQQBotWebSocketMessageGateway>[0],
  data: unknown,
  rawData: string,
): void {
  const invalidSessionDecision = resolveQQBotWebSocketInvalidSessionDecision({
    canResume: data as boolean,
    intentsDesc: params.intentsDesc,
    rawData,
  });
  logDecisionEntries(params.log, params.accountId, invalidSessionDecision.logs);
  if (invalidSessionDecision.shouldClearSession) {
    params.setSessionId(null);
    params.setLastSeq(null);
    params.clearSession(params.accountId);
  }
  if (invalidSessionDecision.shouldRefreshToken) {
    params.setShouldRefreshToken(true);
  }
  if (invalidSessionDecision.cleanup) {
    params.cleanup();
  }
  if (invalidSessionDecision.reconnect) {
    params.scheduleReconnect(invalidSessionDecision.reconnectDelayMs);
  }
}

function saveCurrentSession(
  params: Parameters<typeof handleQQBotWebSocketMessageGateway>[0],
  sessionId: string,
  lastSeq: number | null,
  lastConnectedAt: number,
): void {
  params.saveSession({
    sessionId,
    lastSeq,
    lastConnectedAt,
    intentLevelIndex: 0,
    accountId: params.accountId,
    savedAt: params.now?.() ?? Date.now(),
    appId: params.appId,
  });
}

function logDecisionEntries(
  log: QQBotWebSocketMessageGatewayLogger | undefined,
  accountId: string,
  entries: QQBotWebSocketPayloadLogEntry[],
): void {
  for (const item of entries) {
    const line = `[qqbot:${accountId}] ${item.message}`;
    if (item.level === "error") log?.error?.(line);
    else if (item.level === "debug") log?.debug?.(line);
    else log?.info?.(line);
  }
}
