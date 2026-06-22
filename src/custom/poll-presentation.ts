import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { summarizePollResults } from "./poll.js";
import type { CustomPoll } from "./types.js";
import { slashCommandInput } from "./command-link.js";
import {
  formatPollStatusForDisplay,
  formatUnknown,
} from "./presentation-labels.js";

export function buildCustomPollKeyboard(poll: CustomPoll): InlineKeyboard {
  const rows = poll.options.map((option) => ({
    buttons: [makePollButton(poll.id, option.id, option.label)],
  }));
  return { content: { rows } };
}

export function formatCustomPollHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🗳 自定义投票命令`,
    ``,
    slashCommandInput(`/bot-poll create 问题 | 选项A | 选项B [| 选项C | 选项D]`),
    slashCommandInput(`/bot-poll list`),
    slashCommandInput(`/bot-poll status <pollId>`),
    slashCommandInput(`/bot-poll close <pollId>`),
  );
  return lines.join("\n");
}

export function formatPollCreated(poll: CustomPoll): string {
  return [
    `🗳 投票已创建`,
    ``,
    `投票：${poll.id}`,
    `问题：${poll.question}`,
    ``,
    ...poll.options.map((option) => `${option.id}. ${option.label}`),
  ].join("\n");
}

export function formatPollList(polls: CustomPoll[]): string {
  if (polls.length === 0) return "🗳 当前会话暂无投票。";
  const lines = ["🗳 当前会话投票", ""];
  for (const poll of polls) {
    lines.push(`- ${poll.id} [${formatPollStatusForDisplay(poll.status)}] ${poll.question}`);
  }
  return lines.join("\n");
}

export function formatPollStatus(poll: CustomPoll): string {
  const total = Object.keys(poll.votes).length;
  const lines = [
    `🗳 投票状态`,
    ``,
    `投票：${poll.id}`,
    `状态：${formatPollStatusForDisplay(poll.status)}`,
    `问题：${poll.question}`,
    `总票数：${total}`,
    ``,
    ...summarizePollResults(poll).map((item) => `${item.optionId}. ${item.label}：${item.count}`),
  ];
  return lines.join("\n");
}

export function formatPollClosed(poll: CustomPoll): string {
  return [`✅ 投票已关闭：${poll.id}`, ``, formatPollStatus(poll)].join("\n");
}

export function formatPollVoteAck(poll: CustomPoll, actorId: string): string {
  const vote = poll.votes[actorId];
  const option = vote ? poll.options.find((item) => item.id === vote.optionId) : null;
  return [
    `✅ 已记录投票：${formatUnknown(option?.label ?? vote?.optionId)}`,
    ``,
    `投票：${poll.id}`,
    `当前总票数：${Object.keys(poll.votes).length}`,
  ].join("\n");
}

export function formatPollDecision(reason: string): string {
  if (reason === "invalid_question") return "⚠️ 投票问题不能为空。";
  if (reason === "invalid_options") return "⚠️ 投票需要 2 到 4 个不同选项。";
  if (reason === "closed") return "⚠️ 投票已关闭。";
  if (reason === "not_found") return "⚠️ 投票不存在。";
  return `⚠️ 操作失败：${reason}`;
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
