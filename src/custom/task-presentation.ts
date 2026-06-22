import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { CustomSandboxTask } from "./types.js";
import {
  formatCustomTaskCleanupDuration,
  type CustomTaskCleanupPlan,
} from "./task-cleanup.js";
import { formatTaskStatusForDisplay } from "./presentation-labels.js";

export function buildCustomTaskKeyboard(task: CustomSandboxTask): InlineKeyboard {
  const buttons: KeyboardButton[] = [
    makeTaskCommandButton({
      id: "status",
      label: "查看状态",
      visitedLabel: "已查看",
      command: `/bot-task status ${task.id}`,
      enter: true,
      style: 1,
    }),
  ];

  if (task.status === "queued" || task.status === "running") {
    buttons.push(makeTaskCommandButton({
      id: "add",
      label: "追加需求",
      visitedLabel: "继续追加",
      command: `/bot-task add ${task.id} `,
      enter: false,
      style: 1,
    }));
    buttons.push(makeTaskCommandButton({
      id: "cancel",
      label: "取消任务",
      visitedLabel: "已选择取消",
      command: `/bot-task cancel ${task.id}`,
      enter: true,
      style: 3,
    }));
  }

  buttons.push(makeTaskCommandButton({
    id: "new",
    label: "新建长任务",
    visitedLabel: "继续新建",
    command: "/bot-task create ",
    enter: false,
    style: 0,
  }));

  return {
    content: {
      rows: buttons.map((button) => ({ buttons: [button] })),
    },
  };
}

function makeTaskCommandButton(params: {
  id: string;
  label: string;
  visitedLabel: string;
  command: string;
  enter: boolean;
  style: 0 | 1 | 3;
}): KeyboardButton {
  return {
    id: `task_${params.id}`,
    render_data: { label: params.label, visited_label: params.visitedLabel, style: params.style },
    action: {
      type: 2,
      data: params.command,
      enter: params.enter,
      reply: !params.enter,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: "custom-task",
  };
}

export function formatCustomTaskHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🧪 自定义长任务命令`,
    ``,
    `/bot-task create <任务描述>`,
    `/bot-task list`,
    `/bot-task status <taskId>`,
    `/bot-task add <taskId> <追加需求>`,
    `/bot-task cancel <taskId>`,
    `/bot-task cleanup [--older-than 7d] [--limit 10]`,
  );
  return lines.join("\n");
}

export function formatTaskCreated(task: CustomSandboxTask): string {
  return [
    `🧪 长任务已创建`,
    ``,
    `任务：${task.id}`,
    `状态：${formatTaskStatusForDisplay(task.status)}`,
    `标题：${task.title}`,
    `工作区：${task.workspace}`,
    ``,
    `已写入独立工作区并进入执行队列；当前版本会保持主对话可用，等待执行器认领。`,
    ``,
    formatTaskCommandHints(task, { includeCreate: false }),
  ].join("\n");
}

export function formatTaskList(tasks: CustomSandboxTask[]): string {
  if (tasks.length === 0) return `🧪 当前会话暂无长任务。`;
  const lines = [`🧪 当前会话长任务`, ``];
  for (const task of tasks) {
    lines.push(`- ${task.id} [${formatTaskStatusForDisplay(task.status)}] ${task.title}`);
    lines.push(`  ${cmdInput(`/bot-task status ${task.id}`, "查看")}`);
  }
  return lines.join("\n");
}

export function formatTaskCleanupPlan(plan: CustomTaskCleanupPlan): string {
  const lines = [
    `🧹 长任务工作区清理规划（只读）`,
    ``,
    `范围：当前会话`,
    `条件：已结束任务，更新时间早于 ${formatCustomTaskCleanupDuration(plan.olderThanMs)}`,
    `候选：${plan.totalEligible}`,
  ];
  if (plan.items.length === 0) {
    lines.push(
      ``,
      `暂无可清理任务。`,
      ``,
      cmdInput(`/bot-task cleanup --older-than ${formatCustomTaskCleanupDuration(plan.olderThanMs)}`, "重新检查"),
    );
    return lines.join("\n");
  }

  lines.push(``, `候选列表：`);
  for (const item of plan.items) {
    lines.push(`- ${item.taskId} [${formatTaskStatusForDisplay(item.status)}] ${item.title}`);
    lines.push(`  更新时间：${new Date(item.updatedAt).toISOString()}；工作区：${item.workspace}`);
  }
  if (plan.truncated) {
    lines.push(``, `还有 ${plan.totalEligible - plan.items.length} 个候选未展示，请增大 --limit 或分批处理。`);
  }
  lines.push(
    ``,
    `当前命令只生成计划，不删除文件或任务状态。后续接入 --force 前仍需管理员确认和备份。`,
    cmdInput(`/bot-task cleanup --older-than ${formatCustomTaskCleanupDuration(plan.olderThanMs)} --limit ${Math.min(plan.totalEligible, 50) || 10}`, "刷新规划"),
  );
  return lines.join("\n");
}

export function formatTaskStatus(task: CustomSandboxTask): string {
  const lines = [
    `🧪 长任务状态`,
    ``,
    `任务：${task.id}`,
    `状态：${formatTaskStatusForDisplay(task.status)}`,
    `标题：${task.title}`,
    `发起人：${task.owner.label || task.owner.id}`,
    `工作区：${task.workspace}`,
    `追加需求：${task.requirements.length}`,
  ];
  if (task.execution?.executorId) lines.push(`执行器：${task.execution.executorId}`);
  if (task.execution?.runId) lines.push(`运行：${task.execution.runId}`);
  if (task.execution?.agentId) lines.push(`智能体：${task.execution.agentId}`);
  if (task.execution?.lastHeartbeatAt) lines.push(`心跳：${new Date(task.execution.lastHeartbeatAt).toISOString()}`);
  if (task.progress) {
    lines.push(...formatTaskProgressLines(task.progress));
  }
  if (task.result) lines.push(`结果：${task.result}`);
  if (task.error) lines.push(`错误：${task.error}`);
  lines.push(``, formatTaskCommandHints(task, { includeCreate: true }));
  return lines.join("\n");
}

export function formatTaskRequirementAdded(task: CustomSandboxTask): string {
  return [
    `✅ 已追加需求到 ${task.id}，当前追加需求数：${task.requirements.length}`,
    ``,
    formatTaskCommandHints(task, { includeCreate: false }),
  ].join("\n");
}

export function formatTaskCancelled(task: CustomSandboxTask): string {
  return `✅ 已取消长任务：${task.id}`;
}

export function formatTaskDecision(reason: string): string {
  if (reason === "too_many_active_tasks") return `⚠️ 当前会话活跃长任务过多，请先完成或取消一部分。`;
  if (reason === "empty_prompt") return `⚠️ 任务内容不能为空。`;
  if (reason === "not_active") return `⚠️ 任务已不处于活跃状态。`;
  if (reason === "invalid_transition") return `⚠️ 任务状态不允许执行该操作。`;
  return `⚠️ 操作失败：${reason}`;
}

function formatTaskProgressLines(progress: NonNullable<CustomSandboxTask["progress"]>): string[] {
  const lines = [];
  const parts = [];
  if (progress.percent !== undefined) parts.push(`${progress.percent}%`);
  if (progress.phase) parts.push(progress.phase);
  if (progress.message) parts.push(progress.message);
  lines.push(`进度：${parts.join(" / ") || "已更新"}`);
  lines.push(`进度时间：${new Date(progress.updatedAt).toISOString()}`);
  return lines;
}

function formatTaskCommandHints(task: CustomSandboxTask, options: { includeCreate: boolean }): string {
  const commands = [
    cmdInput(`/bot-task status ${task.id}`, "查看状态"),
  ];
  if (task.status === "queued" || task.status === "running") {
    commands.push(cmdInput(`/bot-task add ${task.id} `, "追加需求"));
    commands.push(cmdInput(`/bot-task cancel ${task.id}`, "取消任务"));
  }
  if (options.includeCreate) {
    commands.push(cmdInput(`/bot-task create `, "新建长任务"));
  }
  return commands.join(" ");
}

function cmdInput(text: string, show: string): string {
  return `<qqbot-cmd-input text="${escapeCmdAttr(text)}" show="${escapeCmdAttr(show)}"/>`;
}

function escapeCmdAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
