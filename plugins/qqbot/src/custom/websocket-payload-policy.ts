export type QQBotWebSocketPayloadLogLevel = "info" | "debug" | "error";

export interface QQBotWebSocketPayloadLogEntry {
  level: QQBotWebSocketPayloadLogLevel;
  message: string;
}

export type QQBotWebSocketOutboundPayload =
  | { op: 1; d: number | null }
  | { op: 2; d: { token: string; intents: number; shard: [number, number] } }
  | { op: 6; d: { token: string; session_id: string; seq: number } };

export interface QQBotWebSocketHelloDecision {
  logs: QQBotWebSocketPayloadLogEntry[];
  outbound: QQBotWebSocketOutboundPayload;
  heartbeatIntervalMs: number;
}

export type QQBotWebSocketDispatchDecision =
  | {
      kind: "ready";
      logs: QQBotWebSocketPayloadLogEntry[];
      sessionId: string;
      shouldNotifyReady: true;
      shouldSaveSession: true;
      startupGreeting: "READY" | null;
    }
  | {
      kind: "resumed";
      logs: QQBotWebSocketPayloadLogEntry[];
      shouldNotifyReady: true;
      shouldSaveSession: true;
      startupGreeting: "RESUMED" | null;
    }
  | {
      kind: "event";
      logs: QQBotWebSocketPayloadLogEntry[];
      eventType: string;
      data: unknown;
    };

export interface QQBotWebSocketInvalidSessionDecision {
  logs: QQBotWebSocketPayloadLogEntry[];
  shouldClearSession: boolean;
  shouldRefreshToken: boolean;
  cleanup: boolean;
  reconnect: boolean;
  reconnectDelayMs: number;
}

export function resolveQQBotWebSocketHelloDecision(params: {
  accessToken: string;
  sessionId: string | null;
  lastSeq: number | null;
  intents: number;
  intentsDesc: string;
  heartbeatInterval: unknown;
}): QQBotWebSocketHelloDecision {
  const logs: QQBotWebSocketPayloadLogEntry[] = [
    { level: "info", message: "Hello received" },
  ];
  let outbound: QQBotWebSocketOutboundPayload;
  if (params.sessionId && params.lastSeq !== null) {
    logs.push({ level: "info", message: `Attempting to resume session ${params.sessionId}` });
    outbound = {
      op: 6,
      d: {
        token: `QQBot ${params.accessToken}`,
        session_id: params.sessionId,
        seq: params.lastSeq,
      },
    };
  } else {
    logs.push({ level: "info", message: `Sending identify with intents: ${params.intents} (${params.intentsDesc})` });
    outbound = {
      op: 2,
      d: {
        token: `QQBot ${params.accessToken}`,
        intents: params.intents,
        shard: [0, 1],
      },
    };
  }

  return {
    logs,
    outbound,
    heartbeatIntervalMs: normalizeHeartbeatInterval(params.heartbeatInterval),
  };
}

export function buildQQBotWebSocketHeartbeatPayload(lastSeq: number | null): QQBotWebSocketOutboundPayload {
  return { op: 1, d: lastSeq };
}

export function resolveQQBotWebSocketDispatchDecision(params: {
  eventType: string | undefined | null;
  data: unknown;
  pendingFirstReady: boolean;
  intentsDesc: string;
}): QQBotWebSocketDispatchDecision {
  if (params.eventType === "READY") {
    const sessionId = objectValue(params.data, "session_id") ?? "";
    return {
      kind: "ready",
      logs: [
        { level: "info", message: `Ready with ${params.intentsDesc}, session: ${sessionId}` },
        ...(params.pendingFirstReady ? [] : [{ level: "info" as const, message: "Skipping startup greeting (reconnect READY, not first startup)" }]),
      ],
      sessionId,
      shouldNotifyReady: true,
      shouldSaveSession: true,
      startupGreeting: params.pendingFirstReady ? "READY" : null,
    };
  }

  if (params.eventType === "RESUMED") {
    return {
      kind: "resumed",
      logs: [{ level: "info", message: "Session resumed" }],
      shouldNotifyReady: true,
      shouldSaveSession: true,
      startupGreeting: params.pendingFirstReady ? "RESUMED" : null,
    };
  }

  return {
    kind: "event",
    logs: [],
    eventType: params.eventType ?? "",
    data: params.data,
  };
}

export function resolveQQBotWebSocketInvalidSessionDecision(params: {
  canResume: boolean;
  intentsDesc: string;
  rawData: string;
}): QQBotWebSocketInvalidSessionDecision {
  const logs: QQBotWebSocketPayloadLogEntry[] = [
    {
      level: "error",
      message: `Invalid session (${params.intentsDesc}), can resume: ${params.canResume}, raw: ${params.rawData}`,
    },
  ];
  if (!params.canResume) {
    logs.push({ level: "info", message: `Will refresh token and retry with full intents (${params.intentsDesc})` });
  }
  return {
    logs,
    shouldClearSession: !params.canResume,
    shouldRefreshToken: !params.canResume,
    cleanup: true,
    reconnect: true,
    reconnectDelayMs: 3000,
  };
}

function normalizeHeartbeatInterval(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return 0;
}

function objectValue(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
