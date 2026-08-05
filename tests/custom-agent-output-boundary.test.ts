import assert from "node:assert";
import {
  captureCustomAgentFinalOutput,
  consumeCustomAgentFinalOutput,
  peekCustomAgentFinalOutput,
  registerCustomAgentOutputBoundary,
  resetCustomAgentOutputBoundaryForTests,
} from "../src/custom/agent-output-boundary.js";

resetCustomAgentOutputBoundaryForTests();

const silent = captureCustomAgentFinalOutput({
  runId: "run-silent",
  assistantTexts: [
    "Luke发了张TapTap服务号的截图。这是轮询未读消化，我可以顺着接一句。\n\nNO_REPLY",
  ],
});
assert.equal(silent?.silent, true);
assert.equal(peekCustomAgentFinalOutput("run-silent")?.silent, true);
assert.equal(consumeCustomAgentFinalOutput("run-silent")?.silent, true);
assert.equal(peekCustomAgentFinalOutput("run-silent"), undefined);

const visible = captureCustomAgentFinalOutput({
  runId: "run-visible",
  assistantTexts: ["TapTap这提醒比游戏本体还勤快。"],
});
assert.equal(visible?.silent, false);

const nativeThinking = captureCustomAgentFinalOutput({
  runId: "run-blocks",
  lastAssistant: {
    content: [
      { type: "thinking", thinking: "I should not expose this." },
      { type: "text", text: "最终正文" },
    ],
  },
});
assert.equal(nativeThinking?.hasThinkingBlocks, true);
assert.equal(nativeThinking?.finalText, "最终正文");
assert.equal(nativeThinking?.silent, false);

resetCustomAgentOutputBoundaryForTests();
const handlers = new Map<string, (event: any) => any>();
registerCustomAgentOutputBoundary({
  on: (name, handler) => {
    handlers.set(name, handler);
  },
});

handlers.get("llm_output")?.({
  runId: "run-hook",
  assistantTexts: ["内部判断写在这里\n\nNO_REPLY"],
});

const qqResult = handlers.get("reply_payload_sending")?.({
  runId: "run-hook",
  channel: "qqbot",
  kind: "final",
  payload: { text: "内部判断写在这里" },
});
assert.deepEqual(qqResult?.payload, { text: "NO_REPLY" });
assert.equal(qqResult?.cancel, undefined);

const otherResult = handlers.get("reply_payload_sending")?.({
  runId: "run-hook",
  channel: "dingtalk",
  kind: "final",
  payload: { text: "内部判断写在这里" },
});
assert.equal(otherResult?.cancel, true);

const reasoningResult = handlers.get("reply_payload_sending")?.({
  runId: "run-thinking",
  channel: "qqbot",
  kind: "block",
  payload: { text: "private reasoning", isReasoning: true },
});
assert.equal(reasoningResult?.cancel, true);

console.log("custom agent output boundary tests passed");
