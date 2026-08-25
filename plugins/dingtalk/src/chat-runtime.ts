import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHAT_POLL_INTERVAL_MS = 60_000;
export const CHAT_MENTION_UNREAD_RECHECK_DELAY_MS = 1_000;
export const CHAT_HISTORY_FAILURE_RETRY_BASE_MS = 5 * 60_000;
export const CHAT_HISTORY_FAILURE_RETRY_MAX_MS = 60 * 60_000;

export interface DingTalkChatEntry {
  messageId: string;
  senderId: string;
  senderName: string;
  body: string;
  timestamp: number;
  media?: Array<{
    kind: "picture";
    path: string;
    contentType: string;
    fileName?: string;
    fileSize?: number;
  }>;
}

export interface DingTalkChatTarget {
  conversationId: string;
  openConversationId?: string;
  conversationTitle?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: string;
}

export interface DingTalkHistoryBatch {
  entries: DingTalkChatEntry[];
  cursorAt: number;
}

interface DingTalkChatState {
  groups: Record<string, {
    target: DingTalkChatTarget;
    unread: DingTalkChatEntry[];
    pollLevel: number;
    dueAt?: number;
    historyCursorAt?: number;
    seenMessageIds?: string[];
    historyFailureCount?: number;
  }>;
}

export interface DingTalkChatRuntimeOptions {
  accountId: string;
  onCatchup: (params: {
    groupId: string;
    target: DingTalkChatTarget;
    entries: DingTalkChatEntry[];
  }) => Promise<boolean>;
  fetchHistory?: (params: {
    groupId: string;
    target: DingTalkChatTarget;
    since: number;
  }) => Promise<DingTalkHistoryBatch>;
  log?: Pick<Console, "info" | "warn" | "error">;
  stateDir?: string;
  now?: () => number;
}

export class DingTalkChatRuntime {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private state: DingTalkChatState;

  constructor(private readonly options: DingTalkChatRuntimeOptions) {
    this.state = this.load();
    this.restore();
  }

  record(groupId: string, target: DingTalkChatTarget, entry: DingTalkChatEntry): number {
    const group = this.getGroup(groupId, target);
    if (!group.unread.some((item) => item.messageId === entry.messageId)) {
      group.unread.push(entry);
      if (group.unread.length > 60) group.unread.splice(0, group.unread.length - 60);
    }
    if (!group.dueAt) this.schedule(groupId, this.now() + CHAT_POLL_INTERVAL_MS);
    this.persist();
    return group.unread.length;
  }

  prepareMentionReply(groupId: string): DingTalkChatEntry[] {
    const group = this.state.groups[groupId];
    if (!group) return [];
    this.clearTimer(groupId);
    group.dueAt = undefined;
    this.persist();
    return [...group.unread];
  }

  markMentionReplyComplete(groupId: string, target: DingTalkChatTarget): void {
    const group = this.getGroup(groupId, target);
    const now = this.now();
    group.historyCursorAt = now;
    group.pollLevel = 0;
    const delay = group.unread.length > 0
      ? CHAT_MENTION_UNREAD_RECHECK_DELAY_MS
      : CHAT_POLL_INTERVAL_MS;
    this.schedule(groupId, now + delay);
    this.persist();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async fire(groupId: string): Promise<void> {
    this.timers.delete(groupId);
    const group = this.state.groups[groupId];
    if (!group) return;
    group.dueAt = undefined;

    let historyFailed = false;
    if (this.options.fetchHistory) {
      try {
        const batch = await this.options.fetchHistory({
          groupId,
          target: group.target,
          since: group.historyCursorAt ?? this.now(),
        });
        const seen = new Set(group.seenMessageIds ?? []);
        for (const entry of batch.entries.sort((a, b) => a.timestamp - b.timestamp)) {
          if (seen.has(entry.messageId)) continue;
          seen.add(entry.messageId);
          group.unread.push(entry);
        }
        group.historyCursorAt = Math.max(group.historyCursorAt ?? 0, batch.cursorAt);
        group.seenMessageIds = [...seen].slice(-200);
        group.historyFailureCount = 0;
        if (group.unread.length > 60) group.unread.splice(0, group.unread.length - 60);
      } catch (error) {
        historyFailed = true;
        group.historyFailureCount = (group.historyFailureCount ?? 0) + 1;
        const retryDelay = historyFailureRetryDelayMs(group.historyFailureCount);
        this.options.log?.error?.(
          `[DingTalk chat] history pull failed for ${groupId}; retry in ${retryDelay}ms: ${String(error)}`,
        );
      }
    }

    if (group.unread.length === 0) {
      group.pollLevel = 0;
      const delay = historyFailed
        ? historyFailureRetryDelayMs(group.historyFailureCount ?? 1)
        : CHAT_POLL_INTERVAL_MS;
      this.schedule(groupId, this.now() + delay);
      this.persist();
      return;
    }

    const entries = group.unread.splice(0);
    try {
      const replied = await this.options.onCatchup({ groupId, target: group.target, entries });
      if (!replied) group.unread.unshift(...entries);
      group.pollLevel = 0;
    } catch (error) {
      group.unread.unshift(...entries);
      group.pollLevel = 0;
      this.options.log?.error?.(`[DingTalk chat] catch-up failed for ${groupId}: ${String(error)}`);
    }
    this.schedule(groupId, this.now() + CHAT_POLL_INTERVAL_MS);
    this.persist();
  }

  private getGroup(groupId: string, target: DingTalkChatTarget): DingTalkChatState["groups"][string] {
    const existing = this.state.groups[groupId];
    if (existing) {
      existing.target = {
        ...existing.target,
        ...target,
        sessionWebhook: target.sessionWebhook ?? existing.target.sessionWebhook,
        sessionWebhookExpiredTime: target.sessionWebhookExpiredTime ?? existing.target.sessionWebhookExpiredTime,
      };
      existing.historyCursorAt ??= this.now();
      existing.seenMessageIds ??= [];
      return existing;
    }
    return (this.state.groups[groupId] = {
      target,
      unread: [],
      pollLevel: 0,
      historyCursorAt: this.now(),
      seenMessageIds: [],
      historyFailureCount: 0,
    });
  }

  private schedule(groupId: string, dueAt: number): void {
    this.clearTimer(groupId);
    const group = this.state.groups[groupId];
    if (!group) return;
    group.dueAt = dueAt;
    const delay = Math.max(1_000, dueAt - this.now());
    const timer = setTimeout(() => void this.fire(groupId), delay);
    timer.unref?.();
    this.timers.set(groupId, timer);
    this.options.log?.info?.(`[DingTalk chat] poll set for ${groupId} in ${delay}ms`);
  }

  private clearTimer(groupId: string): void {
    const timer = this.timers.get(groupId);
    if (timer) clearTimeout(timer);
    this.timers.delete(groupId);
  }

  private restore(): void {
    for (const [groupId, group] of Object.entries(this.state.groups)) {
      group.historyCursorAt ??= this.now();
      group.seenMessageIds ??= [];
      group.pollLevel = 0;
      if (group.dueAt) {
        const dueAt = Math.min(group.dueAt, this.now() + CHAT_POLL_INTERVAL_MS);
        this.schedule(groupId, dueAt);
      }
    }
    this.persist();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private statePath(): string {
    const root = this.options.stateDir
      ?? path.join(process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw"), "ddingtalk", "data");
    const safeAccount = this.options.accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(root, `chat-${safeAccount}.json`);
  }

  private load(): DingTalkChatState {
    try {
      const file = this.statePath();
      if (!fs.existsSync(file)) return { groups: {} };
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DingTalkChatState;
      return { groups: parsed.groups ?? {} };
    } catch (error) {
      this.options.log?.warn?.(`[DingTalk chat] state load failed: ${String(error)}`);
      return { groups: {} };
    }
  }

  private persist(): void {
    try {
      const file = this.statePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      fs.renameSync(temp, file);
    } catch (error) {
      this.options.log?.error?.(`[DingTalk chat] state save failed: ${String(error)}`);
    }
  }
}

export function historyFailureRetryDelayMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(10, Math.trunc(failureCount) - 1));
  return Math.min(CHAT_HISTORY_FAILURE_RETRY_MAX_MS, CHAT_HISTORY_FAILURE_RETRY_BASE_MS * (2 ** exponent));
}

export function buildDingTalkCatchupPrompt(entries: DingTalkChatEntry[]): string {
  const history = entries
    .map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}] ${entry.senderName}: ${entry.body}`)
    .join("\n");
  return [
    "根据下面的群聊新消息，直接生成一条适合发到群里的中文消息。",
    "内容集中时顺着当前聊天自然发言；内容分散时，只选择值得回应的内容，并可用真实昵称点名有代表性的成员。不要自己输出@符号，发送层会将识别到的群成员转换为真实@。",
    "只输出群成员最终会看到的正文。禁止解释你准备如何回复、消息是什么意思或话题是什么；禁止出现“我接一句”“我不接”“接一句就行”“这句话是说”“这话的意思是”“上一个话题”“总结一下”等元叙述。",
    "将正文严格包在 <dingtalk_final> 和 </dingtalk_final> 之间；标签外不要输出任何内容。发送层只会读取标签内正文。",
    "如果没有值得补充的内容，只输出 NO_REPLY，不要解释为什么不回复。",
    "不要输出分析、逐条总结，也不要提到轮询、未读、任务、系统机制或自己在查看历史。",
    "除非群成员明确求助，否则不要调用工具。",
    "\n群聊未读消息：\n",
    history,
  ].join("\n");
}

export function buildDingTalkMentionContext(entries: DingTalkChatEntry[]): string {
  const history = entries
    .map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}] ${entry.senderName}: ${entry.body}`)
    .join("\n");
  return [
    "以下是当前@消息之前尚未处理的群聊消息，仅用于理解当前对话上下文。",
    "本轮只回复后面的当前@消息，不要单独回应、总结或评价这些历史消息。当前回复完成后，系统会独立判断这些消息是否值得回复。",
    "\n此前未读消息：\n",
    history,
  ].join("\n");
}

export function buildDingTalkReplyPolicyPrompt(params: {
  proactive?: boolean;
  wasMentioned?: boolean;
}): string | undefined {
  if (params.wasMentioned) {
    return [
      "DingTalk channel delivery rule: the current group message explicitly mentioned the bot.",
      "You must produce a visible, natural reply, including for a simple greeting such as hello.",
      "Do not answer with NO_REPLY, HEARTBEAT_OK, an empty response, or a reaction-only acknowledgement.",
      "Call tools silently when needed; never output planning, tool narration, intermediate observations, or bracketed image summaries.",
      "Wrap the final user-facing Chinese chat response in <dingtalk_final>...</dingtalk_final>. Put nothing outside these tags.",
      "Keep a greeting response concise when there is no substantive question.",
    ].join(" ");
  }
  if (params.proactive) {
    return [
      "DingTalk channel delivery rule: this turn was triggered because the chat poll found unread group messages.",
      "Produce one natural group-chat contribution only when it adds useful information. Otherwise answer with exactly NO_REPLY and do not explain the decision.",
      "When replying, you may name relevant group members naturally; do not write the @ symbol because the channel will convert recognized member names into native mentions.",
      "Call tools silently when needed. Wrap the final user-facing Chinese chat response in <dingtalk_final>...</dingtalk_final>, with nothing outside the tags and no planning, semantic explanation, response narration, or intermediate observations.",
    ].join(" ");
  }
  return undefined;
}
