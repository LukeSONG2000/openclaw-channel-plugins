import assert from "node:assert";
import {
  buildCustomPollKeyboard,
  handleCustomPollCommand,
  handleCustomPollInteraction,
  parseCustomPollButtonData,
  parseCustomPollCommand,
} from "../src/custom/poll-gateway-adapter.js";
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
assert.deepEqual(parseCustomPollCommand("/bot-poll create Pick one | A | B"), {
  matched: true,
  command: { kind: "create", question: "Pick one", options: ["A", "B"] },
});
assert.deepEqual(parseCustomPollCommand("/bot-poll status poll-1"), {
  matched: true,
  command: { kind: "status", pollId: "poll-1" },
});
assert.deepEqual(parseCustomPollCommand("/bot-poll close"), {
  matched: true,
  error: "缺少 pollId",
});
assert.deepEqual(parseCustomPollButtonData("custom-poll:poll-default-group-GROUP_OPENID-1000-1:vote:2"), {
  pollId: "poll-default-group-GROUP_OPENID-1000-1",
  optionId: "2",
});
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
  rawContent: "/bot-poll create Pick one | A | B | C",
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
assert.equal(vote.reply?.includes("已记录投票：B"), true);
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
assert.equal(creatorCrossPeerVote.reply?.includes("已记录投票：C"), true);
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

const statusBySuffix = handleCustomPollCommand({
  cfg,
  accountId: "default",
  polls,
  message,
  rawContent: "/bot-poll status 1",
  now: 4_000,
});
assert.equal(statusBySuffix.handled, true);
assert.equal(statusBySuffix.reply?.includes("B：1"), true);

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
assert.equal(creatorDmStatus.reply?.includes("投票状态"), true);
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
