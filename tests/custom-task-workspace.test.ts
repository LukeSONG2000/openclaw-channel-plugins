import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendCustomTaskRequirement,
  materializeCustomTaskWorkspace,
  resolveWorkspacePath,
  writeCustomTaskStatus,
} from "../src/custom/task-workspace.js";
import type { CustomSandboxTask, CustomTaskRequirement } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-task-workspace-"));
try {
  const workspace = path.join(tmpDir, "task-1");
  const task: CustomSandboxTask = {
    id: "task-1",
    accountId: "default",
    peer: { kind: "group", id: "GROUP_OPENID" },
    owner: { id: "MEMBER_OPENID", label: "Member" },
    title: "Workspace task",
    prompt: "Build workspace files",
    status: "queued",
    workspace,
    createdAt: 1_000,
    updatedAt: 1_000,
    requirements: [],
  };

  materializeCustomTaskWorkspace(task, { now: 2_000 });
  assert.equal(fs.existsSync(path.join(workspace, "TASK.md")), true);
  assert.equal(fs.existsSync(path.join(workspace, "status.json")), true);
  assert.equal(fs.existsSync(path.join(workspace, "requirements.jsonl")), true);
  assert.match(fs.readFileSync(path.join(workspace, "TASK.md"), "utf8"), /Build workspace files/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "status.json"), "utf8")).savedAt, 2_000);

  const requirement: CustomTaskRequirement = {
    id: "task-1-req-1",
    actor: { id: "ADMIN_OPENID", label: "Admin" },
    content: "Add status persistence",
    createdAt: 3_000,
  };
  task.requirements.push(requirement);
  task.updatedAt = 3_000;
  appendCustomTaskRequirement(task, requirement, { now: 3_500 });
  const requirements = fs.readFileSync(path.join(workspace, "requirements.jsonl"), "utf8").trim().split("\n");
  assert.equal(requirements.length, 1);
  assert.equal(JSON.parse(requirements[0]!).content, "Add status persistence");

  task.status = "running";
  task.execution = { executorId: "executor", startedAt: 4_000 };
  task.progress = { phase: "coding", message: "写入状态文件", percent: 50, updatedAt: 4_250 };
  writeCustomTaskStatus(task, { now: 4_500 });
  const status = JSON.parse(fs.readFileSync(path.join(workspace, "status.json"), "utf8"));
  assert.equal(status.status, "running");
  assert.equal(status.execution.executorId, "executor");
  assert.equal(status.progress.message, "写入状态文件");

  assert.equal(resolveWorkspacePath("/tmp/x"), "/tmp/x");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom task workspace tests passed");
