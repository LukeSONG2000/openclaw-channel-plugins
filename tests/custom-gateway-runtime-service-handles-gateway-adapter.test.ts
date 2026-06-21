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
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: false, hasUnreadScheduler: false });
  assert.equal(handles.getTaskExecutor(), null);
  assert.equal(handles.getTaskExecutorOrUndefined(), undefined);
  assert.equal(handles.getUnreadScheduler(), null);

  const task = disposable("task", events);
  const unread = disposable("unread", events);
  handles.setTaskExecutor(task);
  handles.setUnreadScheduler(unread);

  assert.equal(handles.getTaskExecutor(), task);
  assert.equal(handles.getTaskExecutorOrUndefined(), task);
  assert.equal(handles.getUnreadScheduler(), unread);
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: true, hasUnreadScheduler: true });

  handles.dispose();
  assert.deepEqual(events, ["dispose:unread", "dispose:task"]);
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: false, hasUnreadScheduler: false });
  assert.equal(handles.getTaskExecutor(), null);
  assert.equal(handles.getTaskExecutorOrUndefined(), undefined);
  assert.equal(handles.getUnreadScheduler(), null);

  handles.dispose();
  assert.deepEqual(events, ["dispose:unread", "dispose:task"]);
}

{
  const events: string[] = [];
  const handles = createQQBotGatewayRuntimeServiceHandles();
  handles.setUnreadScheduler(disposable("unread", events, true));
  handles.setTaskExecutor(disposable("task", events, true));

  assert.throws(() => handles.dispose(), /failed:unread/);
  assert.deepEqual(events, ["dispose:unread", "dispose:task"]);
  assert.deepEqual(handles.snapshot(), { hasTaskExecutor: false, hasUnreadScheduler: false });
}

console.log("custom gateway runtime service handles gateway adapter tests passed");
