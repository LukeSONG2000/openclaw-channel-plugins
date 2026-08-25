import {
  QQBotApprovalHandler,
  registerApprovalHandler as defaultRegisterApprovalHandler,
  unregisterApprovalHandler as defaultUnregisterApprovalHandler,
  type QQBotApprovalHandlerOpts,
} from "../approval-handler.js";
import type { ResolvedQQBotAccount } from "../types.js";

export interface QQBotApprovalHandlerGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotApprovalHandlerGatewayHandle {
  handler: QQBotApprovalHandlerLifecycle;
  stop: () => Promise<void>;
  unregister: () => void;
  dispose: () => void;
}

export interface QQBotApprovalHandlerLifecycle {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}

export interface StartQQBotApprovalHandlerGatewayParams {
  account: Pick<ResolvedQQBotAccount, "accountId" | "appId" | "clientSecret">;
  cfg: unknown;
  log?: QQBotApprovalHandlerGatewayLogger;
  createHandler?: (opts: QQBotApprovalHandlerOpts) => QQBotApprovalHandlerLifecycle;
  registerApprovalHandler?: (accountId: string, handler: QQBotApprovalHandlerLifecycle) => void;
  unregisterApprovalHandler?: (accountId: string) => void;
}

export function startQQBotApprovalHandlerGateway(
  params: StartQQBotApprovalHandlerGatewayParams,
): QQBotApprovalHandlerGatewayHandle {
  const { account } = params;
  const createHandler = params.createHandler ?? ((opts) => new QQBotApprovalHandler(opts));
  const registerApprovalHandler = params.registerApprovalHandler
    ?? (defaultRegisterApprovalHandler as (accountId: string, handler: QQBotApprovalHandlerLifecycle) => void);
  const unregisterApprovalHandler = params.unregisterApprovalHandler ?? defaultUnregisterApprovalHandler;

  const handler = createHandler({
    accountId: account.accountId,
    appId: account.appId,
    clientSecret: account.clientSecret,
    cfg: params.cfg as QQBotApprovalHandlerOpts["cfg"],
    log: params.log as QQBotApprovalHandlerOpts["log"],
  });

  let stopped = false;
  let unregistered = false;

  registerApprovalHandler(account.accountId, handler);
  Promise.resolve(handler.start()).catch((err) => {
    params.log?.error?.(`[qqbot:${account.accountId}] approval-handler: uncaught start error: ${err}`);
  });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await handler.stop();
  };
  const unregister = () => {
    if (unregistered) return;
    unregistered = true;
    unregisterApprovalHandler(account.accountId);
  };

  return {
    handler,
    stop,
    unregister,
    dispose: () => {
      void stop().catch((err) => {
        params.log?.error?.(`[qqbot:${account.accountId}] approval-handler: uncaught stop error: ${err}`);
      });
      unregister();
    },
  };
}
