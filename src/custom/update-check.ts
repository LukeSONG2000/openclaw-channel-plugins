import type { QQBotAccountConfig } from "../types.js";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { resolveCustomAdminGroupKey } from "./auth.js";
import type { CustomRuntimeConfig } from "./types.js";
import {
  getUpdateInfo,
  resolveConfiguredUpgradePackage,
  type UpdateInfo,
} from "../update-checker.js";

export const DEFAULT_CUSTOM_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MIN_CUSTOM_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface ResolvedCustomUpdateCheckConfig {
  enabled: boolean;
  packageName: string;
  intervalMs: number;
}

export type CustomUpdateCheckStatus =
  | "disabled"
  | "up-to-date"
  | "update-available"
  | "error";

export interface CustomUpdateCheckResult {
  status: CustomUpdateCheckStatus;
  packageName: string;
  current?: string;
  latest?: string | null;
  stable?: string | null;
  alpha?: string | null;
  checkedAt: number;
  error?: string;
}

export interface CustomUpdateCheckController {
  checkNow: () => Promise<CustomUpdateCheckResult>;
  stop: () => void;
  getLastResult: () => CustomUpdateCheckResult | null;
}

export interface CustomUpdateAvailableNotification {
  groupOpenid: string;
  text: string;
  keyboard: InlineKeyboard;
  packageName: string;
  latest: string;
  current?: string;
}

type CustomUpdateCheckLog = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

type FetchUpdateInfo = (pkgName: string) => Promise<UpdateInfo>;

export function resolveCustomUpdateCheckConfig(
  accountConfig?: QQBotAccountConfig | null,
): ResolvedCustomUpdateCheckConfig {
  const raw = accountConfig?.customUpdateCheck;
  const intervalMs = normalizeIntervalMs(raw?.intervalMs);
  return {
    enabled: raw?.enabled !== false,
    packageName: resolveConfiguredUpgradePackage(accountConfig),
    intervalMs,
  };
}

export function buildCustomUpdateAvailableNotification(params: {
  accountId: string;
  runtime: CustomRuntimeConfig;
  result: CustomUpdateCheckResult;
  now?: number;
}): CustomUpdateAvailableNotification | null {
  if (params.runtime.enabled !== true) return null;
  if (resultIsNotifiable(params.result) === false) return null;
  const groupOpenid = parseAdminGroupOpenid(params.runtime.adminGroup);
  if (!groupOpenid) return null;
  const checkedAt = params.result.checkedAt || params.now || Date.now();
  const text = [
    `🆕 QQBot 二开版本更新可用`,
    ``,
    `账号：${params.accountId}`,
    `包：${params.result.packageName}`,
    ...(params.result.current ? [`当前：v${params.result.current}`] : []),
    `最新：v${params.result.latest}`,
    `检查时间：${new Date(checkedAt).toISOString()}`,
    ``,
    `不会自动安装。请先查看更新内容并确认服务器已备份。`,
    `如需继续，可由管理员在管理群创建确认卡：/bot-deploy confirm /bot-upgrade --latest`,
    `确认后仍需管理员在私聊中手动发送 /bot-upgrade --latest。`,
  ].join("\n");
  return {
    groupOpenid,
    text,
    keyboard: buildCustomUpdateAvailableKeyboard(),
    packageName: params.result.packageName,
    latest: params.result.latest!,
    current: params.result.current,
  };
}

export async function runCustomUpdateCheck(params: {
  accountId: string;
  accountConfig?: QQBotAccountConfig | null;
  log?: CustomUpdateCheckLog;
  fetchUpdateInfo?: FetchUpdateInfo;
  now?: () => number;
}): Promise<CustomUpdateCheckResult> {
  const resolved = resolveCustomUpdateCheckConfig(params.accountConfig);
  const now = params.now ?? Date.now;
  if (!resolved.enabled) {
    const result: CustomUpdateCheckResult = {
      status: "disabled",
      packageName: resolved.packageName,
      checkedAt: now(),
    };
    params.log?.debug?.(`[qqbot:${params.accountId}] custom update check disabled`);
    return result;
  }

  const fetchUpdateInfo = params.fetchUpdateInfo ?? getUpdateInfo;
  let result: CustomUpdateCheckResult;
  try {
    const info = await fetchUpdateInfo(resolved.packageName);
    result = resultFromUpdateInfo(info);
  } catch (err) {
    result = {
      status: "error",
      packageName: resolved.packageName,
      checkedAt: now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  logCustomUpdateCheckResult(params.accountId, result, params.log);
  return result;
}

export function startCustomUpdateCheckLoop(params: {
  accountId: string;
  accountConfig?: QQBotAccountConfig | null;
  log?: CustomUpdateCheckLog;
  fetchUpdateInfo?: FetchUpdateInfo;
  initialDelayMs?: number;
  onUpdateAvailable?: (result: CustomUpdateCheckResult) => void | Promise<void>;
}): CustomUpdateCheckController {
  const resolved = resolveCustomUpdateCheckConfig(params.accountConfig);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastResult: CustomUpdateCheckResult | null = null;
  let lastAnnouncedVersion: string | null = null;
  let lastNotifiedVersion: string | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    if (stopped || !resolved.enabled) return;
    timer = setTimeout(() => {
      void checkNow().finally(() => {
        if (!stopped) schedule(resolved.intervalMs);
      });
    }, Math.max(0, delayMs));
  };

  const checkNow = async (): Promise<CustomUpdateCheckResult> => {
    const result = await runCustomUpdateCheck({
      accountId: params.accountId,
      accountConfig: params.accountConfig,
      log: {
        ...params.log,
        info: (msg) => {
          if (!msg.includes("custom update available")) {
            params.log?.info?.(msg);
            return;
          }
          const version = extractLatestVersionFromMessage(msg);
          if (!version || lastAnnouncedVersion !== version) {
            lastAnnouncedVersion = version ?? lastAnnouncedVersion;
            params.log?.info?.(msg);
          } else {
            params.log?.debug?.(msg);
          }
        },
      },
      fetchUpdateInfo: params.fetchUpdateInfo,
    });
    lastResult = result;
    if (result.status === "update-available" && result.latest && lastNotifiedVersion !== result.latest) {
      lastNotifiedVersion = result.latest;
      try {
        await params.onUpdateAvailable?.(result);
      } catch (err) {
        params.log?.error?.(`[qqbot:${params.accountId}] custom update available notification failed: ${err}`);
      }
    }
    if (result.status === "update-available" && result.latest) {
      lastAnnouncedVersion = result.latest;
    }
    return result;
  };

  if (!resolved.enabled) {
    params.log?.info?.(`[qqbot:${params.accountId}] custom update check disabled`);
    lastResult = {
      status: "disabled",
      packageName: resolved.packageName,
      checkedAt: Date.now(),
    };
  } else {
    params.log?.info?.(
      `[qqbot:${params.accountId}] custom update check enabled: package=${resolved.packageName}, intervalMs=${resolved.intervalMs}, install=manual`,
    );
    schedule(params.initialDelayMs ?? 0);
  }

  return {
    checkNow,
    stop: () => {
      stopped = true;
      clearTimer();
    },
    getLastResult: () => lastResult,
  };
}

function normalizeIntervalMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_CUSTOM_UPDATE_CHECK_INTERVAL_MS;
  }
  return Math.max(MIN_CUSTOM_UPDATE_CHECK_INTERVAL_MS, Math.floor(raw));
}

function resultFromUpdateInfo(info: UpdateInfo): CustomUpdateCheckResult {
  if (info.error) {
    return {
      status: "error",
      packageName: info.packageName,
      current: info.current,
      latest: info.latest,
      stable: info.stable,
      alpha: info.alpha,
      checkedAt: info.checkedAt,
      error: info.error,
    };
  }
  return {
    status: info.hasUpdate ? "update-available" : "up-to-date",
    packageName: info.packageName,
    current: info.current,
    latest: info.latest,
    stable: info.stable,
    alpha: info.alpha,
    checkedAt: info.checkedAt,
  };
}

function logCustomUpdateCheckResult(
  accountId: string,
  result: CustomUpdateCheckResult,
  log?: CustomUpdateCheckLog,
): void {
  if (result.status === "update-available") {
    log?.info?.(
      `[qqbot:${accountId}] custom update available: ${result.packageName} v${result.latest} (current v${result.current}). Review /bot-upgrade before installing; no automatic install will run.`,
    );
    return;
  }
  if (result.status === "error") {
    log?.debug?.(`[qqbot:${accountId}] custom update check failed for ${result.packageName}: ${result.error}`);
    return;
  }
  if (result.status === "up-to-date") {
    log?.debug?.(`[qqbot:${accountId}] custom update check up-to-date: ${result.packageName} v${result.current}`);
  }
}

function resultIsNotifiable(result: CustomUpdateCheckResult): boolean {
  return result.status === "update-available" && Boolean(result.latest);
}

function parseAdminGroupOpenid(raw?: string): string | undefined {
  const key = resolveCustomAdminGroupKey(raw);
  if (!key?.startsWith("qqbot:group:")) return undefined;
  const groupOpenid = key.slice("qqbot:group:".length).trim();
  return groupOpenid || undefined;
}

function buildCustomUpdateAvailableKeyboard(): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            makeUpdateCommandButton("version", "查看版本", "/bot-version", true, 1),
          ],
        },
        {
          buttons: [
            makeUpdateCommandButton("deploy_confirm", "创建确认卡", "/bot-deploy confirm /bot-upgrade --latest", true, 1),
          ],
        },
      ],
    },
  };
}

function makeUpdateCommandButton(
  id: string,
  label: string,
  command: string,
  enter: boolean,
  style: 0 | 1 | 3,
): KeyboardButton {
  return {
    id: `custom_update_${id}`,
    render_data: { label, visited_label: label, style },
    action: {
      type: 2,
      data: command,
      enter,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: "custom-update-check",
  };
}

function extractLatestVersionFromMessage(message: string): string | null {
  const match = message.match(/\bv([^()\s]+)\s+\(current\b/);
  return match?.[1] ?? null;
}
