import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomTaskSandboxRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomTaskSandboxStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomTaskSandboxRuntimeState;
}

export interface CustomTaskSandboxStoreOptions {
  dir?: string;
}

export function getCustomTaskSandboxStatePath(accountId: string, options?: CustomTaskSandboxStoreOptions): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultTaskStateDir(), `tasks-${safeAccountId}.json`);
}

export function loadCustomTaskSandboxState(
  accountId: string,
  options?: CustomTaskSandboxStoreOptions,
): CustomTaskSandboxRuntimeState | null {
  const filePath = getCustomTaskSandboxStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomTaskSandboxStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) return null;
    return normalizeTaskState(doc.state);
  } catch (err) {
    console.error(`[custom-task-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomTaskSandboxState(
  accountId: string,
  state: CustomTaskSandboxRuntimeState,
  options?: CustomTaskSandboxStoreOptions,
): boolean {
  const filePath = getCustomTaskSandboxStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomTaskSandboxStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizeTaskState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-task-store] Failed to save state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizeTaskState(state: CustomTaskSandboxRuntimeState): CustomTaskSandboxRuntimeState {
  return {
    tasks: { ...(state.tasks ?? {}) },
  };
}

function getDefaultTaskStateDir(): string {
  return getQQBotDataDir("data", "custom-tasks");
}
