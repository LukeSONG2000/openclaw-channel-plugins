import assert from "node:assert";
import { runCustomMessageIngressGateway } from "../src/custom/message-ingress-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "msg-1",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
  attachments: [{ url: "https://example.test/a.png", contentType: "image/png" } as any],
};

{
  const logs: string[] = [];
  let activityCount = 0;
  let routePeer: unknown = null;
  const result = runCustomMessageIngressGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      enabled: true,
      config: {},
      systemPrompt: "account prompt",
    } as any,
    event: groupMessage,
    cfg: {
      channels: {
        qqbot: {
          customRuntime: {
            enabled: true,
            scenes: {
              "qqbot:group:GROUP_OPENID": { scene: "chat" },
            },
          },
        },
      },
    },
    getToken: async () => "TOKEN",
    clearTokenCache: () => {},
    recordInboundActivity: () => { activityCount += 1; },
    resolveBaseRoute: (input) => {
      routePeer = input.peer;
      return { agentId: "main", sessionKey: "session:group", accountId: "default" } as any;
    },
    customRuntimeEnabled: true,
    resolveEnvelopeOptions: () => ({ envelope: true }),
    log: {
      info: (msg) => logs.push(msg),
      debug: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
  });

  assert.equal(result.action, "continue");
  assert.equal(activityCount, 1);
  assert.deepEqual(routePeer, { kind: "group", id: "GROUP_OPENID" });
  assert.equal(result.action === "continue" && result.route.agentId, "main");
  assert.deepEqual(result.action === "continue" && result.envelopeOptions, { envelope: true });
  assert.equal(result.action === "continue" && result.messageRoute.requestTarget, "qqbot:group:GROUP_OPENID");
  assert.equal(result.action === "continue" && result.systemPrompts.some((line) => line.includes("account prompt")), true);
  assert.equal(result.action === "continue" && result.systemPrompts.some((line) => line.includes("当前 QQBot 场景是 chat")), true);
  assert.equal(logs.some((line) => line.includes("Attachments: 1")), true);
}

{
  const result = runCustomMessageIngressGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      enabled: true,
      config: {},
    } as any,
    event: groupMessage,
    cfg: {
      channels: {
        qqbot: {
          customRuntime: {
            enabled: true,
            scenes: {
              "qqbot:group:GROUP_OPENID": { scene: "chat", enabled: false },
            },
          },
        },
      },
    },
    getToken: async () => "TOKEN",
    clearTokenCache: () => {},
    recordInboundActivity: () => {},
    resolveBaseRoute: () => ({ agentId: "main", sessionKey: "session:group", accountId: "default" }) as any,
    customRuntimeEnabled: true,
    resolveEnvelopeOptions: () => ({ envelope: true }),
  });

  assert.equal(result.action, "stop");
  assert.equal(result.action === "stop" && result.reason, "scene_disabled");
  assert.equal(result.action === "stop" && result.messageRoute.customScenePeer.kind, "group");
}

console.log("custom message ingress gateway adapter tests passed");
