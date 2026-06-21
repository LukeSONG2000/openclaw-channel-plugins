import assert from "node:assert";
import {
  CUSTOM_RESPONSE_TIMEOUT_MS,
  CUSTOM_TOOL_FALLBACK_MEDIA_TIMEOUT_MS,
  CUSTOM_TOOL_ONLY_MAX_RENEWALS,
  CUSTOM_TOOL_ONLY_TIMEOUT_MS,
  classifyCustomDispatchFailure,
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
assert.equal(classifyCustomDispatchFailure(new Error("other failure")), "other");

console.log("custom fallbacks tests passed");
