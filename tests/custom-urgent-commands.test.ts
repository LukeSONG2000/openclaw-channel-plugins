import assert from "node:assert";
import {
  CUSTOM_URGENT_QUEUE_BYPASS_COMMANDS,
  isCustomUrgentQueueBypassCommand,
} from "../src/custom/urgent-commands.js";

assert.deepEqual(CUSTOM_URGENT_QUEUE_BYPASS_COMMANDS, [
  "/stop",
  "/approve",
  "/new",
  "/compact",
]);

assert.equal(isCustomUrgentQueueBypassCommand("/new"), true);
assert.equal(isCustomUrgentQueueBypassCommand(" /NEW  "), true);
assert.equal(isCustomUrgentQueueBypassCommand("/new reset session"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/compact"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/compact now"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/stop"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/approve abc"), true);

assert.equal(isCustomUrgentQueueBypassCommand("hello /new"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/newspaper"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/compaction"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/approved"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/bot-new"), false);
assert.equal(isCustomUrgentQueueBypassCommand(""), false);
assert.equal(isCustomUrgentQueueBypassCommand(undefined), false);

console.log("custom urgent command tests passed");
