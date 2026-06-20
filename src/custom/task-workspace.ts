import fs from "node:fs";
import path from "node:path";
import { getHomeDir } from "../utils/platform.js";
import type { CustomSandboxTask, CustomTaskRequirement } from "./types.js";

export interface CustomTaskWorkspaceOptions {
  now?: number;
}

export function materializeCustomTaskWorkspace(
  task: CustomSandboxTask,
  options?: CustomTaskWorkspaceOptions,
): void {
  const workspace = resolveWorkspacePath(task.workspace);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "TASK.md"), renderTaskMarkdown(task), "utf8");
  fs.writeFileSync(path.join(workspace, "status.json"), `${JSON.stringify(taskStatusDocument(task, options), null, 2)}\n`, "utf8");
  const requirementsPath = path.join(workspace, "requirements.jsonl");
  if (!fs.existsSync(requirementsPath)) fs.writeFileSync(requirementsPath, "", "utf8");
}

export function appendCustomTaskRequirement(
  task: CustomSandboxTask,
  requirement: CustomTaskRequirement,
  options?: CustomTaskWorkspaceOptions,
): void {
  materializeCustomTaskWorkspace(task, options);
  fs.appendFileSync(
    path.join(resolveWorkspacePath(task.workspace), "requirements.jsonl"),
    `${JSON.stringify(requirement)}\n`,
    "utf8",
  );
  writeCustomTaskStatus(task, options);
}

export function writeCustomTaskStatus(
  task: CustomSandboxTask,
  options?: CustomTaskWorkspaceOptions,
): void {
  const workspace = resolveWorkspacePath(task.workspace);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "status.json"), `${JSON.stringify(taskStatusDocument(task, options), null, 2)}\n`, "utf8");
}

export function resolveWorkspacePath(workspace: string): string {
  if (workspace === "~") return getHomeDir();
  if (workspace.startsWith("~/")) return path.join(getHomeDir(), workspace.slice(2));
  return workspace;
}

function renderTaskMarkdown(task: CustomSandboxTask): string {
  return [
    `# ${task.title}`,
    "",
    `- Task: ${task.id}`,
    `- Status: ${task.status}`,
    `- Account: ${task.accountId}`,
    `- Peer: ${task.peer.kind}:${task.peer.id}`,
    `- Owner: ${task.owner.label || task.owner.id}`,
    `- Created: ${new Date(task.createdAt).toISOString()}`,
    "",
    "## Prompt",
    "",
    task.prompt,
    "",
    "## Requirements",
    "",
    task.requirements.length
      ? task.requirements.map((item) => `- ${new Date(item.createdAt).toISOString()} ${item.actor.label || item.actor.id}: ${item.content}`).join("\n")
      : "- None yet",
    "",
  ].join("\n");
}

function taskStatusDocument(task: CustomSandboxTask, options?: CustomTaskWorkspaceOptions): Record<string, unknown> {
  return {
    savedAt: options?.now ?? Date.now(),
    id: task.id,
    status: task.status,
    accountId: task.accountId,
    peer: task.peer,
    owner: task.owner,
    workspace: task.workspace,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    execution: task.execution,
    requirements: task.requirements,
    result: task.result,
    error: task.error,
  };
}
