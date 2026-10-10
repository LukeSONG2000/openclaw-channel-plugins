import assert from "node:assert/strict";
import { checkCustomGroupScheduledTaskToolCall, registerCustomGroupScheduledTaskPolicy } from "../src/custom/group-scheduled-task-policy.js";
import { runWithRequestContext } from "../src/request-context.js";

for (const toolName of ["cron", "qqbot_remind"]) {
  for (const sessionKey of ["agent:main:qqbot:group:GROUP:qqctx:1", "agent:main:qqbot:default:group:GROUP:mention:msg"]) {
    assert.equal(checkCustomGroupScheduledTaskToolCall({ toolName, params: { action: "add" } }, { sessionKey })?.block, true);
    for (const action of ["list", "remove", "run", "update"]) {
      assert.equal(checkCustomGroupScheduledTaskToolCall({ toolName, params: { action } }, { sessionKey }), undefined);
    }
  }
  for (const sessionKey of ["agent:main:qqbot:c2c:USER", "agent:main:ddingtalk:group:GROUP", "agent:main:feishu:group:GROUP", "agent:main:cron:JOB:run:RUN"]) {
    assert.equal(checkCustomGroupScheduledTaskToolCall({ toolName, params: { action: "add", job: { delivery: { channel: "qqbot", to: "qqbot:group:GROUP" } } } }, { sessionKey }, "qqbot:group:STALE"), undefined);
  }
}
assert.equal(checkCustomGroupScheduledTaskToolCall({ toolName: "web_search", params: { action: "add" } }, { sessionKey: "agent:main:qqbot:group:GROUP" }), undefined);
runWithRequestContext({ target: "qqbot:group:GROUP" }, () => {
  assert.equal(checkCustomGroupScheduledTaskToolCall({ toolName: "cron", params: { action: "add" } }, {})?.block, true);
});
const handlers = new Map<string, (event: any, context: any) => any>();
registerCustomGroupScheduledTaskPolicy({ on: (name, handler) => { handlers.set(name, handler); } });
assert.equal(handlers.get("before_tool_call")?.({ toolName: "cron", params: { action: "add" } }, { sessionKey: "agent:main:qqbot:group:GROUP" })?.block, true);
console.log("custom group scheduled task policy tests passed");
