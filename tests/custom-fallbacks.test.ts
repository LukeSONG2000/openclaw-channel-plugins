import assert from "node:assert";
import {
  CUSTOM_RESPONSE_TIMEOUT_MS,
  CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS,
  CUSTOM_TOOL_ONLY_MAX_RENEWALS,
  CUSTOM_TOOL_ONLY_TIMEOUT_MS,
  buildCustomFallbackEvent,
  classifyCustomDispatchFailure,
  formatCustomFallbackEventLog,
  formatCustomContextTooLongNotice,
  formatCustomResponseTimeoutNotice,
  formatCustomToolNoOutputNotice,
  isCustomModelSkipOutput,
  selectCustomToolFallbackText,
} from "../src/custom/fallbacks.js";

assert.equal(CUSTOM_RESPONSE_TIMEOUT_MS, 300_000);
assert.equal(CUSTOM_TOOL_ONLY_TIMEOUT_MS, 90_000);
assert.equal(CUSTOM_TOOL_ONLY_MAX_RENEWALS, 3);
assert.equal(CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS, 45_000);

assert.equal(isCustomModelSkipOutput("NO_REPLY"), true);
assert.equal(isCustomModelSkipOutput(" [SKIP]\n"), true);
assert.equal(isCustomModelSkipOutput("NO_REPLY please"), false);
assert.equal(isCustomModelSkipOutput(""), false);
assert.equal(isCustomModelSkipOutput(undefined), false);

assert.equal(formatCustomResponseTimeoutNotice(), "这轮处理超时了，我先不挡队列，后面的消息会继续处理。");
assert.equal(formatCustomToolNoOutputNotice(), "工具这轮没产出能发的内容，我先不挡队列，后面的消息会继续处理。");
assert.match(formatCustomContextTooLongNotice(), /\/compact/);
assert.match(formatCustomContextTooLongNotice(), /\/new/);

assert.equal(selectCustomToolFallbackText([]), null);
assert.equal(selectCustomToolFallbackText(["  ", "\n"]), null);
assert.equal(
  selectCustomToolFallbackText(["one", "two", "three", "four"]),
  "two\n---\nthree\n---\nfour",
);
assert.equal(
  selectCustomToolFallbackText([" one ", "two", "three"], { maxItems: 2, separator: "\n" }),
  "two\nthree",
);
assert.equal(selectCustomToolFallbackText(["abcdef"], { maxChars: 3 }), "abc");
assert.equal(selectCustomToolFallbackText(["a", "b"], { maxItems: 0, maxChars: 0 }), "b");

assert.equal(classifyCustomDispatchFailure(new Error("Response timeout")), "response-timeout");
assert.equal(classifyCustomDispatchFailure("Response timeout after 300s"), "response-timeout");
assert.equal(classifyCustomDispatchFailure(new Error("context_length_exceeded")), "context-too-long");
assert.equal(classifyCustomDispatchFailure("maximum context length is 128000 tokens"), "context-too-long");
assert.equal(classifyCustomDispatchFailure("too many tokens in prompt"), "context-too-long");
assert.equal(classifyCustomDispatchFailure("上下文过长，无法继续"), "context-too-long");
assert.equal(classifyCustomDispatchFailure({ message: "input is too long", code: "bad_request" }), "context-too-long");
assert.equal(classifyCustomDispatchFailure({ message: "provider failed", cause: new Error("prompt exceeds token limit") }), "context-too-long");
assert.equal(classifyCustomDispatchFailure(new Error("other failure")), "other");
assert.equal(classifyCustomDispatchFailure(new Error("rate limit exceeded")), "other");
assert.equal(classifyCustomDispatchFailure(new Error("auth token expired")), "other");

const fallbackEvent = buildCustomFallbackEvent({
  kind: "response-timeout",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: undefined },
  sessionKey: "agent:main:qqbot:default:group:group_openid",
  runId: "MSG_ID",
  messageId: "MSG_ID",
  reason: "Response timeout",
  at: 1234,
  timeoutMs: CUSTOM_RESPONSE_TIMEOUT_MS,
  hasResponse: undefined,
  toolDeliverCount: 2,
  toolTextCount: 1,
  toolMediaCount: 0,
  hasBlockResponse: false,
  details: {
    textChars: 10,
    ignored: undefined,
  },
});
assert.equal(fallbackEvent.type, "custom-fallback");
assert.equal(fallbackEvent.kind, "response-timeout");
assert.equal(fallbackEvent.at, 1234);
assert.equal(fallbackEvent.peer?.id, "GROUP_OPENID");
assert.equal("hasResponse" in fallbackEvent, false);
assert.equal("ignored" in (fallbackEvent.details ?? {}), false);
assert.deepEqual(fallbackEvent.details, { textChars: 10 });

const eventLog = formatCustomFallbackEventLog(fallbackEvent);
assert.equal(eventLog.startsWith("custom fallback event: "), true);
assert.deepEqual(
  JSON.parse(eventLog.slice("custom fallback event: ".length)),
  fallbackEvent,
);

console.log("custom fallbacks tests passed");
