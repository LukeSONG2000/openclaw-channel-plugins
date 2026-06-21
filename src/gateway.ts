import path from "node:path";
import type { ResolvedQQBotAccount, TransportMode } from "./types.js";
import { getAccessToken, sendC2CMessage, sendChannelMessage, sendDmMessage, sendGroupMessage, clearTokenCache, initApiConfig, stopBackgroundTokenRefresh, onMessageSent, acknowledgeInteraction, getApiPluginVersion, setApiLogger, sendC2CMessageWithInlineKeyboard, sendGroupMessageWithInlineKeyboard } from "./api.js";
import { loadSession } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { isGroupAllowed, resolveGroupName, resolveGroupPrompt, resolveHistoryLimit, resolveIgnoreOtherMentions, resolveMentionPatterns } from "./config.js";
import { qqbotPlugin, stripMentionText, detectWasMentioned } from "./channel.js";
import { QQBotApprovalHandler, registerApprovalHandler, unregisterApprovalHandler, getApprovalHandler } from "./approval-handler.js";
import {
  formatMessageContent,
  type HistoryEntry,
} from "./group-history.js";

import { setRefIndex, getRefIndex, formatRefEntryForAgent, formatMessageReferenceForAgent, flushRefIndex, type RefAttachmentSummary } from "./ref-index-store.js";
import { getFrameworkVersion } from "./slash-commands.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { startImageServer, isImageServerRunning, type ImageServerConfig } from "./image-server.js";
import { resolveTTSConfig } from "./utils/audio-convert.js";
import { processAttachments, formatVoiceText } from "./inbound-attachments.js";
import { getQQBotDataDir, runDiagnostics } from "./utils/platform.js";

import { sendDocument, sendMedia as sendMediaAuto, type MediaTargetContext } from "./outbound.js";
import { parseFaceTags } from "./utils/text-parsing.js";
import { sendStartupGreetings, type AdminResolverContext } from "./admin-resolver.js";
import { sendTextToTarget, handleStructuredPayload } from "./reply-dispatcher.js";
import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";
import { createDeliverDebouncer } from "./deliver-debounce.js";
import { resolveCustomRuntimeConfig } from "./custom/config.js";
import { createCustomProactiveGatewayGuard } from "./custom/proactive-gateway-adapter.js";
import type { CustomUnreadScheduler } from "./custom/unread-scheduler.js";
import { describeCustomAuthorizationIntents } from "./custom/auth-gateway-adapter.js";
import { createCustomAdminGroupNotificationServiceGateway } from "./custom/admin-group-notification-service-gateway-adapter.js";
import { handleCustomInteractionCreateGateway } from "./custom/interaction-create-gateway-adapter.js";
import { createCustomMessageFlowStateController } from "./custom/message-flow-state.js";
import type { CustomTaskCommandExecutor } from "./custom/task-command-executor.js";
import { createCustomRuntimeServicesGateway } from "./custom/runtime-services-gateway-adapter.js";
import {
  recordCustomFallbackEventGateway,
} from "./custom/fallback-record-gateway-adapter.js";
import { runCustomMessageContextGateway } from "./custom/message-context-gateway-adapter.js";
import { runCustomMessageDispatchGateway } from "./custom/message-dispatch-gateway-adapter.js";
import { dispatchCustomInboundGatewayEvent } from "./custom/inbound-event-gateway-adapter.js";
import {
  startCustomUpdateCheckLoop,
} from "./custom/update-check.js";
import { handleCustomSlashPrequeueGateway } from "./custom/slash-prequeue-gateway-adapter.js";
import { runCustomMessageIngressGateway } from "./custom/message-ingress-gateway-adapter.js";
import {
  isQQBotGatewayWebSocketClosable,
  startQQBotWebSocketConnectionGateway,
  type QQBotGatewayWebSocketLike,
} from "./custom/websocket-connection-gateway-adapter.js";
import { handleQQBotWebSocketConnectionFailureGateway } from "./custom/websocket-close-gateway-adapter.js";
import { startQQBotWebhookTransportGateway } from "./custom/webhook-transport-gateway-adapter.js";

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
  let currentWs: QQBotGatewayWebSocketLike | null = null;
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

  const customAdminGroupNotifications = createCustomAdminGroupNotificationServiceGateway({
    accountId: account.accountId,
    getRuntime: () => resolveCustomRuntimeConfig(cfg as any),
    buildProactiveGuard: () => buildCustomProactiveGuard().proactiveGuard,
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

  // 后台二开版本检查：只检查个人包更新，不自动安装。
  const customUpdateCheck = startCustomUpdateCheckLoop({
    accountId: account.accountId,
    accountConfig: account.config,
    log,
    onUpdateAvailable: customAdminGroupNotifications.sendUpdateAvailableNotification,
  });

  // 斜杠指令拦截：在入队前匹配插件级指令，命中则直接回复，不入队
  // 紧急命令列表：这些命令会立即执行，不进入斜杠匹配流程
  // /stop     — 停止当前 agent run，清空队列
  // /approve  — 审批决策，必须在 agent 等待审批时立即执行，否则死锁
  // /new 和 /compact — 上下文异常或超长时必须能绕过队列，恢复客户端可操作性
  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    await handleCustomSlashPrequeueGateway({
      cfg: cfg as any,
      account: {
        accountId: account.accountId,
        appId: account.appId,
        accountConfig: account.config,
      },
      runtime: customMessageFlow,
      message: msg,
      queue: msgQueue,
      effects: {
        getConfigApi: () => getQQBotRuntime().config as {
          loadConfig?: () => Record<string, unknown>;
          writeConfigFile: (cfg: unknown) => Promise<void>;
        },
        persistAuthState: persistCustomAuthState,
        persistTaskState: persistCustomTaskState,
        persistPollState: persistCustomPollState,
        persistGameState: persistCustomGameState,
        persistDeployConfirmationState: persistCustomDeployConfirmationState,
        sendAdminGroupNotification: async (notification) => {
          await customAdminGroupNotifications.sendAuthAdminGroupNotification({ ...notification, source: "slash" });
        },
        sendTaskNotificationText: async (delivery) => {
          await sendTextToTarget({
            target: delivery.target,
            account,
            cfg,
            log,
          }, delivery.text);
        },
      },
      taskExecutor: customTaskExecutor ?? undefined,
      stripMentionText: (text, mentions) => stripMentionText(text, mentions as any) ?? text,
      recordFallbackEvent: (event) => {
        recordCustomFallbackEventGateway({
          accountId: account.accountId,
          event,
          log,
        });
      },
      sendText: async (target, text) => {
        const token = await getAccessToken(account.appId, account.clientSecret);
        if (target.kind === "c2c") {
          await sendC2CMessage(token, target.userOpenid, text, target.msgId);
        } else if (target.kind === "group") {
          await sendGroupMessage(token, target.groupOpenid, text, target.msgId);
        } else if (target.kind === "channel") {
          await sendChannelMessage(token, target.channelId, text, target.msgId);
        } else {
          await sendDmMessage(token, target.guildId, text, target.msgId);
        }
      },
      sendKeyboard: async (target, text, keyboard) => {
        const token = await getAccessToken(account.appId, account.clientSecret);
        if (target.kind === "c2c") {
          await sendC2CMessageWithInlineKeyboard(token, target.userOpenid, text, keyboard, target.msgId);
        } else {
          await sendGroupMessageWithInlineKeyboard(token, target.groupOpenid, text, keyboard, target.msgId);
        }
      },
      sendFile: async (mediaTarget, filePath, message) => {
        const mediaCtx: MediaTargetContext = {
          targetType: mediaTarget.targetType,
          targetId: mediaTarget.targetId,
          account,
          replyToId: message.messageId,
          logPrefix: `[qqbot:${account.accountId}]`,
        };
        await sendDocument(mediaCtx, filePath);
      },
      log,
    });
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
    if (currentWs && isQQBotGatewayWebSocketClosable(currentWs)) {
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

      const customRuntimeServices = createCustomRuntimeServicesGateway({
        cfg: cfg as any,
        accountId: account.accountId,
        runtime: customMessageFlow,
        previousTaskExecutor: customTaskExecutor,
        enqueueMessage: (message) => trySlashCommandOrEnqueue(message),
        persistTaskState: persistCustomTaskState,
        persistUnreadState: persistCustomUnreadState,
        sendTaskStatusText: async (delivery) => {
          const proactive = buildCustomProactiveGuard();
          await sendTextToTarget({
            target: delivery.target,
            account,
            cfg,
            log,
            prepareUnanchoredTextSend: proactive.proactiveGuard,
          }, delivery.text);
        },
        log,
      });
      customTaskExecutor = customRuntimeServices.taskExecutor;
      customUnreadScheduler = customRuntimeServices.unreadScheduler;

      // 处理收到的消息
      const handleMessage = async (event: QueuedMessage) => {

        const ingress = runCustomMessageIngressGateway({
          account,
          event,
          cfg,
          getToken: () => getAccessToken(account.appId, account.clientSecret),
          clearTokenCache: () => clearTokenCache(account.appId),
          recordInboundActivity: () => pluginRuntime.channel.activity.record({
            channel: "qqbot",
            accountId: account.accountId,
            direction: "inbound",
          }),
          resolveBaseRoute: (input) => pluginRuntime.channel.routing.resolveAgentRoute(input) as any,
          routing: pluginRuntime.channel.routing,
          customRuntimeEnabled: isCustomRuntimeEnabled(),
          resolveEnvelopeOptions: (config) => pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(config),
          log,
        });
        if (ingress.action === "stop") {
          return;
        }
        const typing = ingress.typing;
        const messageRoute = ingress.messageRoute;
        const { isGroupChat, peerId } = messageRoute;
        const route = ingress.route;
        const envelopeOptions = ingress.envelopeOptions;

        const qualifiedTarget = messageRoute.requestTarget;
        let agentHistoryEnvelopeOpts: ReturnType<typeof pluginRuntime.channel.reply.resolveEnvelopeFormatOptions> | undefined;
        const messageContext = await runCustomMessageContextGateway({
          cfg: cfg as any,
          account,
          event,
          ingress,
          unread: customMessageFlow.unread,
          groupHistories,
          initialCustomUnreadCfg: event._customUnreadSnapshotId
            ? customRuntimeServices.resolveUnreadForEvent(event)
            : null,
          hasTTS: !!resolveTTSConfig(cfg as Record<string, unknown>),
          processAttachments,
          formatVoiceText,
          parseFaceTags,
          stripMentionText: (text, mentions) => stripMentionText(text, mentions as any) ?? text,
          getRefEntry: getRefIndex,
          setRefEntry: setRefIndex,
          formatRefEntry: formatRefEntryForAgent,
          formatMessageReference: (ref) =>
            formatMessageReferenceForAgent(ref, { appId: account.appId, peerId, cfg, log }),
          formatInboundEnvelope: (input) =>
            pluginRuntime.channel.reply.formatInboundEnvelope(input as Parameters<typeof pluginRuntime.channel.reply.formatInboundEnvelope>[0]),
          groupDispatch: {
            isGroupAllowed: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              isGroupAllowed(groupCfg as any, groupOpenid, accountId),
            resolveMentionPatterns: ({ cfg: groupCfg, agentId }) =>
              resolveMentionPatterns(groupCfg as any, agentId),
            detectWasMentioned: (input) => detectWasMentioned(input),
            resolveRequireMention: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              qqbotPlugin.groups?.resolveRequireMention?.({
                cfg: groupCfg as any,
                accountId,
                groupId: groupOpenid,
              }) ?? true,
            resolveIgnoreOtherMentions: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              resolveIgnoreOtherMentions(groupCfg as any, groupOpenid, accountId),
            resolveHistoryLimit: ({ cfg: groupCfg, accountId, groupOpenid }) =>
              resolveHistoryLimit(groupCfg as any, groupOpenid, accountId),
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
            getRefEntry: getRefIndex,
            isControlCommand: hasControlCommand,
            applySchedulerEffects: (effects, schedulerCfg) => customUnreadScheduler?.apply(effects, schedulerCfg),
            persistCustomUnreadState,
          },
          resolveHistoryLimit: (groupOpenid, accountId) => resolveHistoryLimit(cfg as any, groupOpenid, accountId),
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
          formatHistoryEnvelope: (entry) => {
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
          finalizeInboundContext: (payload) => pluginRuntime.channel.reply.finalizeInboundContext(payload),
          log,
        });
        if (messageContext.action === "stop") {
          return;
        }
        await runCustomMessageDispatchGateway({
          account,
          event,
          cfg,
          route,
          qualifiedTarget,
          ctxPayload: messageContext.ctxPayload,
          userContent: messageContext.userContent,
          wasMentioned: messageContext.wasMentioned,
          shouldCatchUpUnreadAfterReply: messageContext.shouldCatchUpUnreadAfterReply,
          customUnreadCfgForEvent: messageContext.customUnreadCfgForEvent,
          runtime: {
            auth: customMessageFlow.auth,
            unread: customMessageFlow.unread,
          },
          groupHistories,
          persistAuthState: persistCustomAuthState,
          persistCustomUnreadState,
          applyUnreadSchedulerEffects: (effects, schedulerCfg) => customUnreadScheduler?.apply(effects, schedulerCfg),
          buildProactiveGuard: buildCustomProactiveGuard,
          sendMedia: sendMediaAuto,
          getRuntime: () => resolveCustomRuntimeConfig(cfg as any),
          getQueueSnapshot: () => msgQueue.getSnapshot(peerId),
          sendFallbackAdminGroupAlert: (alert) => customAdminGroupNotifications.sendFallbackAdminGroupAlert(alert),
          notifyAuthAdminGroup: customAdminGroupNotifications.sendAuthAdminGroupNotification,
          sendApprovalCardWithRetry: async (sendWithRetry, target, text, keyboard) => sendWithRetry(async (token) => {
            if (target.kind === "c2c") {
              await sendC2CMessageWithInlineKeyboard(token, target.userOpenid, text, keyboard, target.messageId);
            } else {
              await sendGroupMessageWithInlineKeyboard(token, target.groupOpenid, text, keyboard, target.messageId);
            }
          }),
          createDebouncer: createDeliverDebouncer,
          recordOutboundActivity: () => pluginRuntime.channel.activity.record({
            channel: "qqbot",
            accountId: account.accountId,
            direction: "outbound",
          }),
          parseAndSendMediaTags,
          handleStructuredPayload,
          sendPlainReply,
          stopTyping: () => typing.stop(),
          resolveEffectiveMessagesConfig: (config, agentId) =>
            pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(config, agentId),
          dispatchReply: (input) =>
            pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(input as Parameters<typeof pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher>[0]),
          resolveHistoryLimit: (groupOpenid, accountId) => resolveHistoryLimit(cfg as any, groupOpenid, accountId),
          log,
        });
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
          handleInteraction: async (event) => {
            let interactionToken: Promise<string> | null = null;
            const getInteractionToken = () => {
              interactionToken ??= getAccessToken(account.appId, account.clientSecret);
              return interactionToken;
            };
            await handleCustomInteractionCreateGateway({
              accountId: account.accountId,
              event,
              cfg,
              runtime: {
                auth: customMessageFlow.auth,
                polls: customMessageFlow.polls,
                games: customMessageFlow.games,
                deployConfirmations: customMessageFlow.deployConfirmations,
              },
              persistAuthState: persistCustomAuthState,
              persistPollState: persistCustomPollState,
              persistGameState: persistCustomGameState,
              persistDeployConfirmationState: persistCustomDeployConfirmationState,
              getConfigApi: () => getQQBotRuntime().config as {
                loadConfig: () => Record<string, unknown>;
                writeConfigFile: (cfg: unknown) => Promise<void>;
              },
              routing: getQQBotRuntime().channel?.routing,
              acknowledge: async (code, payload) => {
                const token = await getInteractionToken();
                if (code !== undefined && payload !== undefined) {
                  await acknowledgeInteraction(token, event.id, code, payload);
                } else {
                  await acknowledgeInteraction(token, event.id);
                }
              },
              pluginVersion: getApiPluginVersion(),
              frameworkVersion: getFrameworkVersion(),
              sendReply: async (target, text) => {
                const token = await getInteractionToken();
                if (target.kind === "group") {
                  await sendGroupMessage(token, target.groupOpenid, text);
                } else if (target.kind === "c2c") {
                  await sendC2CMessage(token, target.userOpenid, text);
                } else {
                  await sendChannelMessage(token, target.channelId, text);
                }
              },
              getLegacyApprovalHandler: getApprovalHandler,
              log,
            });
          },
          log,
        });
      };

      // ============ Webhook 模式：共享 handleMessage，不走 WS ============
      if (transportMode === "webhook") {
        isConnecting = false;
        await startQQBotWebhookTransportGateway({
          account,
          abortSignal,
          startMessageProcessor: () => msgQueue.startProcessor(handleMessage),
          dispatchInboundEvent,
          onReady: (payload) => onReady?.(payload),
          onError: (error) => onError?.(error),
          isPendingFirstReady: () => _pendingFirstReady.has(account.accountId),
          markFirstReadyConsumed: () => { _pendingFirstReady.delete(account.accountId); },
          sendStartupGreeting: (event) => sendStartupGreetings(adminCtx, event),
          unregisterApprovalHandler,
          log,
        });
        return; // webhook transport 结束，不继续 WS 逻辑
      }

      await startQQBotWebSocketConnectionGateway({
        accountId: account.accountId,
        appId: account.appId,
        clientSecret: account.clientSecret,
        intents: FULL_INTENTS,
        intentsDesc: FULL_INTENTS_DESC,
        isAborted: () => isAborted,
        getSessionState: () => ({ sessionId, lastSeq, lastConnectTime }),
        setLastSeq: (nextLastSeq) => { lastSeq = nextLastSeq; },
        setSessionId: (nextSessionId) => { sessionId = nextSessionId; },
        setShouldRefreshToken: (nextShouldRefreshToken) => { shouldRefreshToken = nextShouldRefreshToken; },
        setCurrentWebSocket: (ws) => { currentWs = ws; },
        setConnecting: (nextIsConnecting) => { isConnecting = nextIsConnecting; },
        setReconnectAttempts: (nextReconnectAttempts) => { reconnectAttempts = nextReconnectAttempts; },
        setLastConnectTime: (nextLastConnectTime) => { lastConnectTime = nextLastConnectTime; },
        getLastConnectTime: () => lastConnectTime,
        getQuickDisconnectCount: () => quickDisconnectCount,
        setQuickDisconnectCount: (nextQuickDisconnectCount) => { quickDisconnectCount = nextQuickDisconnectCount; },
        quickDisconnectThresholdMs: QUICK_DISCONNECT_THRESHOLD,
        maxQuickDisconnectCount: MAX_QUICK_DISCONNECT_COUNT,
        rateLimitDelayMs: RATE_LIMIT_DELAY,
        startMessageProcessor: () => msgQueue.startProcessor(handleMessage),
        resetHeartbeat: (intervalMs, onHeartbeat, isSocketOpen) => {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          heartbeatInterval = setInterval(() => {
            if (isSocketOpen()) {
              onHeartbeat();
            }
          }, intervalMs);
        },
        isPendingFirstReady: () => _pendingFirstReady.has(account.accountId),
        markFirstReadyConsumed: () => { _pendingFirstReady.delete(account.accountId); },
        onReady: (payload) => onReady?.(payload),
        sendStartupGreeting: (event) => sendStartupGreetings(adminCtx, event),
        dispatchInboundEvent,
        cleanup,
        scheduleReconnect,
        onError: (err) => onError?.(err),
        log,
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      handleQQBotWebSocketConnectionFailureGateway({
        accountId: account.accountId,
        err,
        rateLimitDelayMs: RATE_LIMIT_DELAY,
        scheduleReconnect,
        log,
      });
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
