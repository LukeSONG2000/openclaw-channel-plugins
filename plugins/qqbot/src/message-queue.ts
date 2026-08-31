import type { QueueSnapshot } from "./slash-commands.js";
import type { MsgElement } from "./types.js";
import type { HistoryEntry } from "./group-history.js";

// ── 消息队列默认配置 ──
const DEFAULT_GLOBAL_QUEUE_SIZE = 1000;
const DEFAULT_PER_PEER_QUEUE_SIZE = 20;
const DEFAULT_GROUP_QUEUE_SIZE = 50;
const DEFAULT_MAX_CONCURRENT_USERS = 10;
const DEFAULT_MAX_CONCURRENT_BACKGROUND = 2;
const DEFAULT_MAX_CONCURRENT_MENTIONS_PER_PEER = 3;

export type MessageQueuePriority = "mention" | "normal" | "background";

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
export interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
  /** 被引用消息的 refIdx（用户引用了哪条历史消息） */
  refMsgIdx?: string;
  /** 当前消息自身的 refIdx（供将来被引用） */
  msgIdx?: string;
  /** 事件类型（如 GROUP_AT_MESSAGE_CREATE），用于群消息合并时判断是否有 @ */
  eventType?: string;
  /** 发送者是否为机器人 */
  senderIsBot?: boolean;
  /** @ 提及列表（群消息合并时需要去重合并） */
  mentions?: Array<{ scope?: "all" | "single"; id?: string; user_openid?: string; member_openid?: string; username?: string; bot?: boolean; is_you?: boolean }>;
  /** 消息场景（来源、扩展字段） */
  messageScene?: { source?: string; ext?: string[] };
  /** 消息元素列表，引用消息时 [0] 为被引用的原始消息 */
  msgElements?: MsgElement[];
  /** 消息类型，参见 MSG_TYPE_* */
  msgType?: number;
  /** 群消息合并标记：记录合并了多少条原始消息 */
  _mergedCount?: number;
  /** 合并前的原始消息列表（用于 gateway 侧逐条格式化信封） */
  _mergedMessages?: QueuedMessage[];
  /** 自定义 unread runtime 使用的历史快照 id */
  _customUnreadSnapshotId?: string;
  /** 自定义 unread runtime 使用的历史快照 */
  _customUnreadSnapshot?: HistoryEntry[];
  /** 已标记为已读、仅用于辅助理解的近期上下文 */
  _customUnreadReadContext?: HistoryEntry[];
  /** 轮询回复允许原生 @ 的本次未读成员白名单 */
  _customUnreadMentionActorIds?: string[];
  /** 被明确 @ 时，发送层必须原生 @ 的当前成员 */
  _customReplyMentionActorId?: string;
  /** 自定义消息流要求跳过群消息合并 */
  _noMerge?: boolean;
  /** 由插件级 slash 命令完成前置鉴权后委托给 AI 的内部消息。 */
  _slashAuthorized?: {
    command: string;
    capability?: string;
  };
  /** 队列优先级：真实 @ 优先，轮询合成消息后台执行。 */
  _queuePriority?: MessageQueuePriority;
  /** 性能追踪：消息进入插件队列的时间。 */
  _queueEnqueuedAt?: number;
  /** 性能追踪：消息从插件队列开始处理的时间。 */
  _queueStartedAt?: number;
  /** 同群并发 @ 使用隔离会话，避免共享会话的单运行锁继续串行阻塞。 */
  _queueIsolatedSession?: boolean;
}

export interface MessageQueueContext {
  accountId: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 外部提供的 abort 状态检查 */
  isAborted: () => boolean;
  /** 群聊队列上限（默认 50） */
  groupQueueSize?: number;
  /** 私聊/DM 队列上限（默认 20） */
  peerQueueSize?: number;
  /** 全局队列总量上限（默认 1000） */
  globalQueueSize?: number;
  /** 最大并发处理用户数（默认 10） */
  maxConcurrentUsers?: number;
  /** 最大后台轮询并发数（默认 2，为实时消息保留槽位） */
  maxConcurrentBackground?: number;
  /** 每个群最多并发处理的 @ 数（默认 3） */
  maxConcurrentMentionsPerPeer?: number;
  /** 中止当前 peer 的后台模型运行；仅在真实 @ 抢占后台轮询时调用。 */
  abortActiveBackground?: (peerId: string) => boolean;
}

export interface MessageQueue {
  enqueue: (msg: QueuedMessage) => void;
  startProcessor: (handleMessageFn: (msg: QueuedMessage) => Promise<void>) => void;
  getSnapshot: (senderPeerId: string) => QueueSnapshot;
  getMessagePeerId: (msg: QueuedMessage) => string;
  /** 清空指定用户的排队消息，返回被丢弃的消息数 */
  clearUserQueue: (peerId: string) => number;
  /** 立即执行一条消息（绕过队列），用于紧急命令 */
  executeImmediate: (msg: QueuedMessage) => void;
}

/** 判断 peerId 是否属于群聊 */
const isGroupPeer = (peerId: string): boolean =>
  peerId.startsWith("group:") || peerId.startsWith("guild:");

/**
 * 创建按用户并发的消息队列（同用户串行，跨用户并行）
 *
 * 内置群消息增强：
 * - 群聊 / 私聊使用不同队列上限
 * - 群聊溢出时优先丢弃 bot 消息
 * - 群聊排队消息逐条处理，保留各自的发送者、附件和已读状态
 */
export function createMessageQueue(ctx: MessageQueueContext): MessageQueue {
  const { accountId, log } = ctx;
  const globalQueueSize = ctx.globalQueueSize ?? DEFAULT_GLOBAL_QUEUE_SIZE;
  const peerQueueSize = ctx.peerQueueSize ?? DEFAULT_PER_PEER_QUEUE_SIZE;
  const groupQueueSize = ctx.groupQueueSize ?? DEFAULT_GROUP_QUEUE_SIZE;
  const maxConcurrentUsers = ctx.maxConcurrentUsers ?? DEFAULT_MAX_CONCURRENT_USERS;
  const maxConcurrentBackground = Math.max(
    1,
    Math.min(maxConcurrentUsers, ctx.maxConcurrentBackground ?? DEFAULT_MAX_CONCURRENT_BACKGROUND),
  );
  const maxConcurrentMentionsPerPeer = Math.max(
    1,
    Math.min(5, ctx.maxConcurrentMentionsPerPeer ?? DEFAULT_MAX_CONCURRENT_MENTIONS_PER_PEER),
  );

  const userQueues = new Map<string, QueuedMessage[]>();
  const activeUsers = new Set<string>();
  const activeStartedAt = new Map<string, number>();
  const activePriorities = new Map<string, MessageQueuePriority>();
  const concurrentMentionsByPeer = new Map<string, number>();
  let activeConcurrentMentions = 0;
  const pendingImmediateMessages: QueuedMessage[] = [];
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;
  let totalEnqueued = 0;

  const getMessagePeerId = (msg: QueuedMessage): string => {
    if (msg.type === "guild") return `guild:${msg.channelId ?? "unknown"}`;
    if (msg.type === "group") return `group:${msg.groupOpenid ?? "unknown"}`;
    return `dm:${msg.senderId}`;
  };

  /** 从满队列中淘汰一条消息（群聊优先丢弃 bot 消息，否则丢弃最旧） */
  const evictOne = (queue: QueuedMessage[], isGroup: boolean): QueuedMessage | undefined => {
    if (isGroup) {
      const botIdx = queue.findIndex(m => m.senderIsBot);
      if (botIdx >= 0) return queue.splice(botIdx, 1)[0];
    }
    return queue.shift();
  };

  /** 判断消息是否为斜杠指令 */
  const isSlashCommand = (msg: QueuedMessage): boolean =>
    (msg.content ?? "").trim().startsWith("/");

  const resolvePriority = (msg: QueuedMessage): MessageQueuePriority => {
    if (msg._queuePriority) return msg._queuePriority;
    if (msg.type === "group" && (
      msg.eventType === "GROUP_AT_MESSAGE_CREATE"
      || msg.mentions?.some((mention) => mention.is_you)
    )) {
      return "mention";
    }
    return "normal";
  };

  const priorityRank = (priority: MessageQueuePriority): number => {
    if (priority === "mention") return 2;
    if (priority === "normal") return 1;
    return 0;
  };

  const nextQueuePriority = (queue: QueuedMessage[]): MessageQueuePriority | undefined => {
    let best: MessageQueuePriority | undefined;
    for (const msg of queue) {
      const priority = resolvePriority(msg);
      if (!best || priorityRank(priority) > priorityRank(best)) best = priority;
      if (best === "mention") break;
    }
    return best;
  };

  const takeNextMessage = (queue: QueuedMessage[]): QueuedMessage | undefined => {
    let bestIndex = 0;
    let bestRank = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const rank = priorityRank(resolvePriority(queue[index]!));
      if (rank > bestRank) {
        bestIndex = index;
        bestRank = rank;
      }
    }
    return queue.splice(bestIndex, 1)[0];
  };

  const canStartPriority = (priority: MessageQueuePriority): boolean => {
    if (activeUsers.size >= maxConcurrentUsers) return false;
    if (priority !== "background") return true;
    let activeBackground = 0;
    for (const activePriority of activePriorities.values()) {
      if (activePriority === "background") activeBackground += 1;
    }
    return activeBackground < maxConcurrentBackground;
  };

  /** 处理单条消息，捕获异常并记录日志 */
  const processOne = async (
    msg: QueuedMessage,
    peerId: string,
    label: string,
  ): Promise<boolean> => {
    try {
      const startedAt = Date.now();
      msg._queueStartedAt = startedAt;
      log?.info(
        `[qqbot:${accountId}:latency] phase=queue-start runId=${msg.messageId} priority=${resolvePriority(msg)} queueWaitMs=${Math.max(0, startedAt - (msg._queueEnqueuedAt ?? startedAt))}`,
      );
      await handleMessageFnRef!(msg);
      return true;
    } catch (err) {
      log?.error(`[qqbot:${accountId}] ${label} error for ${peerId}: ${err}`);
      return false;
    }
  };

  const canRunConcurrentMention = (peerId: string): boolean => {
    const peerConcurrent = concurrentMentionsByPeer.get(peerId) ?? 0;
    const baseMention = activePriorities.get(peerId) === "mention" ? 1 : 0;
    return peerConcurrent + baseMention < maxConcurrentMentionsPerPeer
      && activeUsers.size + activeConcurrentMentions < maxConcurrentUsers;
  };

  const runConcurrentMention = (msg: QueuedMessage, peerId: string): void => {
    msg._queueIsolatedSession = true;
    concurrentMentionsByPeer.set(peerId, (concurrentMentionsByPeer.get(peerId) ?? 0) + 1);
    activeConcurrentMentions += 1;
    log?.info(
      `[qqbot:${accountId}] Concurrent mention started for ${peerId}: runId=${msg.messageId}, activeForPeer=${concurrentMentionsByPeer.get(peerId)}`,
    );
    void processOne(msg, peerId, "Concurrent mention processor").finally(() => {
      const remaining = Math.max(0, (concurrentMentionsByPeer.get(peerId) ?? 1) - 1);
      if (remaining === 0) concurrentMentionsByPeer.delete(peerId);
      else concurrentMentionsByPeer.set(peerId, remaining);
      activeConcurrentMentions = Math.max(0, activeConcurrentMentions - 1);
      promoteQueuedMention(peerId);
    });
  };

  const promoteQueuedMention = (peerId: string): void => {
    if (!activeUsers.has(peerId) || !canRunConcurrentMention(peerId)) return;
    const queue = userQueues.get(peerId);
    if (!queue?.length) return;
    const mentionIndex = queue.findIndex((queued) => resolvePriority(queued) === "mention");
    if (mentionIndex < 0) return;
    const [msg] = queue.splice(mentionIndex, 1);
    totalEnqueued = Math.max(0, totalEnqueued - 1);
    runConcurrentMention(msg!, peerId);
  };

  /** 逐条处理群聊排队消息，避免把多条未读消息压成一条。 */
  const drainGroupBatch = async (all: QueuedMessage[], peerId: string): Promise<void> => {
    if (all.length > 1) {
      log?.info(`[qqbot:${accountId}] Draining ${all.length} queued group messages individually for ${peerId}`);
    }
    for (const msg of all) {
      if (isSlashCommand(msg)) {
        log?.info(`[qqbot:${accountId}] Processing command independently for ${peerId}: ${(msg.content ?? "").trim().slice(0, 50)}`);
      }
      await processOne(msg, peerId, isSlashCommand(msg) ? "Command processor" : "Message processor");
    }
  };

  /** 处理指定 peer 队列中的消息（串行） */
  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) return;
    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    const activePriority = nextQueuePriority(queue) ?? "normal";
    if (!canStartPriority(activePriority)) {
      log?.info(
        `[qqbot:${accountId}] Queue priority wait for ${peerId}: priority=${activePriority}, active=${activeUsers.size}, backgroundLimit=${maxConcurrentBackground}`,
      );
      return;
    }

    activeUsers.add(peerId);
    activeStartedAt.set(peerId, Date.now());
    activePriorities.set(peerId, activePriority);
    const isGroup = isGroupPeer(peerId);

    try {
      while (queue.length > 0 && !ctx.isAborted()) {
        const nextPriority = nextQueuePriority(queue) ?? "normal";
        activePriorities.set(peerId, nextPriority);

        // 被 @ 的消息始终逐条优先处理，不能与轮询消息或其他群消息合并。
        if (nextPriority === "mention") {
          const msg = takeNextMessage(queue)!;
          totalEnqueued = Math.max(0, totalEnqueued - 1);
          if (handleMessageFnRef) {
            await processOne(msg, peerId, "Mention processor");
          }
          continue;
        }

        // 群聊排队 > 1 条：批量取出后仍逐条处理，保留消息边界。
        if (isGroup && queue.length > 1 && handleMessageFnRef) {
          const all: QueuedMessage[] = [];
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            if (resolvePriority(queue[index]!) === nextPriority) {
              all.unshift(queue.splice(index, 1)[0]!);
            }
          }
          totalEnqueued = Math.max(0, totalEnqueued - all.length);
          await drainGroupBatch(all, peerId);
          continue;
        }

        // 非群聊 或 队列只剩 1 条：逐条处理
        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        if (handleMessageFnRef) {
          await processOne(msg, peerId, "Message processor");
        }
      }
    } finally {
      activeUsers.delete(peerId);
      activeStartedAt.delete(peerId);
      activePriorities.delete(peerId);
      userQueues.delete(peerId);
      // 尽量填满并发槽位
      const waitingPeers = [...userQueues.entries()].sort((a, b) => (
        priorityRank(nextQueuePriority(b[1]) ?? "normal")
        - priorityRank(nextQueuePriority(a[1]) ?? "normal")
      ));
      for (const [waitingPeerId, waitingQueue] of waitingPeers) {
        if (activeUsers.size >= maxConcurrentUsers) break;
        if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
          drainUserQueue(waitingPeerId);
        }
      }
    }
  };

  const enqueue = (msg: QueuedMessage): void => {
    const peerId = getMessagePeerId(msg);
    const isGroup = isGroupPeer(peerId);
    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    // 群聊和非群聊使用不同的队列上限
    const maxSize = isGroup ? groupQueueSize : peerQueueSize;

    // 队列溢出：淘汰一条旧消息
    if (queue.length >= maxSize) {
      const dropped = evictOne(queue, isGroup);
      totalEnqueued = Math.max(0, totalEnqueued - 1);
      if (isGroup && dropped?.senderIsBot) {
        log?.info(`[qqbot:${accountId}] Queue full for ${peerId}, dropping bot message ${dropped.messageId}`);
      } else {
        log?.error(`[qqbot:${accountId}] Queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
      }
    }

    // 全局总量保护
    totalEnqueued++;
    if (totalEnqueued > globalQueueSize) {
      log?.error(`[qqbot:${accountId}] Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`);
    }

    const enqueuedAt = Date.now();
    msg._queueEnqueuedAt ??= enqueuedAt;
    msg._queuePriority = resolvePriority(msg);
    queue.push(msg);
    log?.info(
      `[qqbot:${accountId}:latency] phase=enqueue runId=${msg.messageId} priority=${msg._queuePriority} peer=${peerId} queueDepth=${queue.length}`,
    );
    log?.debug?.(`[qqbot:${accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`);

    if (msg._queuePriority === "mention" && (activeUsers.has(peerId) || (concurrentMentionsByPeer.get(peerId) ?? 0) > 0)) {
      if (activePriorities.get(peerId) === "background") {
        const aborted = ctx.abortActiveBackground?.(peerId) === true;
        log?.info(`[qqbot:${accountId}] Mention preempted background for ${peerId}: aborted=${aborted}`);
      }
      if (canRunConcurrentMention(peerId)) {
        const queuedIndex = queue.indexOf(msg);
        if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        runConcurrentMention(msg, peerId);
        return;
      }
    }

    // 如果该用户没有正在处理的消息，立即启动处理
    drainUserQueue(peerId);
  };

  const startProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    handleMessageFnRef = handleMessageFn;
    log?.info(`[qqbot:${accountId}] Message processor started (per-user concurrency, max ${maxConcurrentUsers} users, background max ${maxConcurrentBackground}, mentions per peer max ${maxConcurrentMentionsPerPeer})`);
    while (pendingImmediateMessages.length > 0 && !ctx.isAborted()) {
      const msg = pendingImmediateMessages.shift()!;
      executeImmediate(msg);
    }
  };

  const getSnapshot = (senderPeerId: string): QueueSnapshot => {
    let totalPending = 0;
    for (const [, q] of userQueues) {
      totalPending += q.length;
    }
    const senderQueue = userQueues.get(senderPeerId);
    const now = Date.now();
    const senderStartedAt = activeStartedAt.get(senderPeerId);
    let maxActiveMs = 0;
    for (const startedAt of activeStartedAt.values()) {
      maxActiveMs = Math.max(maxActiveMs, Math.max(0, now - startedAt));
    }
    return {
      totalPending,
      activeUsers: activeUsers.size,
      maxConcurrentUsers,
      senderPending: senderQueue ? senderQueue.length : 0,
      senderActiveMs: senderStartedAt === undefined ? undefined : Math.max(0, now - senderStartedAt),
      maxActiveMs: activeStartedAt.size === 0 ? undefined : maxActiveMs,
    };
  };

  const clearUserQueue = (peerId: string): number => {
    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) return 0;
    const droppedCount = queue.length;
    queue.length = 0;
    totalEnqueued = Math.max(0, totalEnqueued - droppedCount);
    return droppedCount;
  };

  const executeImmediate = (msg: QueuedMessage): void => {
    if (!handleMessageFnRef) {
      pendingImmediateMessages.push(msg);
      log?.info(`[qqbot:${accountId}] Immediate message queued until processor starts: ${msg.messageId}`);
      return;
    }
    handleMessageFnRef(msg).catch(err => {
      log?.error(`[qqbot:${accountId}] Immediate execution error: ${err}`);
    });
  };

  return { enqueue, startProcessor, getSnapshot, getMessagePeerId, clearUserQueue, executeImmediate };
}
