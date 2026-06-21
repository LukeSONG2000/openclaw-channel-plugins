import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { CustomTaskExecutor, CustomTaskExecutorAck, CustomTaskExecutorStartResult } from "./task-executor-adapter.js";
import type { CustomSandboxTask, CustomTaskCommandExecutorConfig, CustomTaskRequirement } from "./types.js";
import type { CustomTaskNotificationAudience } from "./task-notification-adapter.js";
import { resolveWorkspacePath } from "./task-workspace.js";

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
      processStdoutChunk({
        running,
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
      appendOutput(running.stderr, chunk, this.config.maxOutputChars);
      this.callbacks.heartbeat?.({ taskId: params.task.id });
    });
    child.on("error", (err) => {
      this.finishFailed(params.task.id, `executor process error: ${formatError(err)}`);
    });
    child.on("close", (code, signal) => {
      if (!this.running.has(params.task.id)) return;
      if (running.timeout) clearTimeout(running.timeout);
      this.running.delete(params.task.id);
      const finalProgress = parseTaskProgressLine(running.stdoutLineBuffer);
      if (finalProgress) {
        this.callbacks.progress?.({
          taskId: params.task.id,
          ...finalProgress,
        });
      }
      const output = formatTaskCommandOutput({
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
    appendOutput(running.stdout, `\n[requirement] ${params.requirement.actor.label || params.requirement.actor.id}: ${params.requirement.content}\n`, this.config.maxOutputChars);
    if (!this.config.forwardRequirementsToStdin) {
      return { accepted: true, message: "requirement recorded in task state; command process stdin forwarding is disabled" };
    }
    if (running.process.stdin.destroyed || running.process.stdin.writableEnded) {
      return { accepted: false, message: "task command process stdin is closed" };
    }
    const forwardedWithoutBackpressure = running.process.stdin.write(`${JSON.stringify(formatRequirementInput(params.requirement))}\n`);
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

function appendOutput(target: string[], chunk: unknown, maxChars: number): void {
  target.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  let joined = target.join("");
  if (joined.length > maxChars) joined = joined.slice(joined.length - maxChars);
  target.length = 0;
  target.push(joined);
}

function processStdoutChunk(params: {
  running: RunningTask;
  chunk: unknown;
  maxOutputChars: number;
  onProgress?: (progress: { phase?: string; message?: string; percent?: number }) => void;
}): void {
  const text = Buffer.isBuffer(params.chunk) ? params.chunk.toString("utf8") : String(params.chunk);
  appendOutput(params.running.stdout, text, params.maxOutputChars);
  if (!params.onProgress) return;
  params.running.stdoutLineBuffer += text;
  const lines = params.running.stdoutLineBuffer.split(/\r?\n/);
  params.running.stdoutLineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const progress = parseTaskProgressLine(line);
    if (progress) params.onProgress(progress);
  }
}

function parseTaskProgressLine(line: string): { phase?: string; message?: string; percent?: number } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let payload: unknown;
  if (trimmed.startsWith("QQBOT_TASK_PROGRESS ")) {
    payload = safeJsonParse(trimmed.slice("QQBOT_TASK_PROGRESS ".length));
  } else {
    const parsed = safeJsonParse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const type = String((parsed as Record<string, unknown>).type ?? "");
    if (type !== "qqbot.task.progress" && type !== "task-progress" && type !== "progress") return null;
    payload = parsed;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const phase = typeof record.phase === "string" ? record.phase.trim().slice(0, 120) : undefined;
  const message = typeof record.message === "string" ? record.message.trim().slice(0, 400) : undefined;
  const percent = normalizeProgressPercent(record.percent ?? record.progress);
  if (!phase && !message && percent === undefined) return null;
  return {
    ...(phase ? { phase } : {}),
    ...(message ? { message } : {}),
    ...(percent !== undefined ? { percent } : {}),
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeProgressPercent(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatRequirementInput(requirement: CustomTaskRequirement): Record<string, unknown> {
  return {
    type: "requirement",
    id: requirement.id,
    actor: requirement.actor,
    content: requirement.content,
    createdAt: requirement.createdAt,
  };
}

function formatTaskCommandOutput(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killedByTimeout?: boolean;
  maxOutputChars: number;
}): string {
  const lines: string[] = [];
  if (params.killedByTimeout) lines.push("Timed out and terminated.");
  lines.push(`Exit code: ${params.code ?? "null"}${params.signal ? ` signal=${params.signal}` : ""}`);
  if (params.stdout.trim()) lines.push("", "STDOUT:", params.stdout.trim());
  if (params.stderr.trim()) lines.push("", "STDERR:", params.stderr.trim());
  const text = lines.join("\n").trim() || "Command completed without output.";
  if (text.length <= params.maxOutputChars) return text;
  return `${text.slice(text.length - params.maxOutputChars)}\n...(output truncated)`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
