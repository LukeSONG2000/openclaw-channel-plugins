#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ADMIN_ENV_KEYS = ["QQBOT_CUSTOM_ADMINS", "QQBOT_ADMINS"];
const ADMIN_GROUP_ENV_KEYS = ["QQBOT_CUSTOM_ADMIN_GROUP", "QQBOT_ADMIN_GROUP"];
const INIT_BIND_CODE_ENV_KEYS = ["QQBOT_CUSTOM_INIT_BIND_CODE", "QQBOT_INIT_BIND_CODE"];
const LIKELY_RAW_QQ_NUMERIC_ID_PATTERN = /^[1-9]\d{4,12}$/;
const DEFAULT_INIT_BIND_TTL_MS = 10 * 60 * 1000;

export function normalizeCustomRuntimeAdminList(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;，；]+/g)
      : raw === null || raw === undefined
        ? []
        : [raw];

  const seen = new Set();
  const admins = [];
  for (const value of values) {
    const admin = String(value ?? "").trim();
    if (!admin) continue;
    const key = admin.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    admins.push(admin);
  }
  return admins;
}

export function normalizeCustomRuntimeAdminGroup(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  if (value.startsWith("qqbot:group:")) {
    const openid = value.slice("qqbot:group:".length).trim();
    return openid ? `qqbot:group:${openid}` : undefined;
  }
  if (value.startsWith("qqbot:")) return undefined;
  if (value.startsWith("group:")) {
    const openid = value.slice("group:".length).trim();
    return openid ? `qqbot:group:${openid}` : undefined;
  }
  return `qqbot:group:${value}`;
}

export function isLikelyRawQQNumericId(raw) {
  const value = stripCustomRuntimeBindingPrefix(String(raw ?? "").trim());
  return LIKELY_RAW_QQ_NUMERIC_ID_PATTERN.test(value);
}

export function findLikelyRawQQNumericAdminIds(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;，；]+/g)
      : raw === null || raw === undefined
        ? []
        : [raw];

  const seen = new Set();
  const matches = [];
  for (const value of values) {
    const candidate = String(value ?? "").trim();
    if (!candidate || !isLikelyRawQQNumericId(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    matches.push(candidate);
  }
  return matches;
}

function stripCustomRuntimeBindingPrefix(value) {
  if (value.startsWith("qqbot:group:")) return value.slice("qqbot:group:".length).trim();
  if (value.startsWith("group:")) return value.slice("group:".length).trim();
  if (value.startsWith("qqbot:c2c:")) return value.slice("qqbot:c2c:".length).trim();
  if (value.startsWith("c2c:")) return value.slice("c2c:".length).trim();
  return value;
}

export function inspectCustomRuntimeInitialization(cfg) {
  const runtime = getQQBotCustomRuntime(cfg);
  const admins = normalizeCustomRuntimeAdminList(runtime?.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(runtime?.adminGroup);
  const missing = [];
  if (admins.length === 0) missing.push("admins");
  if (!adminGroup) missing.push("adminGroup");
  return {
    enabled: runtime?.enabled === true,
    admins,
    adminGroup,
    initBind: normalizeCustomRuntimeInitBindConfig(runtime?.initBind),
    missing,
    ready: missing.length === 0,
  };
}

export function applyCustomRuntimeInitializationToConfig(cfg, input) {
  const channels = objectOrEmpty(cfg.channels);
  const qqbot = objectOrEmpty(channels.qqbot);
  const runtime = { ...getQQBotCustomRuntime(cfg) };

  const admins = normalizeCustomRuntimeAdminList(input.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(input.adminGroup);

  if (admins.length > 0) runtime.admins = admins;
  if (adminGroup) runtime.adminGroup = adminGroup;
  if (typeof input.enabled === "boolean") runtime.enabled = input.enabled;
  const nextRuntime = applyCustomRuntimeAdminGroupSceneBinding(runtime, adminGroup);

  return {
    ...cfg,
    channels: {
      ...channels,
      qqbot: {
        ...qqbot,
        customRuntime: nextRuntime,
      },
    },
  };
}

export function applyCustomRuntimeInitBindChallengeToConfig(cfg, input) {
  const code = normalizeCustomRuntimeInitBindCode(input.code);
  if (!code) return cfg;
  const channels = objectOrEmpty(cfg.channels);
  const qqbot = objectOrEmpty(channels.qqbot);
  const runtime = { ...getQQBotCustomRuntime(cfg) };
  runtime.initBind = {
    code,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    enableRuntimeOnComplete: input.enableRuntimeOnComplete === true,
  };
  return {
    ...cfg,
    channels: {
      ...channels,
      qqbot: {
        ...qqbot,
        customRuntime: runtime,
      },
    },
  };
}

export function normalizeCustomRuntimeInitBindCode(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(value) ? value : undefined;
}

export function normalizeCustomRuntimeInitBindConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const code = normalizeCustomRuntimeInitBindCode(raw.code);
  if (!code) return undefined;
  return {
    code,
    createdAt: finiteNumberOrUndefined(raw.createdAt),
    expiresAt: finiteNumberOrUndefined(raw.expiresAt),
    enableRuntimeOnComplete: raw.enableRuntimeOnComplete === true,
  };
}

function finiteNumberOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function applyCustomRuntimeAdminGroupSceneBinding(runtime, adminGroup) {
  if (!adminGroup) return runtime;
  const scenes = objectOrEmpty(runtime.scenes);
  if (scenes[adminGroup]) {
    return {
      ...runtime,
      scenes: { ...scenes },
    };
  }
  return {
    ...runtime,
    scenes: {
      ...scenes,
      [adminGroup]: { scene: "system-admin" },
    },
  };
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv, env);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.configPath) {
    throw new Error("--config is required");
  }

  const admins = normalizeCustomRuntimeAdminList(args.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(args.adminGroup);
  const initBindCode = normalizeCustomRuntimeInitBindCode(args.initBindCode);
  if (args.hasInitBindCodeInput && !initBindCode) {
    throw new Error("custom runtime init bind code must be 4-64 chars: letters, numbers, _ or -");
  }
  const numericAdmins = findLikelyRawQQNumericAdminIds(args.admins);
  if (args.hasAdminInput && numericAdmins.length > 0) {
    throw new Error(`custom runtime admins must use QQBot user_openid/member_openid, not raw QQ number: ${numericAdmins.join(", ")}`);
  }
  if (args.hasAdminGroupInput && isLikelyRawQQNumericId(args.adminGroup)) {
    throw new Error("custom runtime admin group must use QQBot group_openid, not raw QQ group number");
  }
  if (args.hasAdminInput && admins.length === 0) {
    throw new Error("custom runtime admins cannot be empty");
  }
  if (args.hasAdminGroupInput && !adminGroup) {
    throw new Error("custom runtime admin group must be a QQ group_openid or qqbot:group:<group_openid>");
  }

  const cfg = readJsonConfig(args.configPath);
  const shouldWrite = !args.statusOnly
    && (admins.length > 0 || Boolean(adminGroup) || typeof args.enabled === "boolean" || Boolean(initBindCode));
  let next = shouldWrite
    ? applyCustomRuntimeInitializationToConfig(cfg, {
      admins,
      adminGroup,
      enabled: args.enabled,
    })
    : cfg;
  if (shouldWrite && initBindCode) {
    const createdAt = args.now ?? Date.now();
    next = applyCustomRuntimeInitBindChallengeToConfig(next, {
      code: initBindCode,
      createdAt,
      expiresAt: createdAt + args.initBindTtlMs,
      enableRuntimeOnComplete: args.enableRuntimeOnInitBindComplete,
    });
  }

  if (shouldWrite) {
    fs.writeFileSync(args.configPath, `${JSON.stringify(next, null, 4)}\n`);
  }

  const status = inspectCustomRuntimeInitialization(next);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ changed: shouldWrite, ...status }, null, 2)}\n`);
  } else {
    process.stdout.write(formatStatus({ changed: shouldWrite, ...status }));
  }

  if (args.requireReady && !status.ready) return 2;
  return 0;
}

function getQQBotCustomRuntime(cfg) {
  const qqbot = cfg?.channels?.qqbot;
  const runtime = qqbot && typeof qqbot === "object" && !Array.isArray(qqbot)
    ? qqbot.customRuntime
    : undefined;
  return runtime && typeof runtime === "object" && !Array.isArray(runtime) ? runtime : {};
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readJsonConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function parseCliArgs(argv, env) {
  const adminInputs = [];
  let adminGroup;
  let configPath;
  let enabled;
  let initBindCode;
  let initBindTtlMs = DEFAULT_INIT_BIND_TTL_MS;
  let enableRuntimeOnInitBindComplete = false;
  let statusOnly = false;
  let requireReady = false;
  let json = false;
  let help = false;
  let hasAdminGroupInput = false;
  let hasInitBindCodeInput = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--config" || arg === "-c") {
      configPath = readValue();
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--admin" || arg === "--admins") {
      adminInputs.push(readValue());
    } else if (arg.startsWith("--admin=")) {
      adminInputs.push(arg.slice("--admin=".length));
    } else if (arg.startsWith("--admins=")) {
      adminInputs.push(arg.slice("--admins=".length));
    } else if (arg === "--admin-group" || arg === "--adminGroup") {
      adminGroup = readValue();
      hasAdminGroupInput = true;
    } else if (arg.startsWith("--admin-group=")) {
      adminGroup = arg.slice("--admin-group=".length);
      hasAdminGroupInput = true;
    } else if (arg.startsWith("--adminGroup=")) {
      adminGroup = arg.slice("--adminGroup=".length);
      hasAdminGroupInput = true;
    } else if (arg === "--enable-custom-runtime") {
      enabled = true;
    } else if (arg === "--disable-custom-runtime") {
      enabled = false;
    } else if (arg === "--init-bind-code") {
      initBindCode = readValue();
      hasInitBindCodeInput = true;
    } else if (arg.startsWith("--init-bind-code=")) {
      initBindCode = arg.slice("--init-bind-code=".length);
      hasInitBindCodeInput = true;
    } else if (arg === "--init-bind-ttl-ms") {
      initBindTtlMs = Number(readValue());
    } else if (arg.startsWith("--init-bind-ttl-ms=")) {
      initBindTtlMs = Number(arg.slice("--init-bind-ttl-ms=".length));
    } else if (arg === "--enable-runtime-after-init-bind") {
      enableRuntimeOnInitBindComplete = true;
    } else if (arg === "--status-only") {
      statusOnly = true;
    } else if (arg === "--require-ready") {
      requireReady = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  const envAdmins = firstEnv(env, ADMIN_ENV_KEYS);
  const envAdminGroup = firstEnv(env, ADMIN_GROUP_ENV_KEYS);
  const envInitBindCode = firstEnv(env, INIT_BIND_CODE_ENV_KEYS);
  const admins = adminInputs.length > 0 ? adminInputs.join(",") : envAdmins;
  if (!hasAdminGroupInput && envAdminGroup !== undefined) {
    adminGroup = envAdminGroup;
    hasAdminGroupInput = true;
  }
  if (!hasInitBindCodeInput && envInitBindCode !== undefined) {
    initBindCode = envInitBindCode;
    hasInitBindCodeInput = true;
  }
  if (!Number.isFinite(initBindTtlMs) || initBindTtlMs <= 0) {
    throw new Error("--init-bind-ttl-ms must be a positive number");
  }

  return {
    configPath,
    admins,
    adminGroup,
    enabled,
    initBindCode,
    initBindTtlMs,
    enableRuntimeOnInitBindComplete,
    statusOnly,
    requireReady,
    json,
    help,
    hasAdminInput: adminInputs.length > 0 || envAdmins !== undefined,
    hasAdminGroupInput,
    hasInitBindCodeInput,
  };
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

function formatStatus(status) {
  const lines = [
    `Custom Runtime 管理员: ${status.admins.length ? status.admins.join(", ") : "未绑定"}`,
    `Custom Runtime 管理群: ${status.adminGroup ?? "未绑定"}`,
    ...(status.initBind?.code ? [`Custom Runtime 对话式绑定: 已启用（expiresAt=${status.initBind.expiresAt ?? "未设置"}）`] : []),
    `Custom Runtime 初始化: ${status.ready ? "完整" : `缺少 ${status.missing.join(", ")}`}`,
  ];
  if (status.changed) lines.unshift("Custom Runtime 初始化配置已写入");
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-custom-runtime-init.mjs --config <openclaw.json> --admins <openid,...> --admin-group <group_openid>",
    "",
    "Options:",
    "  --admins, --admin <openid,...>       Bind one or more QQBot user_openid/member_openid admins",
    "  --admin-group <group_openid>         Bind the management QQBot group_openid",
    "  --init-bind-code <code>              Stage a one-time /bot-init-bind <code> chat binding challenge",
    "  --init-bind-ttl-ms <ms>              Challenge TTL, default 600000",
    "  --enable-runtime-after-init-bind     Set customRuntime.enabled=true when chat binding completes",
    "  --enable-custom-runtime              Set customRuntime.enabled=true",
    "  --disable-custom-runtime             Set customRuntime.enabled=false",
    "  --status-only                        Print current binding status without writing",
    "  --require-ready                      Exit 2 when admins or adminGroup is missing",
    "  --json                               Print JSON status",
    "",
    "Environment:",
    "  QQBOT_CUSTOM_ADMINS / QQBOT_ADMINS",
    "  QQBOT_CUSTOM_ADMIN_GROUP / QQBOT_ADMIN_GROUP",
    "  QQBOT_CUSTOM_INIT_BIND_CODE / QQBOT_INIT_BIND_CODE",
    "",
  ].join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
