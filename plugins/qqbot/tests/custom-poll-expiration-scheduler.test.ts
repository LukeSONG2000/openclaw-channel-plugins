import assert from "node:assert";
import { CustomPollExpirationScheduler } from "../src/custom/poll-expiration-scheduler.js";
import { CustomPollRuntime } from "../src/custom/poll.js";

const polls = new CustomPollRuntime();
const poll = polls.createPoll({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID", label: "Creator" },
  question: "Pick one",
  options: ["A", "B"],
  durationMs: 60_000,
  now: 1_000,
});
if (!poll.poll) throw new Error("expected poll");
polls.vote({
  pollId: poll.poll.id,
  optionId: "2",
  actor: { id: "VOTER_OPENID", label: "Voter" },
  now: 2_000,
});

const deliveries: Array<{ target: unknown; text: string }> = [];
let persisted = 0;
const scheduler = new CustomPollExpirationScheduler({
  accountId: "default",
  polls,
  intervalMs: 60_000,
  now: () => 61_000,
  persist: () => { persisted += 1; },
  sendText: (delivery) => {
    deliveries.push({ target: delivery.target, text: delivery.text });
  },
});

await scheduler.tick();
scheduler.dispose();

assert.equal(polls.getPoll(poll.poll.id)?.status, "closed");
assert.equal(polls.getPoll(poll.poll.id)?.resultAnnouncedAt, 61_000);
assert.equal(persisted, 2);
assert.equal(deliveries.length, 1);
assert.deepEqual(deliveries[0]?.target, {
  type: "group",
  senderId: "CREATOR_OPENID",
  groupOpenid: "GROUP_OPENID",
  messageId: "",
});
assert.equal(deliveries[0]?.text.includes("<@VOTER_OPENID>"), true);
assert.equal(deliveries[0]?.text.includes("B：1"), true);

console.log("custom poll expiration scheduler tests passed");
