import type { QueuedMessage } from "../message-queue.js";
import type { MessageTarget } from "../reply-dispatcher.js";
import type { CustomAuthorizationRuntime } from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import { formatScheduledTaskFireText } from "./scheduled-task-gateway-adapter.js";
import { CustomScheduledTaskRuntime } from "./scheduled-task.js";
import type { CustomScheduledTask } from "./types.js";

export interface CustomScheduledTaskDelivery {
  target: MessageTarget;
  text: string;
  task: CustomScheduledTask;
}

export type CustomScheduledTaskSendText = (delivery: CustomScheduledTaskDelivery) => Promise<void> | void;

export interface CustomScheduledTaskSchedulerOptions {
  accountId: string;
  scheduledTasks: CustomScheduledTaskRuntime;
  auth: CustomAuthorizationRuntime;
  getConfig: () => unknown;
  sendText: CustomScheduledTaskSendText;
  enqueue: (message: QueuedMessage) => void | Promise<void>;
  persist: () => void;
  intervalMs?: number;
  now?: () => number;
  log?: { info?: (msg: string) => void; debug?: (msg: string) => void; error?: (msg: string) => void };
}

export class CustomScheduledTaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly options: CustomScheduledTaskSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.options.scheduledTasks.listDueTasks({ accountId: this.options.accountId, now });
      for (const task of due) await this.fireTask(task, now);
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async fireTask(task: CustomScheduledTask, now: number): Promise<void> {
    if (!this.isTaskAuthorized(task, now)) {
      this.options.log?.debug?.(`custom scheduled task skipped without active authorization: task=${task.id}`);
      return;
    }
    try {
      if (task.status === "pending_auth") {
        this.options.scheduledTasks.activateTask({ taskId: task.id, now: task.createdAt });
      }
      if (task.actionKind === "agent") {
        await this.options.enqueue(syntheticMessageFromTask(task, now));
      } else {
        const target = targetFromScheduledTask(task);
        if (!target) return;
        await this.options.sendText({ target, text: formatScheduledTaskFireText(task), task });
      }
      this.options.scheduledTasks.markFired({ taskId: task.id, now });
      this.options.persist();
      this.options.log?.info?.(`custom scheduled task fired: task=${task.id} action=${task.actionKind}`);
    } catch (err) {
      this.options.log?.error?.(`custom scheduled task delivery failed: task=${task.id} error=${err}`);
    }
  }

  private isTaskAuthorized(task: CustomScheduledTask, now: number): boolean {
    const cfg = this.options.getConfig() as any;
    const runtime = resolveCustomRuntimeConfig(cfg);
    const scene = resolveCustomSceneConfig(cfg, task.peer);
    const decision = this.options.auth.check({
      runtime,
      scene,
      peer: task.peer,
      actor: task.creator,
      capability: "schedule.run",
      taskId: task.id,
      now,
      consumeGrant: false,
      requestApproval: false,
    });
    return decision.decision.allowed;
  }
}

function syntheticMessageFromTask(task: CustomScheduledTask, now: number): QueuedMessage {
  const content = formatScheduledTaskFireText(task);
  if (task.peer.kind === "group") {
    return {
      type: "group",
      senderId: task.creator.id,
      senderName: task.creator.label,
      content,
      messageId: `scheduled-${task.id}-${now}`,
      timestamp: new Date(now).toISOString(),
      groupOpenid: task.peer.id,
      _noMerge: true,
      _slashAuthorized: { command: "scheduled-task", capability: "schedule.run" },
    };
  }
  return {
    type: "c2c",
    senderId: task.peer.id,
    senderName: task.creator.label,
    content,
    messageId: `scheduled-${task.id}-${now}`,
    timestamp: new Date(now).toISOString(),
    _noMerge: true,
    _slashAuthorized: { command: "scheduled-task", capability: "schedule.run" },
  };
}

function targetFromScheduledTask(task: CustomScheduledTask): MessageTarget | null {
  if (task.peer.kind === "group") return { type: "group", senderId: task.creator.id, groupOpenid: task.peer.id, messageId: "" };
  if (task.peer.kind === "c2c") return { type: "c2c", senderId: task.peer.id, messageId: "" };
  if (task.peer.kind === "channel") return { type: "guild", senderId: task.creator.id, channelId: task.peer.id, messageId: "" };
  if (task.peer.kind === "dm") return { type: "dm", senderId: task.peer.id, messageId: "" };
  return null;
}
