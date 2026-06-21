import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizeCustomRuntimeAdminGroup, normalizeCustomRuntimeAdminList } from "./config.js";

export type CustomDeployPreflightSeverity = "blocker" | "warning" | "info";

export interface CustomDeployPreflightFinding {
  severity: CustomDeployPreflightSeverity;
  code: string;
  message: string;
}

export interface CustomDeployPreflightSummary {
  ok: boolean;
  blockers: number;
  warnings: number;
  infos: number;
  admins: string[];
  adminGroup?: string;
  customRuntimeEnabled: boolean;
  upgradePkg: string;
  findings: CustomDeployPreflightFinding[];
}

const PERSONAL_PACKAGE = "@lukesong/openclaw-qqbot";
const PERSONAL_PACKAGE_REFS = new Set(["@lukesong/openclaw-qqbot", "lukesong/openclaw-qqbot"]);
const OFFICIAL_PACKAGE_REFS = new Set([
  "@tencent-connect/openclaw-qqbot",
  "tencent-connect/openclaw-qqbot",
  "@tencent-connect/qqbot",
  "tencent-connect/qqbot",
  "@sliverp/qqbot",
  "sliverp/qqbot",
]);
const DESIRED_PLUGIN_ID = "openclaw-qqbot";
const LEGACY_QQBOT_PLUGIN_IDS = new Set([
  "qqbot",
  "openclaw-qq",
  "@sliverp/qqbot",
  "@tencent-connect/qqbot",
  "@tencent-connect/openclaw-qq",
  "@tencent-connect/openclaw-qqbot",
]);

export function buildCustomDeployPreflightSummary(cfg: OpenClawConfig): CustomDeployPreflightSummary {
  const findings: CustomDeployPreflightFinding[] = [];
  const channels = objectOrEmpty((cfg as Record<string, unknown>).channels);
  const qqbot = objectOrEmpty(channels.qqbot);
  const runtime = objectOrEmpty(qqbot.customRuntime);
  const admins = normalizeCustomRuntimeAdminList(runtime.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(runtime.adminGroup);
  const customRuntimeEnabled = runtime.enabled === true;

  if (!channels.qqbot) {
    findings.push(blocker("missing_qqbot_channel", "缺少 channels.qqbot 配置，无法确认二开 QQBot 槽位。"));
  }
  if (!hasQQBotCredentials(qqbot)) {
    findings.push(blocker("qqbot_credentials_missing", "当前配置对象里未发现 QQBot AppID/ClientSecret。"));
  }
  if (admins.length === 0) {
    findings.push(blocker("custom_runtime_admins_missing", "未绑定 customRuntime.admins。"));
  }
  if (!adminGroup) {
    findings.push(blocker("custom_runtime_admin_group_missing", "未绑定 customRuntime.adminGroup。"));
  }
  if (!customRuntimeEnabled) {
    findings.push(warning("custom_runtime_disabled", "customRuntime.enabled 不是 true，二开消息流/鉴权/场景不会生效。"));
  }
  if (adminGroup && !objectOrEmpty(runtime.scenes)[adminGroup]) {
    findings.push(warning("admin_group_scene_missing", "管理群没有显式 scene 绑定，建议绑定 system-admin。"));
  }

  const upgradePkgRaw = stringOrUndefined(qqbot.upgradePkg) || PERSONAL_PACKAGE;
  const upgradeKind = classifyPackageRef(upgradePkgRaw);
  if (upgradeKind === "official") {
    findings.push(blocker("official_upgrade_package", `upgradePkg 指向官方包：${upgradePkgRaw}`));
  } else if (upgradeKind === "unknown") {
    findings.push(warning("unknown_upgrade_package", `upgradePkg 不是已知个人包：${upgradePkgRaw}`));
  }
  if (qqbot.allowUpgradePkgOverride === true) {
    findings.push(warning("upgrade_pkg_override_enabled", "allowUpgradePkgOverride=true，生产实例建议关闭。"));
  }
  if (qqbot.upgradeMode === "hot-reload") {
    findings.push(warning("hot_reload_enabled", "upgradeMode=hot-reload，执行升级前必须确认已备份。"));
  }

  const customUpdateCheck = objectOrUndefined(qqbot.customUpdateCheck);
  if (!customUpdateCheck) {
    findings.push(warning("custom_update_check_missing", "未配置 customUpdateCheck，实例不会主动发现个人二开版本更新。"));
  } else if (customUpdateCheck.enabled === false) {
    findings.push(warning("custom_update_check_disabled", "customUpdateCheck.enabled=false。"));
  }

  findings.push(...inspectPluginConfig(objectOrEmpty((cfg as Record<string, unknown>).plugins)));
  if (!findings.some((finding) => finding.severity === "blocker")) {
    findings.push(info("preflight_read_only", "这是聊天内只读预检；不安装、不重启、不删除、不访问服务器文件。"));
  }

  const blockers = findings.filter((finding) => finding.severity === "blocker").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const infos = findings.filter((finding) => finding.severity === "info").length;
  return {
    ok: blockers === 0,
    blockers,
    warnings,
    infos,
    admins,
    adminGroup,
    customRuntimeEnabled,
    upgradePkg: normalizePackageName(upgradePkgRaw),
    findings,
  };
}

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

function inspectPluginConfig(plugins: Record<string, unknown>): CustomDeployPreflightFinding[] {
  const findings: CustomDeployPreflightFinding[] = [];
  const entries = objectOrEmpty(plugins.entries);
  const installs = objectOrEmpty(plugins.installs);
  const allow = Array.isArray(plugins.allow) ? plugins.allow.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  const activeIds = unique([
    ...Object.keys(entries).filter(isQQBotLikePluginId),
    ...Object.keys(installs).filter(isQQBotLikePluginId),
  ]);
  if (activeIds.length > 1) {
    findings.push(blocker("multiple_qqbot_plugins_configured", `配置中存在多个 QQBot-like 插件：${activeIds.join(", ")}`));
  }
  for (const id of activeIds) {
    if (LEGACY_QQBOT_PLUGIN_IDS.has(id.toLowerCase())) {
      findings.push(blocker("legacy_qqbot_plugin_active", `旧/官方 QQBot 插件仍处于 active 配置：${id}`));
    }
  }
  for (const id of allow) {
    if (LEGACY_QQBOT_PLUGIN_IDS.has(id.toLowerCase())) {
      findings.push(warning("legacy_qqbot_plugin_allowed", `plugins.allow 仍允许旧/官方 QQBot 插件：${id}`));
    }
  }
  for (const [id, value] of Object.entries(installs)) {
    if (!isQQBotLikePluginId(id)) continue;
    const kind = classifyPackageRef(value);
    if (kind === "official") {
      findings.push(blocker("official_qqbot_package_source", `plugins.installs.${id} 指向官方 QQBot 包。`));
    } else if (id === DESIRED_PLUGIN_ID && kind === "unknown") {
      findings.push(warning("unknown_qqbot_package_source", `plugins.installs.${id} 的来源不是已知个人包或本地路径。`));
    }
  }
  if (activeIds.length > 0 && !activeIds.includes(DESIRED_PLUGIN_ID)) {
    findings.push(warning("custom_plugin_entry_missing", `active QQBot 插件不是 ${DESIRED_PLUGIN_ID}。`));
  }
  return findings;
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

function hasQQBotCredentials(qqbot: Record<string, unknown>): boolean {
  if (stringOrUndefined(qqbot.appId) && (stringOrUndefined(qqbot.clientSecret) || stringOrUndefined(qqbot.clientSecretFile))) {
    return true;
  }
  const accounts = objectOrEmpty(qqbot.accounts);
  return Object.values(accounts).some((raw) => {
    const account = objectOrEmpty(raw);
    return account.enabled !== false
      && Boolean(stringOrUndefined(account.appId) && (stringOrUndefined(account.clientSecret) || stringOrUndefined(account.clientSecretFile)));
  });
}

function classifyPackageRef(raw: unknown): "personal" | "official" | "path-or-custom" | "unknown" {
  const text = stringifyRef(raw);
  const normalized = normalizePackageName(text);
  if (PERSONAL_PACKAGE_REFS.has(normalized) || /github(?:\.com)?[:/]LukeSONG2000\/openclaw-qqbot/i.test(text)) return "personal";
  if (OFFICIAL_PACKAGE_REFS.has(normalized) || /tencent-connect\/openclaw-qqbot/i.test(text) || /tencent-connect\/qqbot/i.test(text)) return "official";
  if (/^(?:\.{1,2}\/|\/|file:)/.test(text) || /source["']?\s*:\s*["']?path/i.test(text)) return "path-or-custom";
  return "unknown";
}

function normalizePackageName(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const cleaned = text.replace(/^npm:/i, "").replace(/^package:/i, "").trim();
  const direct = cleaned.match(/^(@?[\w.-]+\/[\w.-]+)(?:@[^/\s]+)?$/);
  if (direct) {
    const name = direct[1]!.toLowerCase();
    return name.startsWith("@") ? name : `@${name}`;
  }
  const scoped = cleaned.match(/(@[\w.-]+\/[\w.-]+)/);
  return scoped ? scoped[1]!.toLowerCase() : cleaned.toLowerCase();
}

function isQQBotLikePluginId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized === DESIRED_PLUGIN_ID || LEGACY_QQBOT_PLUGIN_IDS.has(normalized) || normalized.includes("qqbot") || normalized.includes("openclaw-qq");
}

function blocker(code: string, message: string): CustomDeployPreflightFinding {
  return { severity: "blocker", code, message };
}

function warning(code: string, message: string): CustomDeployPreflightFinding {
  return { severity: "warning", code, message };
}

function info(code: string, message: string): CustomDeployPreflightFinding {
  return { severity: "info", code, message };
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return objectOrUndefined(value) ?? {};
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function stringifyRef(value: unknown): string {
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
