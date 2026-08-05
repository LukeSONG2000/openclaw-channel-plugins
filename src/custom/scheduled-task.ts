import type { QueuedMessage } from "../message-queue.js";
import type {
  CustomActor,
  CustomCapability,
  CustomPeer,
  CustomScheduledTask,
  CustomScheduledTaskRuntimeState,
} from "./types.js";
import {
  detectCustomCodexRunIntent,
  detectCustomConfigReadIntent,
  detectCustomDeployApplyIntent,
  detectCustomRuleWriteIntent,
  detectCustomWebSearchIntent,
} from "./auth-gateway-adapter.js";

export interface CustomCreateScheduledTaskParams {
  accountId: string;
  peer: CustomPeer;
  creator: CustomActor;
  targetActors?: CustomActor[];
  intervalMs: number;
  durationMs?: number;
  prompt: string;
  requiredCapabilities?: Exclude<CustomCapability, "*">[];
  actionKind?: CustomScheduledTask["actionKind"];
  status?: CustomScheduledTask["status"];
  now?: number;
}

export interface CustomScheduledTaskDecision {
  allowed: boolean;
  reason: "allowed" | "invalid_interval" | "invalid_prompt" | "not_found" | "inactive";
  task?: CustomScheduledTask;
}

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60_000;

export class CustomScheduledTaskRuntime {
  private readonly tasks = new Map<string, CustomScheduledTask>();
  private seq = 0;

  createTask(params: CustomCreateScheduledTaskParams): CustomScheduledTaskDecision {
    const intervalMs = normalizeInterval(params.intervalMs);
    if (!intervalMs) return { allowed: false, reason: "invalid_interval" };
    const prompt = params.prompt.replace(/\s+/g, " ").trim();
    if (!prompt) return { allowed: false, reason: "invalid_prompt" };
    const now = params.now ?? Date.now();
    const requiredCapabilities = normalizeCapabilities(params.requiredCapabilities ?? inferScheduledTaskCapabilities(prompt));
    const task: CustomScheduledTask = {
      id: this.nextTaskId(params.accountId, params.peer, now),
      accountId: params.accountId,
      peer: { ...params.peer },
      creator: { ...params.creator },
      targetActors: (params.targetActors ?? []).map((actor) => ({ ...actor })),
      intervalMs,
      actionKind: params.actionKind ?? inferScheduledTaskActionKind(requiredCapabilities),
      prompt,
      requiredCapabilities,
      status: params.status ?? "pending_auth",
      createdAt: now,
      updatedAt: now,
      nextDueAt: now + intervalMs,
      endAt: normalizeDuration(params.durationMs, intervalMs, now),
    };
    this.tasks.set(task.id, task);
    return { allowed: true, reason: "allowed", task: cloneScheduledTask(task) };
  }

  activateTask(params: { taskId: string; now?: number }): CustomScheduledTaskDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    const now = params.now ?? Date.now();
    task.status = "active";
    task.updatedAt = now;
    task.nextDueAt = Math.max(task.nextDueAt, now + task.intervalMs);
    if (task.endAt && task.endAt <= now) {
      const duration = Math.max(task.intervalMs, task.endAt - task.createdAt);
      task.endAt = now + duration;
    }
    return { allowed: true, reason: "allowed", task: cloneScheduledTask(task) };
  }

  cancelTask(params: { taskId: string; now?: number }): CustomScheduledTaskDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    const now = params.now ?? Date.now();
    task.status = "cancelled";
    task.cancelledAt = now;
    task.updatedAt = now;
    return { allowed: true, reason: "allowed", task: cloneScheduledTask(task) };
  }

  listDueTasks(params: { accountId?: string; now?: number; limit?: number } = {}): CustomScheduledTask[] {
    const now = params.now ?? Date.now();
    const tasks = Array.from(this.tasks.values())
      .filter((task) => (task.status === "active" || task.status === "pending_auth") && (!params.accountId || task.accountId === params.accountId) && task.nextDueAt <= now && (!task.endAt || task.endAt >= now))
      .sort((a, b) => a.nextDueAt - b.nextDueAt)
      .slice(0, Math.max(1, params.limit ?? 20));
    return tasks.map(cloneScheduledTask);
  }

  markFired(params: { taskId: string; now?: number }): CustomScheduledTaskDecision {
    const task = this.tasks.get(params.taskId);
    if (!task) return { allowed: false, reason: "not_found" };
    if (task.status !== "active") return { allowed: false, reason: "inactive", task: cloneScheduledTask(task) };
    const now = params.now ?? Date.now();
    task.lastFiredAt = now;
    task.updatedAt = now;
    task.nextDueAt = now + task.intervalMs;
    if (task.endAt && task.nextDueAt > task.endAt) {
      task.status = "cancelled";
      task.cancelledAt = now;
    }
    return { allowed: true, reason: "allowed", task: cloneScheduledTask(task) };
  }

  listTasks(params: {
    accountId?: string;
    peer?: CustomPeer;
    creator?: CustomActor;
    status?: CustomScheduledTask["status"] | "open";
    limit?: number;
  } = {}): CustomScheduledTask[] {
    let tasks = Array.from(this.tasks.values());
    if (params.accountId) tasks = tasks.filter((task) => task.accountId === params.accountId);
    if (params.peer) tasks = tasks.filter((task) => task.peer.kind === params.peer!.kind && task.peer.id === params.peer!.id);
    if (params.creator) tasks = tasks.filter((task) => task.creator.id.toUpperCase() === params.creator!.id.toUpperCase());
    if (params.status === "open") tasks = tasks.filter((task) => task.status === "active" || task.status === "pending_auth");
    else if (params.status) tasks = tasks.filter((task) => task.status === params.status);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    return tasks.slice(0, Math.max(1, params.limit ?? 20)).map(cloneScheduledTask);
  }

  getTask(taskId: string): CustomScheduledTask | null {
    const task = this.tasks.get(taskId);
    return task ? cloneScheduledTask(task) : null;
  }

  getState(): CustomScheduledTaskRuntimeState {
    const tasks: CustomScheduledTaskRuntimeState["tasks"] = {};
    for (const [id, task] of this.tasks) tasks[id] = cloneScheduledTask(task);
    return { tasks };
  }

  loadState(state: CustomScheduledTaskRuntimeState): void {
    this.tasks.clear();
    this.seq = 0;
    for (const [id, task] of Object.entries(state.tasks ?? {})) {
      this.tasks.set(id, cloneScheduledTask(task));
      this.bumpSeq(id);
    }
  }

  private nextTaskId(accountId: string, peer: CustomPeer, now: number): string {
    return `sched-${sanitizePart(accountId)}-${peer.kind}-${sanitizePart(peer.id).slice(0, 16) || "peer"}-${now}-${++this.seq}`;
  }

  private bumpSeq(taskId: string): void {
    const m = taskId.match(/-(\d+)$/);
    const seq = m ? Number.parseInt(m[1]!, 10) : 0;
    if (Number.isFinite(seq) && seq > this.seq) this.seq = seq;
  }
}

export interface ParsedCustomScheduledTaskIntent {
  intervalMs: number;
  prompt: string;
  durationMs?: number;
  targetActors: CustomActor[];
  requiredCapabilities: Exclude<CustomCapability, "*">[];
  actionKind: CustomScheduledTask["actionKind"];
}

export function parseCustomScheduledTaskIntent(content: string, message?: Pick<QueuedMessage, "mentions">): ParsedCustomScheduledTaskIntent | null {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text || !/(每隔|每过|每|定时|定期|周期性|循环)/.test(text)) return null;
  const interval = parseScheduledIntervalMs(text);
  if (!interval) return null;
  const targets = extractScheduledMentionActors(message).filter((actor) => !actor.isBot);
  const durationMs = parseScheduledDurationMs(text);
  let prompt = extractScheduledPrompt(text);
  if (!prompt) prompt = text;
  const requiredCapabilities = inferScheduledTaskCapabilities(prompt);
  return {
    intervalMs: interval,
    prompt,
    durationMs,
    targetActors: targets,
    requiredCapabilities,
    actionKind: inferScheduledTaskActionKind(requiredCapabilities),
  };
}

export function parseCustomScheduledTaskCancelIntent(content: string): string | null {
  const text = content.replace(/\s+/g, " ").trim();
  if (!/(取消|停止|停掉|删除|关掉|不要了).{0,12}(定时|任务|提醒|循环|每隔|每分钟|每小时|刚刚|上一个|上一条)/.test(text)
    && !/(定时|任务|提醒|循环).{0,12}(取消|停止|停掉|删除|关掉|不要了)/.test(text)) {
    return null;
  }
  const id = text.match(/\b(sched-[a-zA-Z0-9_-]+)\b/);
  return id?.[1] ?? "";
}

export function inferScheduledTaskCapabilities(prompt: string): Exclude<CustomCapability, "*">[] {
  const caps: Exclude<CustomCapability, "*">[] = ["schedule.run", "proactive.send"];
  if (detectCustomDeployApplyIntent(prompt)) caps.push("deploy.apply");
  else if (detectCustomRuleWriteIntent(prompt)) caps.push("config.write");
  else if (detectCustomConfigReadIntent(prompt) || /(查询|查看|检查|读取|看一下).{0,24}(服务器|日志|log|文件|配置|状态)/i.test(prompt)) caps.push("config.read");
  else if (detectCustomCodexRunIntent(prompt)) caps.push("codex.run");
  if (detectCustomWebSearchIntent(prompt)) caps.push("web.search");
  return normalizeCapabilities(caps);
}

export function parseScheduledIntervalMs(text: string): number | null {
  const lower = text.toLowerCase();
  const numeric = lower.match(/(?:每隔|每过|每)?\s*(\d+(?:\.\d+)?)\s*(m|min|minute|minutes|分钟|h|hour|hours|小时|d|day|days|天)/i);
  if (numeric) return normalizeInterval(Number.parseFloat(numeric[1]!) * unitMs(numeric[2]!));
  if (/半个?小时|半小时/.test(text)) return 30 * 60_000;
  const zh = text.match(/(?:每隔|每过|每)?\s*([一二两三四五六七八九十]+)\s*(分钟|小时|天)/);
  if (zh) return normalizeInterval(zhNumber(zh[1]!) * unitMs(zh[2]!));
  return null;
}

export function parseScheduledDurationMs(text: string): number | undefined {
  const m = text.match(/(?:持续|连续|执行|运行)\s*(半个?小时|半小时|\d+(?:\.\d+)?\s*(m|min|minute|minutes|分钟|h|hour|hours|小时|d|day|days|天)|[一二两三四五六七八九十]+\s*(分钟|小时|天))/i);
  if (!m) return undefined;
  return parseScheduledIntervalMs(`每${m[1]}`) ?? undefined;
}

function extractScheduledPrompt(text: string): string {
  let stripped = text
    .replace(/<@[^>]+>/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/(每隔|每过|每)\s*(半个?小时|[\d一二两三四五六七八九十半]+\s*(分钟|小时|天)|\d+\s*(m|min|minute|minutes|h|hour|hours|d|day|days))/i, " ")
    .replace(/(?:持续|连续|执行|运行)\s*(半个?小时|半小时|\d+(?:\.\d+)?\s*(m|min|minute|minutes|分钟|h|hour|hours|小时|d|day|days|天)|[一二两三四五六七八九十]+\s*(分钟|小时|天))/gi, " ")
    .replace(/^(定时|定期|周期性|循环)?\s*(提醒我|提醒|帮我|请|让你|你)?\s*/i, " ")
    .trim();
  const quoted = stripped.match(/[“\"'「『](.+?)[”\"'」』]/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const say = stripped.match(/(?:说|发送|发消息|提醒|问)(?:一下|他|她|它|ta|TA|大家)?\s*[:：,， ]\s*(.+)$/i);
  if (say?.[1]?.trim()) stripped = say[1].trim();
  return stripped.replace(/^[：:,，\s]+/, "").replace(/[。；;，, ]+$/g, "").trim();
}

export function extractScheduledMentionActors(message?: Pick<QueuedMessage, "mentions">): CustomActor[] {
  const mentions = message?.mentions ?? [];
  return mentions
    .filter((mention) => !mention.is_you && !mention.bot && mention.scope !== "all")
    .map((mention) => ({
      id: mention.member_openid ?? mention.user_openid ?? mention.id ?? "",
      label: mention.username,
    }))
    .filter((actor) => Boolean(actor.id));
}

function inferScheduledTaskActionKind(caps: Exclude<CustomCapability, "*">[]): CustomScheduledTask["actionKind"] {
  return caps.some((cap) => cap !== "schedule.run" && cap !== "proactive.send") ? "agent" : "message";
}

function normalizeCapabilities(caps: Exclude<CustomCapability, "*">[]): Exclude<CustomCapability, "*">[] {
  return Array.from(new Set(caps));
}

function normalizeInterval(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) return null;
  return Math.min(Math.round(ms), MAX_INTERVAL_MS);
}

function normalizeDuration(ms: number | undefined, intervalMs: number, now: number): number | undefined {
  if (!Number.isFinite(ms) || ms! <= 0) return undefined;
  return now + Math.max(intervalMs, Math.min(Math.round(ms!), MAX_INTERVAL_MS));
}

function unitMs(unit: string): number {
  if (/^(m|min|minute|minutes|分钟)$/i.test(unit)) return 60_000;
  if (/^(h|hour|hours|小时)$/i.test(unit)) return 60 * 60_000;
  return 24 * 60 * 60_000;
}

function zhNumber(text: string): number {
  if (text === "十") return 10;
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? digits[tens] ?? 1 : 1) * 10 + (ones ? digits[ones] ?? 0 : 0);
  }
  return digits[text] ?? 0;
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}

export function cloneScheduledTask(task: CustomScheduledTask): CustomScheduledTask {
  return {
    ...task,
    peer: { ...task.peer },
    creator: { ...task.creator },
    targetActors: task.targetActors.map((actor) => ({ ...actor })),
    requiredCapabilities: [...task.requiredCapabilities],
  };
}
