import assert from "node:assert";
import { executeSendQueue, type MediaSendContext, type SendQueueItem } from "../src/utils/media-send.js";
import type { ResolvedQQBotAccount } from "../src/types.js";
import type { MediaTargetContext, MediaOutboundContext } from "../src/outbound.js";

const account: ResolvedQQBotAccount = {
  accountId: "default",
  enabled: true,
  appId: "APPID",
  clientSecret: "SECRET",
  secretSource: "config",
  markdownSupport: false,
  config: {},
};

const sent: string[] = [];
const commits: string[] = [];
const prepared: SendQueueItem[] = [];
const fallbackTexts: string[] = [];

const baseCtx: MediaSendContext = {
  mediaTarget: {
    targetType: "group",
    targetId: "GROUP_OPENID",
    account,
    logPrefix: "[test]",
  },
  qualifiedTarget: "qqbot:group:GROUP_OPENID",
  account,
};

await executeSendQueue(
  [
    { type: "image", content: "https://example.com/blocked.png" },
    { type: "media", content: "/tmp/allowed.gif" },
  ],
  baseCtx,
  {
    prepareSend: (item) => {
      prepared.push(item);
      if (item.content.includes("blocked")) return { allowed: false, reason: "budget blocked" };
      return { allowed: true, commit: () => commits.push(item.content) };
    },
    onSendText: async (text) => {
      fallbackTexts.push(text);
    },
    handlers: {
      sendPhoto: async (_ctx: MediaTargetContext, mediaUrl: string) => {
        sent.push(`photo:${mediaUrl}`);
        return { channel: "qqbot", messageId: "photo-1" };
      },
      sendMediaAuto: async (ctx: MediaOutboundContext) => {
        sent.push(`media:${ctx.mediaUrl}:${ctx.replyToId ?? "proactive"}`);
        return { channel: "qqbot", messageId: "media-1" };
      },
    },
  },
);

assert.deepEqual(prepared.map((item) => `${item.type}:${item.content}`), [
  "image:https://example.com/blocked.png",
  "media:/tmp/allowed.gif",
]);
assert.deepEqual(sent, ["media:/tmp/allowed.gif:proactive"]);
assert.deepEqual(commits, ["/tmp/allowed.gif"]);
assert.deepEqual(fallbackTexts, []);

let passivePrepareCalled = false;
await executeSendQueue(
  [{ type: "image", content: "https://example.com/passive.png" }],
  {
    ...baseCtx,
    mediaTarget: {
      ...baseCtx.mediaTarget,
      replyToId: "msg-1",
    },
    replyToId: "msg-1",
  },
  {
    prepareSend: () => {
      passivePrepareCalled = true;
      return { allowed: true, commit: () => commits.push("passive") };
    },
    handlers: {
      sendPhoto: async (_ctx: MediaTargetContext, mediaUrl: string) => {
        sent.push(`photo:${mediaUrl}`);
        return { channel: "qqbot", messageId: "photo-2" };
      },
    },
  },
);

assert.equal(passivePrepareCalled, true);
assert.equal(sent.includes("photo:https://example.com/passive.png"), true);
assert.equal(commits.includes("passive"), true);

console.log("media send proactive guard tests passed");
