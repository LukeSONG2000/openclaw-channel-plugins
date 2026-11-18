import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQQImagenInput, getQQImagenQuotedImages, getRecentQQImagenImages, rememberQQImagenImages } from "../src/custom/imagen-input.js";
import { MSG_TYPE_QUOTE } from "../src/types.js";
import type { QueuedMessage } from "../src/message-queue.js";

const event: QueuedMessage = {
  type: "group",
  content: "<@!bot-openid> /imagen ref match these colors",
  senderId: "sender",
  messageId: "message",
  timestamp: "2026-11-18T08:30:00Z",
  mentions: [{ member_openid: "bot-openid", is_you: true }],
  attachments: [{ content_type: "image/png", url: "https://example.org/source.png" }],
};

test("Imagen strips only native self mentions and preserves the current attachment count", () => {
  assert.deepEqual(buildQQImagenInput(event, ["/current/source.png"]), {
    args: "ref match these colors", images: ["/current/source.png"], expectedImages: 1,
  });
  assert.equal(buildQQImagenInput(event, [])?.expectedImages, 1);
  assert.equal(buildQQImagenInput({ ...event, mentions: [{ member_openid: "bot-openid" }] }, []), undefined);
  assert.equal(buildQQImagenInput({ ...event, content: "<@other> " + event.content }, []), undefined);
  assert.equal(buildQQImagenInput({ ...event, content: "/imagenator example" }, []), undefined);
});

test("Imagen is not executed from synthetic or merged messages", () => {
  for (const fields of [
    { senderIsBot: true }, { _customUnreadSnapshotId: "snapshot" }, { _mergedMessages: [event] },
    { _slashAuthorized: { command: "scheduled-task" } },
  ]) assert.equal(buildQQImagenInput({ ...event, ...fields }, []), undefined);
});

test("natural requests are sourced only from private messages or a real bot mention", () => {
  const text = "做一张循环动图";
  assert.deepEqual(buildQQImagenInput({ ...event, content: "<@!bot-openid> " + text }, ["/current/source.png"]), {
    naturalText: text, images: ["/current/source.png"], expectedImages: 1,
  });
  assert.equal(buildQQImagenInput({ ...event, mentions: [], content: text }, [])?.naturalText, undefined);
  assert.equal(buildQQImagenInput({ ...event, type: "c2c", mentions: [], content: text }, [])?.naturalText, text);
});

test("Imagen quote input comes only from the matching official quoted message element", () => {
  const refMsgIdx = "ref123";
  const image = { content_type: "image/png", url: "https://example.org/original.png" };
  const quote = { msgType: MSG_TYPE_QUOTE, refMsgIdx, msgElements: [{ msg_idx: refMsgIdx, attachments: [image] }] };
  assert.deepEqual(getQQImagenQuotedImages(quote), [image]);
  assert.deepEqual(getQQImagenQuotedImages({ ...quote, msgType: 0 }), []);
  assert.deepEqual(getQQImagenQuotedImages({ ...quote, refMsgIdx: "other" }), []);
});

test("recent image bundles are isolated by conversation and expire", () => {
  rememberQQImagenImages("account-a/group-one", event, ["/current/image.png"], 1000);
  assert.deepEqual(getRecentQQImagenImages("account-a/group-one", 2000), ["/current/image.png"]);
  assert.deepEqual(getRecentQQImagenImages("account-b/group-one", 2000), []);
  assert.deepEqual(getRecentQQImagenImages("account-a/group-two", 2000), []);
  assert.deepEqual(getRecentQQImagenImages("account-a/group-one", 601001), []);
});
