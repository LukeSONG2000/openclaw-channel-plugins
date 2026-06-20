import assert from "node:assert";
import { prepareCustomProactiveSend } from "../src/custom/proactive-send-guard.js";

let guardCalls = 0;
let commits = 0;
const guard = (allowed: boolean) => ({
  proactiveGuard: ({ targetType, targetId, text, kind, mediaUrl }: { targetType: "c2c" | "group"; targetId: string; text: string; kind?: string; mediaUrl?: string }) => {
    guardCalls++;
    assert.equal(targetType, "group");
    assert.equal(targetId, "GROUP_OPENID");
    assert.equal(text, "hello");
    assert.equal(kind ?? "text", "text");
    assert.equal(mediaUrl, undefined);
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

let mediaGuardCalls = 0;
const media = prepareCustomProactiveSend(
  { type: "group", senderId: "MEMBER_OPENID", groupOpenid: "GROUP_OPENID" },
  {
    proactiveGuard: ({ targetType, targetId, text, kind, mediaUrl }) => {
      mediaGuardCalls++;
      assert.equal(targetType, "group");
      assert.equal(targetId, "GROUP_OPENID");
      assert.equal(kind, "image");
      assert.equal(mediaUrl, "https://example.com/a.png");
      assert.equal(text, "[image] https://example.com/a.png");
      return { allowed: true, commit: () => { commits++; } };
    },
  },
  { kind: "image", mediaUrl: "https://example.com/a.png" },
);
assert.equal(media.allowed, true);
if (media.allowed) media.commit?.();
assert.equal(mediaGuardCalls, 1);
assert.equal(commits, 2);

const passiveMedia = prepareCustomProactiveSend(
  { type: "group", senderId: "MEMBER_OPENID", replyToId: "msg-1", groupOpenid: "GROUP_OPENID" },
  {
    proactiveGuard: () => {
      throw new Error("passive media should not call proactive guard");
    },
  },
  { kind: "image", mediaUrl: "https://example.com/a.png" },
);
assert.equal(passiveMedia.allowed, true);

console.log("custom proactive send guard tests passed");
