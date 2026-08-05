import assert from "node:assert";
import { buildDefaultCatchupPrompt } from "../src/custom/unread-catchup-prompt.js";
import {
  isCustomUnreadSilentDecisionOutput,
  sanitizeCustomUnreadProactiveMentions,
} from "../src/custom/unread-output.js";

const prompt = buildDefaultCatchupPrompt();
assert.equal(prompt.includes("不要使用 <@member_openid>"), true);
assert.equal(prompt.includes("最终消息不要 @ 任何人"), true);
assert.equal(prompt.includes("禁止出现“我接一句”"), true);
assert.equal(prompt.includes("自然接一句"), false);
assert.equal(prompt.includes("没有则只输出 NO_REPLY"), true);

const mentionPrompt = buildDefaultCatchupPrompt("mention-followup");
assert.equal(mentionPrompt.includes("与刚才 @ 完全无关"), true);
assert.equal(mentionPrompt.includes("禁止再次回应"), true);

assert.equal(
  sanitizeCustomUnreadProactiveMentions("<@USER_OPENID>\n这句不该艾特", {
    type: "group",
    customUnreadSnapshotId: "snapshot-1",
  }),
  "这句不该艾特",
);

assert.equal(
  sanitizeCustomUnreadProactiveMentions("<@USER_OPENID>\n被@回复保留", {
    type: "group",
  }),
  "<@USER_OPENID>\n被@回复保留",
);

assert.equal(
  sanitizeCustomUnreadProactiveMentions("<@USER_OPENID>\n私聊不处理", {
    type: "c2c",
    customUnreadSnapshotId: "snapshot-1",
  }),
  "<@USER_OPENID>\n私聊不处理",
);

assert.equal(
  isCustomUnreadSilentDecisionOutput("Vinty发照片那段我刚才已经回了，没啥新话题就先不重复了", {
    type: "group",
    customUnreadSnapshotId: "snapshot-1",
  }),
  true,
);
assert.equal(
  isCustomUnreadSilentDecisionOutput("这个话题不需要回复", {
    type: "group",
    customUnreadSnapshotId: "snapshot-1",
  }),
  true,
);
assert.equal(
  isCustomUnreadSilentDecisionOutput("Vinty这张照片杀伤力确实大", {
    type: "group",
    customUnreadSnapshotId: "snapshot-1",
  }),
  false,
);
assert.equal(
  isCustomUnreadSilentDecisionOutput("刚才已经回了", {
    type: "group",
  }),
  false,
);

console.log("custom unread proactive mention tests passed");
