import assert from "node:assert";
import { createCustomMessageHandlerGateway } from "../src/custom/message-handler-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "msg-1",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
  _customUnreadSnapshotId: "snapshot-1",
};

function createPluginRuntime(records: string[] = []) {
  return {
    channel: {
      activity: {
        record: (input: { direction: string }) => records.push(input.direction),
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "main" }),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({ envelope: true }),
        formatInboundEnvelope: (input: any) => `ENV:${input.body}`,
        finalizeInboundContext: (payload: unknown) => payload,
        resolveEffectiveMessagesConfig: () => ({}),
        dispatchReplyWithBufferedBlockDispatcher: async () => ({}),
      },
    },
  };
}

{
  const activityRecords: string[] = [];
  const groupHistories = new Map();
  let ingressCalled = false;
  let contextCalled = false;
  let dispatchCalled = false;
  let typingStopped = false;

  const handler = createCustomMessageHandlerGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      config: {},
    } as any,
    cfg: {},
    pluginRuntime: createPluginRuntime(activityRecords) as any,
    runtime: {
      auth: {} as any,
      unread: {} as any,
    } as any,
    groupHistories,
    customRuntimeServices: {
      resolveUnreadForEvent: (event) => {
        assert.equal(event.messageId, "msg-1");
        return { enabled: true } as any;
      },
    },
    getQueueSnapshot: (peerId) => {
      assert.equal(peerId, "GROUP_OPENID");
      return { pending: 2 } as any;
    },
    getUnreadScheduler: () => ({
      apply: () => {},
    } as any),
    persistAuthState: () => {},
    persistCustomUnreadState: () => {},
    buildProactiveGuard: () => ({ proactiveGuard: () => ({ allowed: true }) }),
    sendMedia: async () => ({ ok: true }) as any,
    createDebouncer: () => ({
      run: async (_key: string, fn: () => Promise<unknown>) => fn(),
    }) as any,
    parseAndSendMediaTags: async () => ({ text: "" }) as any,
    handleStructuredPayload: async () => false as any,
    sendPlainReply: async () => {},
    adminGroupNotifications: {
      sendFallbackAdminGroupAlert: async () => {},
      sendAuthAdminGroupNotification: async () => {},
    },
    isCustomRuntimeEnabled: () => true,
    isControlCommand: () => false,
    stripMentionText: (text) => text,
    detectWasMentioned: () => true,
    resolveRequireMention: () => true,
    resolveGroupIntroHint: () => undefined,
    runIngress: (params) => {
      ingressCalled = true;
      params.recordInboundActivity();
      assert.equal(params.customRuntimeEnabled, true);
      return {
        action: "continue",
        typing: { inputNotifyRefIdx: Promise.resolve(undefined), stop: () => { typingStopped = true; } },
        messageRoute: {
          isGroupChat: true,
          peerId: "GROUP_OPENID",
          requestTarget: "qqbot:group:GROUP_OPENID",
          fromAddress: "qqbot:group:GROUP_OPENID",
          toAddress: "qqbot:group:GROUP_OPENID",
        },
        route: { agentId: "main", sessionKey: "session:GROUP_OPENID", accountId: "default" },
        envelopeOptions: { envelope: true },
        systemPrompts: [],
      } as any;
    },
    runContext: async (params) => {
      contextCalled = true;
      assert.equal(params.initialCustomUnreadCfg?.enabled, true);
      assert.equal(params.groupHistories, groupHistories);
      return {
        action: "continue",
        ctxPayload: { body: "ctx" },
        userContent: "hello",
        commandAuthorized: true,
        wasMentioned: true,
        shouldCatchUpUnreadAfterReply: true,
        customUnreadCfgForEvent: { enabled: true },
      } as any;
    },
    runDispatch: async (params) => {
      dispatchCalled = true;
      assert.equal(params.qualifiedTarget, "qqbot:group:GROUP_OPENID");
      assert.deepEqual(params.ctxPayload, { body: "ctx" });
      assert.deepEqual(params.getQueueSnapshot(), { pending: 2 });
      params.recordOutboundActivity();
      params.stopTyping();
      return { action: "completed" } as any;
    },
  });

  await handler(message);

  assert.equal(ingressCalled, true);
  assert.equal(contextCalled, true);
  assert.equal(dispatchCalled, true);
  assert.equal(typingStopped, true);
  assert.deepEqual(activityRecords, ["inbound", "outbound"]);
}

{
  let contextCalled = false;
  const handler = createCustomMessageHandlerGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      config: {},
    } as any,
    cfg: {},
    pluginRuntime: createPluginRuntime() as any,
    runtime: { auth: {} as any, unread: {} as any } as any,
    groupHistories: new Map(),
    customRuntimeServices: { resolveUnreadForEvent: () => null },
    getQueueSnapshot: () => ({}) as any,
    getUnreadScheduler: () => null,
    persistAuthState: () => {},
    persistCustomUnreadState: () => {},
    buildProactiveGuard: () => ({ proactiveGuard: () => ({ allowed: true }) }),
    sendMedia: async () => ({ ok: true }) as any,
    createDebouncer: () => ({
      run: async (_key: string, fn: () => Promise<unknown>) => fn(),
    }) as any,
    parseAndSendMediaTags: async () => ({ text: "" }) as any,
    handleStructuredPayload: async () => false as any,
    sendPlainReply: async () => {},
    adminGroupNotifications: {
      sendFallbackAdminGroupAlert: async () => {},
      sendAuthAdminGroupNotification: async () => {},
    },
    isCustomRuntimeEnabled: () => true,
    isControlCommand: () => false,
    stripMentionText: (text) => text,
    detectWasMentioned: () => true,
    resolveRequireMention: () => true,
    resolveGroupIntroHint: () => undefined,
    runIngress: () => ({ action: "stop", reason: "scene_disabled" }) as any,
    runContext: async () => {
      contextCalled = true;
      return { action: "continue" } as any;
    },
  });

  await handler(message);
  assert.equal(contextCalled, false);
}

console.log("custom message handler gateway adapter tests passed");
