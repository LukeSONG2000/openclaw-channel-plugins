import assert from "node:assert";
import {
  buildCustomGroupPromptContext,
  formatCustomGroupSenderLabel,
  joinCustomPromptParts,
  mergeCustomSystemPromptParts,
} from "../src/custom/group-prompt-context.js";

assert.equal(formatCustomGroupSenderLabel({
  senderId: "MEMBER_OPENID",
  senderName: "Luke",
}), "Luke (MEMBER_OPENID)");

assert.equal(formatCustomGroupSenderLabel({
  senderId: "MEMBER_OPENID",
}), "MEMBER_OPENID");

assert.equal(joinCustomPromptParts([" base ", "", null, "behavior"]), "base\nbehavior");
assert.equal(mergeCustomSystemPromptParts(["", undefined]), undefined);
assert.equal(mergeCustomSystemPromptParts(["[QQBot]", "group prompt"]), "[QQBot]\ngroup prompt");

const calls: string[] = [];
const context = buildCustomGroupPromptContext({
  cfg: { marker: true },
  accountId: "default",
  event: {
    type: "group",
    senderId: "MEMBER_OPENID",
    senderName: "Luke",
    content: "hello",
    messageId: "MSG",
    timestamp: "2026-06-22T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
  },
  resolveGroupName: ({ cfg, accountId, groupOpenid }) => {
    calls.push(`name:${accountId}:${groupOpenid}:${String((cfg as any).marker)}`);
    return "Master Luke的图书馆";
  },
  resolveGroupIntroHint: ({ accountId, groupOpenid }) => {
    calls.push(`intro:${accountId}:${groupOpenid}`);
    return "当前群: Master Luke的图书馆";
  },
  resolveGroupPrompt: ({ accountId, groupOpenid }) => {
    calls.push(`prompt:${accountId}:${groupOpenid}`);
    return "只在被@后回复。";
  },
});

assert.equal(context.senderLabel, "Luke (MEMBER_OPENID)");
assert.equal(context.groupSubject, "Master Luke的图书馆");
assert.equal(context.baseHint, "当前群: Master Luke的图书馆");
assert.equal(context.behaviorPrompt, "只在被@后回复。");
assert.equal(context.groupSystemPrompt, "当前群: Master Luke的图书馆\n只在被@后回复。");
assert.deepEqual(calls, [
  "intro:default:GROUP_OPENID",
  "prompt:default:GROUP_OPENID",
  "name:default:GROUP_OPENID:true",
]);

const withoutIntro = buildCustomGroupPromptContext({
  cfg: {},
  accountId: "default",
  event: {
    type: "group",
    senderId: "MEMBER_OPENID",
    content: "hello",
    messageId: "MSG",
    timestamp: "2026-06-22T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
  },
  resolveGroupName: () => "GROUP_OPENID",
  resolveGroupPrompt: () => undefined,
});
assert.equal(withoutIntro.groupSystemPrompt, "");
assert.equal(withoutIntro.senderLabel, "MEMBER_OPENID");

console.log("custom group prompt context tests passed");
