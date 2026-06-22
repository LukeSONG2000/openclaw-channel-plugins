import assert from "node:assert";
import {
  handleCustomSlashPrequeueGateway,
  normalizeCustomSlashPrequeueContent,
  type CustomSlashPrequeueQueue,
} from "../src/custom/slash-prequeue-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";
import type { QueueSnapshot } from "../src/slash-commands.js";

const snapshot: QueueSnapshot = {
  totalPending: 0,
  activeUsers: 0,
  maxConcurrentUsers: 10,
  senderPending: 0,
};

function event(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    content: "hello",
    messageId: "msg-1",
    timestamp: "2026-06-21T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
    ...overrides,
  };
}

function queue(): CustomSlashPrequeueQueue & { enqueued: QueuedMessage[]; immediate: QueuedMessage[]; cleared: string[] } {
  return {
    enqueued: [],
    immediate: [],
    cleared: [],
    enqueue(msg) { this.enqueued.push(msg); },
    getMessagePeerId(msg) { return msg.type === "group" ? `group:${msg.groupOpenid ?? "unknown"}` : `dm:${msg.senderId}`; },
    getSnapshot() { return snapshot; },
    clearUserQueue(peerId) { this.cleared.push(peerId); return 2; },
    executeImmediate(msg) { this.immediate.push(msg); },
  };
}

function baseParams(message: QueuedMessage, q = queue()) {
  const sentText: Array<{ kind: string; text: string }> = [];
  const sentKeyboard: Array<{ kind: string; text: string }> = [];
  const sentFiles: Array<{ targetType: string; targetId: string; filePath: string }> = [];
  const logs: string[] = [];
  return {
    params: {
      cfg: {} as any,
      account: { accountId: "default", appId: "APPID", accountConfig: {} },
      runtime: {} as any,
      message,
      queue: q,
      effects: {},
      sendText: async (target, text) => { sentText.push({ kind: target.kind, text }); },
      sendKeyboard: async (target, text) => { sentKeyboard.push({ kind: target.kind, text }); },
      sendFile: async (target, filePath) => { sentFiles.push({ ...target, filePath }); },
      handleCustomSlashCommand: () => ({ handled: false } as const),
      log: { info: (msg: string) => logs.push(msg), error: (msg: string) => logs.push(msg) },
      now: () => 1_000,
    },
    q,
    sentText,
    sentKeyboard,
    sentFiles,
    logs,
  };
}

assert.equal(normalizeCustomSlashPrequeueContent({
  message: event({ content: "<@BOT> /bot-auth status", mentions: [{ member_openid: "BOT", username: "bot", is_you: true }] }),
  stripMentionText: (text) => text.replace("<@BOT>", ""),
}), "/bot-auth status");

{
  const t = baseParams(event({ content: "plain" }));
  const result = await handleCustomSlashPrequeueGateway(t.params);
  assert.equal(result.kind, "not-slash-enqueued");
  assert.equal(t.q.enqueued.length, 1);
}

{
  const recorded: unknown[] = [];
  const t = baseParams(event({ content: "/new" }));
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    recordFallbackEvent: (fallbackEvent) => recorded.push(fallbackEvent),
  });
  assert.equal(result.kind, "urgent-bypass");
  assert.deepEqual(t.q.cleared, ["group:GROUP_OPENID"]);
  assert.equal(t.q.immediate.length, 1);
  assert.equal(recorded.length, 1);
}

{
  const t = baseParams(event({ content: "/custom" }));
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    handleCustomSlashCommand: () => ({ handled: true, reply: { kind: "text", text: "custom ok" } }),
  });
  assert.equal(result.kind, "custom-slash");
  assert.deepEqual(t.sentText, [{ kind: "group", text: "<@MEMBER_OPENID>\ncustom ok" }]);
}

{
  const t = baseParams(event({ content: "/unknown" }));
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    matchSlashCommand: async () => null,
  });
  assert.equal(result.kind, "framework-null-enqueued");
  assert.equal(t.q.enqueued.length, 1);
}

{
  const msg = event({ content: "/delegate" });
  const t = baseParams(msg);
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    matchSlashCommand: async () => ({ delegatePrompt: "delegated prompt" }),
  });
  assert.equal(result.kind, "framework-delegate-enqueued");
  assert.equal(msg.content, "delegated prompt");
  assert.equal(t.q.enqueued[0]?.content, "delegated prompt");
}

{
  const t = baseParams(event({ content: "/version" }));
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    matchSlashCommand: async () => "framework ok",
  });
  assert.equal(result.kind, "framework-reply");
  assert.deepEqual(t.sentText, [{ kind: "group", text: "framework ok" }]);
}

{
  const t = baseParams(event({ type: "c2c", groupOpenid: undefined, content: "/file" }));
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    matchSlashCommand: async () => ({ text: "file ok", filePath: "/tmp/report.txt" }),
  });
  assert.equal(result.kind, "framework-reply");
  assert.equal(result.kind === "framework-reply" && result.fileSent, true);
  assert.deepEqual(t.sentFiles, [{ targetType: "c2c", targetId: "MEMBER_OPENID", filePath: "/tmp/report.txt" }]);
}

{
  const t = baseParams(event({ content: "/boom" }));
  const result = await handleCustomSlashPrequeueGateway({
    ...t.params,
    matchSlashCommand: async () => { throw new Error("boom"); },
  });
  assert.equal(result.kind, "error-enqueued");
  assert.equal(t.q.enqueued.length, 1);
  assert.equal(t.logs.some((line) => line.includes("Slash command error")), true);
}

console.log("custom slash prequeue gateway adapter tests passed");
