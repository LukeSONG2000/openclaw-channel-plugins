import type { CustomTaskNotificationAudience } from "./task-notification-adapter.js";
import type { CustomTaskCommandExecutorConfig } from "./types.js";

export const CUSTOM_TASK_COMMAND_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const CUSTOM_TASK_COMMAND_DEFAULT_MAX_OUTPUT_CHARS = 6000;
export const CUSTOM_TASK_COMMAND_DEFAULT_NOTIFY_AUDIENCES: CustomTaskNotificationAudience[] = ["peer"];

export interface CustomTaskCommandExecutorResolvedConfig {
  enabled: boolean;
  command?: string;
  args: string[];
  cwd?: string;
  forwardRequirementsToStdin: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  notifyAudiences: CustomTaskNotificationAudience[];
}

export function resolveCustomTaskCommandExecutorConfig(
  config?: CustomTaskCommandExecutorConfig,
): CustomTaskCommandExecutorResolvedConfig {
  const timeoutMs = positiveInt(config?.timeoutMs, CUSTOM_TASK_COMMAND_DEFAULT_TIMEOUT_MS);
  const maxOutputChars = positiveInt(config?.maxOutputChars, CUSTOM_TASK_COMMAND_DEFAULT_MAX_OUTPUT_CHARS);
  return {
    enabled: config?.enabled === true,
    command: typeof config?.command === "string" && config.command.trim() ? config.command.trim() : undefined,
    args: Array.isArray(config?.args) ? config.args.map(String) : [],
    cwd: typeof config?.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : undefined,
    forwardRequirementsToStdin: config?.forwardRequirementsToStdin === true,
    timeoutMs,
    maxOutputChars,
    notifyAudiences: normalizeNotifyAudiences(config?.notifyAudiences),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeNotifyAudiences(value: unknown): CustomTaskNotificationAudience[] {
  if (!Array.isArray(value) || value.length === 0) return CUSTOM_TASK_COMMAND_DEFAULT_NOTIFY_AUDIENCES.slice();
  const seen = new Set<CustomTaskNotificationAudience>();
  const result: CustomTaskNotificationAudience[] = [];
  for (const item of value) {
    if (item !== "peer" && item !== "owner") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.length ? result : CUSTOM_TASK_COMMAND_DEFAULT_NOTIFY_AUDIENCES.slice();
}
