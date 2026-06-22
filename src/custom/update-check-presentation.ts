import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { resolveCustomAdminGroupKey } from "./auth.js";
import type { CustomUpdateCheckResult } from "./update-check.js";
import type { CustomRuntimeConfig } from "./types.js";

export interface CustomUpdateAvailableNotification {
  groupOpenid: string;
  text: string;
  keyboard: InlineKeyboard;
  packageName: string;
  latest: string;
  current?: string;
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
    `建议先运行聊天内预检：/bot-deploy preflight`,
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

export function buildCustomUpdateAvailableKeyboard(): InlineKeyboard {
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
            makeUpdateCommandButton("deploy_preflight", "部署预检", "/bot-deploy preflight", true, 1),
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

function resultIsNotifiable(result: CustomUpdateCheckResult): boolean {
  return result.status === "update-available" && Boolean(result.latest);
}

function parseAdminGroupOpenid(raw?: string): string | undefined {
  const key = resolveCustomAdminGroupKey(raw);
  if (!key?.startsWith("qqbot:group:")) return undefined;
  const groupOpenid = key.slice("qqbot:group:".length).trim();
  return groupOpenid || undefined;
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
