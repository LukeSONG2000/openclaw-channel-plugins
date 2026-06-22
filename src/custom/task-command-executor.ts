import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { CustomTaskExecutor, CustomTaskExecutorAck, CustomTaskExecutorStartResult } from "./task-executor-adapter.js";
import type { CustomSandboxTask, CustomTaskCommandExecutorConfig, CustomTaskRequirement } from "./types.js";
import type { CustomTaskNotificationAudience } from "./task-notification-adapter.js";
import {
  appendCustomTaskCommandOutput,
  formatCustomTaskCommandOutput,
  formatCustomTaskRequirementInput,
  parseCustomTaskCommandProgressLine,
  processCustomTaskCommandStdoutChunk,
} from "./task-command-output.js";
import { resolveWorkspacePath } from "./task-workspace.js";

export {
  appendCustomTaskCommandOutput,
  formatCustomTaskCommandOutput,
  formatCustomTaskRequirementInput,
  parseCustomTaskCommandProgressLine,
  processCustomTaskCommandStdoutChunk,
  type CustomTaskCommandProgressPayload,
  type CustomTaskCommandStdoutState,
} from "./task-command-output.js";

export interface CustomTaskCommandExecutorLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomTaskCommandExecutorCallbacks {
  complete: (params: { taskId: string; result: string; now?: number }) => void;
  fail: (params: { taskId: string; error: string; now?: number }) => void;
  heartbeat?: (params: { taskId: string; now?: number }) => void;
  progress?: (params: { taskId: string; phase?: string; message?: string; percent?: number; now?: number }) => void;
}

export interface CustomTaskCommandExecutorResolvedConfig {
  enabled: boolean;
  command?: string;
  args: string[];
  cwd?: string;
  forwardRequirementsToStdin: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  notifyAudiences: CustomTaskNotificationAudience[];
}

interface RunningTask {
  taskId: string;
  process: ChildProcessWithoutNullStreams;
  timeout?: ReturnType<typeof setTimeout>;
  stdout: string[];
  stderr: string[];
  stdoutLineBuffer: string;
  killedByTimeout?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 6000;
const DEFAULT_NOTIFY_AUDIENCES: CustomTaskNotificationAudience[] = ["peer"];

export function resolveCustomTaskCommandExecutorConfig(
  config?: CustomTaskCommandExecutorConfig,
): CustomTaskCommandExecutorResolvedConfig {
  const timeoutMs = positiveInt(config?.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = positiveInt(config?.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  return {
    enabled: config?.enabled === true,
    command: typeof config?.command === "string" && config.command.trim() ? config.command.trim() : undefined,
    args: Array.isArray(config?.args) ? config.args.map(String) : [],
    cwd: typeof config?.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : undefined,
    forwardRequirementsToStdin: config?.forwardRequirementsToStdin === true,
    timeoutMs,
    maxOutputChars,
    notifyAudiences: normalizeNotifyAudiences(config?.notifyAudiences),
  };
}

export class CustomTaskCommandExecutor implements CustomTaskExecutor {
  readonly id = "command-executor";
  readonly agentId?: string;
  private readonly running = new Map<string, RunningTask>();
  private readonly config: CustomTaskCommandExecutorResolvedConfig;

  constructor(params: {
    config?: CustomTaskCommandExecutorConfig;
    callbacks: CustomTaskCommandExecutorCallbacks;
    log?: CustomTaskCommandExecutorLogger;
  }) {
    this.config = resolveCustomTaskCommandExecutorConfig(params.config);
    this.callbacks = params.callbacks;
    this.log = params.log;
  }

  private readonly callbacks: CustomTaskCommandExecutorCallbacks;
  private readonly log?: CustomTaskCommandExecutorLogger;

  get notifyAudiences(): CustomTaskNotificationAudience[] {
    return this.config.notifyAudiences;
  }

  start(params: { task: CustomSandboxTask }): CustomTaskExecutorStartResult {
    if (!this.config.enabled) {
      return { accepted: false, message: "custom task command executor is disabled" };
    }
    if (!this.config.command) {
      return { accepted: false, message: "custom task command executor command is not configured" };
    }
    if (this.running.has(params.task.id)) {
      return { accepted: false, message: "custom task command executor is already running this task" };
    }

    const workspace = resolveWorkspacePath(params.task.workspace);
    const cwd = this.config.cwd ? resolveWorkspacePath(this.config.cwd) : workspace;
    const env = {
      ...process.env,
      QQBOT_CUSTOM_TASK_ID: params.task.id,
      QQBOT_CUSTOM_TASK_WORKSPACE: workspace,
      QQBOT_CUSTOM_TASK_TITLE: params.task.title,
      QQBOT_CUSTOM_TASK_PROMPT: params.task.prompt,
      QQBOT_CUSTOM_TASK_PEER: `${params.task.peer.kind}:${params.task.peer.id}`,
      QQBOT_CUSTOM_TASK_OWNER: params.task.owner.id,
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.command, this.config.args, {
        cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!this.config.forwardRequirementsToStdin) {
        child.stdin.end();
      }
    } catch (err) {
      return {
        accepted: false,
        message: `failed to start custom task command executor: ${formatError(err)}`,
      };
    }

    const runId = `${params.task.id}-cmd-${Date.now()}`;
    const running: RunningTask = {
      taskId: params.task.id,
      process: child,
      stdout: [],
      stderr: [],
      stdoutLineBuffer: "",
    };
    this.running.set(params.task.id, running);
    this.log?.info?.(`[custom-task-command-executor] started task=${params.task.id} pid=${child.pid ?? "unknown"} cwd=${cwd}`);

    child.stdout.on("data", (chunk) => {
      processCustomTaskCommandStdoutChunk({
        state: running,
        chunk,
        maxOutputChars: this.config.maxOutputChars,
        onProgress: (progress) => this.callbacks.progress?.({
          taskId: params.task.id,
          ...progress,
        }),
      });
      this.callbacks.heartbeat?.({ taskId: params.task.id });
    });
    child.stderr.on("data", (chunk) => {
      appendCustomTaskCommandOutput(running.stderr, chunk, this.config.maxOutputChars);
      this.callbacks.heartbeat?.({ taskId: params.task.id });
    });
    child.on("error", (err) => {
      this.finishFailed(params.task.id, `executor process error: ${formatError(err)}`);
    });
    child.on("close", (code, signal) => {
      if (!this.running.has(params.task.id)) return;
      if (running.timeout) clearTimeout(running.timeout);
      this.running.delete(params.task.id);
      const finalProgress = parseCustomTaskCommandProgressLine(running.stdoutLineBuffer);
      if (finalProgress) {
        this.callbacks.progress?.({
          taskId: params.task.id,
          ...finalProgress,
        });
      }
      const output = formatCustomTaskCommandOutput({
        code,
        signal,
        stdout: running.stdout.join(""),
        stderr: running.stderr.join(""),
        killedByTimeout: running.killedByTimeout,
        maxOutputChars: this.config.maxOutputChars,
      });
      if (code === 0 && !running.killedByTimeout) {
        this.callbacks.complete({ taskId: params.task.id, result: output });
      } else {
        this.callbacks.fail({ taskId: params.task.id, error: output });
      }
    });

    running.timeout = setTimeout(() => {
      if (!this.running.has(params.task.id)) return;
      running.killedByTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.running.has(params.task.id) && child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref?.();
    }, this.config.timeoutMs);
    running.timeout.unref?.();

    return { accepted: true, runId, agentId: this.id };
  }

  appendRequirement(params: { task: CustomSandboxTask; requirement: CustomTaskRequirement }): CustomTaskExecutorAck {
    const running = this.running.get(params.task.id);
    if (!running) return { accepted: false, message: "task command process is not running" };
    appendCustomTaskCommandOutput(running.stdout, `\n[requirement] ${params.requirement.actor.label || params.requirement.actor.id}: ${params.requirement.content}\n`, this.config.maxOutputChars);
    if (!this.config.forwardRequirementsToStdin) {
      return { accepted: true, message: "requirement recorded in task state; command process stdin forwarding is disabled" };
    }
    if (running.process.stdin.destroyed || running.process.stdin.writableEnded) {
      return { accepted: false, message: "task command process stdin is closed" };
    }
    const forwardedWithoutBackpressure = running.process.stdin.write(`${JSON.stringify(formatCustomTaskRequirementInput(params.requirement))}\n`);
    return {
      accepted: true,
      message: forwardedWithoutBackpressure
        ? "requirement forwarded to task command process stdin"
        : "requirement queued to task command process stdin with backpressure",
    };
  }

  cancel(params: { task: CustomSandboxTask }): CustomTaskExecutorAck {
    const running = this.running.get(params.task.id);
    if (!running) return { accepted: false, message: "task command process is not running" };
    running.process.kill("SIGTERM");
    return { accepted: true, message: "sent SIGTERM to task command process" };
  }

  dispose(): void {
    for (const running of this.running.values()) {
      if (running.timeout) clearTimeout(running.timeout);
      running.process.kill("SIGTERM");
    }
    this.running.clear();
  }

  private finishFailed(taskId: string, error: string): void {
    const running = this.running.get(taskId);
    if (running?.timeout) clearTimeout(running.timeout);
    this.running.delete(taskId);
    this.callbacks.fail({ taskId, error });
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeNotifyAudiences(value: unknown): CustomTaskNotificationAudience[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_NOTIFY_AUDIENCES.slice();
  const seen = new Set<CustomTaskNotificationAudience>();
  const result: CustomTaskNotificationAudience[] = [];
  for (const item of value) {
    if (item !== "peer" && item !== "owner") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.length ? result : DEFAULT_NOTIFY_AUDIENCES.slice();
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
