import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomPollRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomPollStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomPollRuntimeState;
}

export interface CustomPollStoreOptions {
  dir?: string;
}

export function getCustomPollStatePath(accountId: string, options?: CustomPollStoreOptions): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultPollStateDir(), `polls-${safeAccountId}.json`);
}

export function loadCustomPollState(
  accountId: string,
  options?: CustomPollStoreOptions,
): CustomPollRuntimeState | null {
  const filePath = getCustomPollStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomPollStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) return null;
    return normalizePollState(doc.state);
  } catch (err) {
    console.error(`[custom-poll-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomPollState(
  accountId: string,
  state: CustomPollRuntimeState,
  options?: CustomPollStoreOptions,
): boolean {
  const filePath = getCustomPollStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomPollStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizePollState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-poll-store] Failed to save state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizePollState(state: CustomPollRuntimeState): CustomPollRuntimeState {
  return {
    polls: { ...(state.polls ?? {}) },
  };
}

function getDefaultPollStateDir(): string {
  return getQQBotDataDir("data", "custom-polls");
}
