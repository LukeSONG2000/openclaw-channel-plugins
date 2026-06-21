import WebSocket from "ws";
import path from "node:path";
import type { ResolvedQQBotAccount, WSPayload, InteractionEvent, MsgElement, TransportMode } from "./types.js";
import { startWebhookTransport } from "./transport/index.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendDmMessage, sendGroupMessage, clearTokenCache, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify, onMessageSent, getPluginUserAgent, sendProactiveGroupMessage, acknowledgeInteraction, getApiPluginVersion, setApiLogger, sendC2CMessageWithInlineKeyboard, sendGroupMessageWithInlineKeyboard } from "./api.js";
import { loadSession, saveSession, clearSession } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { isGroupAllowed, resolveGroupName, resolveGroupPrompt, resolveHistoryLimit, resolveGroupPolicy, resolveGroupConfig, resolveIgnoreOtherMentions, resolveMentionPatterns } from "./config.js";
import { qqbotPlugin, stripMentionText, detectWasMentioned } from "./channel.js";
import { QQBotApprovalHandler, registerApprovalHandler, unregisterApprovalHandler, getApprovalHandler } from "./approval-handler.js";
import {
  formatMessageContent,
  type HistoryEntry,
} from "./group-history.js";

import { setRefIndex, getRefIndex, formatRefEntryForAgent, formatMessageReferenceForAgent, flushRefIndex, type RefAttachmentSummary } from "./ref-index-store.js";
import { matchSlashCommand, getFrameworkVersion, parseFrameworkDateVersion, type SlashCommandContext, type SlashCommandFileResult, type SlashCommandDelegateResult } from "./slash-commands.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { startImageServer, isImageServerRunning, type ImageServerConfig } from "./image-server.js";
import { resolveTTSConfig } from "./utils/audio-convert.js";
import { processAttachments, formatVoiceText } from "./inbound-attachments.js";
import { getQQBotDataDir, runDiagnostics } from "./utils/platform.js";

import { sendDocument, sendMedia as sendMediaAuto, type MediaTargetContext } from "./outbound.js";
import { parseFaceTags } from "./utils/text-parsing.js";
import { sendStartupGreetings, type AdminResolverContext } from "./admin-resolver.js";
import { sendTextToTarget, handleStructuredPayload } from "./reply-dispatcher.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";
import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";
import { createDeliverDebouncer, type DeliverDebouncer } from "./deliver-debounce.js";
import { runWithRequestContext } from "./request-context.js";
import { StreamingController, shouldUseStreaming } from "./streaming.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneState } from "./custom/config.js";
import { buildCustomSceneSystemPrompt } from "./custom/scenes.js";
import {
  buildCustomGroupMessageGateContext,
  normalizeGroupMessageContentForCommand,
  resolveCustomGroupImplicitMention,
  shouldHandleCustomTextCommands,
} from "./custom/group-message-gate-context.js";
import {
  resolveCustomGroupActivation,
  type CustomGroupActivationMode,
} from "./custom/group-activation.js";
import {
  buildCustomGroupPromptContext,
} from "./custom/group-prompt-context.js";
import { buildCustomAgentMessageBodyContext } from "./custom/agent-message-body-context.js";
import { buildCustomInboundContextPayload } from "./custom/inbound-context-payload.js";
import { buildCustomGatewayReplyContext } from "./custom/reply-context-gateway-adapter.js";
import {
  buildCustomOutboundDeliverContext,
  buildCustomOutboundProactiveSource,
} from "./custom/outbound-deliver-context.js";
import { applyCustomGuardedMediaAutoSend } from "./custom/guarded-media-send-gateway-adapter.js";
import { buildCustomDispatchSendHelpers } from "./custom/dispatch-send-helpers-gateway-adapter.js";
import { applyCustomSceneAgentRoute, type CustomAgentRoute, type CustomRoutePeer } from "./custom/route.js";
import {
  CUSTOM_UNREAD_ACTOR_ID,
  type CustomMessageFlowRuntime,
  type ResolvedCustomUnreadConfig,
} from "./custom/runtime.js";
import { createCustomProactiveGatewayGuard } from "./custom/proactive-gateway-adapter.js";
import {
  observeCustomUnreadMentionBeforeDispatch,
  recordCustomUnreadNonMentionBeforeDispatch,
  resolveCustomUnreadForQueuedGroupMessage,
} from "./custom/unread-ingress.js";
import {
  applyCustomUnreadHistoryContextToAgentBody,
  recordLegacyGroupHistoryBeforeDispatch,
} from "./custom/unread-context.js";
import { applyCustomUnreadCompletionGateway } from "./custom/unread-completion-gateway-adapter.js";
import { CustomUnreadScheduler } from "./custom/unread-scheduler.js";
import { describeCustomAuthorizationIntents } from "./custom/auth-gateway-adapter.js";
import { applyCustomDispatchAuthorizationGateway } from "./custom/dispatch-authorization-gateway-adapter.js";
import { applyCustomAdminGroupDelivery } from "./custom/admin-group-delivery-gateway-adapter.js";
import { handleCustomInteractionGatewayButton, type CustomInteractionGatewayResult } from "./custom/interaction-gateway-adapter.js";
import {
  normalizeQQBotInteractionEvent,
  parseLegacyApprovalInteractionButton,
} from "./custom/interaction-event-normalizer.js";
import { createCustomMessageFlowStateController } from "./custom/message-flow-state.js";
import { handleCustomSlashGatewayCommand } from "./custom/slash-gateway-adapter.js";
import { applyCustomSlashGatewayEffects } from "./custom/slash-effects-gateway-adapter.js";
import { CustomTaskCommandExecutor } from "./custom/task-command-executor.js";
import {
  applyCustomTaskNotificationDeliveries,
  deliveriesFromCustomTaskNotifications,
  type CustomTaskNotificationDelivery,
} from "./custom/task-notification-gateway-adapter.js";
import {
  completeCustomTaskExecution,
  failCustomTaskExecution,
  heartbeatCustomTaskExecution,
  progressCustomTaskExecution,
  type CustomTaskExecutionEffect,
} from "./custom/task-executor-adapter.js";
import {
  CUSTOM_RESPONSE_TIMEOUT_MS,
  CUSTOM_TOOL_ONLY_MAX_RENEWALS,
  CUSTOM_TOOL_ONLY_TIMEOUT_MS,
} from "./custom/fallbacks.js";
import {
  handleCustomLateDispatchDeliver,
  prepareCustomBlockDeliver,
} from "./custom/dispatch-deliver-gateway-adapter.js";
import {
  handleCustomDispatchCallbackFailure,
  handleCustomDispatchRaceFailure,
  handleCustomMessageProcessingFailure,
} from "./custom/dispatch-failure-gateway-adapter.js";
import { resolveCustomFallbackAlertCooldownMs } from "./custom/fallback-alerts.js";
import { CustomFallbackDispatchState } from "./custom/fallback-dispatch-state.js";
import {
  createCustomDispatchFallbackRecorder,
  recordCustomFallbackEventGateway,
  type CustomDispatchFallbackRecorder,
} from "./custom/fallback-record-gateway-adapter.js";
import { handleCustomToolDeliverGateway } from "./custom/tool-deliver-gateway-adapter.js";
import { sendCustomToolFallback } from "./custom/tool-fallback-gateway-adapter.js";
import {
  handleCustomStreamingDeliver,
  handleCustomStreamingError,
  handleCustomStreamingPartialReply,
} from "./custom/streaming-gateway-adapter.js";
import { applyCustomStaticDeliverGateway } from "./custom/static-deliver-gateway-adapter.js";
import { dispatchCustomDebouncedDeliver } from "./custom/deliver-debounce-gateway-adapter.js";
import { finalizeCustomDispatchGateway } from "./custom/dispatch-finalize-gateway-adapter.js";
import {
  buildCustomInboundMediaContext,
  formatCustomInboundVoiceSummary,
} from "./custom/inbound-media-context.js";
import {
  buildCustomCurrentRefIndexRecord,
  resolveCustomQuoteReferenceContext,
} from "./custom/message-reference-context.js";
import { dispatchCustomInboundGatewayEvent } from "./custom/inbound-event-gateway-adapter.js";
import {
  buildCustomUpdateAvailableNotification,
  startCustomUpdateCheckLoop,
  type CustomUpdateCheckResult,
} from "./custom/update-check.js";
import { resolveCustomSlashReplyMediaTarget, resolveCustomSlashReplyTarget } from "./custom/slash-reply-target.js";
import { applyCustomUrgentQueueBypass } from "./custom/urgent-queue-bypass-gateway-adapter.js";
import { resolveCustomGatewayMessageRouteContext } from "./custom/gateway-message-routing.js";

// ============ Interaction 处理 ============

/** 配置查询交互类型 */
const INTERACTION_TYPE_CONFIG_QUERY = 2001;

/** 配置更新交互类型 */
const INTERACTION_TYPE_CONFIG_UPDATE = 2002;

/** 处理 INTERACTION_CREATE 事件 */
async function handleInteractionCreate(params: {
  event: InteractionEvent;
  account: ResolvedQQBotAccount;
  cfg: unknown;
  customAuth?: CustomMessageFlowRuntime["auth"];
  persistCustomAuthState?: () => void;
  customPolls?: CustomMessageFlowRuntime["polls"];
  persistCustomPollState?: () => void;
  customGames?: CustomMessageFlowRuntime["games"];
  persistCustomGameState?: () => void;
  customDeployConfirmations?: CustomMessageFlowRuntime["deployConfirmations"];
  persistCustomDeployConfirmationState?: () => void;
  log?: { info: (msg: string) => void; warn?: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void };
}): Promise<void> {
  const { event, account, cfg, log } = params;
  const token = await getAccessToken(account.appId, account.clientSecret);
  const interaction = normalizeQQBotInteractionEvent(event);

  if (interaction.dataType === INTERACTION_TYPE_CONFIG_QUERY) {
    // 从框架 configApi 读取最新配置（而非闭包中的旧 cfg），确保配置查询返回的数据与磁盘一致
    const runtime = getQQBotRuntime();
    const configApi = runtime.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };
    const latestCfg = configApi.loadConfig() as Record<string, unknown>;

    const groupOpenid = interaction.groupOpenid ?? "";
    const groupCfg = groupOpenid ? resolveGroupConfig(latestCfg as any, groupOpenid, account.accountId) : null;
    const groupPolicy = resolveGroupPolicy(latestCfg as any, account.accountId);
    // require_mention 协议：字符串 "mention" | "always"（mention=@机器人时激活，always=总是激活）
    const configRequireMention = groupCfg?.requireMention ?? true;
    const requireMentionMode: CustomGroupActivationMode = configRequireMention ? "mention" : "always";
    const pluginVersion = getApiPluginVersion();
    const fwVersionRaw = getFrameworkVersion();
    const clawVer = parseFrameworkDateVersion(fwVersionRaw) ?? fwVersionRaw;

    // 通过路由解析 agentId（与消息处理流程一致），用于 agent-aware 的 mentionPatterns
    const interactionAgentId = groupOpenid
      ? (() => {
        const peer: CustomRoutePeer = { kind: "group", id: groupOpenid };
        const route = runtime.channel?.routing?.resolveAgentRoute?.({
          cfg: latestCfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer,
        }) as CustomAgentRoute | undefined;
        if (!route) return undefined;
        const scene = resolveCustomRuntimeConfig(latestCfg as any).enabled
          ? resolveCustomSceneState(latestCfg as any, { kind: "group", id: groupOpenid })
          : null;
        return applyCustomSceneAgentRoute({
          route,
          scene,
          routing: runtime.channel?.routing,
          peer,
          cfg: latestCfg,
        }).agentId;
      })()
      : undefined;

    // mention_patterns 协议：逗号分隔的字符串（@文本的名称提及BOT名，多个使用,分隔）
    const mentionPatternsArr: string[] = resolveMentionPatterns(latestCfg as any, interactionAgentId);
    const mentionPatterns = mentionPatternsArr.join(",");

    const clawCfg = {
      channel_type: "qqbot",
      channel_ver: pluginVersion,
      claw_type: "openclaw",
      claw_ver: clawVer,
      require_mention: requireMentionMode,
      group_policy: groupPolicy,
      mention_patterns: mentionPatterns,
      online_state: "online",
    };

    await acknowledgeInteraction(token, event.id, 0, { claw_cfg: clawCfg });
    log?.info(`[qqbot:${account.accountId}] Interaction ACK (type=${INTERACTION_TYPE_CONFIG_QUERY}) sent: ${event.id}, claw_cfg=${JSON.stringify(clawCfg)}`);
  } else if (interaction.dataType === INTERACTION_TYPE_CONFIG_UPDATE) {
    // type=2002: 配置更新交互，从 resolved.claw_cfg 获取更新信息并写入本地配置
    const clawCfgUpdate = interaction.resolved?.claw_cfg as Record<string, unknown> | undefined;
    const groupOpenid = interaction.groupOpenid ?? "";

    const runtime = getQQBotRuntime();
    const configApi = runtime.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };

    const currentCfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
    const qqbot = ((currentCfg.channels ?? {}) as Record<string, unknown>).qqbot as Record<string, unknown> | undefined;

    let changed = false;

    if (clawCfgUpdate) {
      // 更新 require_mention（群级别）——协议为 "mention" | "always"，写回配置时转为 boolean
      if (clawCfgUpdate.require_mention !== undefined && groupOpenid && qqbot) {
        const requireMentionBool = clawCfgUpdate.require_mention === "mention";
        const accountId = account.accountId;
        const isNamedAccount = accountId !== "default" && (qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId];

        if (isNamedAccount) {
          const accounts = qqbot.accounts as Record<string, Record<string, unknown>>;
          const acct = accounts[accountId] ?? {};
          const groups = (acct.groups ?? {}) as Record<string, Record<string, unknown>>;
          groups[groupOpenid] = { ...groups[groupOpenid], requireMention: requireMentionBool };
          acct.groups = groups;
          accounts[accountId] = acct;
          qqbot.accounts = accounts;
        } else {
          const groups = (qqbot.groups ?? {}) as Record<string, Record<string, unknown>>;
          groups[groupOpenid] = { ...groups[groupOpenid], requireMention: requireMentionBool };
          qqbot.groups = groups;
        }
        changed = true;
      }
    }

    if (changed) {
      await configApi.writeConfigFile(currentCfg);
      log?.info(`[qqbot:${account.accountId}] Config updated via interaction ${event.id}: ${JSON.stringify({
        require_mention: clawCfgUpdate?.require_mention,
        group_openid: groupOpenid || undefined,
      })}`);
    }

    // 无论更新是否成功，ACK 都上报最新的 claw_cfg 快照（写入后重新读取确保一致）
    const latestCfg = changed ? (configApi.loadConfig() as Record<string, unknown>) : currentCfg;
    const updatedGroupCfg = groupOpenid ? resolveGroupConfig(latestCfg as any, groupOpenid, account.accountId) : null;
    const updatedRequireMention = updatedGroupCfg?.requireMention ?? true;
    const updatedRequireMentionMode: CustomGroupActivationMode = updatedRequireMention ? "mention" : "always";
    const pluginVersion = getApiPluginVersion();
    const fwVersionRaw = getFrameworkVersion();
    const clawVer = parseFrameworkDateVersion(fwVersionRaw) ?? fwVersionRaw;

    const ackClawCfg = {
      channel_type: "qqbot",
      channel_ver: pluginVersion,
      claw_type: "openclaw",
      claw_ver: clawVer,
      require_mention: updatedRequireMentionMode,
      online_state: "online",
    };

    await acknowledgeInteraction(token, event.id, 0, { claw_cfg: ackClawCfg });
    log?.info(`[qqbot:${account.accountId}] Interaction ACK (type=${INTERACTION_TYPE_CONFIG_UPDATE}) sent: ${event.id}, claw_cfg=${JSON.stringify(ackClawCfg)}`);
  } else {
    // 普通按钮交互：先 ACK
    await acknowledgeInteraction(token, event.id);
    log?.debug?.(`[qqbot:${account.accountId}] Interaction ACK sent: ${event.id}`);

    // Inline Keyboard 审批按钮（type=1 Callback）
    // button_data 格式：approve:<approvalId>:<decision>
    // approvalId 可能是 "exec:uuid" / "plugin:uuid"（带前缀）或纯 "uuid"（无前缀）
    const customInteraction: CustomInteractionGatewayResult = params.customAuth && params.customPolls && params.customGames && params.customDeployConfirmations ? handleCustomInteractionGatewayButton({
      cfg: cfg as any,
      accountId: account.accountId,
      runtime: { auth: params.customAuth, polls: params.customPolls, games: params.customGames, deployConfirmations: params.customDeployConfirmations },
      buttonData: interaction.buttonData,
      actor: {
        id: interaction.actorId,
      },
      sourcePeer: interaction.sourcePeer,
      now: Date.now(),
    }) : { handled: false };
    if (customInteraction.handled) {
      if (customInteraction.logs) {
        for (const item of customInteraction.logs) {
          if (item.level === "error") log?.error(`[qqbot:${account.accountId}] ${item.message}`);
          else log?.info(`[qqbot:${account.accountId}] ${item.message}`);
        }
      }
      if (customInteraction.persist?.auth) {
        params.persistCustomAuthState?.();
      }
      if (customInteraction.persist?.polls) {
        params.persistCustomPollState?.();
      }
      if (customInteraction.persist?.games) {
        params.persistCustomGameState?.();
      }
      if (customInteraction.persist?.deployConfirmations) {
        params.persistCustomDeployConfirmationState?.();
      }
      if (customInteraction.reply) {
        try {
          if (interaction.replyTarget?.kind === "group") {
            await sendGroupMessage(token, interaction.replyTarget.groupOpenid, customInteraction.reply);
          } else if (interaction.replyTarget?.kind === "c2c") {
            await sendC2CMessage(token, interaction.replyTarget.userOpenid, customInteraction.reply);
          } else if (interaction.replyTarget?.kind === "channel") {
            await sendChannelMessage(token, interaction.replyTarget.channelId, customInteraction.reply);
          }
        } catch (sendErr) {
          log?.error(`[qqbot:${account.accountId}] Failed to send custom interaction reply: ${sendErr}`);
        }
      }
      return;
    }

    const legacyApproval = parseLegacyApprovalInteractionButton(interaction.buttonData);
    if (legacyApproval) {
      log?.info(`[qqbot:${account.accountId}] Approval button clicked: approvalId=${legacyApproval.approvalId}, decision=${legacyApproval.decision}, user=${interaction.actorId}, buttonData=${interaction.buttonData}`);
      const handler = getApprovalHandler(account.accountId);
      if (handler) {
        void handler.resolveApproval(legacyApproval.approvalId, legacyApproval.decision);
      } else {
        log?.error(`[qqbot:${account.accountId}] Approval button: no handler found for accountId=${account.accountId}`);
      }
    }
  }
}

// ============ Mention Gating — 已抽取到 message-gating.ts ============

// ============ Command Detection（委托框架运行时 commands-registry） ============

/**
 * 检测消息是否包含框架控制命令（如 /activation、/status 等）。
 *
 * 不再使用静态 KNOWN_CONTROL_COMMANDS 列表，而是委托给框架运行时
 * pluginRuntime.channel.text.hasControlCommand()，确保框架新增命令时
 * 无需手动同步。
 *
 * 如果 pluginRuntime 尚未初始化（极端边界），回退到简单的 "/" 前缀检测。
 */
function hasControlCommand(text: string): boolean {
  if (!text || !text.startsWith("/")) return false;
  try {
    const runtime = getQQBotRuntime();
    const runtimeHasControlCommand = runtime?.channel?.text?.hasControlCommand;
    if (typeof runtimeHasControlCommand === "function") {
      return runtimeHasControlCommand(text);
    }
  } catch {
    // runtime 未初始化，fallback
  }
  // fallback：简单的 "/" + word 检测（宁可误判为 true 也不漏掉命令）
  return /^\/[a-z][a-z0-9_-]*/i.test(text);
}

// QQ Bot intents - 按权限级别分组
const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0,                    // 频道相关
  GUILD_MEMBERS: 1 << 1,             // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）
  INTERACTION: 1 << 26,              // 按钮交互回调
};

// 固定使用完整权限（群聊 + 私信 + 频道 + 交互），不做降级
const FULL_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION;
const FULL_INTENTS_DESC = "群聊+私信+频道+交互";

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// 图床服务器配置（可通过环境变量覆盖）
const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || getQQBotDataDir("images");


export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 启动图床服务器
 */
async function ensureImageServer(log?: GatewayContext["log"], publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}

// 模块级变量：per-account 首次 READY 跟踪
// 区分 gateway restart（进程重启）和 health-monitor 断线重连
// 每个 account 首次 READY/RESUMED 时从 Set 中移除，之后不再发送问候语
const _pendingFirstReady = new Set<string>();

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 安全网：捕获 approval-handler / SDK 内部 WS 握手异步错误（如 403），避免进程崩溃
  const wsUncaughtHandler = (err: Error) => {
    if (err.message?.includes("Unexpected server response")) {
      log?.error(`[qqbot:${account.accountId}] Caught WS handshake error (non-fatal): ${err.message}`);
      // 不重新抛出，防止进程退出
    } else {
      // 非 WS 握手错误，重新抛出交给上层处理
      throw err;
    }
  };
  process.on("uncaughtException", wsUncaughtHandler);
  abortSignal.addEventListener("abort", () => {
    process.removeListener("uncaughtException", wsUncaughtHandler);
  }, { once: true });

  // 启动环境诊断（首次连接时执行）
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // 预检 openclaw runtime 模块是否可正常解析（兼容性诊断）
  // openclaw 3.23+ 存在 plugin-sdk/root-alias.cjs 回归 bug，
  // 内置插件（qwen-portal-auth 等）全部加载失败，导致 AI agent 调用返回
  // "Unable to resolve plugin runtime module"。提前检测并告警。
  try {
    const pluginRuntime = getQQBotRuntime();
    if (pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
      log?.info(`[qqbot:${account.accountId}] Runtime module preflight: OK`);
    } else {
      log?.error(`[qqbot:${account.accountId}] ⚠️ Runtime preflight: dispatchReply API 不可用，AI 消息处理可能失败。请检查 openclaw 版本兼容性`);
    }
  } catch (preflightErr) {
    log?.error(`[qqbot:${account.accountId}] ⚠️ Runtime preflight failed: ${preflightErr}. AI 消息处理可能失败`);
  }

  // 初始化 API 配置（markdown 支持）
  // 将框架 log 注入 api 模块，统一日志输出
  if (log) {
    setApiLogger(log);
  }
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  // 注册出站消息 refIdx 缓存钩子
  // 所有消息发送函数在拿到 QQ 回包后，如果含 ref_idx 则自动回调此处缓存
  onMessageSent((refIdx, meta) => {
    log?.info(`[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`);
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      // filename 取路径的 basename，如果没有路径信息则留空
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      // 如果是语音消息且有 TTS 原文本，保存到 transcript 并标记来源为 tts
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
        log?.info(`[qqbot:${account.accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`);
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log?.info(`[qqbot:${account.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`);
  });

  // TTS 配置验证
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
  if (ttsCfg) {
    const maskedKey = ttsCfg.apiKey.length > 8
      ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
      : "****";
    log?.info(`[qqbot:${account.accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`);
    log?.info(`[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`);
  }

  // 如果配置了公网 URL，启动图床服务器
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // 使用用户配置的公网地址作为 baseUrl
    await ensureImageServer(log, account.imageServerBaseUrl);
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  // ============ Transport 模式标记 ============
  const transportMode: TransportMode = account.config.transport ?? "websocket";
  if (transportMode === "webhook") {
    log?.info(`[qqbot:${account.accountId}] Using webhook transport mode`);
  }

  // ============ WebSocket / Webhook 公共初始化 ============
  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  // 标记此 account 为待发问候（进程重启时 Set 里已有，断线重连不会重新加入）
  _pendingFirstReady.add(account.accountId);

  const adminCtx: AdminResolverContext = { accountId: account.accountId, appId: account.appId, clientSecret: account.clientSecret, log };

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}`);
  }

  // ============ 审批 Handler ============
  const approvalHandler = new QQBotApprovalHandler({
    accountId: account.accountId,
    appId: account.appId,
    clientSecret: account.clientSecret,
    cfg: cfg as any,
    log,
  });
  registerApprovalHandler(account.accountId, approvalHandler);
  approvalHandler.start().catch((err) => {
    log?.error(`[qqbot:${account.accountId}] approval-handler: uncaught start error: ${err}`);
  });

  // ============ 消息队列（复用 createMessageQueue，内置群消息合并/淘汰策略） ============
  const msgQueue = createMessageQueue({
    accountId: account.accountId,
    log,
    isAborted: () => isAborted,
  });
  const customState = createCustomMessageFlowStateController({
    accountId: account.accountId,
    log,
  });
  const customMessageFlow = customState.runtime;
  for (const item of describeCustomAuthorizationIntents(customState.restoredAuthIntents)) {
    log?.info(`[qqbot:${account.accountId}] custom auth restore: ${item}`);
  }
  const persistCustomAuthState = customState.persistAuthState;
  const persistCustomProactiveBudgetState = customState.persistProactiveBudgetState;
  const persistCustomTaskState = customState.persistTaskState;
  const persistCustomPollState = customState.persistPollState;
  const persistCustomGameState = customState.persistGameState;
  const persistCustomDeployConfirmationState = customState.persistDeployConfirmationState;
  const persistCustomUnreadState = customState.persistUnreadState;
  let customUnreadScheduler: CustomUnreadScheduler | null = null;
  let customTaskExecutor: CustomTaskCommandExecutor | null = null;

  const isCustomRuntimeEnabled = (): boolean =>
    resolveCustomRuntimeConfig(cfg as any).enabled === true;

  const buildCustomProactiveGuard = (source?: {
    actor?: { id: string; label?: string; isBot?: boolean };
    messageId?: string;
    timestamp?: number;
  }) => ({
    proactiveGuard: createCustomProactiveGatewayGuard({
      cfg: cfg as any,
      accountId: account.accountId,
      budget: customMessageFlow.proactiveBudget,
      persistBudgetState: persistCustomProactiveBudgetState,
      log,
      actor: source?.actor,
      sourceMessageId: source?.messageId,
      sourceTimestamp: source?.timestamp,
    }),
  });

  const sendCustomAuthAdminGroupNotification = async (notification: {
    groupOpenid: string;
    text: string;
    keyboard?: import("./types.js").InlineKeyboard;
    requestId: string;
    source: "slash" | "dispatch";
  }): Promise<void> => {
    await sendCustomAdminGroupDelivery({
      groupOpenid: notification.groupOpenid,
      text: notification.text,
      keyboard: notification.keyboard,
      label: "auth admin-group notification",
      details: `source=${notification.source} request=${notification.requestId}`,
    });
  };

  const fallbackAlertCooldowns = new Map<string, number>();
  const sendCustomAdminGroupDelivery = async (delivery: {
    groupOpenid: string;
    text: string;
    keyboard?: import("./types.js").InlineKeyboard;
    label: string;
    details: string;
    cooldownKey?: string;
    cooldownMs?: number;
  }): Promise<void> => {
    const proactive = buildCustomProactiveGuard();
    await applyCustomAdminGroupDelivery({
      accountId: account.accountId,
      delivery,
      proactiveGuard: proactive.proactiveGuard,
      cooldowns: fallbackAlertCooldowns,
      log,
      sendText: async (groupOpenid, text) => {
        const token = await getAccessToken(account.appId, account.clientSecret);
        await sendGroupMessage(token, groupOpenid, text);
      },
      sendKeyboard: async (groupOpenid, text, keyboard) => {
        const token = await getAccessToken(account.appId, account.clientSecret);
        await sendGroupMessageWithInlineKeyboard(token, groupOpenid, text, keyboard);
      },
    });
  };

  const sendCustomFallbackAdminGroupAlert = async (alert: {
    groupOpenid: string;
    text: string;
    keyboard?: import("./types.js").InlineKeyboard;
    cooldownKey: string;
    eventCount?: number;
  }): Promise<void> => {
    const runtime = resolveCustomRuntimeConfig(cfg as any);
    const cooldownMs = resolveCustomFallbackAlertCooldownMs(runtime);
    await sendCustomAdminGroupDelivery({
      groupOpenid: alert.groupOpenid,
      text: alert.text,
      keyboard: alert.keyboard,
      label: "fallback admin-group alert",
      details: `key=${alert.cooldownKey} count=${alert.eventCount ?? "?"}`,
      cooldownKey: alert.cooldownKey,
      cooldownMs,
    });
  };

  const sendCustomUpdateAvailableNotification = async (result: CustomUpdateCheckResult): Promise<void> => {
    const notification = buildCustomUpdateAvailableNotification({
      accountId: account.accountId,
      runtime: resolveCustomRuntimeConfig(cfg as any),
      result,
    });
    if (!notification) {
      log?.debug?.(`[qqbot:${account.accountId}] custom update available notification skipped: missing custom runtime admin group or not notifiable`);
      return;
    }

    await sendCustomAdminGroupDelivery({
      groupOpenid: notification.groupOpenid,
      text: notification.text,
      keyboard: notification.keyboard,
      label: "update available notification",
      details: `package=${notification.packageName} latest=${notification.latest}`,
    });
  };

  // 后台二开版本检查：只检查个人包更新，不自动安装。
  const customUpdateCheck = startCustomUpdateCheckLoop({
    accountId: account.accountId,
    accountConfig: account.config,
    log,
    onUpdateAvailable: sendCustomUpdateAvailableNotification,
  });

  // 斜杠指令拦截：在入队前匹配插件级指令，命中则直接回复，不入队
  // 紧急命令列表：这些命令会立即执行，不进入斜杠匹配流程
  // /stop     — 停止当前 agent run，清空队列
  // /approve  — 审批决策，必须在 agent 等待审批时立即执行，否则死锁
  // /new 和 /compact — 上下文异常或超长时必须能绕过队列，恢复客户端可操作性
  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    const rawContent = (msg.content ?? "").trim();
    const content = msg.type === "group" && msg.mentions?.length
      ? (stripMentionText(rawContent, msg.mentions as any) ?? rawContent).trim()
      : rawContent;
    if (!content.startsWith("/")) {
      msgQueue.enqueue(msg);
      return;
    }

    const urgentBypass = applyCustomUrgentQueueBypass({
      accountId: account.accountId,
      content,
      message: msg,
      queue: msgQueue,
      recordFallbackEvent: (event) => {
        recordCustomFallbackEventGateway({
          accountId: account.accountId,
          event,
          log,
        });
      },
      log,
    });
    if (urgentBypass.handled) {
      return;
    }

    const receivedAt = Date.now();
    const peerId = msgQueue.getMessagePeerId(msg);

    const cmdCtx: SlashCommandContext = {
      type: msg.type,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      eventTimestamp: msg.timestamp,
      receivedAt,
      rawContent: content,
      args: "",
      channelId: msg.channelId,
      groupOpenid: msg.groupOpenid,
      accountId: account.accountId,
      appId: account.appId,
      accountConfig: account.config,
      queueSnapshot: msgQueue.getSnapshot(peerId),
    };

    try {
      const sendSlashTextReply = async (text: string): Promise<void> => {
        const token = await getAccessToken(account.appId, account.clientSecret);
        const target = resolveCustomSlashReplyTarget(msg);
        if (!target) {
          log?.error(`[qqbot:${account.accountId}] Unable to resolve slash reply target for ${msg.type} message ${msg.messageId}`);
          return;
        }
        if (target.kind === "c2c") {
          await sendC2CMessage(token, target.userOpenid, text, target.msgId);
        } else if (target.kind === "group") {
          await sendGroupMessage(token, target.groupOpenid, text, target.msgId);
        } else if (target.kind === "channel") {
          await sendChannelMessage(token, target.channelId, text, target.msgId);
        } else {
          await sendDmMessage(token, target.guildId, text, target.msgId);
        }
      };

      const sendSlashKeyboardReply = async (text: string, keyboard?: import("./types.js").InlineKeyboard): Promise<void> => {
        if (!keyboard) {
          await sendSlashTextReply(text);
          return;
        }
        const token = await getAccessToken(account.appId, account.clientSecret);
        if (msg.type === "c2c") {
          await sendC2CMessageWithInlineKeyboard(token, msg.senderId, text, keyboard, msg.messageId);
        } else if (msg.type === "group" && msg.groupOpenid) {
          await sendGroupMessageWithInlineKeyboard(token, msg.groupOpenid, text, keyboard, msg.messageId);
        } else {
          await sendSlashTextReply(text);
        }
      };

      const customSlashCommand = handleCustomSlashGatewayCommand({
        cfg: cfg as any,
        accountId: account.accountId,
        runtime: customMessageFlow,
        message: msg,
        rawContent: content,
        queueStatus: {
          peerId,
          snapshot: msgQueue.getSnapshot(peerId),
        },
        taskExecutor: customTaskExecutor ?? undefined,
      });
      if (customSlashCommand.handled) {
        await applyCustomSlashGatewayEffects({
          accountId: account.accountId,
          cfg: cfg as any,
          result: customSlashCommand,
          getConfigApi: () => getQQBotRuntime().config as {
            loadConfig?: () => Record<string, unknown>;
            writeConfigFile: (cfg: unknown) => Promise<void>;
          },
          persistAuthState: persistCustomAuthState,
          persistTaskState: persistCustomTaskState,
          persistPollState: persistCustomPollState,
          persistGameState: persistCustomGameState,
          persistDeployConfirmationState: persistCustomDeployConfirmationState,
          sendText: sendSlashTextReply,
          sendKeyboard: sendSlashKeyboardReply,
          sendAdminGroupNotification: async (notification) => {
            await sendCustomAuthAdminGroupNotification({ ...notification, source: "slash" });
          },
          sendTaskNotificationText: async (delivery) => {
            await sendTextToTarget({
              target: delivery.target,
              account,
              cfg,
              log,
            }, delivery.text);
          },
          log,
        });
        return;
      }

      const reply = await matchSlashCommand(cmdCtx);
      if (reply === null) {
        // 不是插件级指令，正常入队交给框架
        msgQueue.enqueue(msg);
        return;
      }

      // 委托给 AI 模型：用加工后的 prompt 替换原始消息入队
      const isDelegateResult = typeof reply === "object" && reply !== null && "delegatePrompt" in reply;
      if (isDelegateResult) {
        const delegatePrompt = (reply as SlashCommandDelegateResult).delegatePrompt;
        log?.info(`[qqbot:${account.accountId}] Slash command delegated to AI: ${content.slice(0, 40)}`);
        msg.content = delegatePrompt;
        msgQueue.enqueue(msg);
        return;
      }

      // 命中插件级指令，直接回复
      log?.info(`[qqbot:${account.accountId}] Slash command matched: ${content}, replying directly`);
      const token = await getAccessToken(account.appId, account.clientSecret);

      // 解析回复：纯文本 or 带文件的结果
      const isFileResult = typeof reply === "object" && reply !== null && "filePath" in reply;
      const replyText = isFileResult ? (reply as SlashCommandFileResult).text : reply as string;
      const replyFile = isFileResult ? (reply as SlashCommandFileResult).filePath : null;

      // 先发送文本回复
      const slashReplyTarget = resolveCustomSlashReplyTarget(msg);
      if (!slashReplyTarget) {
        log?.error(`[qqbot:${account.accountId}] Unable to resolve slash reply target for ${msg.type} message ${msg.messageId}`);
        return;
      }
      if (slashReplyTarget.kind === "c2c") {
        await sendC2CMessage(token, slashReplyTarget.userOpenid, replyText, slashReplyTarget.msgId);
      } else if (slashReplyTarget.kind === "group") {
        await sendGroupMessage(token, slashReplyTarget.groupOpenid, replyText, slashReplyTarget.msgId);
      } else if (slashReplyTarget.kind === "channel") {
        await sendChannelMessage(token, slashReplyTarget.channelId, replyText, slashReplyTarget.msgId);
      } else {
        await sendDmMessage(token, slashReplyTarget.guildId, replyText, slashReplyTarget.msgId);
      }

      // 如果有文件需要发送
      if (replyFile) {
        try {
          const mediaTarget = resolveCustomSlashReplyMediaTarget(msg);
          if (!mediaTarget) {
            log?.error(`[qqbot:${account.accountId}] Slash command file result is not supported for ${msg.type} message ${msg.messageId}`);
            return;
          }
          const mediaCtx: MediaTargetContext = {
            targetType: mediaTarget.targetType,
            targetId: mediaTarget.targetId,
            account,
            replyToId: msg.messageId,
            logPrefix: `[qqbot:${account.accountId}]`,
          };
          await sendDocument(mediaCtx, replyFile);
          log?.info(`[qqbot:${account.accountId}] Slash command file sent: ${replyFile}`);
        } catch (fileErr) {
          log?.error(`[qqbot:${account.accountId}] Failed to send slash command file: ${fileErr}`);
        }
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Slash command error: ${err}`);
      // 出错时回退到正常入队
      msgQueue.enqueue(msg);
    }
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh(account.appId);
    // P1-3: 保存已知用户数据
    flushKnownUsers();
    // P1-4: 保存引用索引数据
    flushRefIndex();
    // 保存自定义消息流状态
    customState.persistAllState();
    // 停止后台二开版本检查
    customUpdateCheck.stop();
    // 停止审批 handler
    void approvalHandler.stop();
    unregisterApprovalHandler(account.accountId);
  });

  const cleanup = () => {
    customUnreadScheduler?.dispose();
    customUnreadScheduler = null;
    customTaskExecutor?.dispose();
    customTaskExecutor = null;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }

      const pluginRuntime = getQQBotRuntime();

      // 群历史消息缓存：非@消息写入此 Map，被@时一次性注入上下文后清空
      const groupHistories = new Map<string, HistoryEntry[]>();

      const applyCustomTaskExecutionEffects = (effects: CustomTaskExecutionEffect[], passiveMessageId?: string): CustomTaskNotificationDelivery[] => {
        const deliveries: CustomTaskNotificationDelivery[] = [];
        for (const effect of effects) {
          log?.[effect.kind === "error" ? "error" : "info"]?.(`[qqbot:${account.accountId}] custom task execution: kind=${effect.kind}${effect.taskId ? ` task=${effect.taskId}` : ""}${effect.runId ? ` run=${effect.runId}` : ""}${effect.message ? ` message=${effect.message}` : ""}`);
          if (effect.kind !== "notify" || !effect.notification || !effect.taskId) continue;
          const task = customMessageFlow.tasks.getTask(effect.taskId);
          if (!task) continue;
          deliveries.push(...deliveriesFromCustomTaskNotifications({
            task,
            notifications: [effect.notification],
            passiveMessageId,
          }));
        }
        return deliveries;
      };

      const sendCustomTaskNotificationDeliveries = async (
        deliveries: CustomTaskNotificationDelivery[],
        allowUnanchored = false,
      ): Promise<void> => {
        if (!deliveries.length) return;
        const results = await applyCustomTaskNotificationDeliveries({
          deliveries,
          allowUnanchored: (delivery) => allowUnanchored
            && (delivery.target.type === "c2c" || delivery.target.type === "group"),
          sendText: async (delivery) => {
            const proactive = buildCustomProactiveGuard();
            await sendTextToTarget({
              target: delivery.target,
              account,
              cfg,
              log,
              prepareUnanchoredTextSend: proactive.proactiveGuard,
            }, delivery.text);
          },
        });
        for (const result of results) {
          const target = `${result.delivery.target.type}:${result.delivery.target.groupOpenid ?? result.delivery.target.channelId ?? result.delivery.target.senderId}`;
          if (result.status === "sent") {
            log?.info(`[qqbot:${account.accountId}] custom task notification sent: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target}`);
          } else if (result.status === "skipped") {
            log?.info(`[qqbot:${account.accountId}] custom task notification skipped: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target} reason=${result.reason}`);
          } else {
            log?.error(`[qqbot:${account.accountId}] custom task notification failed: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target} reason=${result.reason}`);
          }
        }
      };

      const applyAsyncCustomTaskStatus = async (effects: CustomTaskExecutionEffect[]): Promise<void> => {
        try {
          if (!effects.length) return;
          persistCustomTaskState();
          const deliveries = applyCustomTaskExecutionEffects(effects);
          await sendCustomTaskNotificationDeliveries(deliveries, true);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] custom task async status handling failed: ${err}`);
        }
      };

      const resolveCustomUnreadForEvent = (event: QueuedMessage): ResolvedCustomUnreadConfig | null => {
        return resolveCustomUnreadForQueuedGroupMessage({
          cfg: cfg as any,
          accountId: account.accountId,
          event,
        });
      };

      const resolveCustomUnreadForPeer = (peerId: string): ResolvedCustomUnreadConfig | null =>
        resolveCustomUnreadForEvent({
            type: "group",
            senderId: CUSTOM_UNREAD_ACTOR_ID,
            senderIsBot: true,
            content: "",
            messageId: `custom-unread-restore-${peerId}`,
            timestamp: new Date().toISOString(),
            groupOpenid: peerId,
          });

      customTaskExecutor?.dispose();
      customTaskExecutor = new CustomTaskCommandExecutor({
        config: resolveCustomRuntimeConfig(cfg as any).tasks?.commandExecutor,
        callbacks: {
          complete: ({ taskId, result, now }) => {
            const applied = completeCustomTaskExecution({
              tasks: customMessageFlow.tasks,
              taskId,
              result,
              notifyAudiences: customTaskExecutor?.notifyAudiences ?? ["peer"],
              applyWorkspaceEffects: true,
              now,
            });
            void applyAsyncCustomTaskStatus(applied.effects);
          },
          fail: ({ taskId, error, now }) => {
            const applied = failCustomTaskExecution({
              tasks: customMessageFlow.tasks,
              taskId,
              error,
              notifyAudiences: customTaskExecutor?.notifyAudiences ?? ["peer"],
              applyWorkspaceEffects: true,
              now,
            });
            void applyAsyncCustomTaskStatus(applied.effects);
          },
          heartbeat: ({ taskId, now }) => {
            const applied = heartbeatCustomTaskExecution({
              tasks: customMessageFlow.tasks,
              taskId,
              applyWorkspaceEffects: true,
              now,
            });
            if (applied.changed) persistCustomTaskState();
          },
          progress: ({ taskId, phase, message, percent, now }) => {
            const applied = progressCustomTaskExecution({
              tasks: customMessageFlow.tasks,
              taskId,
              phase,
              message,
              percent,
              applyWorkspaceEffects: true,
              now,
            });
            if (applied.changed) persistCustomTaskState();
          },
        },
        log: {
          info: (msg) => log?.info(`[qqbot:${account.accountId}] ${msg}`),
          error: (msg) => log?.error(`[qqbot:${account.accountId}] ${msg}`),
        },
      });

      customUnreadScheduler = new CustomUnreadScheduler({
        accountId: account.accountId,
        unread: customMessageFlow.unread,
        enqueue: (message) => trySlashCommandOrEnqueue(message),
        persist: persistCustomUnreadState,
        resolveConfigForPeer: resolveCustomUnreadForPeer,
        log: {
          info: (msg) => log?.info(`[qqbot:${account.accountId}] ${msg}`),
          debug: (msg) => log?.debug?.(`[qqbot:${account.accountId}] ${msg}`),
          error: (msg) => log?.error(`[qqbot:${account.accountId}] ${msg}`),
        },
      });
      customUnreadScheduler.restore(customMessageFlow.unread.getState());

      const recordCustomUnreadNonMention = (event: QueuedMessage, userContent: string, mentionedBot: boolean, implicitMention?: boolean): number | null => {
        const result = recordCustomUnreadNonMentionBeforeDispatch({
          cfg: cfg as any,
          accountId: account.accountId,
          unread: customMessageFlow.unread,
          event,
          content: userContent,
          mentionedBot,
          implicitMention,
        });
        if (!result.handled) return null;
        customUnreadScheduler?.apply(result.effects, result.cfg);
        if (result.persist) persistCustomUnreadState();
        return result.pendingCount;
      };

      const recordLegacyGroupHistory = (event: QueuedMessage, userContent: string): { pendingCount: number; attachmentCount: number } => {
        return recordLegacyGroupHistoryBeforeDispatch({
          event,
          groupHistories,
          historyLimit: event.groupOpenid
            ? resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId)
            : 0,
          content: userContent,
        });
      };

      // 处理收到的消息
      const handleMessage = async (event: QueuedMessage) => {

        log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        // 发送输入状态提示 + 启动自动续期（仅 C2C 私聊有效）
        // refIdx 通过 Promise 延迟获取，在真正需要时再 await
        const isC2C = event.type === "c2c" || event.type === "dm";
        // 用对象包装避免 TS 控制流分析将 null 初始值窄化为 never
        const typing: { keepAlive: TypingKeepAlive | null } = { keepAlive: null };

        const inputNotifyPromise: Promise<string | undefined> = (async () => {
          if (!isC2C) return undefined;
          try {
            let token = await getAccessToken(account.appId, account.clientSecret);
            try {
              const notifyResponse = await sendC2CInputNotify(token, event.senderId, event.messageId, TYPING_INPUT_SECOND);
              log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}${notifyResponse.refIdx ? `, got refIdx=${notifyResponse.refIdx}` : ""}`);
              // 首次成功后启动定时续期
              typing.keepAlive = new TypingKeepAlive(
                () => getAccessToken(account.appId, account.clientSecret),
                () => clearTokenCache(account.appId),
                event.senderId,
                event.messageId,
                log,
                `[qqbot:${account.accountId}]`,
              );
              typing.keepAlive.start();
              return notifyResponse.refIdx;
            } catch (notifyErr) {
              const errMsg = String(notifyErr);
              if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
                log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
                clearTokenCache(account.appId);
                token = await getAccessToken(account.appId, account.clientSecret);
                const notifyResponse = await sendC2CInputNotify(token, event.senderId, event.messageId, TYPING_INPUT_SECOND);
                typing.keepAlive = new TypingKeepAlive(
                  () => getAccessToken(account.appId, account.clientSecret),
                  () => clearTokenCache(account.appId),
                  event.senderId,
                  event.messageId,
                  log,
                  `[qqbot:${account.accountId}]`,
                );
                typing.keepAlive.start();
                return notifyResponse.refIdx;
              } else {
                throw notifyErr;
              }
            }
          } catch (err) {
            log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
            return undefined;
          }
        })();

        const messageRoute = resolveCustomGatewayMessageRouteContext(event);
        const { isGroupChat, peerId, routePeer } = messageRoute;

        let route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: routePeer,
        }) as CustomAgentRoute;

        const customSceneState = isCustomRuntimeEnabled()
          ? resolveCustomSceneState(cfg as any, messageRoute.customScenePeer)
          : null;
        if (customSceneState && !customSceneState.enabled) {
          log?.info(`[qqbot:${account.accountId}] Custom scene disabled for ${customSceneState.key}, skipping message from ${event.senderId}`);
          return;
        }
        route = applyCustomSceneAgentRoute({
          route,
          scene: customSceneState,
          routing: pluginRuntime.channel.routing,
          peer: routePeer,
          cfg: cfg as Record<string, unknown>,
        });
        if (customSceneState?.config.agentId) {
          log?.info(`[qqbot:${account.accountId}] Custom scene route: scene=${customSceneState.key}, agentId=${route.agentId}, sessionKey=${route.sessionKey}`);
        }

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体
        // 静态系统提示已移至 skills/qqbot-remind/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息
        
        // ============ 用户标识信息 ============
        
        // 收集额外的系统提示（如果配置了账户级别的 systemPrompt）
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        if (customSceneState) {
          systemPrompts.push(buildCustomSceneSystemPrompt(customSceneState));
        }
        
        // 处理附件（图片等）- 下载到本地供 openclaw 访问
        const processed = await processAttachments(event.attachments, { appId: account.appId, peerId, cfg, log });
        const { attachmentInfo, imageUrls, imageMediaTypes, voiceAttachmentPaths, voiceAttachmentUrls, voiceAsrReferTexts, voiceTranscripts, voiceTranscriptSources, attachmentLocalPaths } = processed;
        const inboundMedia = buildCustomInboundMediaContext({
          imageUrls,
          imageMediaTypes,
          voiceAttachmentPaths,
          voiceAttachmentUrls,
          voiceAsrReferTexts,
          voiceTranscriptSources,
        });
        const {
          uniqueVoicePaths,
          uniqueVoiceUrls,
          uniqueVoiceAsrReferTexts,
          dynamicContext: dynamicCtx,
          localMediaPaths,
          localMediaTypes,
          remoteMediaUrls,
          remoteMediaTypes,
        } = inboundMedia;
        
        // 语音转录文本注入到用户消息中
        const voiceText = formatVoiceText(voiceTranscripts);
        const hasAsrReferFallback = inboundMedia.hasAsrReferFallback;

        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        const parsedContent = parseFaceTags(event.content);
        let userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        // 统一处理 <@member_openid> → @username / 移除 @bot mention
        if (event.type === "group" && event.mentions?.length) {
          userContent = stripMentionText(userContent, event.mentions as any) ?? userContent;
        } else if (event.mentions?.length) {
          for (const m of event.mentions) {
            if (m.member_openid && m.username) {
              userContent = userContent.replace(new RegExp(`<@${m.member_openid}>`, "g"), `@${m.username}`);
            }
          }
        }

        const quoteRef = await resolveCustomQuoteReferenceContext({
          event,
          getRefEntry: getRefIndex,
          formatRefEntry: formatRefEntryForAgent,
          formatMessageReference: (ref) =>
            formatMessageReferenceForAgent(ref, { appId: account.appId, peerId, cfg, log }),
        });
        for (const quoteLog of quoteRef.logs) {
          log?.info(`[qqbot:${account.accountId}] ${quoteLog}`);
        }

        // 2. 缓存当前消息自身的 msgIdx（供将来被引用时查找）
        // 优先使用推送事件中的 msgIdx（来自 message_scene.ext），否则使用 InputNotify 返回的 refIdx
        // inputNotifyPromise 在这里才 await，此时附件下载等工作已并行完成
        const inputNotifyRefIdx = await inputNotifyPromise;
        const currentRefRecord = buildCustomCurrentRefIndexRecord({
          event,
          inputNotifyRefIdx,
          parsedContent,
          attachmentLocalPaths,
          voiceTranscripts,
          voiceTranscriptSources,
        });
        if (currentRefRecord) {
          setRefIndex(currentRefRecord.refIdx, currentRefRecord.entry);
          log?.info(`[qqbot:${account.accountId}] Cached msgIdx=${currentRefRecord.refIdx} for future reference (source: ${currentRefRecord.source})`);
        }

        // Body: 展示用的用户原文（Web UI 看到的）
        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroupChat ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });
        
        // BodyForAgent: AI 实际看到的完整上下文（动态数据 + 系统提示 + 用户输入）

        // 构建媒体附件纯数据描述（图片 + 语音统一列出）
        const voiceSummary = formatCustomInboundVoiceSummary({
          media: inboundMedia,
          voiceAttachmentPaths,
          voiceAttachmentUrls,
          voiceTranscriptCount: voiceTranscripts.length,
        });
        if (voiceSummary) {
          log?.info(`[qqbot:${account.accountId}] ${voiceSummary}`);
        }
        // AI 看到的投递地址必须带完整前缀（qqbot:c2c: / qqbot:group:）
        const qualifiedTarget = messageRoute.requestTarget;

        // 动态检测 TTS 配置状态
        const hasTTS = !!resolveTTSConfig(cfg as Record<string, unknown>);

        const quotePart = quoteRef.quotePart;

        // ============ 构建 contextInfo（静态/动态分离） ============
        // 设计原则：
        //   - 静态指引：每条消息不变的内容（场景锚定、投递地址、能力说明），
        //     注入 systemPrompts 前部，session 中虽重复出现但 AI 会自动降权，
        //     且保证长 session 窗口截断后仍可见。
        //   - 动态标签：每条消息变化的数据（时间、附件、ASR），
        //     以紧凑的 [ctx] 块标注在用户消息前，最小化 token 开销。

        // --- 静态指引（仅注入框架信封未覆盖的 QQBot 特有信息） ---
        // 框架 formatInboundEnvelope 已提供：平台标识、发送者、时间戳
        // 投递地址通过 AsyncLocalStorage 请求上下文传递给 remind 工具，无需在 agentBody 中暴露
        const staticParts: string[] = [];
        // TTS 能力声明：仅在启用时告知 AI 可以发语音（媒体标签用法由 qqbot-media SKILL.md 提供）
        // STT 无需声明：转写结果已在动态上下文的 ASR 行中，AI 自然可见
        if (hasTTS) staticParts.push("语音合成已启用");

        // 仅在有静态指引时注入 systemPrompts
        if (staticParts.length > 0) {
          const staticInstruction = staticParts.join(" | ");
          systemPrompts.unshift(staticInstruction);
        }

        // --- 命令授权（所有消息类型共用，群消息门控也需要） ---
        // allowFrom: ["*"] 表示允许所有人，否则检查 senderId 是否在 allowFrom 列表中
        const allowFromList = account.config?.allowFrom ?? [];
        const allowAll = allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
        const commandAuthorized = allowAll || allowFromList.some((entry: string) =>
          entry.toUpperCase() === event.senderId.toUpperCase()
        );

        // --- 群消息上下文：插件只提供策略，框架自动组装 hint ---
        let groupSystemPrompt = "";
        let wasMentioned = false;
        let groupSubject = "";
        let senderLabel = "";
        let shouldCatchUpUnreadAfterReply = false;
        let customUnreadCfgForEvent: ResolvedCustomUnreadConfig | null = event._customUnreadSnapshotId
          ? resolveCustomUnreadForEvent(event)
          : null;
        let customUnreadHistoryForEvent: HistoryEntry[] | undefined;

        if (event.type === "group" && event.groupOpenid) {
          const isCustomUnreadSynthetic = Boolean(event._customUnreadSnapshotId);
          // 1. 群策略检查（直接用 config 工具函数，与 Discord 的 allow-list.ts 同理）
          if (!isGroupAllowed(cfg as any, event.groupOpenid, account.accountId)) {
            log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid} not allowed by groupPolicy, skipping`);
            return;
          }

          // 2. @检测（委托 mentions 适配器）
          const mentionPatternsForDetect: string[] = resolveMentionPatterns(cfg as any, route.agentId);
          wasMentioned = detectWasMentioned({
            eventType: event.eventType,
            mentions: event.mentions,
            content: event.content,
            mentionPatterns: mentionPatternsForDetect,
          });

          // 3. requireMention 门控
          // 优先级：session store 中的 /activation 命令 > 配置文件 requireMention > 默认值
          // 未被 @ 时：消息仍写入上下文（让 bot 拥有完整对话记忆），但不触发 AI 回复
          const configRequireMention = qqbotPlugin.groups?.resolveRequireMention?.({
            cfg: cfg as any,
            accountId: account.accountId,
            groupId: event.groupOpenid,
          }) ?? true;

          const activation = resolveCustomGroupActivation({
            cfg: cfg as any,
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            configRequireMention,
          });
          const requireMention = activation === "mention";

          // 4. 隐式 mention：引用回复 bot 的消息视为隐式 mention
          const implicitMention = resolveCustomGroupImplicitMention({
            refMsgIdx: event.refMsgIdx,
            getRefEntry: getRefIndex,
          });

          // 4.5 统一门控：ignoreOtherMentions → shouldBlock → mention 门控
          // 三层判断收敛到 buildCustomGroupMessageGateContext()
          const contentForCommand = normalizeGroupMessageContentForCommand(event.content);
          const gateContext = buildCustomGroupMessageGateContext({
            content: event.content,
            contentForCommand,
            mentions: event.mentions,
            wasMentioned,
            implicitMention,
            isCustomUnreadSynthetic,
            ignoreOtherMentions: isCustomUnreadSynthetic ? false : resolveIgnoreOtherMentions(cfg as any, event.groupOpenid, account.accountId),
            allowTextCommands: shouldHandleCustomTextCommands(cfg as Record<string, unknown>),
            isControlCommand: hasControlCommand(contentForCommand),
            commandAuthorized,
            requireMention,
            canDetectMention: true,
          });
          const gate = gateContext.gate;

          if (gate.action === "drop_other_mention") {
            // @了其他人但未 @bot：记录历史后丢弃
            const customPending = recordCustomUnreadNonMention(event, userContent, wasMentioned, implicitMention);
            if (customPending !== null) {
              log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: drop other mention, recorded by custom unread runtime (cached=${customPending})`);
            } else {
              const legacy = recordLegacyGroupHistory(event, userContent);
              log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: drop other mention, recorded to legacy history (cached=${legacy.pendingCount}${legacy.attachmentCount ? `, attachments=${legacy.attachmentCount}` : ""})`);
            }
            return;
          }

          if (gate.action === "block_unauthorized_command") {
            // 未授权控制命令：静默拦截，不交给 AI
            log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: blocked unauthorized control command from ${event.senderId}: ${contentForCommand.slice(0, 50)}`);
            return;
          }

          if (gate.action === "skip_no_mention") {
            // 非 @bot 消息：记录到群历史缓存后跳过 AI
            const customPending = recordCustomUnreadNonMention(event, userContent, wasMentioned, implicitMention);
            if (customPending !== null) {
              log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: activation=${activation} not mentioned, recorded by custom unread runtime (cached=${customPending})`);
            } else {
              const historyLimit = resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId);
              const legacy = recordLegacyGroupHistory(event, userContent);
              log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: activation=${activation} (configRequireMention=${configRequireMention}) not mentioned, recorded to history (limit=${historyLimit}, cached=${legacy.pendingCount}${legacy.attachmentCount ? `, attachments=${legacy.attachmentCount}` : ""})`);
            }
            return;
          }

          // gate.action === "pass" — 更新 wasMentioned 为 effectiveWasMentioned（含 implicit + bypass）
          wasMentioned = gate.effectiveWasMentioned;
          if (wasMentioned) {
            const mentionResult = observeCustomUnreadMentionBeforeDispatch({
              cfg: cfg as any,
              accountId: account.accountId,
              unread: customMessageFlow.unread,
              event,
              content: userContent,
              mentionedBot: wasMentioned,
              implicitMention,
            });
            if (mentionResult.handled) {
              customUnreadCfgForEvent = mentionResult.cfg ?? null;
              shouldCatchUpUnreadAfterReply = mentionResult.shouldCatchUpAfterReply;
              customUnreadHistoryForEvent = mentionResult.history;
              customUnreadScheduler?.apply(mentionResult.effects, mentionResult.cfg);
              if (mentionResult.persist) persistCustomUnreadState();
              if (shouldCatchUpUnreadAfterReply) {
                log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: mention with ${mentionResult.pendingCount} custom unread message(s); will catch up after reply`);
              }
            }
          }

          const groupPromptContext = buildCustomGroupPromptContext({
            cfg: cfg as any,
            accountId: account.accountId,
            event,
            resolveGroupName: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              resolveGroupName(groupCfg as any, groupOpenid, accountId),
            resolveGroupIntroHint: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              qqbotPlugin.groups?.resolveGroupIntroHint?.({
                cfg: groupCfg as any,
                accountId,
                groupId: groupOpenid,
              }),
            resolveGroupPrompt: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              resolveGroupPrompt(groupCfg as any, groupOpenid, accountId),
          });
          senderLabel = groupPromptContext.senderLabel;
          groupSubject = groupPromptContext.groupSubject;
          groupSystemPrompt = groupPromptContext.groupSystemPrompt;
        }

        // BodyForAgent 只包含动态上下文 + 用户消息，不拼入 systemPrompts。
        // systemPrompts（[QQBot] to=...、TTS 能力声明等）通过 GroupSystemPrompt 注入到
        // 框架的 extraSystemPrompt 中，不会存入 transcript 的 user turn content。
        let agentBody = buildCustomAgentMessageBodyContext({
          event,
          userContent,
          quotePart,
          dynamicContext: dynamicCtx,
          wasMentioned,
          formatSubMessageContent: (m) =>
            formatMessageContent({
              content: m.content ?? "",
              chatType: m.type,
              mentions: m.mentions as unknown[],
              attachments: m.attachments,
              parseFaceTags,
              stripMentionText: (text, mentions) =>
                stripMentionText(text, mentions as any) ?? text,
            }),
          formatMergedEnvelope: (input) =>
            pluginRuntime.channel.reply.formatInboundEnvelope({
              channel: "qqbot",
              from: input.sender,
              timestamp: input.timestampMs,
              body: input.body,
              chatType: "group",
              envelope: envelopeOptions,
            }),
        }).agentBody;

        // 被@时：将累积的非@历史消息注入上下文，格式与正常群消息保持一致。
        const historyLimitForAgentBody = event.type === "group" && event.groupOpenid
          ? resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId)
          : 0;
        let agentHistoryEnvelopeOpts: ReturnType<typeof pluginRuntime.channel.reply.resolveEnvelopeFormatOptions> | undefined;
        agentBody = applyCustomUnreadHistoryContextToAgentBody({
          event,
          groupHistories,
          mentionHistory: customUnreadHistoryForEvent,
          historyLimit: historyLimitForAgentBody,
          currentMessage: agentBody,
          formatEnvelope: (entry) => {
            agentHistoryEnvelopeOpts ??= pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);
            return pluginRuntime.channel.reply.formatInboundEnvelope({
              channel: "qqbot",
              from: entry.sender,
              timestamp: entry.timestamp,
              body: entry.body,
              chatType: "group",
              envelope: agentHistoryEnvelopeOpts,
            });
          },
        }).body;

        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);

        const fromAddress = messageRoute.fromAddress;
        const toAddress = messageRoute.toAddress;

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext(buildCustomInboundContextPayload({
          event,
          body,
          agentBody,
          fromAddress,
          toAddress,
          sessionKey: route.sessionKey,
          accountId: route.accountId,
          isGroupChat,
          staticSystemPrompts: systemPrompts,
          groupSystemPrompt,
          wasMentioned,
          senderLabel,
          groupSubject,
          hasAsrReferFallback,
          voiceTranscriptSources,
          uniqueVoicePaths,
          uniqueVoiceUrls,
          uniqueVoiceAsrReferTexts,
          commandAuthorized,
          media: {
            localMediaPaths,
            localMediaTypes,
            remoteMediaUrls,
          },
          quote: quoteRef,
        }));

        const replyProactive = buildCustomProactiveGuard();
        const {
          replyAnchorId,
          replyContext: replyCtx,
        } = buildCustomGatewayReplyContext({
          event,
          account,
          cfg,
          log,
          prepareUnanchoredTextSend: replyProactive.proactiveGuard,
        });

        const {
          sendWithRetry,
          sendErrorMessage,
        } = buildCustomDispatchSendHelpers({
          account,
          replyContext: replyCtx,
          log,
        });

        const dispatchAuth = await applyCustomDispatchAuthorizationGateway({
          cfg: cfg as any,
          auth: customMessageFlow.auth,
          message: event,
          rawContent: userContent,
          accountId: account.accountId,
          persistAuthState: persistCustomAuthState,
          sendText: sendErrorMessage,
          sendApprovalCard: async (target, text, keyboard) => sendWithRetry(async (token) => {
            if (target.kind === "c2c") {
              await sendC2CMessageWithInlineKeyboard(token, target.userOpenid, text, keyboard, target.messageId);
            } else {
              await sendGroupMessageWithInlineKeyboard(token, target.groupOpenid, text, keyboard, target.messageId);
            }
          }),
          notifyAdminGroup: sendCustomAuthAdminGroupNotification,
          log,
        });
        if (dispatchAuth.shouldStop) {
          typing.keepAlive?.stop();
          return;
        }

        const deliverProactive = buildCustomProactiveGuard(buildCustomOutboundProactiveSource(event));
        const {
          deliverEvent,
          deliverAccountContext: deliverActx,
        } = buildCustomOutboundDeliverContext({
          event,
          replyAnchorId,
          account,
          qualifiedTarget,
          log,
          proactiveGuard: deliverProactive.proactiveGuard,
        });
        const sendGuardedMediaAuto = async (mediaUrl: string, label: string): Promise<{ channel: string; error?: string }> => {
          return applyCustomGuardedMediaAutoSend({
            mediaUrl,
            label,
            event: deliverEvent,
            accountContext: deliverActx,
            sendMedia: sendMediaAuto,
          });
        };

        // 使用 AsyncLocalStorage 建立请求级上下文，作用域内所有异步代码
        // （包括 AI agent 调用、tool execute）都能安全获取当前会话信息，无并发竞态。
        await runWithRequestContext({ target: qualifiedTarget, accountId: account.accountId }, async () => {
          const fallbackState = new CustomFallbackDispatchState();
          const responseTimeout = CUSTOM_RESPONSE_TIMEOUT_MS; // 300秒超时（5分钟，覆盖长工具任务，避免过早误报）
          const toolOnlyTimeout = CUSTOM_TOOL_ONLY_TIMEOUT_MS; // tool-only 兜底超时：90秒内没有 block 就兜底
          const maxToolRenewals = CUSTOM_TOOL_ONLY_MAX_RENEWALS; // tool 续期上限，防止无限工具调用永远不触发兜底
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;
          const recordFallbackEvent: CustomDispatchFallbackRecorder = createCustomDispatchFallbackRecorder({
            accountId: account.accountId,
            message: event,
            sessionKey: route.sessionKey,
            getRuntime: () => resolveCustomRuntimeConfig(cfg as any),
            getQueueSnapshot: () => msgQueue.getSnapshot(peerId),
            getDispatchSnapshot: () => fallbackState.snapshot(),
            log,
            sendAlert: (alert) => sendCustomFallbackAdminGroupAlert(alert),
          });
        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // ============ Deliver Debouncer：合并短时间内连续到达的 block deliver ============
          const debounceConfig = account.config?.deliverDebounce;
          let debouncer: DeliverDebouncer | null = null as DeliverDebouncer | null;

          // tool-only 兜底：转发工具产生的实际内容（媒体/文本），而非生硬的提示语
          const sendToolFallback = async (): Promise<void> => {
            await sendCustomToolFallback({
              accountId: account.accountId,
              state: fallbackState,
              recordFallbackEvent,
              sendGuardedMediaAuto,
              sendErrorMessage,
              log,
            });
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!fallbackState.hasBlockResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });


          // ============ 流式消息控制器 ============
          const targetType = event.type === "c2c" ? "c2c" as const
                          : event.type === "group" ? "group" as const
                          : "channel" as const;
          const useStreaming = shouldUseStreaming(account, targetType);
          log?.info(`[qqbot:${account.accountId}] Streaming ${useStreaming ? "enabled" : "disabled"} for ${targetType} message from ${event.senderId}`);
          let streamingController: StreamingController | null = null;

          if (useStreaming && replyAnchorId) {
            log?.info(`[qqbot:${account.accountId}] Streaming mode enabled for ${targetType} target`);
            streamingController = new StreamingController({
              account,
              userId: event.senderId,
              replyToMsgId: replyAnchorId,
              eventId: event.messageId,
              logPrefix: `[qqbot:${account.accountId}:streaming]`,
              log,
              mediaContext: {
                account,
                event: {
                  type: event.type as "c2c" | "group" | "channel",
                  senderId: event.senderId,
                  messageId: event.messageId,
                  groupOpenid: event.groupOpenid,
                  channelId: event.channelId,
                },
                log,
              },
            });
          }

          // 打印 runId 用于调试
          log?.info?.(`[qqbot:${account.accountId}] Dispatching with runId: ${event.messageId}`);

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                const lateDeliver = handleCustomLateDispatchDeliver({
                  accountId: account.accountId,
                  dispatchTimedOut: fallbackState.dispatchTimedOut,
                  payload,
                  info,
                  recordFallbackEvent,
                  log,
                });
                if (lateDeliver.kind === "late-ignored") {
                  return;
                }
                fallbackState.markResponse();

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);

                // ============ 跳过工具调用的中间结果（带兜底保护） ============
                if (info.kind === "tool") {
                  await handleCustomToolDeliverGateway({
                    accountId: account.accountId,
                    payload,
                    state: fallbackState,
                    currentTimer: toolOnlyTimeoutId,
                    setTimer: (timer) => { toolOnlyTimeoutId = timer; },
                    toolOnlyTimeoutMs: toolOnlyTimeout,
                    maxToolRenewals,
                    recordFallbackEvent,
                    sendGuardedMediaAuto,
                    sendToolFallback,
                    log,
                  });
                  return;
                }

                // 收到 block 回复，清除所有超时定时器
                const blockDeliver = prepareCustomBlockDeliver({
                  accountId: account.accountId,
                  payload,
                  event: {
                    type: event.type,
                    senderId: event.senderId,
                    content: event.content,
                  },
                  state: fallbackState,
                  stopTyping: () => typing.keepAlive?.stop(),
                  clearResponseTimeout: () => {
                    if (timeoutId) {
                      clearTimeout(timeoutId);
                      timeoutId = null;
                    }
                  },
                  clearToolOnlyTimeout: () => {
                    if (toolOnlyTimeoutId) {
                      clearTimeout(toolOnlyTimeoutId);
                      toolOnlyTimeoutId = null;
                    }
                  },
                  log,
                });
                if (blockDeliver.kind === "model-skip") {
                  return;
                }

                // ============ 流式模式处理 ============
                // 流式模式下，所有 block deliver 内容（含媒体标签）统一交由 StreamingController 处理。
                // StreamingController 内部有重试机制；如果一个分片都没发出去则降级到普通消息。
                const streamingDeliver = await handleCustomStreamingDeliver({
                  accountId: account.accountId,
                  controller: streamingController,
                  payload,
                  recordOutboundActivity: () => pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  }),
                  log,
                });
                if (streamingDeliver.kind === "handled") {
                  return;
                }

                // ============ 实际发送逻辑（可被 debouncer 包裹） ============
                const executeDeliver = async (deliverPayload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, _deliverInfo: { kind: string }) => {
                  await applyCustomStaticDeliverGateway({
                    deliverPayload,
                    replyContext: replyCtx,
                    deliverEvent,
                    deliverAccountContext: deliverActx,
                    sendWithRetry,
                    quoteRef: event.msgIdx,
                    toolMediaUrls: fallbackState.toolMediaUrls,
                    recordBlockDeliveredMedia: (payloadToRecord) => fallbackState.recordBlockDeliveredMedia(payloadToRecord),
                    recordOutboundActivity: () => pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    }),
                    parseAndSendMediaTags,
                    handleStructuredPayload,
                    sendPlainReply,
                  });
                };

                // ============ Debounce 合并回复 ============
                await dispatchCustomDebouncedDeliver({
                  accountId: account.accountId,
                  payload,
                  info,
                  currentDebouncer: debouncer,
                  setDebouncer: (nextDebouncer) => { debouncer = nextDebouncer; },
                  debounceConfig,
                  executeDeliver,
                  createDebouncer: createDeliverDebouncer,
                  log,
                });
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                fallbackState.markResponse();
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                // 流式模式：委托给 streaming controller 处理错误
                const streamingError = await handleCustomStreamingError({
                  accountId: account.accountId,
                  controller: streamingController,
                  err,
                  log,
                });
                if (streamingError.kind === "handled") {
                  return;
                }
                
                await handleCustomDispatchCallbackFailure({
                  accountId: account.accountId,
                  err,
                  recordFallbackEvent,
                  sendErrorMessage,
                  log,
                });
              },
            },

            replyOptions: {
              // 使用消息ID作为 runId，用于追踪一次完整的 AI 对话运行
              runId: event.messageId,
              // 流式模式时禁用 block streaming
              disableBlockStreaming: !useStreaming,
              // 流式模式下注册 onPartialReply 回调，接收流式文本增量
              ...(streamingController ? {
                onPartialReply: async (payload: { text?: string }) => {
                  await handleCustomStreamingPartialReply({
                    accountId: account.accountId,
                    controller: streamingController,
                    payload,
                    log,
                  });
                },
              } : {}),
            },
          });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch (err) {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            await handleCustomDispatchRaceFailure({
              accountId: account.accountId,
              err,
              responseTimeoutMs: responseTimeout,
              state: fallbackState,
              recordFallbackEvent,
              sendErrorMessage,
              log,
            });

          } finally {
            await finalizeCustomDispatchGateway({
              accountId: account.accountId,
              toolOnlyTimer: toolOnlyTimeoutId,
              setToolOnlyTimer: (timer) => { toolOnlyTimeoutId = timer; },
              fallbackState,
              recordFallbackEvent,
              sendToolFallback,
              debouncer,
              setDebouncer: (nextDebouncer) => { debouncer = nextDebouncer; },
              streamingController,
              log,
            });

            // 回复完成后处理群历史/自定义未读 runtime
            if (event.type === "group" && event.groupOpenid) {
              applyCustomUnreadCompletionGateway({
                accountId: account.accountId,
                unread: customMessageFlow.unread,
                groupOpenid: event.groupOpenid,
                cfg: customUnreadCfgForEvent,
                snapshotId: event._customUnreadSnapshotId,
                hasModelBlockOutput: fallbackState.hasModelBlockOutput,
                shouldCatchUpAfterReply: shouldCatchUpUnreadAfterReply,
                wasMentioned,
                groupHistories,
                resolveHistoryLimit: (groupOpenid, accountId) => resolveHistoryLimit(cfg as any, groupOpenid, accountId),
                persistCustomUnreadState,
                applySchedulerEffects: (effects, schedulerCfg) => customUnreadScheduler?.apply(effects, schedulerCfg),
                log,
              });
            }
          }
        } catch (err) {
          await handleCustomMessageProcessingFailure({
            accountId: account.accountId,
            err,
            recordFallbackEvent,
            sendErrorMessage,
            log,
          });
        } finally {
          // 无论成功/失败/超时，都停止输入状态续期
          typing.keepAlive?.stop();
        }
        }); // end runWithRequestContext
      };

      // ============ 统一事件分发（WebSocket/Webhook 共用） ============
      const dispatchInboundEvent = async (t: string, d: unknown): Promise<void> => {
        await dispatchCustomInboundGatewayEvent({
          eventType: t,
          data: d,
          accountId: account.accountId,
          recordKnownUser,
          enqueueMessage: trySlashCommandOrEnqueue,
          setProactiveAcceptance: (acceptance) => {
            customMessageFlow.proactiveBudget.setAcceptance(acceptance);
          },
          persistProactiveBudgetState: persistCustomProactiveBudgetState,
          handleInteraction: (event) => handleInteractionCreate({
            event,
            account,
            cfg,
            customAuth: customMessageFlow.auth,
            persistCustomAuthState,
            customPolls: customMessageFlow.polls,
            persistCustomPollState,
            customGames: customMessageFlow.games,
            persistCustomGameState,
            customDeployConfirmations: customMessageFlow.deployConfirmations,
            persistCustomDeployConfirmationState,
            log,
          }),
          log,
        });
      };

      // ============ Webhook 模式：共享 handleMessage，不走 WS ============
      if (transportMode === "webhook") {
        isConnecting = false;
        msgQueue.startProcessor(handleMessage);
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });

        await startWebhookTransport({
          account,
          abortSignal,
          onEvent: async (event) => {
            const { eventType: t, data: d } = event;
            log?.info(`[qqbot:${account.accountId}:webhook] 📩 Dispatch event: t=${t}, d=${JSON.stringify(d)}`);
            await dispatchInboundEvent(t, d);
          },
          onReady: () => {
            log?.info(`[qqbot:${account.accountId}:webhook] Transport ready`);
            log?.info(`[qqbot:${account.accountId}] ✅ Webhook transport started successfully (path: ${account.config.webhook?.path ?? "/qqbot/webhook"})`);
            onReady?.({ transport: "webhook" });
            if (_pendingFirstReady.has(account.accountId)) {
              _pendingFirstReady.delete(account.accountId);
              sendStartupGreetings(adminCtx, "READY");
            }
          },
          onError: (error) => {
            log?.error(`[qqbot:${account.accountId}:webhook] Error: ${error.message}`);
            onError?.(error);
          },
          log,
        });

        stopBackgroundTokenRefresh();
        unregisterApprovalHandler(account.accountId);
        return; // webhook transport 结束，不继续 WS 逻辑
      }

      // ============ WebSocket 模式：获取 token 并建立 WS 连接 ============
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl, { headers: { "User-Agent": getPluginUserAgent() } });
      currentWs = ws;

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        msgQueue.startProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: 0,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);
              
              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6, // Resume
                  d: {
                    token: `QQBot ${accessToken}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }));
              } else {
                // 新连接，发送 Identify，始终使用完整权限
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${FULL_INTENTS} (${FULL_INTENTS_DESC})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: FULL_INTENTS,
                    shard: [0, 1],
                  },
                }));
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              log?.info(`[qqbot:${account.accountId}] 📩 Dispatch event: t=${t}, d=${JSON.stringify(d)}`);
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                log?.info(`[qqbot:${account.accountId}] Ready with ${FULL_INTENTS_DESC}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex: 0,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);

                // 仅 startGateway 后的首次 READY 才发送上线通知
                // ws 断线重连（resume 失败后重新 Identify）产生的 READY 不发送
                if (!_pendingFirstReady.has(account.accountId)) {
                  log?.info(`[qqbot:${account.accountId}] Skipping startup greeting (reconnect READY, not first startup)`);
                } else {
                  _pendingFirstReady.delete(account.accountId);
                  sendStartupGreetings(adminCtx, "READY");
                } // end isFirstReady
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                onReady?.(d); // 通知框架连接已恢复，避免 health-monitor 误判 disconnected
                // RESUMED 也属于首次启动（gateway restart 通常走 resume）
                if (_pendingFirstReady.has(account.accountId)) {
                  _pendingFirstReady.delete(account.accountId);
                  sendStartupGreetings(adminCtx, "RESUMED");
                }
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: 0,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else {
                // 所有其他事件统一分发
                dispatchInboundEvent(t!, d).catch((err) => {
                  log?.error(`[qqbot:${account.accountId}] Event dispatch error (t=${t}): ${err}`);
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              log?.error(`[qqbot:${account.accountId}] Invalid session (${FULL_INTENTS_DESC}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                shouldRefreshToken = true;
                log?.info(`[qqbot:${account.accountId}] Will refresh token and retry with full intents (${FULL_INTENTS_DESC})`);
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 根据错误码处理（见 QQ 官方文档）
        // 4004: CODE_INVALID_TOKEN - Token 无效，需刷新 token 重新连接
        // 4006: CODE_SESSION_NO_LONGER_VALID - 会话失效，需重新 identify
        // 4007: CODE_INVALID_SEQ - Resume 时 seq 无效，需重新 identify
        // 4008: CODE_RATE_LIMITED - 限流断开，等待后重连
        // 4009: CODE_SESSION_TIMED_OUT - 会话超时，需重新 identify
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        // 4004: Token 无效，强制刷新 token 后重连
        if (code === 4004) {
          log?.info(`[qqbot:${account.accountId}] Invalid token (4004), will refresh token and reconnect`);
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }
        
        // 4008: 限流断开，等待后重连（不需要重新 identify）
        if (code === 4008) {
          log?.info(`[qqbot:${account.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms before reconnect`);
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }
        
        // 4006/4007/4009: 会话失效或超时，需要清除 session 重新 identify
        if (code === 4006 || code === 4007 || code === 4009) {
          const codeDesc: Record<number, string> = {
            4006: "session no longer valid",
            4007: "invalid seq on resume",
            4009: "session timed out",
          };
          log?.info(`[qqbot:${account.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
            log?.error(`[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`);
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }
        
        cleanup();
        
        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      
      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(`[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`);
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号（如果 connect() 返回时 signal 已经 aborted，直接 resolve）
  if (abortSignal.aborted) return;
  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}
