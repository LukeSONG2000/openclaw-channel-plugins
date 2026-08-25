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
const { sendCronMessage, sendProactiveMessage, sendText } = await import("../src/outbound.js");
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
  const guard = ({ targetType, targetId, text }: { targetType: "c2c" | "group"; targetId: string; text: string }) => {
    guardCalls++;
    assert.equal(targetType, "group");
    assert.equal(targetId, "GROUP_OPENID");
    if (text.includes("blocked")) return { allowed: false as const, reason: "budget blocked" };
    return { allowed: true as const, commit: () => { commits++; } };
  };

  const blocked = await sendText({
    to: "qqbot:group:GROUP_OPENID",
    text: "blocked outbound",
    account,
    prepareUnanchoredSend: guard,
  });
  assert.equal(blocked.error, "budget blocked");
  assert.equal(messageCalls.length, 0);
  assert.equal(guardCalls, 1);
  assert.equal(commits, 0);

  const allowed = await sendText({
    to: "qqbot:group:GROUP_OPENID",
    text: "allowed outbound",
    account,
    prepareUnanchoredSend: guard,
  });
  assert.equal(allowed.error, undefined);
  assert.equal(messageCalls.length, 1);
  assert.equal(messageCalls[0]?.body.content, "allowed outbound");
  assert.equal(commits, 1);

  const passive = await sendText({
    to: "qqbot:group:GROUP_OPENID",
    text: "blocked but passive",
    replyToId: "msg-anchor",
    account,
    prepareUnanchoredSend: guard,
  });
  assert.equal(passive.error, undefined);
  assert.equal(messageCalls.length, 2);
  assert.equal(messageCalls[1]?.body.msg_id, "msg-anchor");
  assert.equal(guardCalls, 2);
  assert.equal(commits, 1);

  const proactiveBlocked = await sendProactiveMessage(account, "qqbot:group:GROUP_OPENID", "blocked proactive", {
    prepareUnanchoredSend: guard,
  });
  assert.equal(proactiveBlocked.error, "budget blocked");
  assert.equal(messageCalls.length, 2);

  const cronAllowed = await sendCronMessage(account, "qqbot:group:GROUP_OPENID", "allowed cron", {
    prepareUnanchoredSend: guard,
  });
  assert.equal(cronAllowed.error, undefined);
  assert.equal(messageCalls.length, 3);
  assert.equal(messageCalls[2]?.body.content, "allowed cron");
  assert.equal(commits, 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("outbound proactive guard tests passed");
