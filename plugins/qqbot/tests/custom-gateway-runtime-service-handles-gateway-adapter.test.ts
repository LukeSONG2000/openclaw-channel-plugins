import assert from "node:assert";
import { createQQBotGatewayRuntimeServiceHandles } from "../src/custom/gateway-runtime-service-handles-gateway-adapter.js";

function disposable(id: string, events: string[], fail = false) {
  return {
    id,
    dispose: () => {
      events.push(`dispose:${id}`);
      if (fail) throw new Error(`failed:${id}`);
    },
  } as any;
}

{
  const events: string[] = [];
  const handles = createQQBotGatewayRuntimeServiceHandles();
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: false, hasUnreadScheduler: false, hasPollExpirationScheduler: false, hasScheduledTaskScheduler: false });
  assert.equal(handles.getTaskExecutor(), null);
  assert.equal(handles.getTaskExecutorOrUndefined(), undefined);
  assert.equal(handles.getUnreadScheduler(), null);
  assert.equal(handles.getPollExpirationScheduler(), null);
  assert.equal(handles.getScheduledTaskScheduler(), null);

  const task = disposable("task", events);
  const unread = disposable("unread", events);
  const poll = disposable("poll", events);
  const scheduled = disposable("scheduled", events);
  handles.setTaskExecutor(task);
  handles.setUnreadScheduler(unread);
  handles.setPollExpirationScheduler(poll);
  handles.setScheduledTaskScheduler(scheduled);

  assert.equal(handles.getTaskExecutor(), task);
  assert.equal(handles.getTaskExecutorOrUndefined(), task);
  assert.equal(handles.getUnreadScheduler(), unread);
  assert.equal(handles.getPollExpirationScheduler(), poll);
  assert.equal(handles.getScheduledTaskScheduler(), scheduled);
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: true, hasUnreadScheduler: true, hasPollExpirationScheduler: true, hasScheduledTaskScheduler: true });

  handles.dispose();
  assert.deepEqual(events, ["dispose:scheduled", "dispose:poll", "dispose:unread", "dispose:task"]);
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: false, hasUnreadScheduler: false, hasPollExpirationScheduler: false, hasScheduledTaskScheduler: false });
  assert.equal(handles.getTaskExecutor(), null);
  assert.equal(handles.getTaskExecutorOrUndefined(), undefined);
  assert.equal(handles.getUnreadScheduler(), null);
  assert.equal(handles.getPollExpirationScheduler(), null);
  assert.equal(handles.getScheduledTaskScheduler(), null);

  handles.dispose();
  assert.deepEqual(events, ["dispose:scheduled", "dispose:poll", "dispose:unread", "dispose:task"]);
}

{
  const events: string[] = [];
  const handles = createQQBotGatewayRuntimeServiceHandles();
  handles.setUnreadScheduler(disposable("unread", events, true));
  handles.setTaskExecutor(disposable("task", events, true));
  handles.setPollExpirationScheduler(disposable("poll", events, true));

  assert.throws(() => handles.dispose(), /failed:poll/);
  assert.deepEqual(events, ["dispose:poll", "dispose:unread", "dispose:task"]);
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: false, hasUnreadScheduler: false, hasPollExpirationScheduler: false, hasScheduledTaskScheduler: false });
}

console.log("custom gateway runtime service handles gateway adapter tests passed");
