import type { ResolvedQQBotAccount } from "./types.js";
import { stopBackgroundTokenRefresh } from "./api.js";
import { flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { qqbotPlugin, stripMentionText, detectWasMentioned } from "./channel.js";
import { getApprovalHandler } from "./approval-handler.js";
import { flushRefIndex } from "./ref-index-store.js";
import { sendMedia as sendMediaAuto } from "./outbound.js";
import { handleStructuredPayload } from "./reply-dispatcher.js";
import { parseAndSendMediaTags, sendPlainReply } from "./outbound-deliver.js";
import { createDeliverDebouncer } from "./deliver-debounce.js";
import { sendTextToTarget } from "./reply-dispatcher.js";
import type { CustomUnreadScheduler } from "./custom/unread-scheduler.js";
import type { CustomTaskCommandExecutor } from "./custom/task-command-executor.js";
import {
  isQQBotGatewayWebSocketClosable,
} from "./custom/websocket-connection-gateway-adapter.js";
import { createQQBotGatewayLifecycle } from "./custom/gateway-lifecycle-gateway-adapter.js";
import { startQQBotApprovalHandlerGateway } from "./custom/approval-handler-gateway-adapter.js";
import { createCustomGatewayAccountServices } from "./custom/gateway-account-services-gateway-adapter.js";
import { startQQBotGatewayStartup } from "./custom/gateway-startup-gateway-adapter.js";
import { runQQBotGatewayConnectAttempt } from "./custom/gateway-connect-attempt-gateway-adapter.js";

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

  const startup = await startQQBotGatewayStartup({
    account,
    cfg,
    abortSignal,
    restoreSession: lifecycle.restoreSession,
    markPendingFirstReady: () => { _pendingFirstReady.add(account.accountId); },
    getRuntime: getQQBotRuntime,
    log,
  });
  const transportMode = startup.transportMode;
  const adminCtx = startup.adminContext;

  // ============ 审批 Handler ============
  const approvalHandler = startQQBotApprovalHandlerGateway({
    account,
    cfg,
    log,
  });

  const accountServices = createCustomGatewayAccountServices({
    account,
    cfg,
    isAborted: () => lifecycle.isAborted(),
    getTaskExecutor: () => customTaskExecutor ?? undefined,
    stripMentionText: (text, mentions) => stripMentionText(text, mentions as any) ?? text,
    getConfigApi: () => getQQBotRuntime().config as {
      loadConfig?: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    },
    log,
  });
  const msgQueue = accountServices.queue;
  const customState = accountServices.state;
  const customMessageFlow = accountServices.runtime;
  const persistCustomAuthState = customState.persistAuthState;
  const persistCustomProactiveBudgetState = customState.persistProactiveBudgetState;
  const persistCustomTaskState = customState.persistTaskState;
  const persistCustomPollState = customState.persistPollState;
  const persistCustomGameState = customState.persistGameState;
  const persistCustomDeployConfirmationState = customState.persistDeployConfirmationState;
  const persistCustomUnreadState = customState.persistUnreadState;
  const buildCustomProactiveGuard = accountServices.buildProactiveGuard;
  const isCustomRuntimeEnabled = accountServices.isCustomRuntimeEnabled;
  const customAdminGroupNotifications = accountServices.adminGroupNotifications;
  const customUpdateCheck = accountServices.updateCheck;
  const trySlashCommandOrEnqueue = accountServices.trySlashCommandOrEnqueue;

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
    approvalHandler.dispose();
  });

  const scheduleReconnect = (customDelay?: number) => {
    lifecycle.scheduleReconnect(() => connect(), customDelay);
  };

  const connect = async () => {
    await runQQBotGatewayConnectAttempt({
      account,
      cfg,
      transportMode,
      abortSignal,
      lifecycle,
      messageQueue: msgQueue,
      runtime: customMessageFlow,
      getPreviousTaskExecutor: () => customTaskExecutor,
      setTaskExecutor: (executor) => { customTaskExecutor = executor; },
      setUnreadScheduler: (scheduler) => { customUnreadScheduler = scheduler; },
      enqueueMessage: trySlashCommandOrEnqueue,
      getQueueSnapshot: (peerId) => msgQueue.getSnapshot(peerId),
      persistAuthState: persistCustomAuthState,
      persistProactiveBudgetState: persistCustomProactiveBudgetState,
      persistTaskState: persistCustomTaskState,
      persistPollState: persistCustomPollState,
      persistGameState: persistCustomGameState,
      persistDeployConfirmationState: persistCustomDeployConfirmationState,
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
      getConfigApi: () => getQQBotRuntime().config as {
        loadConfig: () => Record<string, unknown>;
        writeConfigFile: (cfg: unknown) => Promise<void>;
      },
      getRouting: () => getQQBotRuntime().channel?.routing,
      getLegacyApprovalHandler: getApprovalHandler,
      adminContext: adminCtx,
      isPendingFirstReady: () => _pendingFirstReady.has(account.accountId),
      markFirstReadyConsumed: () => { _pendingFirstReady.delete(account.accountId); },
      unregisterApprovalHandler: () => approvalHandler.unregister(),
      scheduleReconnect,
      onReady: (payload) => onReady?.(payload),
      onError: (error) => onError?.(error),
      intents: FULL_INTENTS,
      intentsDesc: FULL_INTENTS_DESC,
      quickDisconnectThresholdMs: QUICK_DISCONNECT_THRESHOLD,
      maxQuickDisconnectCount: MAX_QUICK_DISCONNECT_COUNT,
      rateLimitDelayMs: RATE_LIMIT_DELAY,
      getRuntime: getQQBotRuntime,
      log,
    });
  };

  // 开始连接
  await connect();

  // 等待 abort 信号（如果 connect() 返回时 signal 已经 aborted，直接 resolve）
  await lifecycle.waitForAbort(abortSignal);
}
