import assert from "node:assert";
import { runCustomMessageDispatchGateway } from "../src/custom/message-dispatch-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const c2cMessage: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/admin",
  messageId: "msg-c2c",
  timestamp: "2026-06-22T00:00:00.000Z",
};

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "msg-group",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
  _customUnreadSnapshotId: "snapshot-1",
};

function fakeSetup(overrides: Record<string, unknown> = {}) {
  return {
    replyAnchorId: "anchor-1",
    replyTarget: { type: "c2c", senderId: "USER_OPENID", messageId: "msg-c2c" },
    replyContext: { target: { type: "c2c", senderId: "USER_OPENID", messageId: "msg-c2c" }, account: {}, cfg: {} },
    sendWithRetry: async (sendFn: (token: string) => Promise<unknown>) => sendFn("TOKEN"),
    sendErrorMessage: async () => {},
    deliverEvent: { type: "c2c", senderId: "USER_OPENID", messageId: "msg-c2c" },
    deliverAccountContext: { account: {}, qualifiedTarget: "qqbot:c2c:USER_OPENID" },
    sendGuardedMediaAuto: async () => ({ sent: true }),
    ...overrides,
  } as any;
}

function baseParams(event: QueuedMessage) {
  const peerId = event.type === "group" ? event.groupOpenid! : event.senderId;
  return {
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      config: {},
    } as any,
    event,
    cfg: {},
    route: { agentId: "main", sessionKey: `session:${peerId}` },
    qualifiedTarget: event.type === "group" ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`,
    ctxPayload: { body: event.content },
    userContent: event.content,
    wasMentioned: true,
    shouldCatchUpUnreadAfterReply: true,
    customUnreadCfgForEvent: null,
    runtime: {
      auth: {} as any,
      unread: {} as any,
    },
    groupHistories: new Map(),
    persistAuthState: () => {},
    persistCustomUnreadState: () => {},
    buildProactiveGuard: () => ({ proactiveGuard: () => ({ allowed: true }) }),
    sendMedia: async () => ({ ok: true }) as any,
    getRuntime: () => ({ enabled: true }) as any,
    getQueueSnapshot: () => ({ pending: 1 }) as any,
    createDebouncer: () => ({ flush: async () => {}, cancel: () => {} }) as any,
    recordOutboundActivity: () => {},
    parseAndSendMediaTags: async () => ({ handled: false, normalizedText: "" }),
    handleStructuredPayload: async () => false,
    sendPlainReply: async () => {},
    stopTyping: () => {},
    resolveEffectiveMessagesConfig: () => ({}),
    dispatchReply: async () => ({}),
    resolveHistoryLimit: () => 3,
  };
}

{
  let approvalSent = false;
  let stoppedTyping = false;
  let ranRequestContext = false;
  const result = await runCustomMessageDispatchGateway({
    ...baseParams(c2cMessage),
    stopTyping: () => { stoppedTyping = true; },
    setupGateway: () => fakeSetup(),
    authorizeGateway: async (params) => {
      assert.equal(params.rawContent, "/admin");
      await params.sendApprovalCard?.(
        { kind: "c2c", userOpenid: "USER_OPENID", messageId: "msg-c2c" },
        "需要授权",
        { id: "keyboard" } as any,
      );
      return { decision: {} as any, shouldStop: true };
    },
    sendApprovalCardWithRetry: async (sendWithRetry, target, text, keyboard) => {
      approvalSent = true;
      assert.equal(target.kind, "c2c");
      assert.equal(text, "需要授权");
      assert.deepEqual(keyboard, { id: "keyboard" });
      await sendWithRetry(async (token) => {
        assert.equal(token, "TOKEN");
      });
    },
    runWithRequestContext: async () => {
      ranRequestContext = true;
    },
  });

  assert.deepEqual(result, { action: "stopped", reason: "auth_denied" });
  assert.equal(approvalSent, true);
  assert.equal(stoppedTyping, true);
  assert.equal(ranRequestContext, false);
}

{
  let contextTarget = "";
  let fallbackSessionKey = "";
  let replyRouteAgentId = "";
  let unreadGroupOpenid = "";
  let unreadSnapshotId = "";
  const result = await runCustomMessageDispatchGateway({
    ...baseParams(groupMessage),
    customUnreadCfgForEvent: { enabled: true } as any,
    setupGateway: () => fakeSetup({
      deliverEvent: {
        type: "group",
        senderId: "MEMBER_OPENID",
        messageId: "msg-group",
        groupOpenid: "GROUP_OPENID",
      },
      deliverAccountContext: { account: {}, qualifiedTarget: "qqbot:group:GROUP_OPENID" },
    }),
    authorizeGateway: async () => ({ decision: {} as any, shouldStop: false }),
    runWithRequestContext: async (ctx, fn) => {
      contextTarget = ctx.target;
      await fn();
    },
    createFallbackSession: (params) => {
      fallbackSessionKey = params.sessionKey ?? "";
      assert.deepEqual(params.getQueueSnapshot(), { pending: 1 });
      return { createResponseTimeoutPromise: () => new Promise(() => {}) } as any;
    },
    dispatchReplyGateway: async (params) => {
      replyRouteAgentId = params.routeAgentId;
      await params.onAfterFinalize?.({ hasModelBlockOutput: true } as any);
      return {};
    },
    completeUnreadGateway: (params) => {
      unreadGroupOpenid = params.groupOpenid ?? "";
      unreadSnapshotId = params.snapshotId ?? "";
      assert.equal(params.shouldCatchUpAfterReply, true);
      assert.equal(params.wasMentioned, true);
      assert.equal(params.hasModelBlockOutput, true);
      return { kind: "custom-handled", completion: {} } as any;
    },
  });

  assert.deepEqual(result, { action: "completed" });
  assert.equal(contextTarget, "qqbot:group:GROUP_OPENID");
  assert.equal(fallbackSessionKey, "session:GROUP_OPENID");
  assert.equal(replyRouteAgentId, "main");
  assert.equal(unreadGroupOpenid, "GROUP_OPENID");
  assert.equal(unreadSnapshotId, "snapshot-1");
}

{
  const ctxPayload: Record<string, unknown> = {
    CommandAuthorized: true,
    GroupSystemPrompt: "原始场景提示",
  };
  let deliveredPayload: Record<string, unknown> | null = null;
  const result = await runCustomMessageDispatchGateway({
    ...baseParams(groupMessage),
    ctxPayload,
    setupGateway: () => fakeSetup(),
    authorizeGateway: async () => ({
      shouldStop: false,
      decision: {
        enabled: true,
        allowed: true,
        capability: "chat.send",
        result: {
          decision: {
            allowed: true,
            reason: "allowed",
            capability: "chat.send",
            actorId: "MEMBER_OPENID",
            peerId: "GROUP_OPENID",
            source: "scene",
          },
          intents: [],
        },
        reason: "allowed",
      } as any,
    }),
    dispatchReplyGateway: async (params) => {
      deliveredPayload = params.ctxPayload as Record<string, unknown>;
      return {};
    },
  });

  assert.deepEqual(result, { action: "completed" });
  assert.equal(deliveredPayload?.CommandAuthorized, false);
  assert.equal(String(deliveredPayload?.GroupSystemPrompt).includes("当前发送者不是 customRuntime.admins 管理员"), true);
  assert.equal(String(deliveredPayload?.GroupSystemPrompt).includes("不要运行命令、读写文件"), true);
}

{
  const ctxPayload: Record<string, unknown> = {
    CommandAuthorized: false,
  };
  let deliveredPayload: Record<string, unknown> | null = null;
  const result = await runCustomMessageDispatchGateway({
    ...baseParams(groupMessage),
    ctxPayload,
    setupGateway: () => fakeSetup(),
    authorizeGateway: async () => ({
      shouldStop: false,
      decision: {
        enabled: true,
        allowed: true,
        capability: "codex.run",
        result: {
          decision: {
            allowed: true,
            reason: "allowed",
            capability: "codex.run",
            actorId: "MEMBER_OPENID",
            peerId: "GROUP_OPENID",
            source: "temporary-grant",
            grantId: "grant-1",
          },
          intents: [],
        },
        reason: "allowed",
      } as any,
    }),
    dispatchReplyGateway: async (params) => {
      deliveredPayload = params.ctxPayload as Record<string, unknown>;
      return {};
    },
  });

  assert.deepEqual(result, { action: "completed" });
  assert.equal(deliveredPayload?.CommandAuthorized, true);
  assert.equal(String(deliveredPayload?.GroupSystemPrompt).includes("一次性临时授权"), true);
  assert.equal(String(deliveredPayload?.GroupSystemPrompt).includes("本次授权能力：codex.run"), true);
}

console.log("custom message dispatch gateway adapter tests passed");
