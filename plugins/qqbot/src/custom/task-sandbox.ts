import path from "node:path";
import type {
  CustomActor,
  CustomPeer,
  CustomSandboxTask,
  CustomTaskIntent,
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
  config?: CustomTaskSandboxConfig;
  now?: number;
}

export interface CustomTaskSandboxDecision {
  allowed: boolean;
  reason: "allowed" | "empty_prompt" | "too_many_active_tasks" | "not_found" | "not_active" | "invalid_transition";
  task?: CustomSandboxTask;
  requirement?: CustomTaskRequirement;
  intents?: CustomTaskIntent[];
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
    const taskConfig = resolveTaskSandboxConfig(this.config, params.config);
    if (!prompt) return { allowed: false, reason: "empty_prompt" };
    if (this.countActiveForPeer(params.accountId, params.peer) >= maxActiveTasksPerPeer(taskConfig)) {
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
      workspace: workspaceFor(taskConfig, id),
      createdAt: now,
      updatedAt: now,
      requirements: [],
    };
    this.tasks.set(id, task);
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "start-requested", task: cloneTask(task) }],
    };
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
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      requirement: { ...requirement, actor: { ...requirement.actor } },
      intents: [{ kind: "requirement-added", task: cloneTask(task), requirement: { ...requirement, actor: { ...requirement.actor } } }],
    };
  }

  cancelTask(params: { taskId: string; actor: CustomActor; now?: number }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (!isActiveStatus(task.status)) return { allowed: false, reason: "not_active", task: cloneTask(task) };
    task.status = "cancelled";
    task.updatedAt = params.now ?? Date.now();
    task.result = `Cancelled by ${params.actor.label || params.actor.id}`;
    task.execution = {
      ...task.execution,
      completedAt: task.updatedAt,
    };
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "cancel-requested", task: cloneTask(task) }],
    };
  }

  startTask(params: {
    taskId: string;
    executorId: string;
    runId?: string;
    agentId?: string;
    now?: number;
  }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (task.status !== "queued") return { allowed: false, reason: "invalid_transition", task: cloneTask(task) };
    const now = params.now ?? Date.now();
    task.status = "running";
    task.updatedAt = now;
    task.execution = {
      executorId: params.executorId,
      runId: params.runId,
      agentId: params.agentId,
      startedAt: now,
      lastHeartbeatAt: now,
    };
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "status-updated", task: cloneTask(task) }],
    };
  }

  heartbeatTask(params: {
    taskId: string;
    now?: number;
  }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (task.status !== "running") return { allowed: false, reason: "not_active", task: cloneTask(task) };
    const now = params.now ?? Date.now();
    task.updatedAt = now;
    task.execution = {
      ...task.execution,
      lastHeartbeatAt: now,
    };
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "status-updated", task: cloneTask(task) }],
    };
  }

  updateTaskProgress(params: {
    taskId: string;
    phase?: string;
    message?: string;
    percent?: number;
    now?: number;
  }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (task.status !== "running") return { allowed: false, reason: "not_active", task: cloneTask(task) };
    const now = params.now ?? Date.now();
    const phase = normalizeProgressText(params.phase);
    const message = normalizeProgressText(params.message);
    const percent = normalizeProgressPercent(params.percent);
    if (!phase && !message && percent === undefined) return { allowed: false, reason: "empty_prompt", task: cloneTask(task) };
    task.updatedAt = now;
    task.progress = {
      ...task.progress,
      ...(phase ? { phase } : {}),
      ...(message ? { message } : {}),
      ...(percent !== undefined ? { percent } : {}),
      updatedAt: now,
    };
    task.execution = {
      ...task.execution,
      lastHeartbeatAt: now,
    };
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "status-updated", task: cloneTask(task) }],
    };
  }

  completeTask(params: {
    taskId: string;
    result: string;
    now?: number;
  }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (task.status !== "running") return { allowed: false, reason: "invalid_transition", task: cloneTask(task) };
    const result = params.result.trim();
    if (!result) return { allowed: false, reason: "empty_prompt", task: cloneTask(task) };
    const now = params.now ?? Date.now();
    task.status = "completed";
    task.updatedAt = now;
    task.result = result;
    task.error = undefined;
    task.execution = {
      ...task.execution,
      completedAt: now,
      lastHeartbeatAt: now,
    };
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "status-updated", task: cloneTask(task) }],
    };
  }

  failTask(params: {
    taskId: string;
    error: string;
    now?: number;
  }): CustomTaskSandboxDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (task.status !== "running" && task.status !== "queued") return { allowed: false, reason: "invalid_transition", task: cloneTask(task) };
    const error = params.error.trim();
    if (!error) return { allowed: false, reason: "empty_prompt", task: cloneTask(task) };
    const now = params.now ?? Date.now();
    task.status = "failed";
    task.updatedAt = now;
    task.error = error;
    task.execution = {
      ...task.execution,
      completedAt: now,
      lastHeartbeatAt: task.execution?.lastHeartbeatAt ?? now,
    };
    return {
      allowed: true,
      reason: "allowed",
      task: cloneTask(task),
      intents: [{ kind: "status-updated", task: cloneTask(task) }],
    };
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

export function resolveTaskSandboxConfig(
  base?: CustomTaskSandboxConfig,
  override?: CustomTaskSandboxConfig,
): Required<CustomTaskSandboxConfig> {
  return {
    workspaceRoot: normalizeWorkspaceRoot(override?.workspaceRoot) ?? normalizeWorkspaceRoot(base?.workspaceRoot) ?? DEFAULT_WORKSPACE_ROOT,
    maxActiveTasksPerPeer: normalizeMaxActiveTasks(override?.maxActiveTasksPerPeer) ?? normalizeMaxActiveTasks(base?.maxActiveTasksPerPeer) ?? DEFAULT_MAX_ACTIVE_TASKS_PER_PEER,
  };
}

function isActiveStatus(status: CustomTaskStatus): boolean {
  return status === "queued" || status === "running";
}

function maxActiveTasksPerPeer(config: CustomTaskSandboxConfig): number {
  return normalizeMaxActiveTasks(config.maxActiveTasksPerPeer) ?? DEFAULT_MAX_ACTIVE_TASKS_PER_PEER;
}

function workspaceFor(config: CustomTaskSandboxConfig, taskId: string): string {
  return path.join(normalizeWorkspaceRoot(config.workspaceRoot) ?? DEFAULT_WORKSPACE_ROOT, taskId);
}

function normalizeMaxActiveTasks(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

function normalizeWorkspaceRoot(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeProgressText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 400) : undefined;
}

function normalizeProgressPercent(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
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
    execution: task.execution ? { ...task.execution } : undefined,
    progress: task.progress ? { ...task.progress } : undefined,
  };
}
