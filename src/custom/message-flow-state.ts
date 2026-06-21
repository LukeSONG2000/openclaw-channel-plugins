import {
  loadCustomAuthorizationState,
  saveCustomAuthorizationState,
  type CustomAuthorizationStoreOptions,
} from "./auth-store.js";
import {
  loadCustomPollState,
  saveCustomPollState,
  type CustomPollStoreOptions,
} from "./poll-store.js";
import {
  loadCustomGameState,
  saveCustomGameState,
  type CustomGameStoreOptions,
} from "./game-store.js";
import {
  loadCustomDeployConfirmationState,
  saveCustomDeployConfirmationState,
  type CustomDeployConfirmationStoreOptions,
} from "./deploy-confirmation-store.js";
import {
  loadCustomProactiveBudgetState,
  saveCustomProactiveBudgetState,
  type CustomProactiveBudgetStoreOptions,
} from "./proactive-budget-store.js";
import { createCustomMessageFlowRuntime, type CustomMessageFlowRuntime } from "./runtime.js";
import {
  loadCustomTaskSandboxState,
  saveCustomTaskSandboxState,
  type CustomTaskSandboxStoreOptions,
} from "./task-sandbox-store.js";
import type { CustomAuthorizationIntent } from "./types.js";
import {
  loadCustomUnreadState,
  saveCustomUnreadState,
  type CustomUnreadStoreOptions,
} from "./unread-store.js";

export interface CustomMessageFlowStateLogger {
  info: (msg: string) => void;
}

export interface CustomMessageFlowStateStoreOptions {
  auth?: CustomAuthorizationStoreOptions;
  proactiveBudget?: CustomProactiveBudgetStoreOptions;
  tasks?: CustomTaskSandboxStoreOptions;
  polls?: CustomPollStoreOptions;
  games?: CustomGameStoreOptions;
  deployConfirmations?: CustomDeployConfirmationStoreOptions;
  unread?: CustomUnreadStoreOptions;
}

export interface CustomMessageFlowStateController {
  runtime: CustomMessageFlowRuntime;
  restoredAuthIntents: CustomAuthorizationIntent[];
  persistAuthState: () => void;
  persistProactiveBudgetState: () => void;
  persistTaskState: () => void;
  persistPollState: () => void;
  persistGameState: () => void;
  persistDeployConfirmationState: () => void;
  persistUnreadState: () => void;
  persistAllState: () => void;
}

export function createCustomMessageFlowStateController(params: {
  accountId: string;
  log?: CustomMessageFlowStateLogger;
  storeOptions?: CustomMessageFlowStateStoreOptions;
}): CustomMessageFlowStateController {
  const { accountId, log, storeOptions } = params;
  const runtime = createCustomMessageFlowRuntime();

  const restoredAuthIntents: CustomAuthorizationIntent[] = [];
  const restoredCustomAuthState = loadCustomAuthorizationState(accountId, storeOptions?.auth);
  if (restoredCustomAuthState) {
    restoredAuthIntents.push(...runtime.auth.loadState(restoredCustomAuthState));
    log?.info(`[qqbot:${accountId}] Restored custom auth state: grants=${Object.keys(restoredCustomAuthState.grants).length}, requests=${Object.keys(restoredCustomAuthState.requests).length}`);
    if (restoredAuthIntents.length) {
      saveCustomAuthorizationState(accountId, runtime.auth.getState(), storeOptions?.auth);
    }
  }

  const restoredProactiveBudgetState = loadCustomProactiveBudgetState(accountId, storeOptions?.proactiveBudget);
  if (restoredProactiveBudgetState) {
    runtime.proactiveBudget.loadState(restoredProactiveBudgetState);
    log?.info(`[qqbot:${accountId}] Restored custom proactive budget state: entries=${Object.keys(restoredProactiveBudgetState.entries).length}`);
  }

  const restoredTaskState = loadCustomTaskSandboxState(accountId, storeOptions?.tasks);
  if (restoredTaskState) {
    runtime.tasks.loadState(restoredTaskState);
    log?.info(`[qqbot:${accountId}] Restored custom task sandbox state: tasks=${Object.keys(restoredTaskState.tasks).length}`);
  }

  const restoredPollState = loadCustomPollState(accountId, storeOptions?.polls);
  if (restoredPollState) {
    runtime.polls.loadState(restoredPollState);
    log?.info(`[qqbot:${accountId}] Restored custom poll state: polls=${Object.keys(restoredPollState.polls).length}`);
  }

  const restoredGameState = loadCustomGameState(accountId, storeOptions?.games);
  if (restoredGameState) {
    runtime.games.loadState(restoredGameState);
    log?.info(`[qqbot:${accountId}] Restored custom game state: guessGames=${Object.keys(restoredGameState.guessGames).length}`);
  }

  const restoredDeployConfirmationState = loadCustomDeployConfirmationState(accountId, storeOptions?.deployConfirmations);
  if (restoredDeployConfirmationState) {
    runtime.deployConfirmations.loadState(restoredDeployConfirmationState);
    log?.info(`[qqbot:${accountId}] Restored custom deploy confirmation state: confirmations=${Object.keys(restoredDeployConfirmationState.confirmations).length}`);
  }

  const restoredUnreadState = loadCustomUnreadState(accountId, storeOptions?.unread);
  if (restoredUnreadState) {
    runtime.unread.loadState(restoredUnreadState);
    log?.info(`[qqbot:${accountId}] Restored custom unread state: peers=${Object.keys(restoredUnreadState.peers).length}, snapshots=${Object.keys(restoredUnreadState.snapshots).length}`);
  }

  const persistAuthState = (): void => {
    saveCustomAuthorizationState(accountId, runtime.auth.getState(), storeOptions?.auth);
  };
  const persistProactiveBudgetState = (): void => {
    saveCustomProactiveBudgetState(accountId, runtime.proactiveBudget.getState(), storeOptions?.proactiveBudget);
  };
  const persistTaskState = (): void => {
    saveCustomTaskSandboxState(accountId, runtime.tasks.getState(), storeOptions?.tasks);
  };
  const persistPollState = (): void => {
    saveCustomPollState(accountId, runtime.polls.getState(), storeOptions?.polls);
  };
  const persistGameState = (): void => {
    saveCustomGameState(accountId, runtime.games.getState(), storeOptions?.games);
  };
  const persistDeployConfirmationState = (): void => {
    saveCustomDeployConfirmationState(accountId, runtime.deployConfirmations.getState(), storeOptions?.deployConfirmations);
  };
  const persistUnreadState = (): void => {
    saveCustomUnreadState(accountId, runtime.unread.getState(), storeOptions?.unread);
  };

  return {
    runtime,
    restoredAuthIntents,
    persistAuthState,
    persistProactiveBudgetState,
    persistTaskState,
    persistPollState,
    persistGameState,
    persistDeployConfirmationState,
    persistUnreadState,
    persistAllState: () => {
      persistAuthState();
      persistProactiveBudgetState();
      persistTaskState();
      persistPollState();
      persistGameState();
      persistDeployConfirmationState();
      persistUnreadState();
    },
  };
}
