import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomGameRuntimeState } from "./types.js";

const STORE_VERSION = 1;

export interface CustomGameStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  state: CustomGameRuntimeState;
}

export interface CustomGameStoreOptions {
  dir?: string;
}

export function getCustomGameStatePath(accountId: string, options?: CustomGameStoreOptions): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultGameStateDir(), `games-${safeAccountId}.json`);
}

export function loadCustomGameState(
  accountId: string,
  options?: CustomGameStoreOptions,
): CustomGameRuntimeState | null {
  const filePath = getCustomGameStatePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomGameStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !doc.state) return null;
    return normalizeGameState(doc.state);
  } catch (err) {
    console.error(`[custom-game-store] Failed to load state for ${accountId}: ${err}`);
    return null;
  }
}

export function saveCustomGameState(
  accountId: string,
  state: CustomGameRuntimeState,
  options?: CustomGameStoreOptions,
): boolean {
  const filePath = getCustomGameStatePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomGameStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    state: normalizeGameState(state),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-game-store] Failed to save state for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

function normalizeGameState(state: CustomGameRuntimeState): CustomGameRuntimeState {
  return {
    guessGames: { ...(state.guessGames ?? {}) },
  };
}

function getDefaultGameStateDir(): string {
  return getQQBotDataDir("data", "custom-games");
}
