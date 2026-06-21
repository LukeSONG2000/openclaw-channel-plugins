export type QQBotWebSocketReconnectLogLevel = "info" | "error";

export interface QQBotWebSocketReconnectLogEntry {
  level: QQBotWebSocketReconnectLogLevel;
  message: string;
}

export interface QQBotWebSocketCloseDecision {
  logs: QQBotWebSocketReconnectLogEntry[];
  cleanup: boolean;
  reconnect: boolean;
  reconnectDelayMs?: number;
  shouldRefreshToken: boolean;
  shouldClearSession: boolean;
  nextQuickDisconnectCount: number;
}

export function resolveQQBotWebSocketCloseDecision(params: {
  code: number;
  isAborted: boolean;
  lastConnectTime: number;
  quickDisconnectCount: number;
  quickDisconnectThresholdMs: number;
  maxQuickDisconnectCount: number;
  rateLimitDelayMs: number;
  now?: number;
}): QQBotWebSocketCloseDecision {
  const logs: QQBotWebSocketReconnectLogEntry[] = [];
  const base: QQBotWebSocketCloseDecision = {
    logs,
    cleanup: true,
    reconnect: false,
    shouldRefreshToken: false,
    shouldClearSession: false,
    nextQuickDisconnectCount: params.quickDisconnectCount,
  };

  if (params.code === 4914 || params.code === 4915) {
    logs.push({
      level: "error",
      message: `Bot is ${params.code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`,
    });
    return base;
  }

  if (params.code === 4004) {
    logs.push({ level: "info", message: "Invalid token (4004), will refresh token and reconnect" });
    return {
      ...base,
      reconnect: !params.isAborted,
      shouldRefreshToken: true,
    };
  }

  if (params.code === 4008) {
    logs.push({ level: "info", message: `Rate limited (4008), waiting ${params.rateLimitDelayMs}ms before reconnect` });
    return {
      ...base,
      reconnect: !params.isAborted,
      reconnectDelayMs: params.rateLimitDelayMs,
    };
  }

  let shouldRefreshToken = false;
  let shouldClearSession = false;
  if (isSessionResetCloseCode(params.code)) {
    logs.push({ level: "info", message: `Error ${params.code} (${sessionResetCloseCodeDescription(params.code)}), will re-identify` });
    shouldRefreshToken = true;
    shouldClearSession = true;
  } else if (params.code >= 4900 && params.code <= 4913) {
    logs.push({ level: "info", message: `Internal error (${params.code}), will re-identify` });
    shouldRefreshToken = true;
    shouldClearSession = true;
  }

  const quick = resolveQuickDisconnectState({
    code: params.code,
    lastConnectTime: params.lastConnectTime,
    quickDisconnectCount: params.quickDisconnectCount,
    quickDisconnectThresholdMs: params.quickDisconnectThresholdMs,
    maxQuickDisconnectCount: params.maxQuickDisconnectCount,
    rateLimitDelayMs: params.rateLimitDelayMs,
    now: params.now,
  });
  logs.push(...quick.logs);

  return {
    ...base,
    reconnect: quick.forceRateLimitReconnect
      ? !params.isAborted && params.code !== 1000
      : !params.isAborted && params.code !== 1000,
    reconnectDelayMs: quick.forceRateLimitReconnect ? params.rateLimitDelayMs : undefined,
    shouldRefreshToken,
    shouldClearSession,
    nextQuickDisconnectCount: quick.nextQuickDisconnectCount,
  };
}

export function resolveQQBotConnectionFailureReconnectDelay(
  err: unknown,
  rateLimitDelayMs: number,
): number | undefined {
  const errMsg = String(err);
  if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
    return rateLimitDelayMs;
  }
  return undefined;
}

function resolveQuickDisconnectState(params: {
  code: number;
  lastConnectTime: number;
  quickDisconnectCount: number;
  quickDisconnectThresholdMs: number;
  maxQuickDisconnectCount: number;
  rateLimitDelayMs: number;
  now?: number;
}): {
  logs: QQBotWebSocketReconnectLogEntry[];
  nextQuickDisconnectCount: number;
  forceRateLimitReconnect: boolean;
} {
  const logs: QQBotWebSocketReconnectLogEntry[] = [];
  const now = params.now ?? Date.now();
  const connectionDuration = now - params.lastConnectTime;
  if (connectionDuration < params.quickDisconnectThresholdMs && params.lastConnectTime > 0) {
    const nextQuickDisconnectCount = params.quickDisconnectCount + 1;
    logs.push({
      level: "info",
      message: `Quick disconnect detected (${connectionDuration}ms), count: ${nextQuickDisconnectCount}`,
    });
    if (nextQuickDisconnectCount >= params.maxQuickDisconnectCount) {
      logs.push(
        { level: "error", message: "Too many quick disconnects. This may indicate a permission issue." },
        { level: "error", message: "Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform" },
      );
      return {
        logs,
        nextQuickDisconnectCount: 0,
        forceRateLimitReconnect: true,
      };
    }
    return {
      logs,
      nextQuickDisconnectCount,
      forceRateLimitReconnect: false,
    };
  }

  return {
    logs,
    nextQuickDisconnectCount: 0,
    forceRateLimitReconnect: false,
  };
}

function isSessionResetCloseCode(code: number): boolean {
  return code === 4006 || code === 4007 || code === 4009;
}

function sessionResetCloseCodeDescription(code: number): string {
  if (code === 4006) return "session no longer valid";
  if (code === 4007) return "invalid seq on resume";
  return "session timed out";
}
