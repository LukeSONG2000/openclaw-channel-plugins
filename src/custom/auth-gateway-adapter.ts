import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { getSlashCommandCapability } from "../slash-commands.js";
import {
  type CustomAuthorizationCheckResult,
  type CustomAuthorizationRuntime,
} from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import {
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "./queued-message-context.js";
import {
  formatCustomActorIdentity,
  formatCustomPeerIdentity,
} from "./identity-presentation.js";
import { slashCommandInput } from "./command-link.js";
import { formatCapabilityForUser } from "./presentation-labels.js";
import type {
  CustomActor,
  CustomCapability,
  CustomPeer,
} from "./types.js";

export {
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "./queued-message-context.js";

export interface CustomSlashAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  cfg?: OpenClawConfig;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "not_custom_command" | "allowed" | "denied";
}

export interface CustomDispatchAuthorizationDecision {
  enabled: boolean;
  allowed: boolean;
  cfg?: OpenClawConfig;
  capability?: Exclude<CustomCapability, "*">;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "runtime_disabled" | "allowed" | "denied";
}

export function resolveCustomDispatchCapability(params: {
  cfg: OpenClawConfig;
  message: QueuedMessage;
  rawContent: string;
}): Exclude<CustomCapability, "*"> {
  if (params.message._customUnreadSnapshotId) return "chat.send";

  const content = params.rawContent.trim();

  if (detectCustomRuleWriteIntent(content)) return "config.write";
  if (detectCustomDeployApplyIntent(content)) return "deploy.apply";
  if (detectCustomConfigReadIntent(content)) return "config.read";
  if (detectCustomCodexRunIntent(content)) return "codex.run";
  if (detectCustomWebSearchIntent(content)) return "web.search";
  if (content.startsWith("/")) return "codex.run";

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const capabilities = scene.capabilities ?? [];
  if (!capabilities.includes("chat.send") && capabilities.includes("codex.run")) {
    return "codex.run";
  }
  if (!capabilities.includes("chat.send") && capabilities.includes("system.status")) {
    return "system.status";
  }
  if (runtime.enabled && runtime.defaultScene === "default-dm" && params.message.type !== "group" && !capabilities.includes("chat.send")) {
    return "codex.run";
  }
  return "chat.send";
}

export function detectCustomRuleWriteIntent(content: string): boolean {
  const text = content.replace(/<@[^>]+>/g, " ").trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  if (/(agents?\.md|memory\.md|soul\.md|tools\.md|heartbeat\.md|bootstrap\.md)/i.test(text)) {
    return /(写入|写进|写到|保存|追加|新增|添加|修改|改成|删除|移除|更新|规则|记忆|指令)/.test(text);
  }

  if (/(删除|删掉|移除|清空|擦除|抹掉|重置|忘记|忘掉|改掉|修改|更新).{0,24}(今天|今日|所有|全部|这次|当前|机器人|bot|ai|AI)?.{0,16}(记忆|memory|Memory|MEMORY)/i.test(text)) return true;
  if (/(记忆|memory|Memory|MEMORY).{0,24}(删除|删掉|移除|清空|擦除|抹掉|重置|忘记|忘掉|改掉|修改|更新|别记了|不要记)/i.test(text)) return true;
  if (/(保存到记忆|存到记忆|写入记忆|写进记忆|保存进记忆|记到记忆|记下来|记住)/.test(text)) return true;
  if (/(新增|添加|修改|改成|删除|移除|更新).{0,12}(规则|指令|提示词|prompt)/i.test(text)) return true;
  if (/(规则|指令|提示词|prompt).{0,12}(新增|添加|修改|改成|删除|移除|更新|写入|保存)/i.test(text)) return true;
  if (/以后.{0,24}(有人|群里|大家|谁|用户).{0,24}(说|发|问|询问|提到|触发).{0,32}(回复|回答|回|说|输出)/.test(text)) return true;
  if (/(当|如果|若|只要|遇到|看到|收到).{0,40}(用户|有人|群里|大家|谁|成员|对方)?.{0,24}(说|发|发送|问|询问|提到|触发|输入|出现|包含).{0,48}(回复|回答|回|说|输出)/.test(text)) return true;
  if (/(说|发|发送|问|询问|提到|触发|输入|出现|包含).{0,40}(时|的时候|后|就|则|，|,).{0,32}(回复|回答|回|说|输出)/.test(text)
    && /(当|如果|若|只要|遇到|看到|收到|用户|有人|群里|大家|谁|成员|对方)/.test(text)) return true;
  if (/以后.{0,24}(回复|回答|回|说|输出).{0,32}(规则|记忆)/.test(text)) return true;

  return lower.includes("agent.md") && /(写|改|删|规则|记忆)/.test(text);
}

export function detectCustomDeployApplyIntent(content: string): boolean {
  const text = content.replace(/<@[^>]+>/g, " ").trim();
  if (!text) return false;
  return [
    /(安装|卸载|升级|更新|重启|启动|停止|部署|发布|回滚).{0,40}(openclaw|gateway|服务|service|插件|plugin|npm|pnpm|yarn|pip|python|node|dnf|yum|apt|gh|github|GitHub|系统|服务器|环境)/i,
    /(openclaw|gateway|服务|service|插件|plugin|npm|pnpm|yarn|pip|python|node|dnf|yum|apt|gh|github|GitHub).{0,40}(安装|卸载|升级|更新|重启|启动|停止|部署|发布|回滚|登录)/i,
    /(帮我|给我|现在|继续).{0,24}(安装|升级|更新|重启|部署|配置|配).{0,24}(github|GitHub|gh|ssh|key|环境|服务|插件|openclaw)/i,
    /(cli|CLI).{0,12}(登录|登陆|auth|login)/i,
  ].some((pattern) => pattern.test(text));
}

export function detectCustomConfigReadIntent(content: string): boolean {
  const text = content.replace(/<@[^>]+>/g, " ").trim();
  if (!text) return false;
  return [
    /(查看|看一下|查一下|检查|读取|读一下|列出|找一下|有没有|当前).{0,32}(环境|配置|变量|密钥|秘钥|token|secret|ssh|key|文件|目录|workspace|日志|log|仓库|repo|git|github|GitHub)/i,
    /(环境|配置|变量|密钥|秘钥|token|secret|ssh|key|文件|目录|workspace|日志|log|仓库|repo|git|github|GitHub).{0,32}(查看|看一下|查一下|检查|读取|读一下|列出|有没有|是什么|在哪)/i,
    /(查看|看一下|查一下|读取|读一下|列出|有哪些|什么).{0,20}(记忆|memory|Memory|MEMORY).{0,20}(文件|信息|内容)?/i,
    /(记忆|memory|Memory|MEMORY).{0,12}(文件|内容|信息).{0,20}(查看|看一下|查一下|读取|有哪些|是什么)?/i,
  ].some((pattern) => pattern.test(text));
}

export function detectCustomWebSearchIntent(content: string): boolean {
  const text = content.replace(/<@[^>]+>/g, " ").trim();
  if (!text) return false;
  return [
    /^\/(?:search|web-search|web_search|web|tavily)(?:\s|$)/i,
    /(联网|上网|网页|网上|网络|互联网|web|google|Google|百度|必应|bing|Bing|新闻|最新|今天|今日).{0,24}(搜索|搜一下|查一下|查询|检索|找一下)/i,
    /(搜索|搜一下|查一下|查询|检索|找一下).{0,24}(联网|上网|网页|网上|网络|互联网|web|google|Google|百度|必应|bing|Bing|新闻|最新|今天|今日)/i,
  ].some((pattern) => pattern.test(text));
}

export function detectCustomCodexRunIntent(content: string): boolean {
  const text = content.replace(/<@[^>]+>/g, " ").trim();
  if (!text) return false;
  return [
    /(执行|运行|跑一下|调用|打开|创建|生成|修改|改一下|修复|删除|清空).{0,40}(命令|shell|终端|脚本|代码|仓库|repo|文件|目录|workspace|当前环境|本地|服务器)/i,
    /(帮我|给我|继续).{0,30}(配|配置|改|修|写|建|生成|删除|清空|执行|运行).{0,40}(github|GitHub|git|ssh|key|命令|脚本|代码|文件|目录|workspace|当前环境|本地|服务器)/i,
    /(当前环境|本地|服务器|workspace|仓库|repo).{0,40}(执行|运行|配置|修改|写入|删除|清空|创建|生成|修复)/i,
  ].some((pattern) => pattern.test(text));
}

export function checkCustomDispatchAuthorization(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  capability?: Exclude<CustomCapability, "*">;
  now?: number;
}): CustomDispatchAuthorizationDecision {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return { enabled: false, allowed: true, cfg: params.cfg, reason: "runtime_disabled" };
  }

  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);
  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const capability = params.capability ?? resolveCustomDispatchCapability({
    cfg: params.cfg,
    message: params.message,
    rawContent: params.rawContent,
  });
  const result = params.auth.check({
    runtime,
    scene,
    peer,
    actor,
    capability,
    now: params.now,
  });

  return {
    enabled: true,
    allowed: result.decision.allowed,
    cfg: params.cfg,
    capability,
    peer,
    actor,
    result,
    reason: result.decision.allowed ? "allowed" : "denied",
  };
}

export function checkCustomSlashAuthorization(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomSlashAuthorizationDecision {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) {
    return { enabled: false, allowed: true, cfg: params.cfg, reason: "runtime_disabled" };
  }

  const capability = getSlashCommandCapability(params.rawContent);
  if (!capability) {
    return { enabled: true, allowed: true, cfg: params.cfg, reason: "not_custom_command" };
  }

  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);
  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const result = params.auth.check({
    runtime,
    scene,
    peer,
    actor,
    capability,
    now: params.now,
  });

  return {
    enabled: true,
    allowed: result.decision.allowed,
    cfg: params.cfg,
    capability,
    peer,
    actor,
    result,
    reason: result.decision.allowed ? "allowed" : "denied",
  };
}

export function formatCustomDispatchAuthorizationDeniedMessage(decision: CustomDispatchAuthorizationDecision): string {
  return formatCustomAuthorizationDeniedCore({
    title: "⛔ 需要授权",
    capability: decision.capability,
    actor: decision.actor,
    peer: decision.peer,
    cfg: decision.cfg,
    requestId: decision.result?.decision.requestId,
  });
}

export function formatCustomAuthorizationDeniedMessage(decision: CustomSlashAuthorizationDecision): string {
  return formatCustomAuthorizationDeniedCore({
    title: "⛔ 需要授权",
    capability: decision.capability,
    actor: decision.actor,
    peer: decision.peer,
    cfg: decision.cfg,
    requestId: decision.result?.decision.requestId,
  });
}

function formatCustomAuthorizationDeniedCore(params: {
  title: string;
  capability?: Exclude<CustomCapability, "*">;
  actor?: CustomActor;
  peer?: CustomPeer;
  cfg?: OpenClawConfig;
  requestId?: string;
}): string {
  const capability = params.capability ? formatCapabilityForUser(params.capability) : "未知";
  const actor = params.actor
    ? formatCustomActorIdentity(params.actor, { idLabel: params.peer?.kind === "group" ? "member_openid" : "user_openid" })
    : "当前用户";
  const peer = params.peer ? formatCustomPeerIdentity(params.peer, params.cfg) : "当前会话";
  const lines = [
    params.title,
    `位置：${peer}`,
    `用户：${actor}`,
    `权限：${capability}`,
  ];

  if (params.requestId) {
    lines.push(`操作：${slashCommandInput(`/bot-auth approve ${params.requestId} once`, "允许一次")} ${slashCommandInput(`/bot-auth deny ${params.requestId}`, "拒绝")}`);
  }

  return lines.join("\n");
}

export {
  buildCustomAuthAdminGroupNotification,
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthApprovalText,
  describeCustomAuthorizationIntents,
  firstCustomAuthApprovalRequest,
  handleCustomAuthCommand,
  handleCustomAuthInteraction,
  parseCustomAuthButtonData,
  parseCustomAuthCommand,
  type CustomAuthAdminGroupNotification,
  type CustomAuthButtonPayload,
  type CustomAuthCommand,
  type CustomAuthCommandParseResult,
  type CustomAuthCommandResult,
  type CustomAuthInteractionResult,
} from "./auth-command-gateway-adapter.js";
