import assert from "node:assert";
import { handleCustomInteractionCreateGateway } from "../src/custom/interaction-create-gateway-adapter.js";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";
import type { InteractionEvent } from "../src/types.js";

function groupInteraction(buttonData: string, type = 1): InteractionEvent {
  return {
    id: `interaction-${buttonData.slice(0, 8)}`,
    type: 11,
    scene: "group",
    chat_type: 1,
    group_openid: "GROUP_OPENID",
    group_member_openid: "MEMBER_OPENID",
    version: 1,
    data: {
      type,
      resolved: {
        button_data: buttonData,
      },
    },
  };
}

{
  const ackCalls: Array<{ code?: 0; payload?: { claw_cfg: Record<string, unknown> } }> = [];
  const result = await handleCustomInteractionCreateGateway({
    accountId: "default",
    event: groupInteraction("", 2001),
    cfg: {
      channels: {
        qqbot: {
          groups: {
            GROUP_OPENID: { requireMention: false },
          },
        },
      },
    },
    getConfigApi: () => ({
      loadConfig: () => ({
        channels: {
          qqbot: {
            groups: {
              GROUP_OPENID: { requireMention: false },
            },
          },
        },
      }),
      writeConfigFile: async () => {},
    }),
    acknowledge: async (code, payload) => {
      ackCalls.push({ code, payload });
    },
    pluginVersion: "1.2.3",
    frameworkVersion: "2026.6.22",
    sendReply: async () => {
      throw new Error("config interaction should not send follow-up reply");
    },
  });

  assert.equal(result.kind, "config");
  assert.equal(ackCalls.length, 1);
  assert.equal(ackCalls[0]?.code, 0);
  assert.equal(ackCalls[0]?.payload?.claw_cfg.require_mention, "always");
}

{
  const ackCalls: Array<{ code?: 0 }> = [];
  let pollPersisted = 0;
  let sentReply: unknown = null;
  const result = await handleCustomInteractionCreateGateway({
    accountId: "default",
    event: groupInteraction("custom-poll:poll-1:vote:2"),
    cfg: {},
    runtime: {
      auth: {} as any,
      polls: {} as any,
      games: {} as any,
      deployConfirmations: {} as any,
    },
    getConfigApi: () => ({
      loadConfig: () => ({}),
      writeConfigFile: async () => {},
    }),
    acknowledge: async (code) => {
      ackCalls.push({ code });
    },
    pluginVersion: "1.2.3",
    frameworkVersion: "2026.6.22",
    sendReply: async (target, text) => {
      sentReply = { target, text };
    },
    persistPollState: () => {
      pollPersisted += 1;
    },
    handleButton: (input) => {
      assert.equal(input.buttonData, "custom-poll:poll-1:vote:2");
      assert.equal(input.actor.id, "MEMBER_OPENID");
      assert.deepEqual(input.sourcePeer, { kind: "group", id: "GROUP_OPENID" });
      return {
        handled: true,
        persist: { polls: true },
        reply: "已记录投票：B",
      };
    },
  });

  assert.equal(result.kind, "custom-button");
  assert.equal(ackCalls.length, 1);
  assert.equal(ackCalls[0]?.code, undefined);
  assert.equal(pollPersisted, 1);
  assert.deepEqual(sentReply, {
    target: { kind: "group", groupOpenid: "GROUP_OPENID" },
    text: "已记录投票：B",
  });
  assert.equal(result.kind === "custom-button" && result.effects.replyDelivered, true);
}

{
  const ackCalls: Array<{ code?: 0 }> = [];
  let writtenCfg: any = null;
  let sentReply: unknown = null;
  const cfg = {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          admins: ["MEMBER_OPENID"],
          scenes: {},
        },
      },
    },
  } as any;
  const result = await handleCustomInteractionCreateGateway({
    accountId: "default",
    event: groupInteraction("custom-scene:set:dev-lab"),
    cfg,
    runtime: createCustomMessageFlowRuntime(),
    getConfigApi: () => ({
      loadConfig: () => cfg,
      writeConfigFile: async (nextCfg) => {
        writtenCfg = nextCfg;
      },
    }),
    acknowledge: async (code) => {
      ackCalls.push({ code });
    },
    pluginVersion: "1.2.3",
    frameworkVersion: "2026.6.22",
    sendReply: async (target, text) => {
      sentReply = { target, text };
    },
  });

  assert.equal(result.kind, "custom-button");
  assert.equal(ackCalls.length, 1);
  assert.equal(ackCalls[0]?.code, undefined);
  assert.equal(result.kind === "custom-button" && result.effects.configPersisted, true);
  assert.equal(writtenCfg.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].scene, "dev-lab");
  assert.deepEqual(sentReply, {
    target: { kind: "group", groupOpenid: "GROUP_OPENID" },
    text: result.kind === "custom-button" ? result.customInteraction.reply : undefined,
  });
}

{
  const approvalId = "exec:123e4567-e89b-12d3-a456-426614174000";
  const ackCalls: Array<{ code?: 0 }> = [];
  let resolved: unknown = null;
  const result = await handleCustomInteractionCreateGateway({
    accountId: "default",
    event: groupInteraction(`approve:${approvalId}:deny`),
    cfg: {},
    getConfigApi: () => ({
      loadConfig: () => ({}),
      writeConfigFile: async () => {},
    }),
    acknowledge: async (code) => {
      ackCalls.push({ code });
    },
    pluginVersion: "1.2.3",
    frameworkVersion: "2026.6.22",
    sendReply: async () => {
      throw new Error("legacy approval should not send custom follow-up reply");
    },
    getLegacyApprovalHandler: () => ({
      resolveApproval: (id, decision) => {
        resolved = { id, decision };
      },
    }),
  });

  assert.equal(result.kind, "legacy-approval");
  assert.equal(result.kind === "legacy-approval" && result.handlerFound, true);
  assert.deepEqual(resolved, { id: approvalId, decision: "deny" });
  assert.equal(ackCalls.length, 1);
  assert.equal(ackCalls[0]?.code, undefined);
}

console.log("custom interaction create gateway adapter tests passed");
