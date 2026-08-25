import assert from "node:assert";
import {
  createQQBotGatewayPlatformServices,
  isQQBotGatewayControlCommand,
} from "../src/custom/gateway-platform-services-gateway-adapter.js";

{
  const calls: string[] = [];
  const result = isQQBotGatewayControlCommand("/bot-ping", () => ({
    channel: {
      text: {
        hasControlCommand: (text) => {
          calls.push(text);
          return text === "/bot-ping";
        },
      },
    },
  }));
  assert.equal(result, true);
  assert.deepEqual(calls, ["/bot-ping"]);
}

{
  assert.equal(isQQBotGatewayControlCommand("hello", () => { throw new Error("no runtime"); }), false);
  assert.equal(isQQBotGatewayControlCommand("/new", () => { throw new Error("no runtime"); }), true);
  assert.equal(isQQBotGatewayControlCommand("/123", () => ({})), false);
}

{
  const events: string[] = [];
  const runtime = {
    channel: { routing: { id: "route" } },
    config: { loadConfig: () => ({ ok: true }), writeConfigFile: async () => {} },
  };
  const legacyHandler = { id: "legacy" };
  const service = createQQBotGatewayPlatformServices({
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET", config: {} } as any,
    cfg: { channel: true },
    getRuntime: () => runtime,
    getLegacyApprovalHandler: () => legacyHandler as any,
    stripMentionText: (text, mentions) => {
      events.push(`strip:${mentions?.length ?? 0}`);
      return text.replace("<@bot>", "").trim();
    },
    detectWasMentioned: (input) => {
      events.push(`detect:${input.content}`);
      return input.mentions?.some((mention) => mention.is_you) ?? false;
    },
    plugin: {
      groups: {
        resolveRequireMention: ({ accountId, groupId }) => {
          events.push(`require:${accountId}:${groupId}`);
          return false;
        },
        resolveGroupIntroHint: ({ accountId, groupId }) => {
          events.push(`intro:${accountId}:${groupId}`);
          return "intro hint";
        },
      },
    },
  });

  assert.equal(service.stripMentionText("<@bot> hello", [{ is_you: true }] as any), "hello");
  assert.equal(service.detectWasMentioned({ content: "hello", mentions: [{ is_you: true }] as any, mentionPatterns: [] }), true);
  assert.equal(service.resolveRequireMention({ cfg: {}, accountId: "default", groupOpenid: "GROUP" }), false);
  assert.equal(service.resolveGroupIntroHint({ cfg: {}, accountId: "default", groupOpenid: "GROUP" }), "intro hint");
  assert.equal(service.getConfigApi().loadConfig?.().ok, true);
  assert.deepEqual(service.getRouting?.(), { id: "route" });
  assert.equal(service.getLegacyApprovalHandler(), legacyHandler);
  assert.deepEqual(events, [
    "strip:1",
    "detect:hello",
    "require:default:GROUP",
    "intro:default:GROUP",
  ]);
}

{
  const sent: any[] = [];
  const service = createQQBotGatewayPlatformServices({
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET", config: {} } as any,
    cfg: { channel: true },
    getRuntime: () => ({}),
    sendTextToTarget: async (context: any, text: string) => {
      sent.push({ context, text });
    },
  });
  const sendTaskStatusText = service.createTaskStatusTextSender(() => ({ proactiveGuard: "guard" }));
  await sendTaskStatusText({
    target: { type: "group", groupOpenid: "GROUP" },
    text: "done",
    taskId: "task-1",
    audience: "peer",
  } as any);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "done");
  assert.equal(sent[0].context.account.appId, "APP");
  assert.equal(sent[0].context.prepareUnanchoredTextSend, "guard");
}

{
  const service = createQQBotGatewayPlatformServices({
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET", config: {} } as any,
    cfg: {},
    getRuntime: () => ({}),
    stripMentionText: () => undefined,
    plugin: {},
  });
  assert.equal(service.stripMentionText("fallback text", [] as any), "fallback text");
  assert.equal(service.resolveRequireMention({ cfg: {}, accountId: "default", groupOpenid: "GROUP" }), true);
  assert.equal(service.resolveGroupIntroHint({ cfg: {}, accountId: "default", groupOpenid: "GROUP" }), undefined);
}

console.log("custom gateway platform services gateway adapter tests passed");
