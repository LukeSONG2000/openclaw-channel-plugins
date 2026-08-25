import type { CustomPeer, CustomSandboxTask, CustomTaskSandboxRuntimeState, CustomTaskStatus } from "./types.js";

export interface CustomTaskCleanupPlanOptions {
  accountId?: string;
  peer?: CustomPeer;
  now?: number;
  olderThanMs?: number;
  statuses?: CustomTaskStatus[];
  limit?: number;
}

export interface CustomTaskCleanupPlanItem {
  taskId: string;
  status: CustomTaskStatus;
  title: string;
  workspace: string;
  updatedAt: number;
  ageMs: number;
}

export interface CustomTaskCleanupPlan {
  generatedAt: number;
  olderThanMs: number;
  statuses: CustomTaskStatus[];
  items: CustomTaskCleanupPlanItem[];
  totalEligible: number;
  truncated: boolean;
}

const DEFAULT_CLEANUP_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_LIMIT = 10;
const MAX_CLEANUP_LIMIT = 50;
const TERMINAL_TASK_STATUSES: CustomTaskStatus[] = ["completed", "failed", "cancelled"];

export function buildCustomTaskCleanupPlan(
  state: CustomTaskSandboxRuntimeState,
  options: CustomTaskCleanupPlanOptions = {},
): CustomTaskCleanupPlan {
  const now = normalizeNow(options.now);
  const olderThanMs = normalizeOlderThan(options.olderThanMs);
  const statuses = normalizeStatuses(options.statuses);
  const limit = normalizeLimit(options.limit);
  const cutoff = now - olderThanMs;
  const eligible = Object.values(state.tasks ?? {})
    .filter((task) => matchesCleanupScope(task, options.accountId, options.peer, statuses, cutoff))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const items = eligible.slice(0, limit).map((task) => ({
    taskId: task.id,
    status: task.status,
    title: task.title,
    workspace: task.workspace,
    updatedAt: task.updatedAt,
    ageMs: Math.max(0, now - task.updatedAt),
  }));
  return {
    generatedAt: now,
    olderThanMs,
    statuses,
    items,
    totalEligible: eligible.length,
    truncated: eligible.length > items.length,
  };
}

export function parseCustomTaskCleanupDuration(raw: string | undefined): number | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] ?? "d";
  const multiplier = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 60 * 60_000
          : 24 * 60 * 60_000;
  return Math.floor(amount * multiplier);
}

export function parseCustomTaskCleanupLimit(raw: string | undefined): number | null {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_CLEANUP_LIMIT) return null;
  return n;
}

export function formatCustomTaskCleanupDuration(ms: number): string {
  const value = Math.max(1, Math.floor(ms));
  const day = 24 * 60 * 60_000;
  const hour = 60 * 60_000;
  const minute = 60_000;
  if (value % day === 0) return `${value / day}d`;
  if (value % hour === 0) return `${value / hour}h`;
  if (value % minute === 0) return `${value / minute}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}

function matchesCleanupScope(
  task: CustomSandboxTask,
  accountId: string | undefined,
  peer: CustomPeer | undefined,
  statuses: CustomTaskStatus[],
  cutoff: number,
): boolean {
  if (accountId && task.accountId !== accountId) return false;
  if (peer && (task.peer.kind !== peer.kind || task.peer.id !== peer.id)) return false;
  if (!statuses.includes(task.status)) return false;
  return task.updatedAt <= cutoff;
}

function normalizeNow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeOlderThan(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_CLEANUP_OLDER_THAN_MS;
}

function normalizeStatuses(value: CustomTaskStatus[] | undefined): CustomTaskStatus[] {
  if (!Array.isArray(value) || value.length === 0) return TERMINAL_TASK_STATUSES.slice();
  const allowed = new Set(TERMINAL_TASK_STATUSES);
  const seen = new Set<CustomTaskStatus>();
  const result: CustomTaskStatus[] = [];
  for (const status of value) {
    if (!allowed.has(status) || seen.has(status)) continue;
    seen.add(status);
    result.push(status);
  }
  return result.length ? result : TERMINAL_TASK_STATUSES.slice();
}

function normalizeLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CLEANUP_LIMIT;
  return Math.min(MAX_CLEANUP_LIMIT, Math.floor(n));
}
