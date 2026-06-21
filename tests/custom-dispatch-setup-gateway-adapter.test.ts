import assert from "node:assert";
import { applyCustomDispatchSetupGateway } from "../src/custom/dispatch-setup-gateway-adapter.js";
import type { CustomOutboundProactiveSource } from "../src/custom/outbound-deliver-context.js";

const account = {
  accountId: "default",
  appId: "APPID",
  clientSecret: "SECRET",
  enabled: true,
  config: {},
} as any;

const baseEvent = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Luke",
  senderIsBot: false,
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
} as any;

{
  const guardSources: Array<CustomOutboundProactiveSource | undefined> = [];
  let guardCommitted = 0;
  let mediaSent = 0;

  const setup = applyCustomDispatchSetupGateway({
    event: baseEvent,
    account,
    cfg: { channels: { qqbot: {} } },
    qualifiedTarget: "qqbot:group:GROUP_OPENID",
    buildProactiveGuard: (source) => {
      guardSources.push(source);
      return {
        proactiveGuard: () => ({
          allowed: true,
          commit: () => {
            guardCommitted += 1;
          },
        }),
      };
    },
    sendMedia: async (input) => {
      mediaSent += 1;
      assert.equal(input.to, "qqbot:group:GROUP_OPENID");
      assert.equal(input.replyToId, "MSG_ID");
      assert.equal(input.mediaUrl, "https://example.com/image.png");
      return { channel: "qqbot" };
    },
  });

  assert.equal(setup.replyAnchorId, "MSG_ID");
  assert.equal(setup.replyContext.target.messageId, "MSG_ID");
  assert.equal(setup.deliverEvent.replyToId, "MSG_ID");
  assert.equal(setup.deliverAccountContext.qualifiedTarget, "qqbot:group:GROUP_OPENID");
  assert.equal(guardSources.length, 2);
  assert.equal(guardSources[0], undefined);
  assert.equal(guardSources[1]?.actor.id, "MEMBER_OPENID");

  const mediaResult = await setup.sendGuardedMediaAuto("https://example.com/image.png", "test media");
  assert.equal(mediaResult.error, undefined);
  assert.equal(mediaSent, 1);
  assert.equal(guardCommitted, 0);
}

{
  let mediaSent = 0;
  const setup = applyCustomDispatchSetupGateway({
    event: {
      ...baseEvent,
      messageId: "SYNTHETIC_MSG",
      _customUnreadSnapshotId: "snapshot-1",
    },
    account,
    cfg: {},
    qualifiedTarget: "qqbot:group:GROUP_OPENID",
    buildProactiveGuard: () => ({
      proactiveGuard: () => ({
        allowed: false,
        reason: "blocked",
      }),
    }),
    sendMedia: async () => {
      mediaSent += 1;
      return { channel: "qqbot" };
    },
    log: {
      info: () => {},
      debug: () => {},
      error: () => {},
    },
  });

  assert.equal(setup.replyAnchorId, undefined);
  assert.equal(setup.replyContext.target.messageId, "");
  assert.equal(setup.deliverEvent.replyToId, undefined);
  const blockedResult = await setup.sendGuardedMediaAuto("https://example.com/blocked.png", "blocked media");
  assert.equal(blockedResult.error?.includes("blocked by custom proactive guard"), true);
  assert.equal(mediaSent, 0);
}

{
  let guardCommitted = 0;
  const setup = applyCustomDispatchSetupGateway({
    event: {
      ...baseEvent,
      messageId: "SYNTHETIC_MSG",
      _customUnreadSnapshotId: "snapshot-2",
    },
    account,
    cfg: {},
    qualifiedTarget: "qqbot:group:GROUP_OPENID",
    buildProactiveGuard: () => ({
      proactiveGuard: () => ({
        allowed: true,
        commit: () => {
          guardCommitted += 1;
        },
      }),
    }),
    sendMedia: async () => ({ channel: "qqbot" }),
  });

  const allowedResult = await setup.sendGuardedMediaAuto("https://example.com/allowed.png", "allowed media");
  assert.equal(allowedResult.error, undefined);
  assert.equal(guardCommitted, 1);
}

console.log("custom dispatch setup gateway adapter tests passed");
