import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { CustomPollRuntime, summarizePollResults } from "./poll.js";
import type { CustomActor, CustomPeer, CustomPoll } from "./types.js";

export type CustomPollCommand =
  | { kind: "help" }
  | { kind: "create"; question: string; options: string[] }
  | { kind: "list" }
  | { kind: "status"; pollId: string }
  | { kind: "close"; pollId: string };

export type CustomPollCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomPollCommand; error?: string };

export interface CustomPollCommandResult {
  handled: boolean;
  reply?: string;
  keyboard?: InlineKeyboard;
  changed?: boolean;
}

export interface CustomPollInteractionResult {
  handled: boolean;
  reply?: string;
  changed?: boolean;
}

export function parseCustomPollCommand(rawContent: string): CustomPollCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-poll") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "status" || action === "show") {
    const pollId = tokens.shift();
    if (!pollId) return { matched: true, error: "缺少 pollId" };
    return { matched: true, command: { kind: "status", pollId } };
  }
  if (action === "close" || action === "end") {
    const pollId = tokens.shift();
    if (!pollId) return { matched: true, error: "缺少 pollId" };
    return { matched: true, command: { kind: "close", pollId } };
  }
  if (action === "create" || action === "new") {
    const rest = tokens.join(" ");
    const parts = rest.split("|").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) return { matched: true, error: "格式：/bot-poll create 问题 | 选项A | 选项B [| 选项C | 选项D]" };
    const [question, ...options] = parts;
    return { matched: true, command: { kind: "create", question: question!, options } };
  }
  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomPollCommand(params: {
  cfg: OpenClawConfig;
  accountId: string;
  polls: CustomPollRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomPollCommandResult {
  const parsed = parseCustomPollCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) return { handled: true, reply: "ℹ️ customRuntime 未启用，无法使用 /bot-poll。" };
  if (parsed.error) return { handled: true, reply: formatCustomPollHelp(parsed.error) };
  const command = parsed.command ?? { kind: "help" as const };
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);

  if (command.kind === "help") return { handled: true, reply: formatCustomPollHelp() };
  if (command.kind === "list") {
    return { handled: true, reply: formatPollList(params.polls.listPolls({ accountId: params.accountId, peer, limit: 8 })) };
  }
  if (command.kind === "status") {
    const poll = resolvePoll(params.polls, command.pollId);
    if (!poll || !canReadPoll(poll, params.accountId, peer, actor)) {
      return { handled: true, reply: `⚠️ 未找到投票，或该投票不属于当前会话：${command.pollId}` };
    }
    return { handled: true, reply: formatPollStatus(poll) };
  }
  if (command.kind === "close") {
    const poll = resolvePoll(params.polls, command.pollId);
    if (!poll || !canReadPoll(poll, params.accountId, peer, actor)) {
      return { handled: true, reply: `⚠️ 未找到投票，或该投票不属于当前会话：${command.pollId}` };
    }
    const result = params.polls.closePoll({ pollId: poll.id, now: params.now });
    return {
      handled: true,
      changed: result.allowed,
      reply: result.allowed && result.poll ? formatPollClosed(result.poll) : formatPollDecision(result.reason),
    };
  }
  if (command.kind === "create") {
    const result = params.polls.createPoll({
      accountId: params.accountId,
      peer,
      creator: actor,
      question: command.question,
      options: command.options,
      now: params.now,
    });
    if (!result.allowed || !result.poll) return { handled: true, reply: formatPollDecision(result.reason) };
    return {
      handled: true,
      changed: true,
      reply: formatPollCreated(result.poll),
      keyboard: buildCustomPollKeyboard(result.poll),
    };
  }
  return { handled: true, reply: formatCustomPollHelp() };
}

export function parseCustomPollButtonData(buttonData: string): { pollId: string; optionId: string } | null {
  const m = buttonData.match(/^custom-poll:([^:]+):vote:([1-4])$/i);
  if (!m) return null;
  return { pollId: m[1]!, optionId: m[2]! };
}

export function handleCustomPollInteraction(params: {
  accountId?: string;
  polls: CustomPollRuntime;
  buttonData: string;
  actorId: string;
  actorLabel?: string;
  sourcePeer?: CustomPeer;
  now?: number;
}): CustomPollInteractionResult {
  const payload = parseCustomPollButtonData(params.buttonData);
  if (!payload) return { handled: false };
  const actor: CustomActor = { id: params.actorId, label: params.actorLabel };
  const poll = params.polls.getPoll(payload.pollId);
  if (!canVoteFromInteraction({
    poll,
    accountId: params.accountId,
    sourcePeer: params.sourcePeer,
    actor,
  })) {
    return {
      handled: true,
      changed: false,
      reply: `⚠️ 投票不存在，或该投票不属于当前会话。`,
    };
  }
  const result = params.polls.vote({
    pollId: payload.pollId,
    optionId: payload.optionId,
    actor,
    now: params.now,
  });
  return {
    handled: true,
    changed: result.allowed,
    reply: result.allowed && result.poll ? formatPollVoteAck(result.poll, actor.id) : formatPollDecision(result.reason),
  };
}

export function buildCustomPollKeyboard(poll: CustomPoll): InlineKeyboard {
  const rows = poll.options.map((option) => ({
    buttons: [makePollButton(poll.id, option.id, option.label)],
  }));
  return { content: { rows } };
}

function makePollButton(pollId: string, optionId: string, label: string): KeyboardButton {
  return {
    id: `poll_${optionId}`,
    render_data: { label, visited_label: `已选 ${label}`, style: 1 },
    action: {
      type: 1,
      data: `custom-poll:${pollId}:vote:${optionId}`,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: `custom-poll-${pollId}`,
  };
}

function formatCustomPollHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🗳 自定义投票命令`,
    ``,
    `/bot-poll create 问题 | 选项A | 选项B [| 选项C | 选项D]`,
    `/bot-poll list`,
    `/bot-poll status <pollId>`,
    `/bot-poll close <pollId>`,
  );
  return lines.join("\n");
}

function formatPollCreated(poll: CustomPoll): string {
  return [
    `🗳 投票已创建`,
    ``,
    `投票：${poll.id}`,
    `问题：${poll.question}`,
    ``,
    ...poll.options.map((option) => `${option.id}. ${option.label}`),
  ].join("\n");
}

function formatPollList(polls: CustomPoll[]): string {
  if (polls.length === 0) return "🗳 当前会话暂无投票。";
  const lines = ["🗳 当前会话投票", ""];
  for (const poll of polls) {
    lines.push(`- ${poll.id} [${poll.status}] ${poll.question}`);
  }
  return lines.join("\n");
}

function formatPollStatus(poll: CustomPoll): string {
  const total = Object.keys(poll.votes).length;
  const lines = [
    `🗳 投票状态`,
    ``,
    `投票：${poll.id}`,
    `状态：${poll.status}`,
    `问题：${poll.question}`,
    `总票数：${total}`,
    ``,
    ...summarizePollResults(poll).map((item) => `${item.optionId}. ${item.label}：${item.count}`),
  ];
  return lines.join("\n");
}

function formatPollClosed(poll: CustomPoll): string {
  return [`✅ 投票已关闭：${poll.id}`, ``, formatPollStatus(poll)].join("\n");
}

function formatPollVoteAck(poll: CustomPoll, actorId: string): string {
  const vote = poll.votes[actorId];
  const option = vote ? poll.options.find((item) => item.id === vote.optionId) : null;
  return [
    `✅ 已记录投票：${option?.label ?? vote?.optionId ?? "unknown"}`,
    ``,
    `投票：${poll.id}`,
    `当前总票数：${Object.keys(poll.votes).length}`,
  ].join("\n");
}

function formatPollDecision(reason: string): string {
  if (reason === "invalid_question") return "⚠️ 投票问题不能为空。";
  if (reason === "invalid_options") return "⚠️ 投票需要 2 到 4 个不同选项。";
  if (reason === "closed") return "⚠️ 投票已关闭。";
  if (reason === "not_found") return "⚠️ 投票不存在。";
  return `⚠️ 操作失败：${reason}`;
}

function resolvePoll(polls: CustomPollRuntime, input: string): CustomPoll | null {
  const exact = polls.getPoll(input);
  if (exact) return exact;
  const matches = polls.listPolls({ limit: Number.MAX_SAFE_INTEGER })
    .filter((poll) => poll.id.startsWith(input) || poll.id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function canReadPoll(
  poll: CustomPoll,
  accountId: string,
  peer: ReturnType<typeof toCustomPeerFromQueuedMessage>,
  actor: ReturnType<typeof toCustomActorFromQueuedMessage>,
): boolean {
  if (poll.accountId !== accountId) return false;
  if (poll.creator.id.toUpperCase() === actor.id.toUpperCase()) return true;
  return poll.peer.kind === peer.kind && poll.peer.id === peer.id;
}

function canVoteFromInteraction(params: {
  poll: CustomPoll | null;
  accountId?: string;
  sourcePeer?: CustomPeer;
  actor: CustomActor;
}): boolean {
  const { poll } = params;
  if (!poll) return false;
  if (params.accountId && poll.accountId !== params.accountId) return false;
  if (poll.creator.id.toUpperCase() === params.actor.id.toUpperCase()) return true;
  if (!params.sourcePeer) return true;
  return poll.peer.kind === params.sourcePeer.kind && poll.peer.id === params.sourcePeer.id;
}
