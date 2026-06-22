import assert from "node:assert";
import { CustomPollRuntime, summarizePollResults } from "../src/custom/poll.js";
import type { CustomActor, CustomPeer } from "../src/custom/types.js";

const peer: CustomPeer = { kind: "group", id: "GROUP_OPENID", label: "Master Luke" };
const otherPeer: CustomPeer = { kind: "c2c", id: "USER_OPENID" };
const creator: CustomActor = { id: "CREATOR_OPENID", label: "Creator" };
const voter: CustomActor = { id: "VOTER_OPENID", label: "Voter" };

const runtime = new CustomPollRuntime();

const emptyQuestion = runtime.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "   ",
  options: ["A", "B"],
  now: 1_000,
});
assert.equal(emptyQuestion.allowed, false);
assert.equal(emptyQuestion.reason, "invalid_question");

const invalidOptions = runtime.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "Pick one",
  options: ["same", "same"],
  now: 2_000,
});
assert.equal(invalidOptions.allowed, false);
assert.equal(invalidOptions.reason, "invalid_options");

const created = runtime.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "  Pick  a path  ",
  options: [" Ship ", "Wait", "Ship", "Refactor", "Document", "Extra"],
  durationMs: 600_000,
  now: 3_000,
});
assert.equal(created.allowed, true);
if (!created.poll) throw new Error("expected poll");
assert.equal(created.poll.id, "poll-default-group-GROUP_OPENID-3000-1");
assert.equal(created.poll.question, "Pick a path");
assert.equal(created.poll.multiple, false);
assert.equal(created.poll.anonymous, false);
assert.equal(created.poll.expiresAt, 603_000);
assert.deepEqual(created.poll.options.map((option) => option.label), ["Ship", "Wait", "Refactor", "Document"]);

const vote = runtime.vote({
  pollId: created.poll.id,
  optionId: "2",
  actor: voter,
  now: 4_000,
});
assert.equal(vote.allowed, true);
assert.equal(vote.poll?.votes.VOTER_OPENID?.optionId, "2");
assert.deepEqual(vote.poll?.votes.VOTER_OPENID?.optionIds, ["2"]);
assert.deepEqual(summarizePollResults(vote.poll!).map((item) => item.count), [0, 1, 0, 0]);

const changedVote = runtime.vote({
  pollId: created.poll.id,
  optionId: "3",
  actor: voter,
  now: 5_000,
});
assert.equal(changedVote.allowed, true);
assert.deepEqual(summarizePollResults(changedVote.poll!).map((item) => item.count), [0, 0, 1, 0]);

const multiPoll = runtime.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "Pick many",
  options: ["A", "B", "C"],
  multiple: true,
  anonymous: true,
  now: 5_500,
});
assert.equal(multiPoll.allowed, true);
assert.equal(multiPoll.poll?.multiple, true);
assert.equal(multiPoll.poll?.anonymous, true);
runtime.vote({ pollId: multiPoll.poll!.id, optionId: "1", actor: voter, now: 5_600 });
const multiVote = runtime.vote({ pollId: multiPoll.poll!.id, optionId: "2", actor: voter, now: 5_700 });
assert.deepEqual(multiVote.poll?.votes.VOTER_OPENID?.optionIds, ["1", "2"]);
assert.deepEqual(summarizePollResults(multiVote.poll!).map((item) => item.count), [1, 1, 0]);

const otherPoll = runtime.createPoll({
  accountId: "default",
  peer: otherPeer,
  creator,
  question: "DM poll",
  options: ["Yes", "No"],
  now: 6_000,
});
assert.equal(otherPoll.allowed, true);
assert.equal(runtime.listPolls({ accountId: "default", peer }).some((poll) => poll.id === created.poll.id), true);

const closed = runtime.closePoll({ pollId: created.poll.id, now: 7_000 });
assert.equal(closed.allowed, true);
assert.equal(closed.poll?.status, "closed");
assert.equal(closed.poll?.closedAt, 7_000);

const voteClosed = runtime.vote({
  pollId: created.poll.id,
  optionId: "1",
  actor: { id: "LATE_VOTER" },
  now: 8_000,
});
assert.equal(voteClosed.allowed, false);
assert.equal(voteClosed.reason, "closed");

const expiredPoll = runtime.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "Expires",
  options: ["Yes", "No"],
  durationMs: 60_000,
  now: 20_000,
});
assert.equal(expiredPoll.allowed, true);
assert.deepEqual(runtime.closeExpiredPolls({ accountId: "default", now: 79_999 }).map((poll) => poll.id), []);
const expired = runtime.closeExpiredPolls({ accountId: "default", now: 80_000 });
assert.deepEqual(expired.map((poll) => poll.id), [expiredPoll.poll!.id]);
assert.equal(runtime.getPoll(expiredPoll.poll!.id)?.status, "closed");
assert.equal(runtime.listUnannouncedClosedPolls({ accountId: "default" }).some((poll) => poll.id === expiredPoll.poll!.id), true);
runtime.markResultAnnounced({ pollId: expiredPoll.poll!.id, now: 81_000 });
assert.equal(runtime.listUnannouncedClosedPolls({ accountId: "default" }).some((poll) => poll.id === expiredPoll.poll!.id), false);

const restored = new CustomPollRuntime();
restored.loadState(runtime.getState());
assert.equal(restored.getPoll(created.poll.id)?.status, "closed");
const next = restored.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "Next poll",
  options: ["A", "B"],
  now: 9_000,
});
assert.equal(next.poll?.id.endsWith("-5"), true);

restored.loadState({ polls: {} });
const reset = restored.createPoll({
  accountId: "default",
  peer,
  creator,
  question: "Reset poll",
  options: ["A", "B"],
  now: 10_000,
});
assert.equal(reset.poll?.id.endsWith("-1"), true);

console.log("custom poll runtime tests passed");
