import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomUnreadRuntimeState } from "./unread-runtime.js";

const STORE_VERSION = 1;

export interface CustomUnreadStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomUnreadRuntimeState;
}

export interface CustomUnreadStoreOptions {
  dir?: string;
}

export function getCustomUnreadStatePath(accountId: string, options?: CustomUnreadStoreOptions): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultUnreadStateDir(), `unread-${safeAccountId}.json`);
}

export function loadCustomUnreadState(
  accountId: string,
  options?: CustomUnreadStoreOptions,
): CustomUnreadRuntimeState | null {
  const filePath = getCustomUnreadStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomUnreadStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) return null;
    return normalizeUnreadState(doc.state);
  } catch (err) {
    console.error(`[custom-unread-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomUnreadState(
  accountId: string,
  state: CustomUnreadRuntimeState,
  options?: CustomUnreadStoreOptions,
): boolean {
  const filePath = getCustomUnreadStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomUnreadStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizeUnreadState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-unread-store] Failed to save state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizeUnreadState(state: CustomUnreadRuntimeState): CustomUnreadRuntimeState {
  return {
    peers: { ...(state.peers ?? {}) },
    snapshots: { ...(state.snapshots ?? {}) },
  };
}

function getDefaultUnreadStateDir(): string {
  return getQQBotDataDir("data", "custom-unread");
}
