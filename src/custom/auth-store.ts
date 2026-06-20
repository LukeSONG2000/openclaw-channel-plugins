import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomAuthorizationRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomAuthorizationStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomAuthorizationRuntimeState;
}

export interface CustomAuthorizationStoreOptions {
  dir?: string;
}

export function getCustomAuthorizationStatePath(
  accountId: string,
  options?: CustomAuthorizationStoreOptions,
): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultAuthorizationStateDir(), `auth-${safeAccountId}.json`);
}

export function loadCustomAuthorizationState(
  accountId: string,
  options?: CustomAuthorizationStoreOptions,
): CustomAuthorizationRuntimeState | null {
  const filePath = getCustomAuthorizationStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomAuthorizationStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) {
      return null;
    }
    return normalizeAuthorizationState(doc.state);
  } catch (err) {
    console.error(`[custom-auth-store] Failed to load auth state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomAuthorizationState(
  accountId: string,
  state: CustomAuthorizationRuntimeState,
  options?: CustomAuthorizationStoreOptions,
): boolean {
  const filePath = getCustomAuthorizationStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomAuthorizationStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizeAuthorizationState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-auth-store] Failed to save auth state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizeAuthorizationState(state: CustomAuthorizationRuntimeState): CustomAuthorizationRuntimeState {
  return {
    grants: { ...(state.grants ?? {}) },
    requests: { ...(state.requests ?? {}) },
  };
}

function getDefaultAuthorizationStateDir(): string {
  return getQQBotDataDir("data", "custom-auth");
}
