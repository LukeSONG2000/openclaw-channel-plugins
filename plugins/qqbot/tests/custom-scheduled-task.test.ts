import assert from "node:assert/strict";
import {
  CustomScheduledTaskRuntime,
  parseCustomScheduledTaskCancelIntent,
  parseCustomScheduledTaskIntent,
  parseScheduledDurationMs,
  parseScheduledIntervalMs,
} from "../src/custom/scheduled-task.js";

assert.equal(parseScheduledIntervalMs("每隔半个小时问他醒了没"), 30 * 60_000);
assert.equal(parseScheduledIntervalMs("每隔2小时执行一次"), 2 * 60 * 60_000);
assert.equal(parseScheduledIntervalMs("每十分钟提醒"), 10 * 60_000);
assert.equal(parseScheduledIntervalMs("每30秒提醒"), null);

const parsed = parseCustomScheduledTaskIntent("每隔半个小时 @张三 问他醒了没", {
  mentions: [{ member_openid: "MEMBER_1", username: "张三" }],
});
assert.ok(parsed);
assert.equal(parsed.intervalMs, 30 * 60_000);
assert.equal(parsed.prompt, "问他醒了没");
assert.equal(parsed.targetActors[0]?.id, "MEMBER_1");
assert.equal(parsed.requiredCapabilities.includes("schedule.run"), true);
assert.equal(parsed.requiredCapabilities.includes("proactive.send"), true);
assert.equal(parsed.actionKind, "message");

const gameParsed = parseCustomScheduledTaskIntent("每一分钟 @树 说：玩大乱斗，持续五分钟", {
  mentions: [{ member_openid: "TREE", username: "树" }],
});
assert.ok(gameParsed);
assert.equal(gameParsed.intervalMs, 60_000);
assert.equal(gameParsed.durationMs, 5 * 60_000);
assert.equal(gameParsed.prompt, "玩大乱斗");
assert.equal(gameParsed.targetActors[0]?.id, "TREE");
assert.equal(parseScheduledDurationMs("每一分钟说喝水，持续五分钟"), 5 * 60_000);
assert.equal(parseCustomScheduledTaskCancelIntent("取消刚刚的定时任务"), "");
assert.equal(parseCustomScheduledTaskCancelIntent("停止任务 sched-default-group-GROUP-1000-1"), "sched-default-group-GROUP-1000-1");

const toolParsed = parseCustomScheduledTaskIntent("每隔1小时 查询服务器日志", {});
assert.ok(toolParsed);
assert.equal(toolParsed.actionKind, "agent");
assert.equal(toolParsed.requiredCapabilities.includes("config.read"), true);

const runtime = new CustomScheduledTaskRuntime();
const created = runtime.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP" },
  creator: { id: "USER" },
  intervalMs: 60_000,
  prompt: "提醒喝水",
  now: 1000,
});
assert.equal(created.allowed, true);
assert.equal(created.task?.status, "pending_auth");
runtime.activateTask({ taskId: created.task!.id, now: 1000 });
assert.equal(runtime.listDueTasks({ now: 60_999 }).length, 0);
assert.equal(runtime.listDueTasks({ now: 61_000 }).length, 1);
runtime.markFired({ taskId: created.task!.id, now: 61_000 });
assert.equal(runtime.getTask(created.task!.id)?.nextDueAt, 121_000);

const expiring = runtime.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP" },
  creator: { id: "USER" },
  intervalMs: 60_000,
  durationMs: 2 * 60_000,
  prompt: "玩大乱斗",
  now: 2000,
});
runtime.activateTask({ taskId: expiring.task!.id, now: 2000 });
runtime.markFired({ taskId: expiring.task!.id, now: 122_000 });
assert.equal(runtime.getTask(expiring.task!.id)?.status, "cancelled");
assert.equal(runtime.listTasks({ peer: { kind: "group", id: "GROUP" }, creator: { id: "USER" }, status: "open" }).length, 1);

console.log("custom scheduled task tests passed");
