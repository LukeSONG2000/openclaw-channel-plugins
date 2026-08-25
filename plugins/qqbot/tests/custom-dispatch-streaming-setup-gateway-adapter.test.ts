import assert from "node:assert";
import {
  resolveStreamingTargetType,
  setupCustomDispatchStreamingGateway,
} from "../src/custom/dispatch-streaming-setup-gateway-adapter.js";
import type { StreamingControllerDeps } from "../src/streaming.js";

const account = {
  accountId: "default",
  appId: "APPID",
  clientSecret: "SECRET",
  enabled: true,
  config: { streaming: true },
} as any;

const c2cEvent = {
  type: "c2c",
  senderId: "USER_OPENID",
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-22T00:00:00.000Z",
} as any;

assert.equal(resolveStreamingTargetType({ type: "c2c" } as any), "c2c");
assert.equal(resolveStreamingTargetType({ type: "group" } as any), "group");
assert.equal(resolveStreamingTargetType({ type: "guild" } as any), "channel");
assert.equal(resolveStreamingTargetType({ type: "dm" } as any), "channel");

{
  const logs: string[] = [];
  let deps: StreamingControllerDeps | null = null;
  const controller = { id: "stream" };
  const result = setupCustomDispatchStreamingGateway({
    account,
    event: c2cEvent,
    replyAnchorId: "MSG_ID",
    log: {
      info: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    createController: (input) => {
      deps = input;
      return controller;
    },
  });

  assert.equal(result.targetType, "c2c");
  assert.equal(result.useStreaming, true);
  assert.equal(result.streamingController, controller);
  assert.equal(deps?.userId, "USER_OPENID");
  assert.equal(deps?.replyToMsgId, "MSG_ID");
  assert.equal(deps?.eventId, "MSG_ID");
  assert.equal(deps?.logPrefix, "[qqbot:default:streaming]");
  assert.equal(deps?.mediaContext?.event.type, "c2c");
  assert.equal(logs.some((line) => line.includes("Streaming enabled for c2c")), true);
  assert.equal(logs.some((line) => line.includes("Streaming mode enabled for c2c target")), true);
}

{
  let controllerCreated = false;
  const result = setupCustomDispatchStreamingGateway({
    account,
    event: { ...c2cEvent, _customUnreadSnapshotId: "snapshot-1" },
    replyAnchorId: undefined,
    createController: () => {
      controllerCreated = true;
      return {};
    },
  });

  assert.equal(result.useStreaming, true);
  assert.equal(result.streamingController, null);
  assert.equal(controllerCreated, false);
}

{
  let controllerCreated = false;
  const result = setupCustomDispatchStreamingGateway({
    account,
    event: {
      ...c2cEvent,
      type: "group",
      groupOpenid: "GROUP_OPENID",
    },
    replyAnchorId: "GROUP_MSG_ID",
    createController: () => {
      controllerCreated = true;
      return {};
    },
  });

  assert.equal(result.targetType, "group");
  assert.equal(result.useStreaming, false);
  assert.equal(result.streamingController, null);
  assert.equal(controllerCreated, false);
}

{
  const result = setupCustomDispatchStreamingGateway({
    account: {
      ...account,
      config: { streaming: false },
    },
    event: c2cEvent,
    replyAnchorId: "MSG_ID",
  });

  assert.equal(result.targetType, "c2c");
  assert.equal(result.useStreaming, false);
  assert.equal(result.streamingController, null);
}

console.log("custom dispatch streaming setup gateway adapter tests passed");
