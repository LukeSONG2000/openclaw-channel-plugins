import type { AdminResolverContext } from "../admin-resolver.js";
import { loadSession as defaultLoadSession, type SessionState } from "../session-store.js";
import { setRefIndex as defaultSetRefIndex } from "../ref-index-store.js";
import type { ResolvedQQBotAccount, TransportMode } from "../types.js";
import {
  registerCustomOutboundRefIndexGateway as defaultRegisterCustomOutboundRefIndexGateway,
  type RegisterCustomOutboundRefIndexGatewayParams,
} from "./outbound-ref-index-gateway-adapter.js";
import {
  runQQBotGatewayStartupPreflight as defaultRunQQBotGatewayStartupPreflight,
  type QQBotGatewayStartupPreflightLogger,
} from "./startup-preflight-gateway-adapter.js";

export interface QQBotGatewayStartupLogger extends QQBotGatewayStartupPreflightLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotGatewayProcessLike {
  on: (event: "uncaughtException", handler: (err: Error) => void) => unknown;
  removeListener: (event: "uncaughtException", handler: (err: Error) => void) => unknown;
}

export interface QQBotGatewayAbortSignalLike {
  addEventListener: (event: "abort", handler: () => void, options?: { once?: boolean }) => unknown;
}

export interface StartQQBotGatewayStartupParams {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  abortSignal: QQBotGatewayAbortSignalLike;
  restoreSession: (session: SessionState | null) => void;
  markPendingFirstReady: () => void;
  log?: QQBotGatewayStartupLogger;
  getRuntime?: () => unknown;
  loadSession?: typeof defaultLoadSession;
  registerOutboundRefIndex?: typeof defaultRegisterCustomOutboundRefIndexGateway;
  setRefEntry?: RegisterCustomOutboundRefIndexGatewayParams["setRefEntry"];
  runStartupPreflight?: typeof defaultRunQQBotGatewayStartupPreflight;
  processLike?: QQBotGatewayProcessLike;
}

export interface QQBotGatewayStartupResult {
  transportMode: TransportMode;
  adminContext: AdminResolverContext;
  disposeProcessGuard: () => void;
}

export async function startQQBotGatewayStartup(
  params: StartQQBotGatewayStartupParams,
): Promise<QQBotGatewayStartupResult> {
  const { account } = params;
  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  const disposeProcessGuard = registerQQBotGatewayUncaughtExceptionGuard({
    accountId: account.accountId,
    abortSignal: params.abortSignal,
    log: params.log,
    processLike: params.processLike,
  });

  await (params.runStartupPreflight ?? defaultRunQQBotGatewayStartupPreflight)({
    account,
    cfg: params.cfg,
    getRuntime: params.getRuntime ?? (() => undefined),
    log: params.log,
  });

  (params.registerOutboundRefIndex ?? defaultRegisterCustomOutboundRefIndexGateway)({
    accountId: account.accountId,
    setRefEntry: params.setRefEntry ?? defaultSetRefIndex,
    log: params.log,
  });

  const transportMode: TransportMode = account.config.transport ?? "websocket";
  if (transportMode === "webhook") {
    params.log?.info?.(`[qqbot:${account.accountId}] Using webhook transport mode`);
  }

  params.markPendingFirstReady();
  params.restoreSession((params.loadSession ?? defaultLoadSession)(account.accountId, account.appId));
  const adminLog = params.log?.info && params.log?.error
    ? { info: params.log.info, error: params.log.error }
    : undefined;

  return {
    transportMode,
    adminContext: {
      accountId: account.accountId,
      appId: account.appId,
      clientSecret: account.clientSecret,
      log: adminLog,
    },
    disposeProcessGuard,
  };
}

export function registerQQBotGatewayUncaughtExceptionGuard(params: {
  accountId: string;
  abortSignal: QQBotGatewayAbortSignalLike;
  log?: QQBotGatewayStartupLogger;
  processLike?: QQBotGatewayProcessLike;
}): () => void {
  const processLike = params.processLike ?? process;
  let disposed = false;
  const handler = (err: Error) => {
    if (err.message?.includes("Unexpected server response")) {
      params.log?.error?.(`[qqbot:${params.accountId}] Caught WS handshake error (non-fatal): ${err.message}`);
      return;
    }
    throw err;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    processLike.removeListener("uncaughtException", handler);
  };

  processLike.on("uncaughtException", handler);
  params.abortSignal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
