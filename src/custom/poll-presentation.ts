import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { getPollVotedCount, summarizePollResults } from "./poll.js";
import type { CustomActor, CustomPoll } from "./types.js";
import { slashCommandInput } from "./command-link.js";
import {
  formatPollStatusForDisplay,
  formatUnknown,
} from "./presentation-labels.js";
import { formatCustomActorIdentity } from "./identity-presentation.js";

export const CUSTOM_POLL_LIST_PAGE_SIZE = 10;

export function buildCustomPollKeyboard(poll: CustomPoll): InlineKeyboard {
  const buttons = poll.options.map((option) => makePollButton(poll, option.id, option.label));
  const chunkSize = buttons.length > 5 ? 2 : 1;
  const rows = chunkButtons(buttons, chunkSize).map((rowButtons) => ({ buttons: rowButtons }));
  return { content: { rows } };
}

export function formatCustomPollHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🗳 自定义投票命令`,
    ``,
    slashCommandInput(`/bot-poll 今天午饭吃什么？米饭、面条、沙拉，10分钟后结束`),
    slashCommandInput(`/bot-poll 发起匿名多选：周末去哪玩，露营、爬山、看电影`),
    slashCommandInput(`/bot-poll list`),
    slashCommandInput(`/bot-poll status <pollId>`),
    slashCommandInput(`/bot-poll close <pollId>`),
    ``,
    `创建投票只需要自然语言描述。默认：单选、不匿名、持续 10 分钟。可写“多选 / 匿名 / 30分钟”。`,
  );
  return lines.join("\n");
}

export function formatPollCreated(poll: CustomPoll): string {
  return [
    `🗳 投票已创建`,
    ``,
    `投票：${poll.id}`,
    `标题：${poll.question}`,
    `类型：${poll.multiple ? "多选" : "单选"}｜${poll.anonymous ? "匿名" : "不匿名"}`,
    `截止：${formatTimestamp(poll.expiresAt)}`,
    ``,
    ...poll.options.map((option) => `${option.id}. ${option.label}`),
  ].join("\n");
}

export function formatPollList(polls: CustomPoll[], params: {
  page?: number;
  actorId?: string;
  hasPrev?: boolean;
  hasNext?: boolean;
} = {}): string {
  if (polls.length === 0) return "🗳 当前会话暂无投票。";
  const page = Math.max(0, params.page ?? 0);
  const lines = [`🗳 当前会话投票（第 ${page + 1} 页，近 ${CUSTOM_POLL_LIST_PAGE_SIZE} 条，按创建时间先后）`, ""];
  for (const poll of polls) {
    const ownerHint = poll.status === "open" && params.actorId
      ? `｜属于你：${isPollCreator(poll, params.actorId) ? "是" : "否"}`
      : "";
    lines.push(`- ${formatPollStatusForDisplay(poll.status)}｜${poll.question}${ownerHint}`);
    lines.push(`  ${poll.id}`);
  }
  if (params.hasPrev || params.hasNext) lines.push("", `可用下方按钮翻页或查看详情。`);
  return lines.join("\n");
}

export function formatPollStatus(poll: CustomPoll): string {
  const total = getPollVotedCount(poll);
  const lines = [
    `🗳 投票状态`,
    ``,
    `投票：${poll.id}`,
    `状态：${formatPollStatusForDisplay(poll.status)}`,
    `标题：${poll.question}`,
    `类型：${poll.multiple ? "多选" : "单选"}｜${poll.anonymous ? "匿名" : "不匿名"}`,
    `已投票人数：${total}`,
    ``,
    ...(poll.status === "closed"
      ? formatPollResultLines(poll)
      : [`进行中投票暂不展示结果。`]),
  ];
  return lines.join("\n");
}

export function formatPollClosed(poll: CustomPoll): string {
  return [`✅ 投票已关闭：${poll.id}`, ``, formatPollStatus(poll)].join("\n");
}

export function formatPollVoteAck(poll: CustomPoll, actor: Pick<CustomActor, "id" | "label">): string {
  return [
    `✅ ${formatUnknown(actor.label ?? actor.id)} 已投票`,
    ``,
    `投票：${poll.id}`,
    `当前已投票人数：${getPollVotedCount(poll)}`,
  ].join("\n");
}

export function formatPollDetail(poll: CustomPoll, params: { actorId?: string } = {}): string {
  const isCreator = params.actorId ? isPollCreator(poll, params.actorId) : false;
  if (poll.status === "closed") return formatPollStatus(poll);
  return [
    `🗳 投票详情`,
    ``,
    `投票：${poll.id}`,
    `状态：${formatPollStatusForDisplay(poll.status)}`,
    `标题：${poll.question}`,
    `类型：${poll.multiple ? "多选" : "单选"}｜${poll.anonymous ? "匿名" : "不匿名"}`,
    `截止：${formatTimestamp(poll.expiresAt)}`,
    `已投票人数：${getPollVotedCount(poll)}`,
    ...(params.actorId ? [`属于你：${isCreator ? "是" : "否"}`] : []),
    ``,
    isCreator ? `如需提前结束，请点击下方按钮二次确认。` : `进行中投票暂不展示结果。`,
  ].join("\n");
}

export function formatPollCloseConfirm(poll: CustomPoll): string {
  return [
    `⚠️ 确认提前结束投票？`,
    ``,
    `标题：${poll.question}`,
    `已投票人数：${getPollVotedCount(poll)}`,
    `确认后会立即显示最终结果。`,
  ].join("\n");
}

export function formatPollFinalResult(poll: CustomPoll): string {
  return [
    `🗳 投票结果`,
    ``,
    `标题：${poll.question}`,
    `总人数：${getPollVotedCount(poll)}`,
    ``,
    ...formatPollResultLines(poll),
  ].join("\n");
}

export function formatPollDecision(reason: string): string {
  if (reason === "invalid_question") return "⚠️ 投票问题不能为空。";
  if (reason === "invalid_options") return "⚠️ 投票需要 2 到 10 个不同选项。";
  if (reason === "closed") return "⚠️ 投票已关闭。";
  if (reason === "not_found") return "⚠️ 投票不存在。";
  return `⚠️ 操作失败：${reason}`;
}

function makePollButton(poll: CustomPoll, optionId: string, label: string): KeyboardButton {
  return {
    id: `poll_${optionId}`,
    render_data: { label, visited_label: `已选 ${label}`, style: 1 },
    action: {
      type: 1,
      data: `custom-poll:${poll.id}:vote:${optionId}`,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: poll.multiple ? `custom-poll-${poll.id}-${optionId}` : `custom-poll-${poll.id}`,
  };
}

export function buildCustomPollListKeyboard(params: {
  polls: CustomPoll[];
  page?: number;
  hasPrev?: boolean;
  hasNext?: boolean;
}): InlineKeyboard {
  const page = Math.max(0, params.page ?? 0);
  const rows = params.polls.map((poll, index) => ({
    buttons: [makePollActionButton(`poll_detail_${index}`, `查看 ${index + 1}`, `custom-poll:${poll.id}:detail:${page}`, 1)],
  }));
  const navButtons: KeyboardButton[] = [];
  if (params.hasPrev) navButtons.push(makePollActionButton("poll_prev", "上一页", `custom-poll:list:${page - 1}`, 0));
  if (params.hasNext) navButtons.push(makePollActionButton("poll_next", "下一页", `custom-poll:list:${page + 1}`, 0));
  if (navButtons.length > 0) rows.push({ buttons: navButtons });
  return { content: { rows } };
}

export function buildCustomPollDetailKeyboard(poll: CustomPoll, params: {
  actorId?: string;
  page?: number;
} = {}): InlineKeyboard | undefined {
  const page = Math.max(0, params.page ?? 0);
  const buttons: KeyboardButton[] = [
    makePollActionButton("poll_back", "返回列表", `custom-poll:list:${page}`, 0),
  ];
  if (poll.status === "open" && params.actorId && isPollCreator(poll, params.actorId)) {
    buttons.unshift(makePollActionButton("poll_close_request", "提前结束", `custom-poll:${poll.id}:close-request:${page}`, 3));
  }
  return { content: { rows: [{ buttons }] } };
}

export function buildCustomPollCloseConfirmKeyboard(poll: CustomPoll, page = 0): InlineKeyboard {
  return {
    content: {
      rows: [{
        buttons: [
          makePollActionButton("poll_close_confirm", "确认结束", `custom-poll:${poll.id}:close-confirm:${page}`, 3),
          makePollActionButton("poll_cancel", "取消", `custom-poll:${poll.id}:detail:${page}`, 0),
        ],
      }],
    },
  };
}

function makePollActionButton(id: string, label: string, data: string, style: 0 | 1 | 2 | 3 | 4): KeyboardButton {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 0,
    },
  };
}

function chunkButtons(buttons: KeyboardButton[], size: number): KeyboardButton[][] {
  const rows: KeyboardButton[][] = [];
  for (let index = 0; index < buttons.length; index += size) {
    rows.push(buttons.slice(index, index + size));
  }
  return rows;
}

function formatPollResultLines(poll: CustomPoll): string[] {
  const votersByOption = new Map<string, CustomActor[]>();
  if (!poll.anonymous) {
    for (const vote of Object.values(poll.votes)) {
      const optionIds = vote.optionIds?.length ? vote.optionIds : [vote.optionId];
      for (const optionId of optionIds) {
        if (!votersByOption.has(optionId)) votersByOption.set(optionId, []);
        votersByOption.get(optionId)!.push(vote.actor);
      }
    }
  }
  return summarizePollResults(poll).map((item) => {
    const voters = votersByOption.get(item.optionId) ?? [];
    const voterText = poll.anonymous || voters.length === 0
      ? ""
      : `｜${voters.map((actor) => formatCustomActorIdentity(actor, { idLabel: "openid" })).join("、")}`;
    return `${item.optionId}. ${item.label}：${item.count}${voterText}`;
  });
}

function isPollCreator(poll: CustomPoll, actorId: string): boolean {
  return poll.creator.id.toUpperCase() === actorId.toUpperCase();
}

function formatTimestamp(value: number | undefined): string {
  if (!value) return "未设置";
  return new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}
