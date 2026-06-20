import path from "node:path";
import type {
  CustomActor,
  CustomPeer,
  CustomSandboxTask,
  CustomTaskRequirement,
  CustomTaskSandboxRuntimeState,
  CustomTaskStatus,
} from "./types.js";

export interface CustomTaskSandboxConfig {
  workspaceRoot?: string;
  maxActiveTasksPerPeer?: number;
}

export interface CustomCreateTaskParams {
  accountId: string;
  peer: CustomPeer;
  actor: CustomActor;
  prompt: string;
  title?: string;
  now?: number;
}

export interface CustomTaskSandboxDecision {
  allowed: boolean;
  reason: "allowed" | "empty_prompt" | "too_many_active_tasks" | "not_found" | "not_active";
  task?: CustomSandboxTask;
}

const DEFAULT_MAX_ACTIVE_TASKS_PER_PEER = 3;
const DEFAULT_WORKSPACE_ROOT = "~/.openclaw/qqbot/tasks";

export class CustomTaskSandboxRuntime {
  private readonly tasks = new Map<string, CustomSandboxTask>();
  private seq = 0;

  constructor(private readonly config: CustomTaskSandboxConfig = {}) {}

  createTask(params: CustomCreateTaskParams): CustomTaskSandboxDecision {
    const prompt = params.prompt.trim();
    const now = params.now ?? Date.now();
    if (!prompt) return { allowed: false, reason: "empty_prompt" };
    if (this.countActiveForPeer(params.accountId, params.peer) >= this.maxActiveTasksPerPeer()) {
      return { allowed: false, reason: "too_many_active_tasks" };
    }

    const id = this.nextTaskId(params.accountId, params.peer, now);
    const task: CustomSandboxTask = {
      id,
      accountId: params.accountId,
      peer: { ...params.peer },
      owner: { ...params.actor },
      title: params.title?.trim() || summarizeTitle(prompt),
      prompt,
      status: "queued",
      workspace: this.workspaceFor(id),
      createdAt: now,
      updatedAt: now,
      requirements: [],
    };
    this.tasks.set(id, task);
    return { allowed: true, reason: "allowed", task: cloneTask(task) };
  }

  addRequirement(params: {
    taskId: string;
    actor: CustomActor;
    content: string;
    now?: number;
  }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (!isActiveStatus(task.status)) return { allowed: false, reason: "not_active", task: cloneTask(task) };
    const content = params.content.trim();
    if (!content) return { allowed: false, reason: "empty_prompt", task: cloneTask(task) };
    const now = params.now ?? Date.now();
    const requirement: CustomTaskRequirement = {
      id: `${params.taskId}-req-${task.requirements.length + 1}`,
      actor: { ...params.actor },
      content,
      createdAt: now,
    };
    task.requirements.push(requirement);
    task.updatedAt = now;
    return { allowed: true, reason: "allowed", task: cloneTask(task) };
  }

  cancelTask(params: { taskId: string; actor: CustomActor; now?: number }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (!isActiveStatus(task.status)) return { allowed: false, reason: "not_active", task: cloneTask(task) };
    task.status = "cancelled";
    task.updatedAt = params.now ?? Date.now();
    task.result = `Cancelled by ${params.actor.label || params.actor.id}`;
    return { allowed: true, reason: "allowed", task: cloneTask(task) };
  }

  getTask(taskId: string): CustomSandboxTask | null {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : null;
  }

  listTasks(params: {
    accountId?: string;
    peer?: CustomPeer;
    status?: CustomTaskStatus | "active";
    limit?: number;
  } = {}): CustomSandboxTask[] {
    let tasks = Array.from(this.tasks.values());
    if (params.accountId) tasks = tasks.filter((task) => task.accountId === params.accountId);
    if (params.peer) tasks = tasks.filter((task) => task.peer.kind === params.peer!.kind && task.peer.id === params.peer!.id);
    if (params.status) {
      tasks = params.status === "active"
        ? tasks.filter((task) => isActiveStatus(task.status))
        : tasks.filter((task) => task.status === params.status);
    }
    tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    return tasks.slice(0, Math.max(1, params.limit ?? 10)).map(cloneTask);
  }

  getState(): CustomTaskSandboxRuntimeState {
    const tasks: CustomTaskSandboxRuntimeState["tasks"] = {};
    for (const [id, task] of this.tasks) {
      tasks[id] = cloneTask(task);
    }
    return { tasks };
  }

  loadState(state: CustomTaskSandboxRuntimeState): void {
    this.clear();
    this.seq = 0;
    for (const [id, task] of Object.entries(state.tasks ?? {})) {
      this.tasks.set(id, cloneTask(task));
      this.bumpSeq(id);
    }
  }

  clear(): void {
    this.tasks.clear();
  }

  private countActiveForPeer(accountId: string, peer: CustomPeer): number {
    return this.listTasks({ accountId, peer, status: "active", limit: Number.MAX_SAFE_INTEGER }).length;
  }

  private maxActiveTasksPerPeer(): number {
    const n = Number(this.config.maxActiveTasksPerPeer);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ACTIVE_TASKS_PER_PEER;
    return Math.floor(n);
  }

  private workspaceFor(taskId: string): string {
    return path.join(this.config.workspaceRoot || DEFAULT_WORKSPACE_ROOT, taskId);
  }

  private nextTaskId(accountId: string, peer: CustomPeer, now: number): string {
    const safeAccount = sanitizeTaskPart(accountId);
    const safePeer = sanitizeTaskPart(peer.id).slice(0, 16) || "peer";
    return `qqbot-${safeAccount}-${peer.kind}-${safePeer}-${now}-${++this.seq}`;
  }

  private bumpSeq(taskId: string): void {
    const m = taskId.match(/-(\d+)$/);
    if (!m) return;
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > this.seq) this.seq = n;
  }
}

function isActiveStatus(status: CustomTaskStatus): boolean {
  return status === "queued" || status === "running";
}

function summarizeTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 40 ? compact : `${compact.slice(0, 40)}...`;
}

function sanitizeTaskPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function cloneTask(task: CustomSandboxTask): CustomSandboxTask {
  return {
    ...task,
    peer: { ...task.peer },
    owner: { ...task.owner },
    requirements: task.requirements.map((item) => ({
      ...item,
      actor: { ...item.actor },
    })),
  };
}
