import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DingTalkAuthorizationRuntime, formatAuthorizationRequest } from "../src/authorization.js";
import {
  buildDingTalkCatchupPrompt,
  buildDingTalkMentionContext,
  buildDingTalkReplyPolicyPrompt,
  CHAT_MENTION_UNREAD_RECHECK_DELAY_MS,
  CHAT_POLL_INTERVAL_MS,
  DingTalkChatRuntime,
  historyFailureRetryDelayMs,
} from "../src/chat-runtime.js";
import type { DingTalkMessageData } from "../src/types.js";
import { buildWebhookReplyBody } from "../src/client.js";
import { extractDwsImageMediaIds, parseDwsHistoryResponse } from "../src/dws-history.js";
import {
  sanitizeDingTalkReplyText,
  shouldDeliverDingTalkReply,
  stripDingTalkControlTags,
} from "../src/reply-filter.js";
import { KeyedAsyncQueue } from "../src/message-queue.js";
import {
  buildDingTalkMemberAliases,
  findMentionedDingTalkMembers,
} from "../src/member-directory.js";

const message: DingTalkMessageData = {
  conversationId: "conversation-1",
  openConversationId: "cid-group-1",
  conversationTitle: "测试群",
  conversationType: "2",
  chatbotCorpId: "corp",
  chatbotUserId: "robot",
  msgId: "message-1",
  msgtype: "text",
  createAt: String(Date.now()),
  senderNick: "测试用户",
  senderStaffId: "user-1",
  senderCorpId: "corp",
  robotCode: "robot-code",
  isInAtList: false,
  text: { content: "/help" },
};

const authorization = new DingTalkAuthorizationRuntime("admin-1");
assert.equal(authorization.isAdmin("admin-1"), true);
assert.equal(authorization.isRestrictedCommand(message), true);
const request = authorization.create(message);
assert.match(formatAuthorizationRequest(request), /位置：测试群/);
assert.equal(authorization.take(request.id)?.data.msgId, message.msgId);
assert.equal(authorization.take(request.id), undefined);

const prompt = buildDingTalkCatchupPrompt([{
  messageId: "m1",
  senderId: "u1",
  senderName: "小宋",
  body: "今天上线吗？",
  timestamp: Date.now(),
}]);
assert.match(prompt, /小宋: 今天上线吗/);
assert.match(prompt, /发送层会将识别到的群成员转换为真实@/);
assert.match(prompt, /禁止出现“我接一句”/);
assert.doesNotMatch(prompt, /自然接话/);
assert.match(prompt, /<dingtalk_final>/);
assert.match(prompt, /只输出 NO_REPLY/);
const mentionContext = buildDingTalkMentionContext([{
  messageId: "m-context",
  senderId: "u-context",
  senderName: "陈帆",
  body: "此前的群消息",
  timestamp: Date.now(),
}]);
assert.match(mentionContext, /仅用于理解当前对话上下文/);
assert.match(mentionContext, /本轮只回复后面的当前@消息/);
assert.match(mentionContext, /陈帆: 此前的群消息/);
assert.match(buildDingTalkReplyPolicyPrompt({ wasMentioned: true }) ?? "", /must produce a visible/);
assert.match(buildDingTalkReplyPolicyPrompt({ proactive: true }) ?? "", /native mentions/);
assert.equal(buildDingTalkReplyPolicyPrompt({}), undefined);
assert.equal(CHAT_POLL_INTERVAL_MS, 60_000);
assert.equal(CHAT_MENTION_UNREAD_RECHECK_DELAY_MS, 1_000);
assert.equal(historyFailureRetryDelayMs(1), 5 * 60_000);
assert.equal(historyFailureRetryDelayMs(2), 10 * 60_000);
assert.equal(historyFailureRetryDelayMs(20), 60 * 60_000);

const pulled = parseDwsHistoryResponse(JSON.stringify({
  success: true,
  result: {
    messages: [
      { content: "你是谁", createTime: "2026-07-14 15:16:52", openMessageId: "m2", sender: "宋雨扬 (Luke)", senderOpenDingTalkId: "u1" },
      { content: "机器人回复", createTime: "2026-07-14 15:16:41", openMessageId: "m1", sender: "R2-D2", senderOpenDingTalkId: "bot" },
      { content: "@R2-D2 hello", createTime: "2026-07-14 15:16:32", openMessageId: "m0", sender: "宋雨扬 (Luke)", senderOpenDingTalkId: "u1" },
    ],
  },
}), new Set(["R2-D2"]));
assert.equal(pulled.entries.length, 1);
assert.equal(pulled.entries[0]?.body, "你是谁");
assert.equal(pulled.entries[0]?.senderId, "u1");
assert.ok(pulled.cursorAt > 0);
assert.deepEqual(
  extractDwsImageMediaIds("[图片消息](mediaId=$abc123) 注意：请下载"),
  ["$abc123"],
);
assert.equal(shouldDeliverDingTalkReply({}, "final"), true);
assert.equal(shouldDeliverDingTalkReply({}, "block"), true);
assert.equal(shouldDeliverDingTalkReply({}, "tool"), false);
assert.equal(shouldDeliverDingTalkReply({ isReasoning: true }, "final"), false);
assert.equal(shouldDeliverDingTalkReply({ isReasoning: true }, "block"), false);
assert.equal(shouldDeliverDingTalkReply({ isStatusNotice: true }, "final"), false);
assert.equal(shouldDeliverDingTalkReply({ isStatusNotice: true }, "block"), false);
assert.equal(shouldDeliverDingTalkReply({ isFallbackNotice: true }, "block"), false);
assert.equal(shouldDeliverDingTalkReply({ isCompactionNotice: true }, "block"), false);
assert.equal(sanitizeDingTalkReplyText("我接一句：这效率确实高"), "这效率确实高");
assert.equal(sanitizeDingTalkReplyText("我不接这个话题。"), "");
assert.equal(
  sanitizeDingTalkReplyText("Damon发了张图。上一个话题是PBC。\n\n接一句就行。PBC=项目资料。\n\n还没同步的记得补一下"),
  "还没同步的记得补一下",
);
assert.equal(sanitizeDingTalkReplyText("第一段。\n\n第二段"), "第一段。\n\n第二段");
assert.equal(
  sanitizeDingTalkReplyText("我先分析一下。<dingtalk_final>收到，稍后看一下。</dingtalk_final>其他内容"),
  "收到，稍后看一下。",
);
assert.equal(
  sanitizeDingTalkReplyText('陈帆发了报告。\n\n我没有补充意见。\n\nNO_REPLY'),
  "",
);
assert.equal(sanitizeDingTalkReplyText("HEARTBEAT_OK"), "");
assert.equal(sanitizeDingTalkReplyText("[assistant turn failed before producing content]"), "");
assert.equal(
  sanitizeDingTalkReplyText("陈帆发了一个CRM系统问题根因分析的文件到群里。这是在分享工作文档，不是在求助我。我不需要回复。"),
  "",
);
assert.equal(
  sanitizeDingTalkReplyText("朱鹏让我分析刚才的文件。我需要先下载这个文件来看看。"),
  "",
);
assert.equal(sanitizeDingTalkReplyText("Let me inspect the file before answering."), "");
assert.equal(
  sanitizeDingTalkReplyText("<dingtalk_final>我需要先确认两个信息：负责人和截止时间。</dingtalk_final>"),
  "我需要先确认两个信息：负责人和截止时间。",
);
assert.equal(
  sanitizeDingTalkReplyText("好的，我来做个系统调研，稍等一下。", { requireTaggedFinal: true }),
  "",
);
assert.equal(
  sanitizeDingTalkReplyText("<dingtalk_final>收到，整理好发出来。</dingtalk_final>", { requireTaggedFinal: true }),
  "收到，整理好发出来。",
);
assert.equal(
  sanitizeDingTalkReplyText("&lt;dingtalk_final&gt;转义正文&lt;/dingtalk_final&gt;", { requireTaggedFinal: true }),
  "转义正文",
);
assert.equal(stripDingTalkControlTags("前<dingtalk_final>正文</dingtalk_final>后"), "前正文后");
assert.equal(stripDingTalkControlTags("&lt;dingtalk_final&gt;正文&lt;/dingtalk_final&gt;"), "正文");
assert.equal(sanitizeDingTalkReplyText("私聊兼容文本"), "私聊兼容文本");

const directoryMembers = [
  { displayName: "朱欢欢", names: ["朱欢欢"], userId: "821269407" },
  { displayName: "朱鹏", names: ["朱鹏"], userId: "633153376" },
  { displayName: "宋雨扬 (Luke)", names: ["宋雨扬", "宋雨扬 (Luke)"], userId: "51135122" },
];
assert.ok(buildDingTalkMemberAliases(directoryMembers[0]!).includes("欢哥"));
assert.deepEqual(
  findMentionedDingTalkMembers("欢哥牛逼，效率担当", directoryMembers).map((member) => member.userId),
  ["821269407"],
);
assert.deepEqual(
  findMentionedDingTalkMembers("欢欢和朱鹏互相谦让", directoryMembers).map((member) => member.userId),
  ["821269407", "633153376"],
);

const queue = new KeyedAsyncQueue();
const queueOrder: string[] = [];
let releaseFirst!: () => void;
let markFirstStarted!: () => void;
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const firstStarted = new Promise<void>((resolve) => {
  markFirstStarted = resolve;
});
const firstQueued = queue.run("group:1", async () => {
  queueOrder.push("first:start");
  markFirstStarted();
  await firstGate;
  queueOrder.push("first:end");
});
const secondQueued = queue.run("group:1", async () => {
  queueOrder.push("second");
});
await firstStarted;
assert.deepEqual(queueOrder, ["first:start"]);
releaseFirst();
await Promise.all([firstQueued, secondQueued]);
assert.deepEqual(queueOrder, ["first:start", "first:end", "second"]);

const mentionBody = buildWebhookReplyBody("你好", { atUserIds: ["51135122"] });
assert.equal(mentionBody.msgtype, "text");
assert.deepEqual(mentionBody.at?.atUserIds, ["51135122"]);
assert.equal("text" in mentionBody ? mentionBody.text.content : undefined, "你好");
const plainBody = buildWebhookReplyBody("普通回复");
assert.equal(plainBody.msgtype, "markdown");
const sanitizedBody = buildWebhookReplyBody("<dingtalk_final>最终正文</dingtalk_final>");
assert.equal("markdown" in sanitizedBody ? sanitizedBody.markdown.text : undefined, "最终正文");

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-chat-test-"));
let now = 123_000;
const runtime = new DingTalkChatRuntime({
  accountId: "default",
  stateDir,
  onCatchup: async () => true,
  now: () => now,
});
assert.equal(runtime.record("cid-group-1", {
  conversationId: "conversation-1",
  openConversationId: "cid-group-1",
}, {
  messageId: "m1",
  senderId: "u1",
  senderName: "小宋",
  body: "消息",
  timestamp: Date.now(),
}), 1);
assert.equal(runtime.prepareMentionReply("cid-group-1").length, 1);
let persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "chat-default.json"), "utf8"));
assert.equal(persisted.groups["cid-group-1"].unread.length, 1);
assert.equal(persisted.groups["cid-group-1"].dueAt, undefined);
runtime.markMentionReplyComplete("cid-group-1", {
  conversationId: "conversation-1",
  openConversationId: "cid-group-1",
});
persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "chat-default.json"), "utf8"));
assert.equal(persisted.groups["cid-group-1"].unread.length, 1);
assert.equal(persisted.groups["cid-group-1"].historyCursorAt, now);
assert.equal(persisted.groups["cid-group-1"].dueAt, now + CHAT_MENTION_UNREAD_RECHECK_DELAY_MS);
runtime.dispose();
assert.equal(fs.existsSync(path.join(stateDir, "chat-default.json")), true);
fs.rmSync(stateDir, { recursive: true, force: true });

console.log("custom runtime tests passed");
