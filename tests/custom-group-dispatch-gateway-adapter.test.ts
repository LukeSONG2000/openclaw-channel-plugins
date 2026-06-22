import assert from "node:assert";
import { applyCustomGroupDispatchGateway } from "../src/custom/group-dispatch-gateway-adapter.js";
import { CustomUnreadRuntime } from "../src/custom/unread-runtime.js";
import type { HistoryEntry } from "../src/group-history.js";
import type { QueuedMessage } from "../src/message-queue.js";

const customUnreadCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        unread: {
          enabled: true,
          followupDelayMs: 1_000,
          sleepDelayMs: 10_000,
        },
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            allowAutonomousReply: true,
            allowProactiveSend: true,
          },
        },
      },
    },
  },
} as any;

const disabledCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: false,
      },
    },
  },
} as any;

function groupEvent(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    content: "hello",
    messageId: "msg-1",
    timestamp: "2026-06-21T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
    attachments: [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
    ...overrides,
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const groupHistories = new Map<string, HistoryEntry[]>();
  const unread = new CustomUnreadRuntime();
  let scheduledEffects = 0;
  let persistCount = 0;
  return {
    logs,
    groupHistories,
    unread,
    get scheduledEffects() { return scheduledEffects; },
    get persistCount() { return persistCount; },
    params: {
      cfg: customUnreadCfg,
      accountId: "default",
      route: { agentId: "agent", sessionKey: "session" },
      unread,
      event: groupEvent(),
      content: "hello",
      commandAuthorized: true,
      groupHistories,
      isGroupAllowed: () => true,
      resolveMentionPatterns: () => [],
      detectWasMentioned: () => false,
      resolveRequireMention: () => true,
      resolveActivation: () => "mention",
      resolveIgnoreOtherMentions: () => false,
      resolveHistoryLimit: () => 10,
      resolveGroupName: () => "Master Luke的图书馆",
      resolveGroupIntroHint: () => "群介绍",
      resolveGroupPrompt: () => "群行为提示",
      getRefEntry: () => null,
      isControlCommand: (text: string) => text.startsWith("/"),
      applySchedulerEffects: (effects: unknown[]) => { scheduledEffects += effects.length; },
      persistCustomUnreadState: () => { persistCount += 1; },
      log: { info: (msg: string) => logs.push(msg) },
      ...overrides,
    },
  };
}

{
  const setup = baseParams({ event: { ...groupEvent(), type: "c2c", groupOpenid: undefined } });
  const result = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(result.action, "continue");
  assert.equal(result.reason, "non_group");
  assert.equal(result.wasMentioned, false);
}

{
  const setup = baseParams({ isGroupAllowed: () => false });
  const result = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "group_not_allowed");
  assert.equal(setup.logs.some((line) => line.includes("not allowed by groupPolicy")), true);
}

{
  const setup = baseParams({
    cfg: disabledCfg,
    content: "hello with attachment",
  });
  const result = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "skip_no_mention");
  assert.equal(setup.groupHistories.get("GROUP_OPENID")?.[0]?.body, "hello with attachment");
  assert.equal(setup.groupHistories.get("GROUP_OPENID")?.[0]?.attachments?.[0]?.type, "image");
  assert.equal(setup.scheduledEffects, 0);
  assert.equal(setup.persistCount, 0);
}

{
  const setup = baseParams({
    event: groupEvent({ content: "/bot-scene set dev-lab" }),
    content: "/bot-scene set dev-lab",
    commandAuthorized: false,
  });
  const result = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "block_unauthorized_command");
  assert.equal(setup.logs.some((line) => line.includes("blocked unauthorized control command")), true);
}

{
  const setup = baseParams();
  const skipped = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(skipped.action, "stop");
  assert.equal(skipped.reason, "skip_no_mention");
  assert.equal(setup.persistCount, 1);

  const mentioned = applyCustomGroupDispatchGateway({
    ...(setup.params as any),
    event: groupEvent({
      content: "@bot what did I miss?",
      messageId: "mention-1",
      eventType: "GROUP_AT_MESSAGE_CREATE",
      mentions: [{ is_you: true }],
    }),
    content: "what did I miss?",
    detectWasMentioned: () => true,
  });
  assert.equal(mentioned.action, "continue");
  assert.equal(mentioned.wasMentioned, true);
  assert.equal(mentioned.shouldCatchUpUnreadAfterReply, true);
  assert.equal(mentioned.customUnreadHistoryForEvent?.[0]?.body, "hello");
  assert.equal(mentioned.senderLabel, "Member (MEMBER_OPENID)");
  assert.equal(mentioned.groupSubject, "Master Luke的图书馆");
  assert.equal(mentioned.groupSystemPrompt, "群介绍\n群行为提示");
  assert.equal(setup.scheduledEffects, 2);
  assert.equal(setup.persistCount, 2);
  assert.equal(setup.logs.some((line) => line.includes("mention with 1 custom unread message(s)")), true);
}


{
  const adminGroupCfg = {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          admins: ["MEMBER_OPENID"],
          adminGroup: "qqbot:group:GROUP_OPENID",
          unread: { enabled: true },
        },
      },
    },
  } as any;
  const setup = baseParams({
    cfg: adminGroupCfg,
    resolveActivation: () => "mention",
    resolveRequireMention: () => true,
    detectWasMentioned: () => false,
  });
  const result = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(result.action, "continue");
  assert.equal(result.reason, undefined);
  assert.equal(result.wasMentioned, true);
}

{
  const adminGroupCfg = {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          admins: ["OTHER_OPENID"],
          adminGroup: "qqbot:group:GROUP_OPENID",
          unread: { enabled: true },
        },
      },
    },
  } as any;
  const setup = baseParams({
    cfg: adminGroupCfg,
    resolveActivation: () => "mention",
    resolveRequireMention: () => true,
    detectWasMentioned: () => false,
  });
  const result = applyCustomGroupDispatchGateway(setup.params as any);
  assert.equal(result.action, "stop");
  assert.equal(result.reason, "skip_no_mention");
}

console.log("custom group dispatch gateway adapter tests passed");
