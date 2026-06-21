import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "../utils/platform.js";
import type { CustomFallbackEvent } from "./fallbacks.js";

const STORE_VERSION = 1;
export const DEFAULT_CUSTOM_FALLBACK_EVENT_LIMIT = 100;

export interface CustomFallbackEventStoreDocument {
  version: number;
  accountId: string;
  savedAt: number;
  events: CustomFallbackEvent[];
}

export interface CustomFallbackEventStoreOptions {
  dir?: string;
  limit?: number;
}

export function getCustomFallbackEventStorePath(
  accountId: string,
  options?: CustomFallbackEventStoreOptions,
): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(options?.dir ?? getDefaultFallbackEventDir(), `events-${safeAccountId}.json`);
}

export function loadCustomFallbackEvents(
  accountId: string,
  options?: CustomFallbackEventStoreOptions,
): CustomFallbackEvent[] {
  const filePath = getCustomFallbackEventStorePath(accountId, options);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = JSON.parse(raw) as Partial<CustomFallbackEventStoreDocument>;
    if (doc.version !== STORE_VERSION || doc.accountId !== accountId || !Array.isArray(doc.events)) {
      return [];
    }
    return trimFallbackEvents(doc.events, options?.limit, accountId);
  } catch (err) {
    console.error(`[custom-fallback-event-store] Failed to load events for ${accountId}: ${err}`);
    return [];
  }
}

export function saveCustomFallbackEvents(
  accountId: string,
  events: readonly CustomFallbackEvent[],
  options?: CustomFallbackEventStoreOptions,
): boolean {
  const filePath = getCustomFallbackEventStorePath(accountId, options);
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const doc: CustomFallbackEventStoreDocument = {
    version: STORE_VERSION,
    accountId,
    savedAt: Date.now(),
    events: trimFallbackEvents(events, options?.limit, accountId),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[custom-fallback-event-store] Failed to save events for ${accountId}: ${err}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    return false;
  }
}

export function appendCustomFallbackEvent(
  accountId: string,
  event: CustomFallbackEvent,
  options?: CustomFallbackEventStoreOptions,
): boolean {
  const events = loadCustomFallbackEvents(accountId, options);
  events.push(event);
  return saveCustomFallbackEvents(accountId, events, options);
}

function trimFallbackEvents(
  events: readonly CustomFallbackEvent[],
  rawLimit?: number,
  accountId?: string,
): CustomFallbackEvent[] {
  const limit = normalizeLimit(rawLimit);
  return events
    .filter((event) =>
      event?.type === "custom-fallback"
      && typeof event.accountId === "string"
      && (!accountId || event.accountId === accountId)
    )
    .slice(-limit);
}

function normalizeLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_CUSTOM_FALLBACK_EVENT_LIMIT;
  }
  return Math.max(1, Math.floor(raw));
}

function getDefaultFallbackEventDir(): string {
  return getQQBotDataDir("data", "custom-fallback-events");
}
