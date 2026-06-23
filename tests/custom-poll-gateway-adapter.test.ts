import assert from "node:assert";
import {
  buildCustomPollKeyboard,
  handleCustomPollCommand,
  handleCustomPollInteraction,
  parseCustomPollButtonData,
  parseCustomPollCommand,
} from "../src/custom/poll-gateway-adapter.js";
import {
  encodeCustomPollCreateCommand,
  parseCustomPollButtonData as parseCustomPollButtonDataDirect,
  parseCustomPollCommand as parseCustomPollCommandDirect,
} from "../src/custom/poll-command-parser.js";
import {
  buildCustomPollKeyboard as buildCustomPollKeyboardDirect,
  formatPollStatus as formatPollStatusDirect,
} from "../src/custom/poll-presentation.js";
import { CustomPollRuntime } from "../src/custom/poll.js";
import type { QueuedMessage } from "../src/message-queue.js";

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
      },
    },
  },
} as any;

const disabledCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: false,
      },
    },
  },
} as any;

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-poll create Pick one | A | B",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(parseCustomPollCommand("hello"), { matched: false });
const encodedCreate = encodeCustomPollCreateCommand({ kind: "create", question: "Pick one", options: ["A", "B"] });
assert.deepEqual(parseCustomPollCommand(encodedCreate), {
  matched: true,
  command: { kind: "create", question: "Pick one", options: ["A", "B"] },
});
const naturalCreate = parseCustomPollCommand("/bot-poll 晚上吃什么，肯德基还是麦当劳");
assert.equal(naturalCreate.matched, true);
assert.equal(naturalCreate.matched && naturalCreate.error?.includes("自然语言"), true);
assert.deepEqual(parseCustomPollCommand("创建投票，肯德基，麦当劳，晚上吃什么，2分钟后收集"), { matched: false });
assert.deepEqual(parseCustomPollCommand("创建投票，晚上吃什么"), { matched: false });
assert.deepEqual(
  parseCustomPollCommandDirect(encodedCreate),
  parseCustomPollCommand(encodedCreate),
);
assert.deepEqual(parseCustomPollCommand("/bot-poll status poll-1"), {
  matched: true,
  command: { kind: "status", pollId: "poll-1" },
});
assert.deepEqual(parseCustomPollCommand("/bot-poll close"), {
  matched: true,
  error: "缺少 pollId",
});
assert.deepEqual(parseCustomPollButtonData("custom-poll:poll-default-group-GROUP_OPENID-1000-1:vote:2"), {
  kind: "vote",
  pollId: "poll-default-group-GROUP_OPENID-1000-1",
  optionId: "2",
});
assert.deepEqual(parseCustomPollButtonData("custom-poll:list:1"), { kind: "list", page: 1 });
assert.deepEqual(
  parseCustomPollButtonDataDirect("custom-poll:poll-default-group-GROUP_OPENID-1000-1:vote:2"),
  parseCustomPollButtonData("custom-poll:poll-default-group-GROUP_OPENID-1000-1:vote:2"),
);
assert.equal(parseCustomPollButtonData("custom-auth:req:allow-once"), null);

const disabledRuntime = new CustomPollRuntime();
const disabled = handleCustomPollCommand({
  cfg: disabledCfg,
  accountId: "default",
  polls: disabledRuntime,
  message,
  rawContent: "/bot-poll list",
  now: 500,
});
assert.equal(disabled.handled, true);
assert.equal(disabled.reply?.includes("customRuntime 未启用"), true);

const polls = new CustomPollRuntime();
const create = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message,
  rawContent: encodeCustomPollCreateCommand({ kind: "create", question: "Pick one", options: ["A", "B", "C"] }),
  now: 1_000,
});
assert.equal(create.handled, true);
assert.equal(create.changed, true);
assert.equal(create.reply?.includes("投票已创建"), true);
assert.equal(create.keyboard?.content?.rows.length, 3);

const pollId = Object.keys(polls.getState().polls)[0]!;
assert.equal(pollId, "poll-default-group-GROUP_OPENID-1000-1");
const keyboard = buildCustomPollKeyboard(polls.getPoll(pollId)!);
assert.equal(keyboard.content?.rows[1]?.buttons[0]?.action?.data, `custom-poll:${pollId}:vote:2`);
assert.deepEqual(buildCustomPollKeyboardDirect(polls.getPoll(pollId)!), keyboard);

const vote = handleCustomPollInteraction({
  accountId: "default",
  polls,
  buttonData: `custom-poll:${pollId}:vote:2`,
  actorId: "VOTER_OPENID",
  actorLabel: "Voter",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_000,
});
assert.equal(vote.handled, true);
assert.equal(vote.changed, true);
assert.equal(vote.reply?.includes("Voter 已投票"), true);
assert.equal(vote.reply?.includes("B"), false);
assert.equal(polls.getPoll(pollId)?.votes.VOTER_OPENID?.optionId, "2");

const crossPeerVote = handleCustomPollInteraction({
  accountId: "default",
  polls,
  buttonData: `custom-poll:${pollId}:vote:1`,
  actorId: "OTHER_MEMBER_OPENID",
  actorLabel: "Other",
  sourcePeer: { kind: "group", id: "OTHER_GROUP_OPENID" },
  now: 2_100,
});
assert.equal(crossPeerVote.handled, true);
assert.equal(crossPeerVote.changed, false);
assert.equal(crossPeerVote.reply?.includes("不属于当前会话"), true);
assert.equal(polls.getPoll(pollId)?.votes.OTHER_MEMBER_OPENID, undefined);

const crossAccountVote = handleCustomPollInteraction({
  accountId: "other-account",
  polls,
  buttonData: `custom-poll:${pollId}:vote:1`,
  actorId: "OTHER_ACCOUNT_MEMBER_OPENID",
  actorLabel: "Other Account",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_150,
});
assert.equal(crossAccountVote.handled, true);
assert.equal(crossAccountVote.changed, false);
assert.equal(crossAccountVote.reply?.includes("不属于当前会话"), true);
assert.equal(polls.getPoll(pollId)?.votes.OTHER_ACCOUNT_MEMBER_OPENID, undefined);

const creatorCrossPeerVote = handleCustomPollInteraction({
  accountId: "default",
  polls,
  buttonData: `custom-poll:${pollId}:vote:3`,
  actorId: "MEMBER_OPENID",
  actorLabel: "Member",
  sourcePeer: { kind: "c2c", id: "MEMBER_OPENID" },
  now: 2_200,
});
assert.equal(creatorCrossPeerVote.handled, true);
assert.equal(creatorCrossPeerVote.changed, true);
assert.equal(creatorCrossPeerVote.reply?.includes("Member 已投票"), true);
assert.equal(creatorCrossPeerVote.reply?.includes("C"), false);
assert.equal(polls.getPoll(pollId)?.votes.MEMBER_OPENID?.optionId, "3");

const list = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message,
  rawContent: "/bot-poll list",
  now: 3_000,
});
assert.equal(list.handled, true);
assert.equal(list.reply?.includes(pollId), true);
assert.equal(Boolean(list.keyboard?.content?.rows.length), true);

const detail = handleCustomPollInteraction({
  accountId: "default",
  polls,
  buttonData: `custom-poll:${pollId}:detail:0`,
  actorId: "MEMBER_OPENID",
  actorLabel: "Member",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 3_100,
});
assert.equal(detail.handled, true);
assert.equal(detail.reply?.includes("已投票人数：2"), true);
assert.equal(detail.reply?.includes("属于你：是"), true);
assert.equal(detail.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, `custom-poll:${pollId}:close-request:0`);

const closeRequest = handleCustomPollInteraction({
  accountId: "default",
  polls,
  buttonData: `custom-poll:${pollId}:close-request:0`,
  actorId: "MEMBER_OPENID",
  actorLabel: "Member",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 3_200,
});
assert.equal(closeRequest.handled, true);
assert.equal(closeRequest.reply?.includes("确认提前结束"), true);
assert.equal(closeRequest.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, `custom-poll:${pollId}:close-confirm:0`);

const statusBySuffix = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message,
  rawContent: "/bot-poll status 1",
  now: 4_000,
});
assert.equal(statusBySuffix.handled, true);
assert.equal(statusBySuffix.reply?.includes("已投票人数：2"), true);
assert.equal(formatPollStatusDirect(polls.getPoll(pollId)!).includes("进行中投票暂不展示结果"), true);

const otherGroupStatus = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message: { ...message, groupOpenid: "OTHER_GROUP_OPENID", senderId: "OTHER_MEMBER_OPENID" },
  rawContent: `/bot-poll status ${pollId}`,
  now: 4_100,
});
assert.equal(otherGroupStatus.handled, true);
assert.equal(otherGroupStatus.reply?.includes("不属于当前会话"), true);
assert.equal(otherGroupStatus.reply?.includes("Pick one"), false);

const otherGroupClose = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message: { ...message, groupOpenid: "OTHER_GROUP_OPENID", senderId: "OTHER_MEMBER_OPENID" },
  rawContent: `/bot-poll close ${pollId}`,
  now: 4_200,
});
assert.equal(otherGroupClose.handled, true);
assert.equal(otherGroupClose.changed, undefined);
assert.equal(otherGroupClose.reply?.includes("不属于当前会话"), true);
assert.equal(polls.getPoll(pollId)?.status, "open");

const creatorDmStatus = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message: { ...message, type: "c2c", groupOpenid: undefined },
  rawContent: `/bot-poll status ${pollId}`,
  now: 4_300,
});
assert.equal(creatorDmStatus.handled, true);
assert.equal(creatorDmStatus.reply?.includes("投票详情"), true);
assert.equal(creatorDmStatus.reply?.includes("Pick one"), true);

const close = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message,
  rawContent: `/bot-poll close ${pollId}`,
  now: 5_000,
});
assert.equal(close.handled, true);
assert.equal(close.changed, true);
assert.equal(close.reply?.includes("投票已关闭"), true);
assert.equal(close.reply?.includes("B：1"), true);

const voteClosed = handleCustomPollInteraction({
  accountId: "default",
  polls,
  buttonData: `custom-poll:${pollId}:vote:1`,
  actorId: "VOTER2_OPENID",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 6_000,
});
assert.equal(voteClosed.handled, true);
assert.equal(voteClosed.changed, false);
assert.equal(voteClosed.reply?.includes("投票已关闭"), true);

const noMatch = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message,
  rawContent: "/bot-ping",
  now: 7_000,
});
assert.deepEqual(noMatch, { handled: false });

console.log("custom poll gateway adapter tests passed");
