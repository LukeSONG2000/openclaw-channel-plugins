import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQQImagenInput } from "../src/custom/imagen-input.js";
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
