#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findLikelyRawQQNumericAdminIds,
  isLikelyRawQQNumericId,
  normalizeCustomRuntimeAdminGroup,
  normalizeCustomRuntimeAdminList,
} from "./apply-custom-runtime-init.mjs";

const DESIRED_PLUGIN_ID = "openclaw-qqbot";
const DESIRED_PACKAGE = "@lukesong/openclaw-qqbot";
const PERSONAL_PACKAGE_REFS = new Set([
  "@lukesong/openclaw-qqbot",
  "lukesong/openclaw-qqbot",
]);
const OFFICIAL_PACKAGE_REFS = new Set([
  "@tencent-connect/openclaw-qqbot",
  "tencent-connect/openclaw-qqbot",
  "@tencent-connect/qqbot",
  "tencent-connect/qqbot",
  "@sliverp/qqbot",
  "sliverp/qqbot",
]);
const LEGACY_QQBOT_PLUGIN_IDS = [
  "qqbot",
  "openclaw-qq",
  "@sliverp/qqbot",
  "@tencent-connect/qqbot",
  "@tencent-connect/openclaw-qq",
  "@tencent-connect/openclaw-qqbot",
];
const QQBOT_LIKE_PLUGIN_IDS = new Set([
  DESIRED_PLUGIN_ID,
  ...LEGACY_QQBOT_PLUGIN_IDS,
]);
const LEGACY_EXTENSION_DIRS = [
  "qqbot",
  "openclaw-qq",
];
const OFFICIAL_NODE_MODULE_DIRS = [
  ["@tencent-connect", "openclaw-qqbot"],
  ["@tencent-connect", "qqbot"],
  ["@sliverp", "qqbot"],
];

export function parseCliArgs(argv, env = process.env) {
  const args = {
    configPath: undefined,
    openclawHome: undefined,
    requireReady: false,
    json: false,
    help: false,
    allowEnvCredentials: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--config" || arg === "-c") args.configPath = readValue();
    else if (arg.startsWith("--config=")) args.configPath = arg.slice("--config=".length);
    else if (arg === "--home" || arg === "--openclaw-home") args.openclawHome = readValue();
    else if (arg.startsWith("--home=")) args.openclawHome = arg.slice("--home=".length);
    else if (arg.startsWith("--openclaw-home=")) args.openclawHome = arg.slice("--openclaw-home=".length);
    else if (arg === "--allow-env-credentials") args.allowEnvCredentials = true;
    else if (arg === "--require-ready") args.requireReady = true;
    else if (arg === "--json") args.json = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  const configPath = args.configPath || defaultConfigPath(env);
  return {
    ...args,
    configPath,
    openclawHome: args.openclawHome || path.dirname(configPath),
  };
}

export function inspectCustomRuntimeDeployPreflight(params) {
  const cfg = params.cfg ?? {};
  const configPath = params.configPath;
  const openclawHome = params.openclawHome;
  const env = params.env ?? {};
  const localPackageName = normalizePackageName(params.localPackageName || DESIRED_PACKAGE);
  const findings = [];
  const qqbot = objectOrUndefined(cfg?.channels?.qqbot);
  const plugins = objectOrEmpty(cfg?.plugins);

  if (!objectOrUndefined(cfg?.channels)) {
    findings.push(blocker("missing_channels", "配置缺少 channels 对象，无法确认 QQBot 部署槽位。"));
  }
  if (!qqbot) {
    findings.push(blocker("missing_qqbot_channel", "配置缺少 channels.qqbot，不能进行二开 QQBot 迁移。"));
  }

  const credentialStatus = inspectQQBotCredentials(qqbot, env, params.allowEnvCredentials === true);
  if (!credentialStatus.ready) {
    findings.push(blocker(
      "qqbot_credentials_missing",
      "channels.qqbot 未发现完整 AppID/ClientSecret；部署前需要确认机器人凭据存在。",
      credentialStatus.reason,
    ));
  } else if (credentialStatus.source === "env") {
    findings.push(info("qqbot_credentials_from_env", "QQBot 凭据来自当前环境变量；请确认 systemd/生产进程也注入同一组变量。"));
  }

  const runtime = objectOrEmpty(qqbot?.customRuntime);
  const admins = normalizeCustomRuntimeAdminList(runtime.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(runtime.adminGroup);
  const rawNumericAdmins = findLikelyRawQQNumericAdminIds(runtime.admins);
  if (rawNumericAdmins.length > 0) {
    findings.push(blocker("custom_runtime_admins_raw_qq_number", "customRuntime.admins 包含疑似原始 QQ 号；必须使用 QQBot user_openid/member_openid。", rawNumericAdmins.join(", ")));
  }
  if (isLikelyRawQQNumericId(runtime.adminGroup)) {
    findings.push(blocker("custom_runtime_admin_group_raw_qq_number", "customRuntime.adminGroup 是疑似原始 QQ 群号；必须使用 QQBot group_openid。"));
  }
  if (admins.length === 0) {
    findings.push(blocker("custom_runtime_admins_missing", "初始化未绑定 customRuntime.admins；部署前必须至少绑定一个管理员 openid。"));
  }
  if (!adminGroup) {
    findings.push(blocker("custom_runtime_admin_group_missing", "初始化未绑定 customRuntime.adminGroup；部署前必须绑定管理群 group_openid。"));
  }
  if (runtime.enabled !== true) {
    findings.push(warning("custom_runtime_disabled", "channels.qqbot.customRuntime.enabled 不是 true；二开消息流、鉴权、场景和兜底逻辑不会生效。"));
  }
  if (adminGroup) {
    const scenes = objectOrEmpty(runtime.scenes);
    if (!scenes[adminGroup]) {
      findings.push(warning("admin_group_scene_missing", "管理群未显式绑定 customRuntime.scenes；建议用初始化脚本补上默认 system-admin 场景。"));
    }
  }

  const upgradePkgRaw = stringOrUndefined(qqbot?.upgradePkg) || localPackageName;
  const upgradePkg = normalizePackageName(upgradePkgRaw);
  const upgradePkgKind = classifyPackageReference(upgradePkgRaw);
  if (upgradePkgKind === "official") {
    findings.push(blocker("official_upgrade_package", `channels.qqbot.upgradePkg 指向官方包 ${upgradePkgRaw}；生产实例应只检查个人二开包。`));
  } else if (upgradePkgKind === "unknown") {
    findings.push(warning("unknown_upgrade_package", `channels.qqbot.upgradePkg 不是已知个人包：${upgradePkgRaw}；请确认不会切回官方更新源。`));
  } else if (upgradePkgKind === "missing") {
    findings.push(warning("upgrade_package_missing", `未能解析升级检查包名；建议设置为 ${DESIRED_PACKAGE}。`));
  }

  if (qqbot?.allowUpgradePkgOverride === true) {
    findings.push(warning("upgrade_pkg_override_enabled", "/bot-upgrade --pkg 当前允许覆盖包名；生产实例建议保持 false，避免误切官方包。"));
  }
  if (qqbot?.upgradeMode === "hot-reload") {
    findings.push(warning("hot_reload_enabled", "upgradeMode=hot-reload 会在管理员命令后执行安装；生产实例默认建议使用 doc 模式。"));
  } else if (qqbot?.upgradeMode && qqbot.upgradeMode !== "doc") {
    findings.push(warning("unknown_upgrade_mode", `未知 upgradeMode=${String(qqbot.upgradeMode)}；请确认升级命令不会自动安装未知来源。`));
  }

  const customUpdateCheck = objectOrUndefined(qqbot?.customUpdateCheck);
  if (!customUpdateCheck) {
    findings.push(warning("custom_update_check_missing", "未配置 customUpdateCheck；建议让实例只检查个人包更新，再由管理员判断是否升级。"));
  } else if (customUpdateCheck.enabled === false) {
    findings.push(warning("custom_update_check_disabled", "customUpdateCheck.enabled=false；实例不会自动发现个人二开版本更新。"));
  }

  const pluginRefs = collectQQBotPluginReferences(plugins);
  findings.push(...inspectPluginReferences(pluginRefs));
  findings.push(...inspectOpenClawHome(openclawHome));

  return summarizePreflightResult({
    generatedAt: params.generatedAt || new Date().toISOString(),
    configPath,
    openclawHome,
    summary: {
      qqbotConfigured: Boolean(qqbot),
      credentialSource: credentialStatus.source,
      customRuntimeEnabled: runtime.enabled === true,
      admins,
      adminGroup,
      upgradePkg,
      upgradePkgKind,
      pluginRefs,
    },
    findings,
  });
}

export function collectQQBotPluginReferences(plugins) {
  const entries = objectOrEmpty(plugins.entries);
  const installs = objectOrEmpty(plugins.installs);
  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  const refs = [];

  for (const [id, value] of Object.entries(entries)) {
    if (isQQBotLikeReference(id, value)) refs.push({ section: "plugins.entries", id, value });
  }
  for (const [id, value] of Object.entries(installs)) {
    if (isQQBotLikeReference(id, value)) refs.push({ section: "plugins.installs", id, value });
  }
  for (const item of allow) {
    const id = String(item ?? "").trim();
    if (isQQBotLikeReference(id, undefined)) refs.push({ section: "plugins.allow", id, value: item });
  }
  return refs;
}

export function inspectPluginReferences(pluginRefs) {
  const findings = [];
  const activeRefs = pluginRefs.filter((ref) => ref.section === "plugins.entries" || ref.section === "plugins.installs");
  const activeIds = unique(activeRefs.map((ref) => ref.id));
  const legacyActive = activeRefs.filter((ref) => isLegacyQQBotPluginId(ref.id));
  const legacyAllowed = pluginRefs.filter((ref) => ref.section === "plugins.allow" && isLegacyQQBotPluginId(ref.id));

  if (activeIds.length > 1) {
    findings.push(blocker(
      "multiple_qqbot_plugins_configured",
      `配置里发现多个 QQBot-like 插件引用：${activeIds.join(", ")}；部署前必须只保留二开槽位 ${DESIRED_PLUGIN_ID}。`,
    ));
  }
  for (const ref of legacyActive) {
    findings.push(blocker(
      "legacy_qqbot_plugin_active",
      `${ref.section}.${ref.id} 仍指向旧/官方 QQBot 插件；可能导致重复连接、重复回复或队列竞争。`,
    ));
  }
  for (const ref of legacyAllowed) {
    findings.push(warning(
      "legacy_qqbot_plugin_allowed",
      `plugins.allow 中仍允许 ${ref.id}；建议清理，避免后续误装官方/旧插件。`,
    ));
  }

  for (const ref of activeRefs.filter((item) => item.section === "plugins.installs")) {
    const kind = classifyPackageReference(ref.value);
    if (kind === "official") {
      findings.push(blocker(
        "official_qqbot_package_source",
        `${ref.section}.${ref.id} 的安装来源看起来是官方包；二开实例应安装 ${DESIRED_PACKAGE} 或本地二开源码。`,
        stringifyRefValue(ref.value),
      ));
    } else if (kind === "unknown" && ref.id === DESIRED_PLUGIN_ID) {
      findings.push(warning(
        "unknown_qqbot_package_source",
        `${ref.section}.${ref.id} 的安装来源无法确认是否为个人二开包；请人工核对。`,
        stringifyRefValue(ref.value),
      ));
    }
  }

  if (!activeIds.includes(DESIRED_PLUGIN_ID)) {
    findings.push(info("custom_plugin_entry_not_found", `未在 plugins.entries/installs 中看到 ${DESIRED_PLUGIN_ID}；如果由 OpenClaw 运行时自动发现，可忽略。`));
  }

  return findings;
}

export function inspectOpenClawHome(openclawHome) {
  if (!openclawHome || !fs.existsSync(openclawHome)) return [];
  const findings = [];
  const extensionsDir = path.join(openclawHome, "extensions");
  for (const dir of LEGACY_EXTENSION_DIRS) {
    const candidate = path.join(extensionsDir, dir);
    if (fs.existsSync(candidate)) {
      findings.push(warning(
        "legacy_extension_dir_present",
        `检测到旧 QQBot 扩展目录 ${candidate}；确认未被加载后再迁移/清理。`,
      ));
    }
  }
  for (const parts of OFFICIAL_NODE_MODULE_DIRS) {
    const candidate = path.join(extensionsDir, "node_modules", ...parts);
    if (fs.existsSync(candidate)) {
      findings.push(warning(
        "official_extension_package_present",
        `检测到官方/旧 QQBot 包目录 ${candidate}；即使当前未激活，也建议备份后清理以降低误加载风险。`,
      ));
    }
  }
  return findings;
}

export function buildPreflightReport(result) {
  const lines = [
    "QQBot 二开部署预检",
    `生成时间: ${result.generatedAt}`,
    `配置文件: ${result.configPath || "(未指定)"}`,
    `OpenClaw Home: ${result.openclawHome || "(未检查)"}`,
    "只读检查: 不修改配置、不安装插件、不重启网关、不访问远端实例。",
    "",
    `结论: ${result.ok ? "无阻断项" : `发现 ${result.counts.blocker} 个阻断项`}${result.counts.warning ? `，${result.counts.warning} 个警告` : ""}`,
    `管理员: ${result.summary.admins.length ? result.summary.admins.join(", ") : "未绑定"}`,
    `管理群: ${result.summary.adminGroup || "未绑定"}`,
    `customRuntime.enabled: ${result.summary.customRuntimeEnabled ? "true" : "false"}`,
    `升级检查包: ${result.summary.upgradePkg || "未解析"} (${result.summary.upgradePkgKind})`,
    "",
  ];

  appendFindingSection(lines, "阻断项", result.findings.filter((item) => item.severity === "blocker"));
  appendFindingSection(lines, "警告", result.findings.filter((item) => item.severity === "warning"));
  appendFindingSection(lines, "提示", result.findings.filter((item) => item.severity === "info"));
  lines.push(
    "建议:",
    `- 阻断项清零后再部署或执行 /bot-deploy 确认流程。`,
    `- 生产实例保留一个 QQBot 槽位：${DESIRED_PLUGIN_ID} + ${DESIRED_PACKAGE}。`,
    "- 首次初始化必须绑定 customRuntime.admins 和 customRuntime.adminGroup。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function normalizePackageName(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const cleaned = text
    .replace(/^npm:/i, "")
    .replace(/^package:/i, "")
    .trim();
  const direct = cleaned.match(/^(@?[\w.-]+\/[\w.-]+)(?:@[^/\s]+)?$/);
  if (direct) {
    const name = direct[1].toLowerCase();
    return name.startsWith("@") ? name : `@${name}`;
  }
  const scoped = cleaned.match(/(@[\w.-]+\/[\w.-]+)/);
  if (scoped) return scoped[1].toLowerCase();
  const short = cleaned.match(/\b(openclaw-qqbot|qqbot)\b/i);
  return short ? short[1].toLowerCase() : cleaned.toLowerCase();
}

export function classifyPackageReference(raw) {
  if (raw === null || raw === undefined || raw === "") return "missing";
  const text = stringifyRefValue(raw);
  const normalized = normalizePackageName(text);
  if (PERSONAL_PACKAGE_REFS.has(normalized) || /github(?:\.com)?[:/]LukeSONG2000\/openclaw-qqbot/i.test(text)) {
    return "personal";
  }
  if (OFFICIAL_PACKAGE_REFS.has(normalized) || /tencent-connect\/openclaw-qqbot/i.test(text) || /tencent-connect\/qqbot/i.test(text)) {
    return "official";
  }
  if (/^(?:\.{1,2}\/|\/|file:)/.test(text) || /source["']?\s*:\s*["']?path/i.test(text)) {
    return "path-or-custom";
  }
  return "unknown";
}

export function runCli(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout }) {
  const args = parseCliArgs(argv, env);
  if (args.help) {
    io.stdout.write(usage());
    return 0;
  }
  const cfg = readJsonConfig(args.configPath);
  const result = inspectCustomRuntimeDeployPreflight({
    cfg,
    configPath: args.configPath,
    openclawHome: args.openclawHome,
    env,
    allowEnvCredentials: args.allowEnvCredentials,
    localPackageName: readLocalPackageName(),
  });
  if (args.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(buildPreflightReport(result));
  }
  return args.requireReady && !result.ok ? 2 : 0;
}

function inspectQQBotCredentials(qqbot, env, allowEnvCredentials) {
  if (!qqbot) return { ready: false, source: "missing", reason: "channels.qqbot 不存在" };
  if (hasCredentialPair(qqbot)) return { ready: true, source: "channels.qqbot" };
  const accounts = objectOrEmpty(qqbot.accounts);
  const accountIds = Object.keys(accounts).filter((id) => {
    const account = objectOrEmpty(accounts[id]);
    return account.enabled !== false && hasCredentialPair(account);
  });
  if (accountIds.length > 0) return { ready: true, source: `channels.qqbot.accounts.${accountIds[0]}` };
  if (allowEnvCredentials && stringOrUndefined(env.QQBOT_APP_ID) && stringOrUndefined(env.QQBOT_CLIENT_SECRET)) {
    return { ready: true, source: "env" };
  }
  return { ready: false, source: "missing", reason: "缺少 appId + clientSecret/clientSecretFile" };
}

function hasCredentialPair(value) {
  return Boolean(stringOrUndefined(value?.appId) && (stringOrUndefined(value?.clientSecret) || stringOrUndefined(value?.clientSecretFile)));
}

function summarizePreflightResult(result) {
  const counts = {
    blocker: result.findings.filter((item) => item.severity === "blocker").length,
    warning: result.findings.filter((item) => item.severity === "warning").length,
    info: result.findings.filter((item) => item.severity === "info").length,
  };
  return {
    ...result,
    ok: counts.blocker === 0,
    counts,
  };
}

function inspectPackageValue(value) {
  return classifyPackageReference(value);
}

function isQQBotLikeReference(id, value) {
  const normalizedId = String(id ?? "").trim().toLowerCase();
  if (!normalizedId) return false;
  if (QQBOT_LIKE_PLUGIN_IDS.has(normalizedId)) return true;
  if (normalizedId.includes("qqbot") || normalizedId.includes("openclaw-qq")) return true;
  return inspectPackageValue(value) === "official" || inspectPackageValue(value) === "personal";
}

function isLegacyQQBotPluginId(id) {
  return LEGACY_QQBOT_PLUGIN_IDS.includes(String(id ?? "").trim().toLowerCase());
}

function finding(severity, code, message, detail) {
  return {
    severity,
    code,
    message,
    ...(detail ? { detail } : {}),
  };
}

function blocker(code, message, detail) {
  return finding("blocker", code, message, detail);
}

function warning(code, message, detail) {
  return finding("warning", code, message, detail);
}

function info(code, message, detail) {
  return finding("info", code, message, detail);
}

function appendFindingSection(lines, title, findings) {
  lines.push(`${title}:`);
  if (!findings.length) {
    lines.push("- 无");
  } else {
    for (const item of findings) {
      lines.push(`- [${item.code}] ${item.message}${item.detail ? ` (${item.detail})` : ""}`);
    }
  }
  lines.push("");
}

function readJsonConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function readLocalPackageName() {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return stringOrUndefined(pkg.name) || DESIRED_PACKAGE;
  } catch {
    return DESIRED_PACKAGE;
  }
}

function defaultConfigPath(env) {
  const home = env?.HOME || env?.USERPROFILE || os.homedir();
  return path.join(home, ".openclaw", "openclaw.json");
}

function objectOrEmpty(value) {
  return objectOrUndefined(value) || {};
}

function objectOrUndefined(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringOrUndefined(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function stringifyRefValue(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function usage() {
  return [
    "Usage:",
    "  node scripts/preflight-custom-runtime-deploy.mjs [--config ~/.openclaw/openclaw.json] [--home ~/.openclaw]",
    "",
    "Options:",
    "  --config, -c <path>        OpenClaw config file. Default: ~/.openclaw/openclaw.json",
    "  --home <path>              OpenClaw home for read-only extension-dir checks. Default: dirname(config)",
    "  --allow-env-credentials    Treat QQBOT_APP_ID/QQBOT_CLIENT_SECRET in current env as configured credentials",
    "  --require-ready            Exit 2 when blockers exist",
    "  --json                     Print JSON result",
    "",
    "Checks:",
    "  - QQBot credentials and customRuntime admin/adminGroup anchors",
    "  - personal update package, safe upgrade mode, and update check settings",
    "  - duplicate/legacy QQBot plugin entries that may cause repeated replies",
    "  - optional local extension directories under OpenClaw home",
    "",
  ].join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
