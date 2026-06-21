import assert from "node:assert";
import type { ReplyContext } from "../src/reply-dispatcher.js";
import {
  buildCustomDispatchSendHelpers,
} from "../src/custom/dispatch-send-helpers-gateway-adapter.js";

const account = {
  accountId: "default",
  appId: "APPID",
  clientSecret: "SECRET",
} as any;

const replyContext: ReplyContext = {
  target: {
    type: "group",
    senderId: "MEMBER_OPENID",
    messageId: "MSG_ID",
    groupOpenid: "GROUP_OPENID",
  },
  account,
  cfg: { marker: true },
};

let retryArgs: unknown[] = [];
let tokenSeen = "";
let errorTargetText = "";
const helpers = buildCustomDispatchSendHelpers({
  account,
  replyContext,
  log: { info: () => {}, error: () => {} },
  sendWithTokenRetry: async <T>(
    appId: string,
    clientSecret: string,
    sendFn: (token: string) => Promise<T>,
    log,
    accountId?: string,
  ): Promise<T> => {
    retryArgs = [appId, clientSecret, Boolean(log), accountId];
    return sendFn("ACCESS_TOKEN");
  },
  sendErrorToTarget: async (ctx, text) => {
    assert.equal(ctx, replyContext);
    errorTargetText = text;
  },
});

const retryResult = await helpers.sendWithRetry(async (token) => {
  tokenSeen = token;
  return "sent";
});
assert.equal(retryResult, "sent");
assert.equal(tokenSeen, "ACCESS_TOKEN");
assert.deepEqual(retryArgs, ["APPID", "SECRET", true, "default"]);

await helpers.sendErrorMessage("error text");
assert.equal(errorTargetText, "error text");

console.log("custom dispatch send helpers gateway adapter tests passed");
