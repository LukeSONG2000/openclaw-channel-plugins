import assert from "node:assert";
import { applyCustomStaticDeliverGateway } from "../src/custom/static-deliver-gateway-adapter.js";

const baseReplyContext = {
  target: { type: "group", senderId: "MEMBER", messageId: "MSG", groupOpenid: "GROUP" },
  account: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
  cfg: {},
} as any;
const baseDeliverEvent = {
  type: "group",
  senderId: "MEMBER",
  messageId: "MSG",
  groupOpenid: "GROUP",
} as any;
const baseDeliverAccount = {
  account: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
  qualifiedTarget: "qqbot:group:GROUP",
} as any;
const sendWithRetry = (async <T>(sendFn: (token: string) => Promise<T>) => sendFn("TOKEN")) as any;

let mediaActivity = 0;
let mediaBlockRecorded = 0;
let mediaPlainSent = 0;
let mediaStructuredCalled = 0;
const mediaResult = await applyCustomStaticDeliverGateway({
  deliverPayload: { text: "look <qqimg>/tmp/a.png</qqimg>" },
  replyContext: baseReplyContext,
  deliverEvent: baseDeliverEvent,
  deliverAccountContext: baseDeliverAccount,
  sendWithRetry,
  quoteRef: "QUOTE",
  toolMediaUrls: [],
  recordBlockDeliveredMedia: () => { mediaBlockRecorded += 1; },
  recordOutboundActivity: () => { mediaActivity += 1; },
  parseAndSendMediaTags: (async (_text: string, _event: any, _actx: any, _send: any, consumeQuoteRef: () => string | undefined) => {
      assert.equal(consumeQuoteRef(), "QUOTE");
      assert.equal(consumeQuoteRef(), undefined);
      return { handled: true, normalizedText: _text };
    }) as any,
  handleStructuredPayload: (async () => {
      mediaStructuredCalled += 1;
      return false;
    }) as any,
  sendPlainReply: (async () => { mediaPlainSent += 1; }) as any,
});
assert.equal(mediaResult.kind, "media-tags");
assert.equal(mediaActivity, 1);
assert.equal(mediaBlockRecorded, 0);
assert.equal(mediaPlainSent, 0);
assert.equal(mediaStructuredCalled, 0);

let structuredActivity = 0;
let structuredPlainSent = 0;
const structuredResult = await applyCustomStaticDeliverGateway({
  deliverPayload: { text: " {structured:true} " },
  replyContext: baseReplyContext,
  deliverEvent: baseDeliverEvent,
  deliverAccountContext: baseDeliverAccount,
  sendWithRetry,
  quoteRef: "QUOTE2",
  toolMediaUrls: [],
  recordBlockDeliveredMedia: () => {
    throw new Error("structured payload should not record block media");
  },
  recordOutboundActivity: () => { structuredActivity += 1; },
  parseAndSendMediaTags: (async () => ({ handled: false, normalizedText: "structured normalized" })) as any,
  handleStructuredPayload: (async (_ctx: any, text: string, recordOutboundActivity: () => void) => {
      assert.equal(text, "structured normalized");
      recordOutboundActivity();
      return true;
    }) as any,
  sendPlainReply: (async () => { structuredPlainSent += 1; }) as any,
});
assert.equal(structuredResult.kind, "structured-payload");
assert.equal(structuredActivity, 1);
assert.equal(structuredPlainSent, 0);

let plainActivity = 0;
let plainBlockRecorded = 0;
let plainSent = 0;
const plainToolMediaUrls = ["tool-a", "tool-b"];
const plainResult = await applyCustomStaticDeliverGateway({
  deliverPayload: { text: "plain reply", mediaUrl: "payload-media" },
  replyContext: baseReplyContext,
  deliverEvent: baseDeliverEvent,
  deliverAccountContext: baseDeliverAccount,
  sendWithRetry,
  quoteRef: "QUOTE3",
  toolMediaUrls: plainToolMediaUrls,
  recordBlockDeliveredMedia: (payload) => {
    plainBlockRecorded += 1;
    assert.equal(payload.mediaUrl, "payload-media");
  },
  recordOutboundActivity: () => { plainActivity += 1; },
  parseAndSendMediaTags: (async () => ({ handled: false, normalizedText: "plain normalized" })) as any,
  handleStructuredPayload: (async () => false) as any,
  sendPlainReply: (async (_payload: any, replyText: string, _event: any, _actx: any, _send: any, consumeQuoteRef: () => string | undefined, toolMediaUrls: string[]) => {
      plainSent += 1;
      assert.equal(replyText, "plain normalized");
      assert.equal(consumeQuoteRef(), "QUOTE3");
      assert.equal(consumeQuoteRef(), undefined);
      assert.equal(toolMediaUrls, plainToolMediaUrls);
    }) as any,
});
assert.equal(plainResult.kind, "plain");
assert.equal(plainBlockRecorded, 1);
assert.equal(plainSent, 1);
assert.equal(plainActivity, 1);

console.log("custom static deliver gateway adapter tests passed");
