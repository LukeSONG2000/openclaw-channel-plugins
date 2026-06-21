import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomDeployConfirmationRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomDeployConfirmationStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomDeployConfirmationRuntimeState;
}

export interface CustomDeployConfirmationStoreOptions {
  dir?: string;
}

export function getCustomDeployConfirmationStatePath(
  accountId: string,
  options?: CustomDeployConfirmationStoreOptions,
): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultDeployConfirmationStateDir(), `deploy-confirmations-${safeAccountId}.json`);
}

export function loadCustomDeployConfirmationState(
  accountId: string,
  options?: CustomDeployConfirmationStoreOptions,
): CustomDeployConfirmationRuntimeState | null {
  const filePath = getCustomDeployConfirmationStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomDeployConfirmationStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) return null;
    return normalizeDeployConfirmationState(doc.state);
  } catch (err) {
    console.error(`[custom-deploy-confirmation-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomDeployConfirmationState(
  accountId: string,
  state: CustomDeployConfirmationRuntimeState,
  options?: CustomDeployConfirmationStoreOptions,
): boolean {
  const filePath = getCustomDeployConfirmationStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomDeployConfirmationStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizeDeployConfirmationState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-deploy-confirmation-store] Failed to save state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizeDeployConfirmationState(
  state: CustomDeployConfirmationRuntimeState,
): CustomDeployConfirmationRuntimeState {
  return {
    confirmations: { ...(state.confirmations ?? {}) },
  };
}

function getDefaultDeployConfirmationStateDir(): string {
  return getQQBotDataDir("data", "custom-deploy-confirmations");
}
