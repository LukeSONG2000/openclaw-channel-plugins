import assert from "node:assert/strict";
import { resolveCustomScheduledTaskCreateWithModel } from "../src/custom/scheduled-task-llm-parser.js";

const calls: unknown[] = [];
const parsed = await resolveCustomScheduledTaskCreateWithModel({
  cfg: {} as any,
  rawContent: "每隔一分钟发：玩大乱斗给@Stardust",
  targetActors: [{ id: "MEMBER_1", label: "Stardust" }],
  complete: async (params) => {
    calls.push(params);
    return { text: JSON.stringify({ ok: true, intervalMs: 60000, durationMs: null, messageText: "玩大乱斗", actionKind: "message" }) };
  },
});
assert.equal(parsed.handled, true);
assert.equal(parsed.parsed?.intervalMs, 60_000);
assert.equal(parsed.parsed?.prompt, "玩大乱斗");
assert.equal(parsed.parsed?.targetActors[0]?.id, "MEMBER_1");
assert.equal(parsed.parsed?.actionKind, "message");
assert.equal((calls[0] as any).purpose, "qqbot.scheduled_task.parse");
assert.match((calls[0] as any).messages[0].content, /不要把调度词复制进 messageText/);

const cleaned = await resolveCustomScheduledTaskCreateWithModel({
  cfg: {} as any,
  rawContent: "每隔半小时问他醒了没",
  targetActors: [],
  complete: async () => ({ text: '{"ok":true,"intervalMs":1800000,"durationMs":null,"messageText":"问他：你醒了没","actionKind":"message"}' }),
});
assert.equal(cleaned.parsed?.prompt, "你醒了没");

console.log("custom scheduled task llm parser tests passed");
