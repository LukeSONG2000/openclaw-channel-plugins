import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomProactiveBudgetRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomProactiveBudgetStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomProactiveBudgetRuntimeState;
}

export interface CustomProactiveBudgetStoreOptions {
  dir?: string;
}

export function getCustomProactiveBudgetStatePath(
  accountId: string,
  options?: CustomProactiveBudgetStoreOptions,
): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultBudgetStateDir(), `budget-${safeAccountId}.json`);
}

export function loadCustomProactiveBudgetState(
  accountId: string,
  options?: CustomProactiveBudgetStoreOptions,
): CustomProactiveBudgetRuntimeState | null {
  const filePath = getCustomProactiveBudgetStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomProactiveBudgetStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) {
      return null;
    }
    return normalizeBudgetState(doc.state);
  } catch (err) {
    console.error(`[custom-proactive-budget-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomProactiveBudgetState(
  accountId: string,
  state: CustomProactiveBudgetRuntimeState,
  options?: CustomProactiveBudgetStoreOptions,
): boolean {
  const filePath = getCustomProactiveBudgetStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomProactiveBudgetStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizeBudgetState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-proactive-budget-store] Failed to save state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizeBudgetState(state: CustomProactiveBudgetRuntimeState): CustomProactiveBudgetRuntimeState {
  return {
    entries: { ...(state.entries ?? {}) },
    acceptance: { ...(state.acceptance ?? {}) },
  };
}

function getDefaultBudgetStateDir(): string {
  return getQQBotDataDir("data", "custom-proactive-budget");
}
