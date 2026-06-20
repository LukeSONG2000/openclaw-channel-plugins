import assert from "node:assert";
import { prepareCustomProactiveSend } from "../src/custom/proactive-send-guard.js";

let guardCalls = 0;
let commits = 0;
const guard = (allowed: boolean) => ({
  proactiveGuard: ({ targetType, targetId, text }: { targetType: "c2c" | "group"; targetId: string; text: string }) => {
    guardCalls++;
    assert.equal(targetType, "group");
    assert.equal(targetId, "GROUP_OPENID");
    assert.equal(text, "hello");
    return allowed
      ? { allowed: true as const, commit: () => { commits++; } }
      : { allowed: false as const, reason: "budget blocked" };
  },
});

const blocked = prepareCustomProactiveSend(
  { type: "group", senderId: "MEMBER_OPENID", groupOpenid: "GROUP_OPENID" },
  guard(false),
  "hello",
);
assert.equal(blocked.allowed, false);
assert.equal(guardCalls, 1);
assert.equal(commits, 0);

const passive = prepareCustomProactiveSend(
  { type: "group", senderId: "MEMBER_OPENID", replyToId: "msg-1", groupOpenid: "GROUP_OPENID" },
  guard(false),
  "hello",
);
assert.equal(passive.allowed, true);
assert.equal(guardCalls, 1);

const allowed = prepareCustomProactiveSend(
  { type: "group", senderId: "MEMBER_OPENID", groupOpenid: "GROUP_OPENID" },
  guard(true),
  "hello",
);
assert.equal(allowed.allowed, true);
if (allowed.allowed) allowed.commit?.();
assert.equal(guardCalls, 2);
assert.equal(commits, 1);

const channel = prepareCustomProactiveSend(
  { type: "guild", senderId: "MEMBER_OPENID", replyToId: undefined },
  guard(false),
  "hello",
);
assert.equal(channel.allowed, true);
assert.equal(guardCalls, 2);

console.log("custom proactive send guard tests passed");
