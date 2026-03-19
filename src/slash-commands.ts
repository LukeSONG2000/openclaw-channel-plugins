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
import { getUpdateInfo } from "./update-checker.js";
import { getHomeDir, isWindows } from "./utils/platform.js";
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
  handler: () => {
    const frameworkVersion = getFrameworkVersion();
    const lines = [
      `🦞框架版本：${frameworkVersion}`,
      `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
    ];
    const info = getUpdateInfo();
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
 * 找到升级脚本路径
 */
function getUpgradeScriptPath(): string | null {
  const currentFile = fileURLToPath(import.meta.url);
  const scriptDir = path.resolve(path.dirname(currentFile), "..", "..", "scripts");
  const scriptPath = path.join(scriptDir, "upgrade-via-npm.sh");
  return fs.existsSync(scriptPath) ? scriptPath : null;
}

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
 * 执行热更新：执行脚本(--no-restart) → 触发 gateway restart
 *
 * fire-and-forget 操作：
 * - 异步执行升级脚本（--no-restart，只做文件替换）
 * - 脚本完成后触发 gateway restart（当前进程会被杀掉）
 * - 新进程启动时 getStartupGreeting() 检测到版本变更，自动通知管理员
 *
 * @returns true 表示已启动升级流程，false 表示无法执行（如 Windows 无 bash）
 */
function fireHotUpgrade(targetVersion?: string): boolean {
  const scriptPath = getUpgradeScriptPath();
  if (!scriptPath) return false;

  const cli = findCli();
  if (!cli) return false;

  const bash = findBash();
  if (!bash) return false;

  const args: string[] = ["--no-restart"];
  if (targetVersion) {
    args.push("--version", targetVersion);
  }

  // 异步执行升级脚本
  execFile(bash, [scriptPath, ...args], {
    timeout: 120_000,
    env: { ...process.env },
    ...(isWindows() ? { windowsHide: true } : {}),
  }, (error, _stdout, _stderr) => {
    if (error) {
      return;
    }

    // 文件替换成功，触发 gateway restart
    execFile(cli, ["gateway", "restart"], { timeout: 30_000 }, () => {});
  });

  return true;
}

/**
 * /bot-upgrade — 查看版本更新状态 + 升级指引（根据 upgradeMode 决定行为）
 */
registerCommand({
  name: "bot-upgrade",
  description: "查看版本更新与升级指引",
  handler: (ctx) => {
    // 升级相关指令仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    const upgradeMode = ctx.accountConfig?.upgradeMode || "doc";
    const url = ctx.accountConfig?.upgradeUrl || DEFAULT_UPGRADE_URL;
    const info = getUpdateInfo();
    const lines: string[] = [];

    lines.push(`📌当前版本：v${PLUGIN_VERSION}`);

    if (info.checkedAt === 0) {
      lines.push(`⏳ 版本检查中，请稍后再试`);
      return lines.join("\n");
    } else if (info.error) {
      lines.push(`⚠️ 版本检查失败`);
      lines.push(`⬆️升级指引：[点击查看](${url})`);
      return lines.join("\n");
    } else if (info.hasUpdate && info.latest) {
      lines.push(`🆕最新可用版本：v${info.latest}`);
    } else {
      lines.push(`✅ 当前已是最新版本`);
      return lines.join("\n");
    }

    // 有新版本：根据 upgradeMode 决定行为
    if (upgradeMode === "hot-reload") {
      const started = fireHotUpgrade(info.latest!);
      if (!started) {
        lines.push(`⚠️ 当前环境不支持热更新（需要 bash 环境）`);
        lines.push(`⬆️升级指引：[点击查看](${url})`);
        return lines.join("\n");
      }
      lines.push(``);
      lines.push(`🔄 正在执行热更新到 v${info.latest}...`);
      lines.push(`⏳ 升级过程约需 30~60 秒，完成后会自动通知您`);
      return lines.join("\n");
    }

    // doc 模式：展示升级文档
    lines.push(`⬆️升级指引：[点击查看](${url})`);
    lines.push(`🌟官方 GitHub 仓库：[点击前往](https://github.com/tencent-connect/openclaw-qqbot/)`);
    lines.push(``, `> 💡 提示：管理员可通过 <qqbot-cmd-input text="/bot-hot-upgrade" show="/bot-hot-upgrade"/> 直接执行热更新`);
    return lines.join("\n");
  },
});

/**
 * /bot-hot-upgrade — 直接执行热更新（无论 upgradeMode 配置如何）
 *
 * 支持参数：
 *   /bot-hot-upgrade           — 升级到 latest
 *   /bot-hot-upgrade 1.6.4     — 升级到指定版本
 *   /bot-hot-upgrade --force   — 强制升级（即使当前已是最新版）
 */
registerCommand({
  name: "bot-hot-upgrade",
  description: "直接执行热更新升级",
  handler: (ctx) => {
    // 升级相关指令仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    // 前置检查
    const scriptPath = getUpgradeScriptPath();
    if (!scriptPath) {
      return "❌ 升级脚本不存在，请检查安装是否完整";
    }
    const cli = findCli();
    if (!cli) {
      return "❌ 未找到 openclaw / clawdbot / moltbot CLI";
    }

    const args = ctx.args.trim();
    const info = getUpdateInfo();

    // 解析参数
    const isForce = args.includes("--force");
    const versionArg = args.replace("--force", "").trim() || undefined;

    // 如果没有指定版本，先检查是否有更新
    if (!versionArg && !isForce) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (!info.hasUpdate && !info.error) {
        return `✅ 当前版本 v${PLUGIN_VERSION} 已是最新，无需升级\n\n> 💡 使用 /bot-hot-upgrade --force 可强制重新安装`;
      }
    }

    const targetVersion = versionArg || info.latest || undefined;

    // 异步执行升级
    const started = fireHotUpgrade(targetVersion);
    if (!started) {
      return `❌ 当前环境不支持热更新（需要 bash 环境）\n\n> Windows 用户请安装 Git for Windows 后重试，或手动执行升级脚本`;
    }

    const lines = [
      `🔄 开始热更新...`,
      `📌 当前版本：v${PLUGIN_VERSION}`,
    ];
    if (targetVersion) {
      lines.push(`🎯 目标版本：v${targetVersion}`);
    }
    lines.push(``);
    lines.push(`⏳ 升级过程约需 30~60 秒，完成后会自动通知您`);
    return lines.join("\n");
  },
});

/**
 * /bot-logs — 导出本地日志文件
 *
 * 日志路径检测策略（兼容特殊安装路径和 --profile/--dev 模式）：
 * 1. OPENCLAW_STATE_DIR 环境变量指定的目录
 * 2. 扫描 home 目录下所有 .openclaw-xxx/logs/ 目录，取最近修改的 gateway.log
 */
registerCommand({
  name: "bot-logs",
  description: "导出本地日志文件",
  handler: () => {
    const homeDir = getHomeDir();

    // 收集所有可能的日志目录
    const logDirs: string[] = [];

    // 优先：环境变量指定的状态目录
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (stateDir) {
      logDirs.push(path.join(stateDir, "logs"));
    }

    // 扫描搜索根目录列表（兼容 Windows APPDATA 路径）
    const searchRoots = new Set<string>([homeDir]);
    const appData = process.env.APPDATA; // Windows: C:\Users\xxx\AppData\Roaming
    if (appData) searchRoots.add(appData);
    const localAppData = process.env.LOCALAPPDATA; // Windows: C:\Users\xxx\AppData\Local
    if (localAppData) searchRoots.add(localAppData);

    for (const root of searchRoots) {
      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && (entry.name.startsWith(".openclaw") || entry.name.startsWith("openclaw"))) {
            const candidate = path.join(root, entry.name, "logs");
            if (!logDirs.includes(candidate)) {
              logDirs.push(candidate);
            }
          }
        }
      } catch {
        // 无权限或不存在，跳过
      }
    }

    // 兜底：默认路径
    const defaultLogDir = path.join(homeDir, ".openclaw", "logs");
    if (!logDirs.includes(defaultLogDir)) {
      logDirs.push(defaultLogDir);
    }

    // 从所有候选目录中找到存在且最近修改的 gateway.log
    let bestLogDir: string | null = null;
    let bestMtime = 0;

    for (const logDir of logDirs) {
      const gatewayLog = path.join(logDir, "gateway.log");
      try {
        const stat = fs.statSync(gatewayLog);
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestLogDir = logDir;
        }
      } catch {
        // 不存在或无权限，跳过
      }
    }

    if (!bestLogDir) {
      const searched = logDirs.map(d => `  - ${d}`).join("\n");
      return `⚠️ 未找到日志文件\n\n已搜索以下路径：\n${searched}`;
    }

    const gatewayLog = path.join(bestLogDir, "gateway.log");
    const errLog = path.join(bestLogDir, "gateway.err.log");

    const lines: string[] = [];

    for (const logFile of [gatewayLog, errLog]) {
      if (!fs.existsSync(logFile)) continue;
      try {
        const content = fs.readFileSync(logFile, "utf8");
        const allLines = content.split("\n");
        const tail = allLines.slice(-1000);
        if (tail.length > 0) {
          lines.push(`\n========== ${path.basename(logFile)} (last ${tail.length} lines) ==========\n`);
          lines.push(...tail);
        }
      } catch {
        lines.push(`[读取 ${path.basename(logFile)} 失败]`);
      }
    }

    if (lines.length === 0) {
      return `⚠️ 日志文件为空（路径：${bestLogDir}）`;
    }

    // 写入临时文件
    const tmpDir = path.join(homeDir, ".openclaw", "qqbot", "downloads");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}.txt`);
    fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

    const totalLines = lines.filter(l => !l.startsWith("=")).length;
    return {
      text: `📋 日志已打包（约 ${totalLines} 行），正在发送文件...\n📂 来源：${bestLogDir}`,
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

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
