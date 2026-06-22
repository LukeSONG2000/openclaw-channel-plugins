import type { CustomTaskRequirement } from "./types.js";

export interface CustomTaskCommandStdoutState {
  stdout: string[];
  stdoutLineBuffer: string;
}

export interface CustomTaskCommandProgressPayload {
  phase?: string;
  message?: string;
  percent?: number;
}

export function appendCustomTaskCommandOutput(target: string[], chunk: unknown, maxChars: number): void {
  target.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  let joined = target.join("");
  if (joined.length > maxChars) joined = joined.slice(joined.length - maxChars);
  target.length = 0;
  target.push(joined);
}

export function processCustomTaskCommandStdoutChunk(params: {
  state: CustomTaskCommandStdoutState;
  chunk: unknown;
  maxOutputChars: number;
  onProgress?: (progress: CustomTaskCommandProgressPayload) => void;
}): void {
  const text = Buffer.isBuffer(params.chunk) ? params.chunk.toString("utf8") : String(params.chunk);
  appendCustomTaskCommandOutput(params.state.stdout, text, params.maxOutputChars);
  if (!params.onProgress) return;
  params.state.stdoutLineBuffer += text;
  const lines = params.state.stdoutLineBuffer.split(/\r?\n/);
  params.state.stdoutLineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const progress = parseCustomTaskCommandProgressLine(line);
    if (progress) params.onProgress(progress);
  }
}

export function parseCustomTaskCommandProgressLine(line: string): CustomTaskCommandProgressPayload | null {
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

export function formatCustomTaskRequirementInput(requirement: CustomTaskRequirement): Record<string, unknown> {
  return {
    type: "requirement",
    id: requirement.id,
    actor: requirement.actor,
    content: requirement.content,
    createdAt: requirement.createdAt,
  };
}

export function formatCustomTaskCommandOutput(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killedByTimeout?: boolean;
  maxOutputChars: number;
}): string {
  const lines: string[] = [];
  if (params.killedByTimeout) lines.push("已超时并终止。");
  lines.push(`退出码：${params.code ?? "无"}${params.signal ? `，信号=${params.signal}` : ""}`);
  if (params.stdout.trim()) lines.push("", "标准输出：", params.stdout.trim());
  if (params.stderr.trim()) lines.push("", "标准错误：", params.stderr.trim());
  const text = lines.join("\n").trim() || "命令已完成，无输出。";
  if (text.length <= params.maxOutputChars) return text;
  return `${text.slice(text.length - params.maxOutputChars)}\n...（输出已截断）`;
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
