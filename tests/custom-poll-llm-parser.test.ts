import assert from "node:assert/strict";
import {
  extractPollRequestText,
  isCustomPollCreateNeedingModel,
  resolveCustomPollCreateWithModel,
} from "../src/custom/poll-llm-parser.js";

assert.equal(isCustomPollCreateNeedingModel("/bot-poll list"), false);
assert.equal(isCustomPollCreateNeedingModel("/bot-poll status poll-1"), false);
assert.equal(isCustomPollCreateNeedingModel("/bot-poll 晚上吃什么，肯德基还是麦当劳"), true);
assert.equal(extractPollRequestText("/bot-poll create 晚上吃什么，肯德基还是麦当劳"), "晚上吃什么，肯德基还是麦当劳");
assert.equal(extractPollRequestText("/bot-poll 晚上吃什么，肯德基还是麦当劳"), "晚上吃什么，肯德基还是麦当劳");

const parsed = await resolveCustomPollCreateWithModel({
  cfg: { agents: { list: [{ id: "main" }] } } as any,
  rawContent: "/bot-poll 帮我问一下晚上吃什么，肯德基还是麦当劳，多选，匿名，半小时",
  complete: async (params) => {
    assert.equal(params.purpose, "qqbot.poll.parse");
    assert.equal(params.agentId, undefined);
    assert.equal(params.messages[1]?.content.includes("晚上吃什么"), true);
    return { text: JSON.stringify({ ok: true, question: "晚上吃什么", options: ["肯德基", "麦当劳"], multiple: true, anonymous: true, durationMs: 1_800_000 }) };
  },
});
assert.equal(parsed.handled, true);
assert.equal(parsed.content?.startsWith("/bot-poll __create "), true);

const missing = await resolveCustomPollCreateWithModel({
  cfg: {} as any,
  rawContent: "/bot-poll 晚上吃什么",
  complete: async () => ({ text: '{"ok":false,"missing":["options"],"question":"晚上吃什么","options":[]}' }),
});
assert.equal(missing.handled, true);
assert.equal(missing.reply?.includes("至少提供标题和 2 个选项"), true);

console.log("custom poll llm parser tests passed");
