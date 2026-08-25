import { stopBackgroundTokenRefresh as defaultStopBackgroundTokenRefresh } from "../api.js";
import { flushKnownUsers as defaultFlushKnownUsers } from "../known-users.js";
import { flushRefIndex as defaultFlushRefIndex } from "../ref-index-store.js";
import type { QQBotGatewayLifecycleController } from "./gateway-lifecycle-gateway-adapter.js";
import type { CustomMessageFlowStateController } from "./message-flow-state.js";
import type { QQBotApprovalHandlerGatewayHandle } from "./approval-handler-gateway-adapter.js";
import type { CustomUpdateCheckController } from "./update-check.js";

export interface QQBotGatewayAbortCleanupLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotGatewayAbortCleanupStepResult {
  step: string;
  status: "completed" | "failed";
  error?: unknown;
}

export interface RunQQBotGatewayAbortCleanupParams {
  account: { accountId: string; appId: string };
  customState: Pick<CustomMessageFlowStateController, "persistAllState">;
  updateCheck: Pick<CustomUpdateCheckController, "stop">;
  approvalHandler: Pick<QQBotApprovalHandlerGatewayHandle, "dispose">;
  log?: QQBotGatewayAbortCleanupLogger;
  stopBackgroundTokenRefresh?: typeof defaultStopBackgroundTokenRefresh;
  flushKnownUsers?: typeof defaultFlushKnownUsers;
  flushRefIndex?: typeof defaultFlushRefIndex;
}

export interface RegisterQQBotGatewayAbortCleanupParams extends RunQQBotGatewayAbortCleanupParams {
  abortSignal: AbortSignal;
  lifecycle: Pick<QQBotGatewayLifecycleController, "registerAbort">;
}

export function registerQQBotGatewayAbortCleanup(
  params: RegisterQQBotGatewayAbortCleanupParams,
): void {
  params.lifecycle.registerAbort(params.abortSignal, () => {
    runQQBotGatewayAbortCleanup(params);
  });
}

export function runQQBotGatewayAbortCleanup(
  params: RunQQBotGatewayAbortCleanupParams,
): QQBotGatewayAbortCleanupStepResult[] {
  const steps: Array<{ name: string; run: () => void }> = [
    {
      name: "stop-background-token-refresh",
      run: () => (params.stopBackgroundTokenRefresh ?? defaultStopBackgroundTokenRefresh)(params.account.appId),
    },
    {
      name: "flush-known-users",
      run: () => (params.flushKnownUsers ?? defaultFlushKnownUsers)(),
    },
    {
      name: "flush-ref-index",
      run: () => (params.flushRefIndex ?? defaultFlushRefIndex)(),
    },
    {
      name: "persist-custom-state",
      run: () => params.customState.persistAllState(),
    },
    {
      name: "stop-update-check",
      run: () => params.updateCheck.stop(),
    },
    {
      name: "dispose-approval-handler",
      run: () => params.approvalHandler.dispose(),
    },
  ];

  const results: QQBotGatewayAbortCleanupStepResult[] = [];
  for (const step of steps) {
    try {
      step.run();
      results.push({ step: step.name, status: "completed" });
    } catch (err) {
      params.log?.error?.(
        `[qqbot:${params.account.accountId}] abort cleanup failed at ${step.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({ step: step.name, status: "failed", error: err });
    }
  }
  return results;
}
