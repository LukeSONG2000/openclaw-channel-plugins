import assert from "node:assert/strict";
import { CustomAuthorizationRuntime } from "../src/custom/auth.js";
import { resolveCustomDispatchCapability } from "../src/custom/auth-gateway-adapter.js";
import { handleCustomScheduledTaskNaturalLanguage } from "../src/custom/scheduled-task-gateway-adapter.js";
import { CustomScheduledTaskRuntime } from "../src/custom/scheduled-task.js";
import type { QueuedMessage } from "../src/message-queue.js";

const cfg = { channels: { qqbot: { customRuntime: { enabled: true, admins: ["ADMIN"], adminGroup: "GROUP" } } } } as any;
for (const senderId of ["MEMBER", "ADMIN"]) {
  for (const content of ["如果是每小时137份，每份需要烘烤2小时，那么我得要配备多少台火炉跟请多少名员工？", "就好比你每天买四罐体力 第二天才能恢复50一罐", "每十分钟提醒我喝水", "[卡片消息] 每天定投100元买纳斯达克会怎么样"]) {
    const message: QueuedMessage = { type: "group", groupOpenid: "GROUP", senderId, content, messageId: "msg", timestamp: "2026-10-10T06:00:00Z" };
    const scheduledTasks = new CustomScheduledTaskRuntime();
    const auth = new CustomAuthorizationRuntime();
    const result = await handleCustomScheduledTaskNaturalLanguage({
      cfg, account: { accountId: "default" } as any, auth, scheduledTasks, message, content,
      persistAuthState: () => { throw new Error("must not persist authorization"); },
      persistScheduledTaskState: () => { throw new Error("must not persist tasks"); },
      notifyAdminGroup: async () => { throw new Error("must not notify admins"); },
    });
    assert.deepEqual(result, { handled: false });
    assert.deepEqual(scheduledTasks.getState().tasks, {});
    assert.deepEqual(auth.getState().requests, {});
    assert.equal(resolveCustomDispatchCapability({ cfg, message, rawContent: content }), "chat.send");
    assert.equal(resolveCustomDispatchCapability({ cfg, message: { ...message, type: "c2c" }, rawContent: "每十分钟提醒我喝水" }), "schedule.run");
  }
}
console.log("custom scheduled task gateway adapter tests passed");
