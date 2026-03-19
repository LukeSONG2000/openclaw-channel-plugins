/**
 * QQBot 插件级斜杠指令处理器
 *
 * 设计原则：
 * 1. 在消息入队前拦截，匹配到插件级指令后直接回复，不进入 AI 处理队列
 * 2. 不匹配的 "/" 消息照常入队，交给 OpenClaw 框架处理
 * 3. 每个指令通过 SlashCommand 接口注册，易于扩展
 *
 * 时间线追踪：
 *   开平推送时间戳 → 插件收到(Date.now()) → 指令处理完成(Date.now())
 *   从而计算「开平→插件」和「插件处理」两段耗时
 */

import type { QQBotAccountConfig } from "./types.js";
import { createRequire } from "node:module";
import { execFileSync, execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getUpdateInfo, checkVersionExists } from "./update-checker.js";
import { getHomeDir, getQQBotDataDir, isWindows } from "./utils/platform.js";
import { saveCredentialBackup } from "./credential-backup.js";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

// 读取 package.json 中的版本号
let PLUGIN_VERSION = "unknown";
try {
  const pkg = require("../package.json");
  PLUGIN_VERSION = pkg.version ?? "unknown";
} catch {
  // fallback
}

// 获取 openclaw 框架版本（缓存结果，只执行一次）
let _frameworkVersion: string | null = null;
function getFrameworkVersion(): string {
  if (_frameworkVersion !== null) return _frameworkVersion;
  try {
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      try {
        const out = execFileSync(cli, ["--version"], { timeout: 3000, encoding: "utf8" }).trim();
        // 输出格式: "OpenClaw 2026.3.13 (61d171a)"
        if (out) {
          _frameworkVersion = out;
          return _frameworkVersion;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // fallback
  }
  _frameworkVersion = "unknown";
  return _frameworkVersion;
}

// ============ 类型定义 ============

/** 斜杠指令上下文（消息元数据 + 运行时状态） */
export interface SlashCommandContext {
  /** 消息类型 */
  type: "c2c" | "guild" | "dm" | "group";
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderName?: string;
  /** 消息 ID（用于被动回复） */
  messageId: string;
  /** 开平推送的事件时间戳（ISO 字符串） */
  eventTimestamp: string;
  /** 插件收到消息的本地时间（ms） */
  receivedAt: number;
  /** 原始消息内容 */
  rawContent: string;
  /** 指令参数（去掉指令名后的部分） */
  args: string;
  /** 频道 ID（guild 类型） */
  channelId?: string;
  /** 群 openid（group 类型） */
  groupOpenid?: string;
  /** 账号 ID */
  accountId: string;
  /** Bot App ID */
  appId: string;
  /** 账号配置（供指令读取可配置项） */
  accountConfig?: QQBotAccountConfig;
  /** 当前用户队列状态快照 */
  queueSnapshot: QueueSnapshot;
}

/** 队列状态快照 */
export interface QueueSnapshot {
  /** 各用户队列中的消息总数 */
  totalPending: number;
  /** 正在并行处理的用户数 */
  activeUsers: number;
  /** 最大并发用户数 */
  maxConcurrentUsers: number;
  /** 当前发送者在队列中的待处理消息数 */
  senderPending: number;
}

/** 斜杠指令返回值：文本、带文件的结果、或 null（不处理） */
export type SlashCommandResult = string | SlashCommandFileResult | null;

/** 带文件的指令结果（先回复文本，再发送文件） */
export interface SlashCommandFileResult {
  text: string;
  /** 要发送的本地文件路径 */
  filePath: string;
}

/** 斜杠指令定义 */
interface SlashCommand {
  /** 指令名（不含 /） */
  name: string;
  /** 简要描述 */
  description: string;
  /** 详细用法说明（支持多行），用于 /指令 ? 查询 */
  usage?: string;
  /** 处理函数 */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

// ============ 指令注册表 ============

const commands: Map<string, SlashCommand> = new Map();

function registerCommand(cmd: SlashCommand): void {
  commands.set(cmd.name.toLowerCase(), cmd);
}

// ============ 内置指令 ============

/**
 * /bot-ping — 测试当前 openclaw 与 QQ 连接的网络延迟
 */
registerCommand({
  name: "bot-ping",
  description: "测试当前 openclaw 与 QQ 连接的网络延迟",
  usage: [
    `/bot-ping`,
    ``,
    `测试 OpenClaw 主机与 QQ 服务器之间的网络延迟。`,
    `返回网络传输耗时和插件处理耗时。`,
  ].join("\n"),
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    if (isNaN(eventTime)) {
      return `✅ pong!`;
    }
    const totalMs = now - eventTime;
    const qqToPlugin = ctx.receivedAt - eventTime;
    const pluginProcess = now - ctx.receivedAt;
    const lines = [
      `✅ pong！`,
      ``,
      `⏱ 延迟: ${totalMs}ms`,
      `  ├ 网络传输: ${qqToPlugin}ms`,
      `  └ 插件处理: ${pluginProcess}ms`,
    ];
    return lines.join("\n");
  },
});

/**
 * /bot-version — 查看插件版本号
 */
registerCommand({
  name: "bot-version",
  description: "查看插件版本号",
  usage: [
    `/bot-version`,
    ``,
    `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`,
    `同时检查是否有新版本可用。`,
  ].join("\n"),
  handler: async () => {
    const frameworkVersion = getFrameworkVersion();
    const lines = [
      `🦞框架版本：${frameworkVersion}`,
      `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
    ];
    const info = await getUpdateInfo();
    if (info.checkedAt === 0) {
      lines.push(`⏳ 版本检查中...`);
    } else if (info.error) {
      lines.push(`⚠️ 版本检查失败`);
    } else if (info.hasUpdate && info.latest) {
      lines.push(`🆕最新可用版本：v${info.latest}，点击 <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> 查看升级指引`);
    } 
    lines.push(`🌟官方 GitHub 仓库：[点击前往](https://github.com/tencent-connect/openclaw-qqbot/)`);
    return lines.join("\n");
  },
});

/**
 * /bot-help — 查看所有指令以及用途
 */
registerCommand({
  name: "bot-help",
  description: "查看所有指令以及用途",
  usage: [
    `/bot-help`,
    ``,
    `列出所有可用的 QQBot 插件内置指令及其简要说明。`,
    `使用 /指令名 ? 可查看某条指令的详细用法。`,
  ].join("\n"),
  handler: () => {
    const lines = [`### QQBot插件内置调试指令`, ``];
    for (const [name, cmd] of commands) {
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    lines.push(``, `> 插件版本 v${PLUGIN_VERSION}`);
    return lines.join("\n");
  },
});

const DEFAULT_UPGRADE_URL = "https://doc.weixin.qq.com/doc/w3_AKEAGQaeACgCNHrh1CbHzTAKtT2gB?scode=AJEAIQdfAAozxFEnLZAKEAGQaeACg";

function saveUpgradeGreetingTarget(accountId: string, appId: string, openid: string): void {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(getQQBotDataDir("data"), `upgrade-greeting-target-${safeAccountId}-${safeAppId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      accountId,
      appId,
      openid,
      savedAt: new Date().toISOString(),
    }) + "\n");
  } catch {
    // ignore
  }
}

// ============ 热更新 ============

/**
 * 找到 CLI 命令名（openclaw / clawdbot / moltbot）
 */
function findCli(): string | null {
  const whichCmd = isWindows() ? "where" : "which";
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    try {
      execFileSync(whichCmd, [cli], { timeout: 3000, encoding: "utf8", stdio: "pipe" });
      return cli;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 找到升级脚本路径（兼容源码运行、dist 运行、已安装扩展目录）
 */
function getUpgradeScriptPath(): string | null {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  const candidates = [
    path.resolve(currentDir, "..", "..", "scripts", "upgrade-via-npm.sh"),
    path.resolve(currentDir, "..", "scripts", "upgrade-via-npm.sh"),
    path.resolve(process.cwd(), "scripts", "upgrade-via-npm.sh"),
  ];

  const homeDir = getHomeDir();
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    candidates.push(path.join(homeDir, `.${cli}`, "extensions", "openclaw-qqbot", "scripts", "upgrade-via-npm.sh"));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

type HotUpgradeStartResult = {
  ok: boolean;
  reason?: "no-script" | "no-cli" | "no-bash";
};

/**
 * 在 Windows 上查找可用的 bash（Git Bash / WSL 等）
 */
function findBash(): string | null {
  if (!isWindows()) return "bash";

  // Git Bash 常见路径
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  // 尝试 PATH 中的 bash
  try {
    execFileSync("where", ["bash"], { timeout: 3000, encoding: "utf8", stdio: "pipe" });
    return "bash";
  } catch {
    return null;
  }
}

/**
 * 将 openclaw.json 中的 qqbot 插件 source 从 "path" 切换为 "npm"。
 * 用于热更新场景：从 npm 拉取新版本后，确保 openclaw 不再从本地源码加载。
 *
 * 安全保障：写回配置前验证 channels.qqbot 未丢失，防止竞态写入导致凭证消失。
 */
function switchPluginSourceToNpm(): void {
  try {
    const homeDir = getHomeDir();
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;

      // 读取当前配置
      const raw = fs.readFileSync(cfgPath, "utf8");
      const cfg = JSON.parse(raw);
      const inst = cfg?.plugins?.installs?.["openclaw-qqbot"];
      if (!inst || inst.source === "npm") {
        break; // 无需修改
      }

      // 记录修改前的 channels.qqbot 快照，用于写后校验
      const channelsBefore = JSON.stringify(cfg.channels?.qqbot ?? null);

      inst.source = "npm";
      delete inst.sourcePath;
      const newRaw = JSON.stringify(cfg, null, 4) + "\n";

      // 写后校验：重新解析确认 channels.qqbot 未被破坏
      const verify = JSON.parse(newRaw);
      const channelsAfter = JSON.stringify(verify.channels?.qqbot ?? null);
      if (channelsBefore !== channelsAfter) {
        // channels 数据异常，放弃写入
        break;
      }

      fs.writeFileSync(cfgPath, newRaw);
      break;
    }
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 热更新前保存当前账户的 appId/secret 到暂存文件。
 * 从 openclaw.json 中直接读取 clientSecret（slash command ctx 中不含 secret）。
 */
function preUpgradeCredentialBackup(accountId: string, appId: string): void {
  try {
    const homeDir = getHomeDir();
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const qqbot = cfg?.channels?.qqbot;
      if (!qqbot) break;
      // 从默认账户或 accounts 子节点中读取 secret
      let secret = "";
      if (accountId === "default" && qqbot.clientSecret) {
        secret = qqbot.clientSecret;
      } else if (qqbot.accounts?.[accountId]?.clientSecret) {
        secret = qqbot.accounts[accountId].clientSecret;
      } else if (qqbot.clientSecret) {
        secret = qqbot.clientSecret;
      }
      if (appId && secret) {
        saveCredentialBackup(accountId, appId, secret);
      }
      break;
    }
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 执行热更新：执行脚本(--no-restart) → 立即触发 gateway restart
 *
 * fire-and-forget 操作：
 * - 异步执行升级脚本（--no-restart，只做文件替换）
 * - 脚本完成后**立即**触发 gateway restart（当前进程会被杀掉）
 * - 新进程启动时 getStartupGreeting() 检测到版本变更，自动通知管理员
 *
 * 注意：gateway restart 必须在文件替换完成后尽快执行，
 * 否则 openclaw 的配置热加载轮询（~1s）会不断检测到插件目录
 * 已变更但进程未重启，从而产生 "plugin not found" warning 刷屏。
 */
function fireHotUpgrade(targetVersion?: string): HotUpgradeStartResult {
  const scriptPath = getUpgradeScriptPath();
  if (!scriptPath) return { ok: false, reason: "no-script" };

  const cli = findCli();
  if (!cli) return { ok: false, reason: "no-cli" };

  const bash = findBash();
  if (!bash) return { ok: false, reason: "no-bash" };

  // 异步执行升级脚本
  execFile(bash, [scriptPath, "--no-restart", ...(targetVersion ? ["--version", targetVersion] : [])], {
    timeout: 120_000,
    env: { ...process.env },
    ...(isWindows() ? { windowsHide: true } : {}),
  }, (error, stdout, _stderr) => {
    if (error) {
      return;
    }

    // 从脚本输出中提取版本号，验证文件替换是否成功
    const versionMatch = stdout.match(/QQBOT_NEW_VERSION=(\S+)/);
    const newVersion = versionMatch?.[1];
    if (newVersion === "unknown") {
      // 文件替换异常，不执行 restart 以保持现有服务
      return;
    }

    // 文件替换成功，在 restart 之前把 source 从 path 切换为 npm，
    // 确保新进程启动时读到的是 npm source，不会被本地源码覆盖。
    // 必须在 restart 之前同步完成，避免 openclaw 轮询检测到配置变更后
    // 先于我们的 restart 触发非预期的 reload。
    switchPluginSourceToNpm();

    // 文件替换成功，立即触发 gateway restart（不再等后续步骤）
    execFile(cli, ["gateway", "restart"], { timeout: 30_000 }, (restartErr) => {
      if (restartErr) {
        // restart 失败，尝试 stop + start 作为 fallback
        execFile(cli, ["gateway", "stop"], { timeout: 10_000 }, () => {
          setTimeout(() => {
            execFile(cli, ["gateway", "start"], { timeout: 30_000 }, () => {});
          }, 1000);
        });
      }
    });
  });

  return { ok: true };
}

/**
 * /bot-upgrade — 统一升级入口
 *
 * 产品流程：
 *   /bot-upgrade              — 展示版本信息+确认按钮（不直接升级）
 *   /bot-upgrade --latest     — 确认升级到最新版本
 *   /bot-upgrade --version X  — 升级到指定版本
 *   /bot-upgrade --force      — 强制升级（即使当前已是最新版）
 */
let _upgrading = false; // 升级锁

registerCommand({
  name: "bot-upgrade",
  description: "检查更新并自动热更",
  usage: [
    `/bot-upgrade              检查是否有新版本（展示信息+确认按钮）`,
    `/bot-upgrade --latest     确认升级到最新版本`,
    `/bot-upgrade --version X  升级到指定版本（如 1.6.4-alpha.7）`,
    `/bot-upgrade --force      强制重新安装当前版本`,
    ``,
    `⚠️ 仅在私聊中可用。升级过程约 30~60 秒，期间服务短暂不可用。`,
  ].join("\n"),
  handler: async (ctx) => {
    // 升级相关指令仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    // 升级锁：防止重复触发
    if (_upgrading) {
      return `⏳ 正在升级中，请稍候...`;
    }

    const url = ctx.accountConfig?.upgradeUrl || DEFAULT_UPGRADE_URL;
    const args = ctx.args.trim();
    const info = await getUpdateInfo();

    let isForce = false;
    let isLatest = false;
    let versionArg: string | undefined;
    const tokens = args ? args.split(/\s+/).filter(Boolean) : [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (t === "--force") {
        isForce = true;
        continue;
      }
      if (t === "--latest") {
        isLatest = true;
        continue;
      }
      if (t === "--version") {
        const next = tokens[i + 1];
        if (!next || next.startsWith("--")) {
          return `❌ 参数错误：--version 需要版本号\n\n示例：/bot-upgrade --version 1.6.4-alpha.1`;
        }
        versionArg = next.replace(/^v/, "");
        i += 1;
        continue;
      }
      if (t.startsWith("--version=")) {
        const v = t.slice("--version=".length).trim();
        if (!v) {
          return `❌ 参数错误：--version 需要版本号\n\n示例：/bot-upgrade --version 1.6.4-alpha.1`;
        }
        versionArg = v.replace(/^v/, "");
        continue;
      }
      if (!t.startsWith("--") && !versionArg) {
        versionArg = t.replace(/^v/, "");
        continue;
      }
    }

    const GITHUB_URL = "https://github.com/tencent-connect/openclaw-qqbot/";

    // ── 无参数（也没有 --latest / --version / --force）：只展示信息+确认按钮 ──
    if (!versionArg && !isLatest && !isForce) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate) {
        return [
          `✅ 当前已是最新版本 v${PLUGIN_VERSION}`,
          ``,
          `项目地址：[GitHub](${GITHUB_URL})`,
        ].join("\n");
      }

      // 有新版本：展示信息 + 确认按钮
      return [
        `🆕 发现新版本`,
        ``,
        `当前版本：**v${PLUGIN_VERSION}**`,
        `最新版本：**v${info.latest}**`,
        ``,
        `升级将重启 Gateway 服务，期间短暂不可用。`,
        `请确认主机网络可正常访问 npm 仓库。`,
        ``,
        `**点击确认升级** <qqbot-cmd-enter text="/bot-upgrade --latest" />`,
        ``,
        `手动升级指引：[点击查看](${url})`,
        `🌟官方 GitHub 仓库：[点击前往](${GITHUB_URL})`,
      ].join("\n");
    }

    // ── --version 指定版本：先校验版本号是否存在 ──
    if (versionArg) {
      const exists = await checkVersionExists(versionArg);
      if (!exists) {
        return `❌ 版本 ${versionArg} 不存在，请检查版本号`;
      }

      // 检查是否就是当前版本
      if (versionArg === PLUGIN_VERSION && !isForce) {
        return `✅ 当前已是 v${PLUGIN_VERSION}，无需升级`;
      }
    }

    // ── --latest：检查是否需要升级 ──
    if (isLatest && !versionArg) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate && !isForce) {
        return `✅ 当前已是 v${PLUGIN_VERSION}，无需升级`;
      }
    }

    const targetVersion = versionArg || info.latest || undefined;

    // 加锁
    _upgrading = true;

    // 热更新前保存凭证快照，防止更新过程被打断导致 appId/secret 丢失
    preUpgradeCredentialBackup(ctx.accountId, ctx.appId);

    // 异步执行升级
    const startResult = fireHotUpgrade(targetVersion);
    if (!startResult.ok) {
      _upgrading = false;
      if (startResult.reason === "no-script") {
        return [
          `❌ 未找到升级脚本，无法执行热更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (startResult.reason === "no-cli") {
        return [
          `❌ 未找到 CLI 工具，无法执行热更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      return [
        `❌ 当前环境不支持热更新（需要 bash）`,
        ``,
        `Windows 用户请安装 Git for Windows 后重试`,
        `查看手动升级指引：[点击查看](${url})`,
      ].join("\n");
    }

    saveUpgradeGreetingTarget(ctx.accountId, ctx.appId, ctx.senderId);

    const resultLines = [
      `🔄 正在升级...`,
      ``,
      `当前版本：v${PLUGIN_VERSION}`,
    ];
    if (targetVersion) {
      resultLines.push(`目标版本：v${targetVersion}`);
    }
    resultLines.push(``);
    resultLines.push(`预计 30~60 秒完成，届时会自动通知您`);
    return resultLines.join("\n");
  },
});

/**
 * /bot-logs — 导出本地日志文件
 *
 * 日志定位策略（兼容腾讯云/各云厂商不同安装路径）：
 * 1. 优先使用 *_STATE_DIR 环境变量（OPENCLAW/CLAWDBOT/MOLTBOT）
 * 2. 扫描常见状态目录：~/.openclaw, ~/.clawdbot, ~/.moltbot 及其 logs 子目录
 * 3. 扫描 home/cwd/AppData 下名称包含 openclaw/clawdbot/moltbot 的目录
 * 4. 在候选目录中选取最近更新的日志文件（gateway/openclaw/clawdbot/moltbot）
 */
function collectCandidateLogDirs(): string[] {
  const homeDir = getHomeDir();
  const dirs = new Set<string>();

  const pushDir = (p?: string) => {
    if (!p) return;
    const normalized = path.resolve(p);
    dirs.add(normalized);
  };

  const pushStateDir = (stateDir?: string) => {
    if (!stateDir) return;
    pushDir(stateDir);
    pushDir(path.join(stateDir, "logs"));
  };

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/STATE_DIR$/i.test(key) && /(OPENCLAW|CLAWDBOT|MOLTBOT)/i.test(key)) {
      pushStateDir(value);
    }
  }

  for (const name of [".openclaw", ".clawdbot", ".moltbot", "openclaw", "clawdbot", "moltbot"]) {
    pushDir(path.join(homeDir, name));
    pushDir(path.join(homeDir, name, "logs"));
  }

  const searchRoots = new Set<string>([
    homeDir,
    process.cwd(),
    path.dirname(process.cwd()),
  ]);
  if (process.env.APPDATA) searchRoots.add(process.env.APPDATA);
  if (process.env.LOCALAPPDATA) searchRoots.add(process.env.LOCALAPPDATA);

  for (const root of searchRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/(openclaw|clawdbot|moltbot)/i.test(entry.name)) continue;
        const base = path.join(root, entry.name);
        pushDir(base);
        pushDir(path.join(base, "logs"));
      }
    } catch {
      // 无权限或不存在，跳过
    }
  }

  return Array.from(dirs);
}

type LogCandidate = {
  filePath: string;
  sourceDir: string;
  mtimeMs: number;
};

function collectRecentLogFiles(logDirs: string[]): LogCandidate[] {
  const candidates: LogCandidate[] = [];
  const dedupe = new Set<string>();

  const pushFile = (filePath: string, sourceDir: string) => {
    const normalized = path.resolve(filePath);
    if (dedupe.has(normalized)) return;
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) return;
      dedupe.add(normalized);
      candidates.push({ filePath: normalized, sourceDir, mtimeMs: stat.mtimeMs });
    } catch {
      // 文件不存在或无权限
    }
  };

  for (const dir of logDirs) {
    pushFile(path.join(dir, "gateway.log"), dir);
    pushFile(path.join(dir, "gateway.err.log"), dir);
    pushFile(path.join(dir, "openclaw.log"), dir);
    pushFile(path.join(dir, "clawdbot.log"), dir);
    pushFile(path.join(dir, "moltbot.log"), dir);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(log|txt)$/i.test(entry.name)) continue;
        if (!/(gateway|openclaw|clawdbot|moltbot)/i.test(entry.name)) continue;
        pushFile(path.join(dir, entry.name), dir);
      }
    } catch {
      // 无权限或不存在，跳过
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

registerCommand({
  name: "bot-logs",
  description: "导出本地日志文件",
  usage: [
    `/bot-logs`,
    ``,
    `导出最近的 OpenClaw 日志文件（最多 4 个）。`,
    `每个文件最多保留最后 1000 行，以文件形式返回。`,
  ].join("\n"),
  handler: () => {
    const logDirs = collectCandidateLogDirs();
    const recentFiles = collectRecentLogFiles(logDirs).slice(0, 4);

    if (recentFiles.length === 0) {
      const searched = logDirs.map(d => `  - ${d}`).join("\n");
      return `⚠️ 未找到日志文件\n\n已搜索以下路径：\n${searched}`;
    }

    const lines: string[] = [];
    let totalIncluded = 0;
    let totalOriginal = 0;
    let truncatedCount = 0;
    const MAX_LINES_PER_FILE = 1000;
    for (const logFile of recentFiles) {
      try {
        const content = fs.readFileSync(logFile.filePath, "utf8");
        const allLines = content.split("\n");
        const totalFileLines = allLines.length;
        const tail = allLines.slice(-MAX_LINES_PER_FILE);
        if (tail.length > 0) {
          const fileName = path.basename(logFile.filePath);
          lines.push(`\n========== ${fileName} (last ${tail.length} of ${totalFileLines} lines) ==========`);
          lines.push(`from: ${logFile.sourceDir}`);
          lines.push(...tail);
          totalIncluded += tail.length;
          totalOriginal += totalFileLines;
          if (totalFileLines > MAX_LINES_PER_FILE) truncatedCount++;
        }
      } catch {
        lines.push(`[读取 ${path.basename(logFile.filePath)} 失败]`);
      }
    }

    if (lines.length === 0) {
      return `⚠️ 找到日志文件但读取失败，请检查文件权限`;
    }

    const tmpDir = getQQBotDataDir("downloads");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}.txt`);
    fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

    const fileCount = recentFiles.length;
    const topSources = Array.from(new Set(recentFiles.map(item => item.sourceDir))).slice(0, 3);
    // 紧凑摘要：N 个日志文件，共 X 行（如有截断则注明）
    let summaryText = `${fileCount} 个日志文件，共 ${totalIncluded} 行`;
    if (truncatedCount > 0) {
      summaryText += `（${truncatedCount} 个文件因过长仅保留最后 ${MAX_LINES_PER_FILE} 行，原始共 ${totalOriginal} 行）`;
    }
    return {
      text: `📋 ${summaryText}\n📂 来源：${topSources.join(" | ")}`,
      filePath: tmpFile,
    };
  },
});

// ============ 匹配入口 ============

/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) return null;

  // 解析指令名和参数
  const spaceIdx = content.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const cmd = commands.get(cmdName);
  if (!cmd) return null; // 不是插件级指令，交给框架

  // /指令 ? — 返回用法说明
  if (args === "?") {
    if (cmd.usage) {
      return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
    }
    return `/${cmd.name} — ${cmd.description}`;
  }

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
