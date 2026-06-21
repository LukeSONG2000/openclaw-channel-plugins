import assert from "node:assert";
import type { ResolvedQQBotAccount } from "../src/types.js";

const originalFetch = globalThis.fetch;
const messageCalls: Array<{ url: string; body: any }> = [];

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = init?.body ? JSON.parse(init.body as string) : {};
  if (url.includes("/getAppAccessToken")) {
    return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 7200 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/messages")) {
    messageCalls.push({ url, body });
    return new Response(JSON.stringify({ id: `msg-${messageCalls.length}`, timestamp: Date.now().toString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
};

const { clearTokenCache, setApiLogger } = await import("../src/api.js");
const { sendTextToTarget } = await import("../src/reply-dispatcher.js");
setApiLogger({ info: () => {}, error: () => {} });

const account: ResolvedQQBotAccount = {
  accountId: "default",
  enabled: true,
  appId: "APPID",
  clientSecret: "SECRET",
  secretSource: "config",
  markdownSupport: false,
  config: {},
};

try {
  clearTokenCache(account.appId);

  let guardCalls = 0;
  let commits = 0;
  const guardedCtx = {
    account,
    cfg: {},
    prepareUnanchoredTextSend: ({ targetType, targetId, text }: { targetType: "c2c" | "group"; targetId: string; text: string }) => {
      guardCalls++;
      if (text === "blocked") return { allowed: false as const, reason: "budget blocked" };
      assert.equal(targetType, "group");
      assert.equal(targetId, "GROUP_OPENID");
      return { allowed: true as const, commit: () => { commits++; } };
    },
  };

  await sendTextToTarget({
    ...guardedCtx,
    target: {
      type: "group",
      senderId: "MEMBER_OPENID",
      messageId: "msg-anchor",
      groupOpenid: "GROUP_OPENID",
    },
  }, "anchored");
  assert.equal(guardCalls, 0);
  assert.equal(commits, 0);
  assert.equal(messageCalls.length, 1);
  assert.equal(messageCalls[0]?.body.msg_id, "msg-anchor");

  await sendTextToTarget({
    ...guardedCtx,
    target: {
      type: "group",
      senderId: "MEMBER_OPENID",
      messageId: "",
      groupOpenid: "GROUP_OPENID",
    },
  }, "allowed");
  assert.equal(guardCalls, 1);
  assert.equal(commits, 1);
  assert.equal(messageCalls.length, 2);
  assert.equal(messageCalls[1]?.body.msg_id, undefined);

  await assert.rejects(
    () => sendTextToTarget({
      ...guardedCtx,
      target: {
        type: "group",
        senderId: "MEMBER_OPENID",
        messageId: "",
        groupOpenid: "GROUP_OPENID",
      },
    }, "blocked"),
    /budget blocked/,
  );
  assert.equal(guardCalls, 2);
  assert.equal(commits, 1);
  assert.equal(messageCalls.length, 2);

  let c2cTargetId = "";
  await sendTextToTarget({
    account,
    cfg: {},
    target: {
      type: "c2c",
      senderId: "USER_OPENID",
      messageId: "",
    },
    prepareUnanchoredTextSend: ({ targetType, targetId }) => {
      assert.equal(targetType, "c2c");
      c2cTargetId = targetId;
      return { allowed: true };
    },
  }, "c2c proactive");
  assert.equal(c2cTargetId, "USER_OPENID");
  assert.equal(messageCalls.length, 3);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("reply dispatcher proactive guard tests passed");
