import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomScheduledTaskRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomScheduledTaskStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomScheduledTaskRuntimeState;
}

export interface CustomScheduledTaskStoreOptions {
  dir?: string;
}

export function getCustomScheduledTaskStatePath(accountId: string, options?: CustomScheduledTaskStoreOptions): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getQQBotDataDir("data", "custom-scheduled-tasks"), `scheduled-tasks-${safeAccountId}.json`);
}

export function loadCustomScheduledTaskState(accountId: string, options?: CustomScheduledTaskStoreOptions): CustomScheduledTaskRuntimeState | null {
  const filePath = getCustomScheduledTaskStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CustomScheduledTaskStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) return null;
    return { tasks: { ...(doc.state.tasks ?? {}) } };
  } catch (err) {
    console.error(`[custom-scheduled-task-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomScheduledTaskState(accountId: string, state: CustomScheduledTaskRuntimeState, options?: CustomScheduledTaskStoreOptions): boolean {
  const filePath = getCustomScheduledTaskStatePath(accountId, options);
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify({ version: STORE_VERSION, accountId, savedAt: Date.now(), state: { tasks: { ...(state.tasks ?? {}) } } }, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-scheduled-task-store] Failed to save state for ${accountId}: ${err}`);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}
