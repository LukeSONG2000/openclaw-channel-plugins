import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { CustomDeployConfirmation } from "./types.js";
import { slashCommandInput } from "./command-link.js";
import { formatDeployStatusForDisplay } from "./presentation-labels.js";

export function buildCustomDeployConfirmationKeyboard(confirmation: CustomDeployConfirmation): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            makeDeployButton({
              id: "confirm",
              label: "确认",
              visitedLabel: "已确认",
              data: `custom-deploy:${confirmation.id}:confirm`,
              style: 1,
            }),
            makeDeployButton({
              id: "cancel",
              label: "取消",
              visitedLabel: "已取消",
              data: `custom-deploy:${confirmation.id}:cancel`,
              style: 3,
            }),
          ],
        },
      ],
    },
  };
}

export function formatCustomDeployHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🚀 自定义部署确认命令`,
    ``,
    slashCommandInput(`/bot-deploy confirm /bot-upgrade --latest`),
    slashCommandInput(`/bot-deploy confirm /bot-upgrade --version <version>`),
    slashCommandInput(`/bot-deploy list`),
    slashCommandInput(`/bot-deploy status <confirmationId>`),
    slashCommandInput(`/bot-deploy preflight`),
    ``,
    `当前只创建确认卡，不自动执行升级。确认后仍需管理员手动发送确认中的升级命令。`,
  );
  return lines.join("\n");
}

export function formatDeployConfirmationCreated(confirmation: CustomDeployConfirmation): string {
  return [
    `🚀 部署确认已创建`,
    ``,
    `确认：${confirmation.id}`,
    `命令：${slashCommandInput(confirmation.command)}`,
    `发起人：${confirmation.creator.label || confirmation.creator.id}`,
    `过期：${formatExpiresIn(confirmation.expiresAt)}`,
    ``,
    `点击确认只会记录确认状态，不会自动执行热更新。`,
    `确认后请在管理员私聊中手动发送：${slashCommandInput(confirmation.command)}`,
  ].join("\n");
}

export function formatDeployConfirmationList(confirmations: CustomDeployConfirmation[]): string {
  if (confirmations.length === 0) return "🚀 当前会话暂无部署确认。";
  const lines = ["🚀 当前会话部署确认", ""];
  for (const confirmation of confirmations) {
    lines.push(`- ${confirmation.id} [${formatDeployStatusForDisplay(confirmation.status)}] ${slashCommandInput(confirmation.command)}`);
  }
  return lines.join("\n");
}

export function formatDeployConfirmationStatus(confirmation: CustomDeployConfirmation, now?: number): string {
  return [
    `🚀 部署确认状态`,
    ``,
    `确认：${confirmation.id}`,
    `状态：${formatDeployStatusForDisplay(confirmation.status)}`,
    `命令：${slashCommandInput(confirmation.command)}`,
    `发起人：${confirmation.creator.label || confirmation.creator.id}`,
    `过期：${formatExpiresIn(confirmation.expiresAt, now)}`,
    ...(confirmation.resolvedBy ? [`处理人：${confirmation.resolvedBy.label || confirmation.resolvedBy.id}`] : []),
  ].join("\n");
}

export function formatDeployConfirmationResolved(confirmation: CustomDeployConfirmation, reason: string): string {
  if (reason === "expired") {
    return [
      `⚠️ 部署确认已过期`,
      ``,
      `确认：${confirmation.id}`,
      `命令：${slashCommandInput(confirmation.command)}`,
    ].join("\n");
  }
  if (reason === "not_pending") {
    return [
      `⚠️ 部署确认已处理`,
      ``,
      `确认：${confirmation.id}`,
      `状态：${formatDeployStatusForDisplay(confirmation.status)}`,
      `命令：${slashCommandInput(confirmation.command)}`,
    ].join("\n");
  }
  if (confirmation.status === "confirmed") {
    return [
      `✅ 已确认部署操作`,
      ``,
      `确认：${confirmation.id}`,
      `命令：${slashCommandInput(confirmation.command)}`,
      ``,
      `安全起见，本卡片不会自动执行热更新。`,
      `请管理员在私聊中手动发送该命令，并确保已完成服务器备份。`,
    ].join("\n");
  }
  if (confirmation.status === "cancelled") {
    return [
      `✅ 已取消部署操作`,
      ``,
      `确认：${confirmation.id}`,
      `命令：${slashCommandInput(confirmation.command)}`,
    ].join("\n");
  }
  return formatDeployDecision(reason);
}

export function formatDeployDecision(reason: string): string {
  if (reason === "invalid_command") return `⚠️ 当前只支持确认 ${slashCommandInput("/bot-upgrade --latest", "/bot-upgrade")} 的带参数命令。`;
  if (reason === "not_found") return "⚠️ 部署确认不存在。";
  if (reason === "not_pending") return "⚠️ 部署确认已处理。";
  if (reason === "expired") return "⚠️ 部署确认已过期。";
  return `⚠️ 操作失败：${reason}`;
}

function makeDeployButton(params: {
  id: string;
  label: string;
  visitedLabel: string;
  data: string;
  style: 0 | 1 | 3;
}): KeyboardButton {
  return {
    id: `deploy_${params.id}`,
    render_data: { label: params.label, visited_label: params.visitedLabel, style: params.style },
    action: {
      type: 1,
      data: params.data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "custom-deploy",
  };
}

function formatExpiresIn(expiresAt: number, now: number = Date.now()): string {
  return `${Math.max(0, Math.ceil((expiresAt - now) / 1000))} 秒后`;
}
