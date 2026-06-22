import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { CustomDeployPreflightFinding, CustomDeployPreflightSummary } from "./deploy-preflight.js";

export function formatCustomDeployPreflightSummary(summary: CustomDeployPreflightSummary): string {
  const lines = [
    "🛡️ QQBot 二开部署预检（只读）",
    "",
    `结论：${summary.ok ? "无阻断项" : `发现 ${summary.blockers} 个阻断项`}${summary.warnings ? `，${summary.warnings} 个警告` : ""}`,
    `管理员：${summary.admins.length ? summary.admins.join(", ") : "未绑定"}`,
    `管理群：${summary.adminGroup ?? "未绑定"}`,
    `customRuntime.enabled：${summary.customRuntimeEnabled ? "true" : "false"}`,
    `升级检查包：${summary.upgradePkg || "未解析"}`,
    "",
  ];
  appendFindings(lines, "阻断项", summary.findings.filter((finding) => finding.severity === "blocker"));
  appendFindings(lines, "警告", summary.findings.filter((finding) => finding.severity === "warning"));
  appendFindings(lines, "提示", summary.findings.filter((finding) => finding.severity === "info"));
  lines.push(
    "建议：",
    "- 阻断项清零后再创建 /bot-deploy confirm 确认卡。",
    "- 真正部署前仍需在服务器运行脚本版 preflight，并完成备份。",
  );
  return lines.join("\n");
}

export function buildCustomDeployPreflightKeyboard(summary: CustomDeployPreflightSummary): InlineKeyboard {
  const rows: Array<{ buttons: KeyboardButton[] }> = [
    {
      buttons: [
        makePreflightCommandButton("refresh", "刷新预检", "/bot-deploy preflight", true, 1),
        makePreflightCommandButton("version", "查看版本", "/bot-version", true, 1),
      ],
    },
  ];
  if (summary.ok) {
    rows.push({
      buttons: [
        makePreflightCommandButton("confirm_latest", "创建确认卡", "/bot-deploy confirm /bot-upgrade --latest", true, 1),
      ],
    });
  } else {
    rows.push({
      buttons: [
        makePreflightCommandButton("auth_status", "授权状态", "/bot-auth status", true, 0),
        makePreflightCommandButton("scene_bindings", "场景绑定", "/bot-scene bindings", true, 0),
      ],
    });
  }
  return { content: { rows } };
}

function appendFindings(lines: string[], title: string, findings: CustomDeployPreflightFinding[]): void {
  lines.push(`${title}：`);
  if (!findings.length) {
    lines.push("- 无", "");
    return;
  }
  for (const finding of findings) {
    lines.push(`- [${finding.code}] ${finding.message}`);
  }
  lines.push("");
}

function makePreflightCommandButton(
  id: string,
  label: string,
  command: string,
  enter: boolean,
  style: 0 | 1 | 3,
): KeyboardButton {
  return {
    id: `deploy_preflight_${id}`,
    render_data: { label, visited_label: label, style },
    action: {
      type: 2,
      data: command,
      enter,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: "custom-deploy-preflight",
  };
}
