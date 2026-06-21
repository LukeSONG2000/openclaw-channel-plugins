import type { ResolvedQQBotAccount, TransportMode } from "./types.js";
import { getAccessToken, sendGroupMessage, clearTokenCache, stopBackgroundTokenRefresh, sendGroupMessageWithInlineKeyboard } from "./api.js";
import { loadSession } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { qqbotPlugin, stripMentionText, detectWasMentioned } from "./channel.js";
import { QQBotApprovalHandler, registerApprovalHandler, unregisterApprovalHandler, getApprovalHandler } from "./approval-handler.js";
import type { HistoryEntry } from "./group-history.js";
import { setRefIndex, flushRefIndex } from "./ref-index-store.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { sendMedia as sendMediaAuto } from "./outbound.js";
import { handleStructuredPayload } from "./reply-dispatcher.js";
import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";
import { createDeliverDebouncer } from "./deliver-debounce.js";
import { sendStartupGreetings, type AdminResolverContext } from "./admin-resolver.js";
import { sendTextToTarget } from "./reply-dispatcher.js";
import { resolveCustomRuntimeConfig } from "./custom/config.js";
import { createCustomProactiveGatewayGuard } from "./custom/proactive-gateway-adapter.js";
import type { CustomUnreadScheduler } from "./custom/unread-scheduler.js";
import { describeCustomAuthorizationIntents } from "./custom/auth-gateway-adapter.js";
import { createCustomAdminGroupNotificationServiceGateway } from "./custom/admin-group-notification-service-gateway-adapter.js";
import { createCustomMessageFlowStateController } from "./custom/message-flow-state.js";
import type { CustomTaskCommandExecutor } from "./custom/task-command-executor.js";
import { createCustomRuntimeServicesGateway } from "./custom/runtime-services-gateway-adapter.js";
import { dispatchCustomInboundGatewayEvent } from "./custom/inbound-event-gateway-adapter.js";
import {
  startCustomUpdateCheckLoop,
} from "./custom/update-check.js";
import { createCustomSlashPrequeueHandlerGateway } from "./custom/slash-prequeue-handler-gateway-adapter.js";
import {
  isQQBotGatewayWebSocketClosable,
  startQQBotWebSocketConnectionGateway,
} from "./custom/websocket-connection-gateway-adapter.js";
import { handleQQBotWebSocketConnectionFailureGateway } from "./custom/websocket-close-gateway-adapter.js";
import { startQQBotWebhookTransportGateway } from "./custom/webhook-transport-gateway-adapter.js";
import { registerCustomOutboundRefIndexGateway } from "./custom/outbound-ref-index-gateway-adapter.js";
import { runQQBotGatewayStartupPreflight } from "./custom/startup-preflight-gateway-adapter.js";
import { createCustomInteractionCreateHandlerGateway } from "./custom/interaction-create-handler-gateway-adapter.js";
import { createQQBotGatewayLifecycle } from "./custom/gateway-lifecycle-gateway-adapter.js";
import { createCustomMessageHandlerGateway } from "./custom/message-handler-gateway-adapter.js";

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

  await runQQBotGatewayStartupPreflight({
    account,
    cfg,
    getRuntime: getQQBotRuntime,
    log,
  });

  // 注册出站消息 refIdx 缓存钩子
  // 所有消息发送函数在拿到 QQ 回包后，如果含 ref_idx 则自动回调此处缓存
  registerCustomOutboundRefIndexGateway({
    accountId: account.accountId,
    setRefEntry: setRefIndex,
    log,
  });

  // ============ Transport 模式标记 ============
  const transportMode: TransportMode = account.config.transport ?? "websocket";
  if (transportMode === "webhook") {
    log?.info(`[qqbot:${account.accountId}] Using webhook transport mode`);
  }

  let customUnreadScheduler: CustomUnreadScheduler | null = null;
  let customTaskExecutor: CustomTaskCommandExecutor | null = null;
  const lifecycle = createQQBotGatewayLifecycle({
    accountId: account.accountId,
    reconnectDelays: RECONNECT_DELAYS,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    isWebSocketClosable: isQQBotGatewayWebSocketClosable,
    disposeRuntimeServices: () => {
      customUnreadScheduler?.dispose();
      customUnreadScheduler = null;
      customTaskExecutor?.dispose();
      customTaskExecutor = null;
    },
    log,
  });
  // 标记此 account 为待发问候（进程重启时 Set 里已有，断线重连不会重新加入）
  _pendingFirstReady.add(account.accountId);

  const adminCtx: AdminResolverContext = { accountId: account.accountId, appId: account.appId, clientSecret: account.clientSecret, log };

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  lifecycle.restoreSession(loadSession(account.accountId, account.appId));

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
    isAborted: () => lifecycle.isAborted(),
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
  const slashPrequeueHandler = createCustomSlashPrequeueHandlerGateway({
    cfg: cfg as any,
    account,
    runtime: customMessageFlow,
    queue: msgQueue,
    getTaskExecutor: () => customTaskExecutor ?? undefined,
    stripMentionText: (text, mentions) => stripMentionText(text, mentions as any) ?? text,
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
    log,
  });
  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    await slashPrequeueHandler(msg);
  };

  lifecycle.registerAbort(abortSignal, () => {
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

  const cleanup = lifecycle.cleanup;
  const scheduleReconnect = (customDelay?: number) => {
    lifecycle.scheduleReconnect(() => connect(), customDelay);
  };

  const connect = async () => {
    // 防止并发连接
    if (!lifecycle.beginConnect()) return;

    try {
      lifecycle.prepareConnection({
        clearTokenCache: () => clearTokenCache(account.appId),
      });

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
      const handleMessage = createCustomMessageHandlerGateway({
        account,
        cfg,
        pluginRuntime,
        runtime: customMessageFlow,
        groupHistories,
        customRuntimeServices,
        getQueueSnapshot: (peerId) => msgQueue.getSnapshot(peerId),
        getUnreadScheduler: () => customUnreadScheduler,
        persistAuthState: persistCustomAuthState,
        persistCustomUnreadState,
        buildProactiveGuard: buildCustomProactiveGuard,
        sendMedia: sendMediaAuto,
        createDebouncer: createDeliverDebouncer,
        parseAndSendMediaTags,
        handleStructuredPayload,
        sendPlainReply,
        adminGroupNotifications: customAdminGroupNotifications,
        isCustomRuntimeEnabled,
        isControlCommand: hasControlCommand,
        stripMentionText: (text, mentions) => stripMentionText(text, mentions as any) ?? text,
        detectWasMentioned: (input) => detectWasMentioned(input),
        resolveRequireMention: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          qqbotPlugin.groups?.resolveRequireMention?.({
            cfg: groupCfg as any,
            accountId,
            groupId: groupOpenid,
          }) ?? true,
        resolveGroupIntroHint: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          qqbotPlugin.groups?.resolveGroupIntroHint?.({
            cfg: groupCfg as any,
            accountId,
            groupId: groupOpenid,
          }),
        log,
      });

      const handleInteraction = createCustomInteractionCreateHandlerGateway({
        account,
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
        getRouting: () => getQQBotRuntime().channel?.routing,
        getLegacyApprovalHandler: getApprovalHandler,
        log,
      });

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
            await handleInteraction(event);
          },
          log,
        });
      };

      // ============ Webhook 模式：共享 handleMessage，不走 WS ============
      if (transportMode === "webhook") {
        lifecycle.setConnecting(false);
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
        isAborted: lifecycle.isAborted,
        getSessionState: lifecycle.getSessionState,
        setLastSeq: lifecycle.setLastSeq,
        setSessionId: lifecycle.setSessionId,
        setShouldRefreshToken: lifecycle.setShouldRefreshToken,
        setCurrentWebSocket: lifecycle.setCurrentWebSocket,
        setConnecting: lifecycle.setConnecting,
        setReconnectAttempts: lifecycle.setReconnectAttempts,
        setLastConnectTime: lifecycle.setLastConnectTime,
        getLastConnectTime: lifecycle.getLastConnectTime,
        getQuickDisconnectCount: lifecycle.getQuickDisconnectCount,
        setQuickDisconnectCount: lifecycle.setQuickDisconnectCount,
        quickDisconnectThresholdMs: QUICK_DISCONNECT_THRESHOLD,
        maxQuickDisconnectCount: MAX_QUICK_DISCONNECT_COUNT,
        rateLimitDelayMs: RATE_LIMIT_DELAY,
        startMessageProcessor: () => msgQueue.startProcessor(handleMessage),
        resetHeartbeat: lifecycle.resetHeartbeat,
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
      lifecycle.setConnecting(false); // 释放锁
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
  await lifecycle.waitForAbort(abortSignal);
}
