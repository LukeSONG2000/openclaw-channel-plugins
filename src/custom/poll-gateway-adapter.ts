import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { CustomPollRuntime } from "./poll.js";
import { parseCustomPollButtonData, parseCustomPollCommand } from "./poll-command-parser.js";
import {
  buildCustomPollKeyboard,
  formatCustomPollHelp,
  formatPollClosed,
  formatPollCreated,
  formatPollDecision,
  formatPollList,
  formatPollStatus,
  formatPollVoteAck,
} from "./poll-presentation.js";
import type { CustomActor, CustomPeer, CustomPoll } from "./types.js";

export {
  parseCustomPollButtonData,
  parseCustomPollCommand,
  type CustomPollButtonPayload,
  type CustomPollCommand,
  type CustomPollCommandParseResult,
} from "./poll-command-parser.js";

export {
  buildCustomPollKeyboard,
  formatCustomPollHelp,
  formatPollClosed,
  formatPollCreated,
  formatPollDecision,
  formatPollList,
  formatPollStatus,
  formatPollVoteAck,
} from "./poll-presentation.js";

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
