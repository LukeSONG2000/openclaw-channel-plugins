import assert from "node:assert";
import { evaluateCustomTaskPeerAccess, formatCustomTaskOutOfScope } from "../src/custom/task-access.js";
import type { CustomSandboxTask } from "../src/custom/types.js";

const task: CustomSandboxTask = {
  id: "task-1",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  owner: { id: "OWNER_OPENID", label: "Owner" },
  title: "Task",
  prompt: "Prompt",
  status: "queued",
  workspace: "/tmp/task-1",
  createdAt: 1_000,
  updatedAt: 1_000,
  requirements: [],
};

const samePeerMember = evaluateCustomTaskPeerAccess({
  task,
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID" },
  operation: "mutate",
});
assert.equal(samePeerMember.allowed, true);
assert.equal(samePeerMember.reason, "same-peer");
assert.equal(samePeerMember.isOwner, false);

const ownerAcrossPeer = evaluateCustomTaskPeerAccess({
  task,
  accountId: "default",
  peer: { kind: "c2c", id: "OWNER_OPENID" },
  actor: { id: "owner_openid" },
  operation: "read",
});
assert.equal(ownerAcrossPeer.allowed, true);
assert.equal(ownerAcrossPeer.reason, "owner");
assert.equal(ownerAcrossPeer.isOwner, true);

const crossPeerMember = evaluateCustomTaskPeerAccess({
  task,
  accountId: "default",
  peer: { kind: "group", id: "OTHER_GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID" },
  operation: "mutate",
});
assert.equal(crossPeerMember.allowed, false);
assert.equal(crossPeerMember.reason, "cross-peer");

const accountMismatch = evaluateCustomTaskPeerAccess({
  task,
  accountId: "other",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID" },
  operation: "read",
});
assert.equal(accountMismatch.allowed, false);
assert.equal(accountMismatch.reason, "account-mismatch");

assert.equal(formatCustomTaskOutOfScope("task-1"), "⚠️ 未找到任务，或该任务不属于当前会话：task-1");

console.log("custom task access tests passed");
