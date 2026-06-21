import type { CustomSandboxTask } from "./types.js";

export type CustomTaskNotificationAudience = "peer" | "owner";

export interface CustomTaskNotificationEffect {
  kind: "notify";
  audience: CustomTaskNotificationAudience;
  taskId: string;
  title: string;
  text: string;
}

export function notificationForCustomTaskStatus(params: {
  task: CustomSandboxTask;
  audience?: CustomTaskNotificationAudience;
  includeWorkspace?: boolean;
  maxResultChars?: number;
}): CustomTaskNotificationEffect | null {
  const task = params.task;
  const audience = params.audience ?? "peer";
  if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
    return null;
  }

  const title = statusTitle(task);
  const lines = [
    title,
    "",
    `任务：${task.id}`,
    `标题：${task.title}`,
    `状态：${task.status}`,
  ];

  if (task.execution?.runId) lines.push(`运行：${task.execution.runId}`);
  if (task.execution?.agentId) lines.push(`Agent：${task.execution.agentId}`);
  if (task.progress) lines.push(`进度：${formatTaskProgress(task.progress)}`);
  if (task.updatedAt) lines.push(`更新时间：${new Date(task.updatedAt).toISOString()}`);
  if (params.includeWorkspace) lines.push(`工作区：${task.workspace}`);

  const result = task.status === "failed"
    ? task.error
    : task.result;
  if (result) {
    lines.push("", task.status === "failed" ? "错误：" : "结果：", truncateText(result, params.maxResultChars ?? 1200));
  }

  return {
    kind: "notify",
    audience,
    taskId: task.id,
    title,
    text: lines.join("\n"),
  };
}

export function notificationsForCustomTaskStatus(params: {
  task: CustomSandboxTask;
  audiences?: CustomTaskNotificationAudience[];
  includeWorkspace?: boolean;
  maxResultChars?: number;
}): CustomTaskNotificationEffect[] {
  const audiences: CustomTaskNotificationAudience[] = params.audiences?.length ? params.audiences : ["peer"];
  const effects: CustomTaskNotificationEffect[] = [];
  const seen = new Set<CustomTaskNotificationAudience>();
  for (const audience of audiences) {
    if (seen.has(audience)) continue;
    seen.add(audience);
    const effect = notificationForCustomTaskStatus({
      task: params.task,
      audience,
      includeWorkspace: params.includeWorkspace,
      maxResultChars: params.maxResultChars,
    });
    if (effect) effects.push(effect);
  }
  return effects;
}

function statusTitle(task: CustomSandboxTask): string {
  if (task.status === "completed") return "✅ 长任务已完成";
  if (task.status === "failed") return "❌ 长任务失败";
  if (task.status === "cancelled") return "✅ 长任务已取消";
  return "🧪 长任务状态更新";
}

function truncateText(value: string, maxChars: number): string {
  const compact = value.trim();
  const max = Math.max(20, Math.floor(maxChars));
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 12)}\n...(已截断)`;
}

function formatTaskProgress(progress: NonNullable<CustomSandboxTask["progress"]>): string {
  const parts = [];
  if (progress.percent !== undefined) parts.push(`${progress.percent}%`);
  if (progress.phase) parts.push(progress.phase);
  if (progress.message) parts.push(progress.message);
  return parts.join(" / ") || "已更新";
}
