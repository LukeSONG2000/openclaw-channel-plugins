import assert from "node:assert";
import { runCustomMessageContextGateway, resolveCommandAuthorized, resolveCustomCommandAuthorized } from "../src/custom/message-context-gateway-adapter.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig } from "../src/custom/unread-runtime.js";
import type { QueuedMessage } from "../src/message-queue.js";

const emptyProcessed = {
  attachmentInfo: "",
  imageUrls: [],
  imageMediaTypes: [],
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceAsrReferTexts: [],
  voiceTranscripts: [],
  voiceTranscriptSources: [],
  attachmentLocalPaths: [],
};

const c2cMessage: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/status",
  messageId: "msg-1",
  timestamp: "2026-06-22T00:00:00.000Z",
};

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "msg-2",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

function baseIngress(event: QueuedMessage) {
  const isGroup = event.type === "group";
  const peerId = isGroup ? event.groupOpenid! : event.senderId;
  return {
    typing: { inputNotifyRefIdx: Promise.resolve(undefined), stop: () => {} },
    messageRoute: {
      isGroupChat: isGroup,
      peerId,
      routePeer: { kind: isGroup ? "group" as const : "direct" as const, id: peerId },
      customScenePeer: { kind: isGroup ? "group" as const : "c2c" as const, id: peerId },
      fromAddress: isGroup ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`,
      toAddress: isGroup ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`,
      requestTarget: isGroup ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`,
    },
    route: { agentId: "main", sessionKey: `session:${peerId}`, accountId: "default" },
    envelopeOptions: { envelope: true },
    systemPrompts: ["scene prompt"],
  };
}

function baseGroupDispatch(overrides: Record<string, unknown> = {}) {
  return {
    isGroupAllowed: () => true,
    resolveMentionPatterns: () => ["bot"],
    detectWasMentioned: () => true,
    resolveRequireMention: () => false,
    resolveIgnoreOtherMentions: () => false,
    resolveHistoryLimit: () => 0,
    resolveGroupName: () => "Group",
    resolveGroupIntroHint: () => undefined,
    resolveGroupPrompt: () => undefined,
    getRefEntry: () => null,
    isControlCommand: () => false,
    ...overrides,
  } as any;
}

{
  const result = await runCustomMessageContextGateway({
    cfg: {} as any,
    account: {
      accountId: "default",
      appId: "APP",
      config: { allowFrom: ["OTHER_OPENID"] },
    } as any,
    event: c2cMessage,
    ingress: baseIngress(c2cMessage),
    unread: {} as any,
    groupHistories: new Map(),
    hasTTS: true,
    processAttachments: async () => emptyProcessed,
    formatVoiceText: () => "",
    parseFaceTags: (content) => content,
    stripMentionText: (text) => text,
    getRefEntry: () => null,
    setRefEntry: () => {},
    formatRefEntry: () => "ref",
    formatMessageReference: async () => "message ref",
    formatInboundEnvelope: (input) => `BODY:${input.body}`,
    groupDispatch: baseGroupDispatch(),
    resolveHistoryLimit: () => 0,
    formatSubMessageContent: (message) => message.content,
    formatMergedEnvelope: (input) => `MERGED:${input.body}`,
    formatHistoryEnvelope: (entry) => `HISTORY:${entry.body}`,
    finalizeInboundContext: (payload) => payload,
  });

  assert.equal(result.action, "continue");
  assert.equal(result.commandAuthorized, false);
  assert.equal(result.userContent, "/status");
  assert.equal((result as any).ctxPayload.GroupSystemPrompt.includes("语音合成已启用"), true);
  assert.equal((result as any).ctxPayload.GroupSystemPrompt.includes("scene prompt"), true);
  assert.equal((result as any).ctxPayload.CommandAuthorized, false);
  assert.equal((result as any).ctxPayload.Body, "BODY:/status");
}

{
  const result = await runCustomMessageContextGateway({
    cfg: {} as any,
    account: {
      accountId: "default",
      appId: "APP",
      config: { allowFrom: ["*"] },
    } as any,
    event: groupMessage,
    ingress: baseIngress(groupMessage),
    unread: {} as any,
    groupHistories: new Map(),
    hasTTS: false,
    processAttachments: async () => emptyProcessed,
    formatVoiceText: () => "",
    parseFaceTags: (content) => content,
    stripMentionText: (text) => text,
    getRefEntry: () => null,
    setRefEntry: () => {},
    formatRefEntry: () => "ref",
    formatMessageReference: async () => "message ref",
    formatInboundEnvelope: (input) => `BODY:${input.body}`,
    groupDispatch: baseGroupDispatch({ isGroupAllowed: () => false }),
    resolveHistoryLimit: () => 0,
    formatSubMessageContent: (message) => message.content,
    formatMergedEnvelope: (input) => `MERGED:${input.body}`,
    formatHistoryEnvelope: (entry) => `HISTORY:${entry.body}`,
    finalizeInboundContext: (payload) => payload,
  });

  assert.equal(result.action, "stop");
  assert.equal(result.reason, "group_not_allowed");
  assert.equal(result.commandAuthorized, true);
}

{
  const unread = new CustomUnreadRuntime();
  const unreadCfg = resolveCustomUnreadConfig({ runtime: { enabled: true }, scene: { scene: "chat" } });
  unread.recordNonMention({
    cfg: unreadCfg,
    message: {
      accountId: "default",
      peer: { kind: "group", id: "GROUP_OPENID" },
      actor: { id: "MEMBER_A", label: "Alice" },
      content: "三张图里的观点",
      messageId: "hist-image-1",
      timestamp: 1_000,
      mentionedBot: false,
      attachments: [{ contentType: "image/png", url: "https://example.com/history.png", filename: "history.png" }],
    },
    now: 1_000,
  });
  const attachmentCalls: any[] = [];
  const result = await runCustomMessageContextGateway({
    cfg: { channels: { qqbot: { customRuntime: { enabled: true } } } } as any,
    account: {
      accountId: "default",
      appId: "APP",
      config: { allowFrom: ["*"] },
    } as any,
    event: { ...groupMessage, content: "@bot 总结一下图里的观点", messageId: "mention-image" },
    ingress: baseIngress(groupMessage),
    unread,
    groupHistories: new Map(),
    hasTTS: false,
    processAttachments: async (attachments) => {
      attachmentCalls.push(attachments ?? []);
      if (attachments?.[0]?.url === "https://example.com/history.png") {
        return {
          ...emptyProcessed,
          imageUrls: ["/tmp/history.png"],
          imageMediaTypes: ["image/png"],
          attachmentLocalPaths: ["/tmp/history.png"],
        };
      }
      return emptyProcessed;
    },
    formatVoiceText: () => "",
    parseFaceTags: (content) => content,
    stripMentionText: (text) => text,
    getRefEntry: () => null,
    setRefEntry: () => {},
    formatRefEntry: () => "ref",
    formatMessageReference: async () => "message ref",
    formatInboundEnvelope: (input) => `BODY:${input.body}`,
    groupDispatch: baseGroupDispatch(),
    resolveHistoryLimit: () => 10,
    formatSubMessageContent: (message) => message.content,
    formatMergedEnvelope: (input) => `MERGED:${input.body}`,
    formatHistoryEnvelope: (entry) => `HISTORY:${entry.body}`,
    finalizeInboundContext: (payload) => payload,
  });

  assert.equal(result.action, "continue");
  assert.equal((result as any).ctxPayload.MediaPath, "/tmp/history.png");
  assert.equal(attachmentCalls.some((call) => call[0]?.url === "https://example.com/history.png"), true);
}

{
  const unread = new CustomUnreadRuntime();
  const unreadCfg = resolveCustomUnreadConfig({ runtime: { enabled: true }, scene: { scene: "chat" } });
  for (const [index, url] of ["old.png", "middle.png", "latest.png"].entries()) {
    unread.recordNonMention({
      cfg: unreadCfg,
      message: {
        accountId: "default",
        peer: { kind: "group", id: "GROUP_OPENID" },
        actor: { id: `MEMBER_${index}`, label: `Member ${index}` },
        content: `history image ${index}`,
        messageId: `hist-image-${index}`,
        timestamp: 1_000 + index,
        mentionedBot: false,
        attachments: [{ contentType: "image/png", url: `https://example.com/${url}`, filename: url }],
      },
      now: 1_000 + index,
    });
  }
  const attachmentCalls: any[] = [];
  const result = await runCustomMessageContextGateway({
    cfg: { channels: { qqbot: { customRuntime: { enabled: true } } } } as any,
    account: {
      accountId: "default",
      appId: "APP",
      config: { allowFrom: ["*"] },
    } as any,
    event: { ...groupMessage, content: "@bot 这张图是什么", messageId: "mention-latest-image" },
    ingress: baseIngress(groupMessage),
    unread,
    groupHistories: new Map(),
    hasTTS: false,
    processAttachments: async (attachments) => {
      attachmentCalls.push(attachments ?? []);
      return attachments?.length
        ? {
            ...emptyProcessed,
            imageUrls: attachments.map((attachment) => `/tmp/${attachment.filename}`),
            imageMediaTypes: attachments.map(() => "image/png"),
            attachmentLocalPaths: attachments.map((attachment) => `/tmp/${attachment.filename}`),
          }
        : emptyProcessed;
    },
    formatVoiceText: () => "",
    parseFaceTags: (content) => content,
    stripMentionText: (text) => text,
    getRefEntry: () => null,
    setRefEntry: () => {},
    formatRefEntry: () => "ref",
    formatMessageReference: async () => "message ref",
    formatInboundEnvelope: (input) => `BODY:${input.body}`,
    groupDispatch: baseGroupDispatch(),
    resolveHistoryLimit: () => 10,
    formatSubMessageContent: (message) => message.content,
    formatMergedEnvelope: (input) => `MERGED:${input.body}`,
    formatHistoryEnvelope: (entry) => `HISTORY:${entry.body}`,
    finalizeInboundContext: (payload) => payload,
  });

  assert.equal(result.action, "continue");
  assert.equal((result as any).ctxPayload.MediaPath, "/tmp/latest.png");
  assert.deepEqual(
    attachmentCalls.filter((call) => call.length > 0).map((call) => call.map((attachment: any) => attachment.url)),
    [["https://example.com/latest.png"]],
  );
}

assert.equal(resolveCommandAuthorized(undefined, "USER"), true);
assert.equal(resolveCommandAuthorized(["*"], "USER"), true);
assert.equal(resolveCommandAuthorized(["user"], "USER"), true);
assert.equal(resolveCommandAuthorized(["OTHER"], "USER"), false);
assert.equal(resolveCustomCommandAuthorized({
  channels: { qqbot: { customRuntime: { enabled: true, admins: ["USER"] } } },
} as any, ["OTHER"], { ...c2cMessage, senderId: "USER" }), true);
assert.equal(resolveCustomCommandAuthorized({
  channels: { qqbot: { customRuntime: { enabled: true, admins: ["OTHER"] } } },
} as any, ["OTHER"], { ...c2cMessage, senderId: "USER" }), false);

console.log("custom message context gateway adapter tests passed");
