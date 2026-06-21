import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import type { CustomSandboxTask, CustomTaskIntent, CustomTaskRequirement, CustomTaskSandboxRuntimeState } from "./types.js";
import { CustomTaskSandboxRuntime } from "./task-sandbox.js";
import type { CustomTaskSandboxConfig } from "./task-sandbox.js";
import { evaluateCustomTaskPeerAccess, formatCustomTaskOutOfScope } from "./task-access.js";
import {
  buildCustomTaskCleanupPlan,
  formatCustomTaskCleanupDuration,
  parseCustomTaskCleanupDuration,
  parseCustomTaskCleanupLimit,
  type CustomTaskCleanupPlan,
} from "./task-cleanup.js";

export type CustomTaskCommand =
  | { kind: "help" }
  | { kind: "create"; prompt: string }
  | { kind: "list" }
  | { kind: "status"; taskId: string }
  | { kind: "add"; taskId: string; content: string }
  | { kind: "cancel"; taskId: string }
  | { kind: "cleanup-plan"; olderThanMs?: number; limit?: number };

export type CustomTaskCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomTaskCommand; error?: string };

export interface CustomTaskCommandResult {
  handled: boolean;
  reply?: string;
  keyboard?: InlineKeyboard;
  changed?: boolean;
  task?: CustomSandboxTask;
  requirement?: CustomTaskRequirement;
  intents?: CustomTaskIntent[];
  change?: "created" | "requirement-added" | "cancelled";
}

export function parseCustomTaskCommand(rawContent: string): CustomTaskCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-task") return { matched: false };

  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "create" || action === "new" || action === "start") {
    const prompt = tokens.join(" ").trim();
    if (!prompt) return { matched: true, error: "缺少任务描述" };
    return { matched: true, command: { kind: "create", prompt } };
  }
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "cleanup" || action === "cleanup-plan" || action === "prune" || action === "prune-plan") {
    const parsed = parseCleanupPlanOptions(tokens);
    return parsed.error
      ? { matched: true, error: parsed.error }
      : { matched: true, command: { kind: "cleanup-plan", olderThanMs: parsed.olderThanMs, limit: parsed.limit } };
  }
  if (action === "status" || action === "show") {
    const taskId = tokens.shift();
    if (!taskId) return { matched: true, error: "缺少 taskId" };
    return { matched: true, command: { kind: "status", taskId } };
  }
  if (action === "add" || action === "append") {
    const taskId = tokens.shift();
    const text = tokens.join(" ").trim();
    if (!taskId) return { matched: true, error: "缺少 taskId" };
    if (!text) return { matched: true, error: "缺少追加需求内容" };
    return { matched: true, command: { kind: "add", taskId, content: text } };
  }
  if (action === "cancel" || action === "stop") {
    const taskId = tokens.shift();
    if (!taskId) return { matched: true, error: "缺少 taskId" };
    return { matched: true, command: { kind: "cancel", taskId } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomTaskCommand(params: {
  accountId: string;
  tasks: CustomTaskSandboxRuntime;
  message: QueuedMessage;
  rawContent: string;
  taskConfig?: CustomTaskSandboxConfig;
  now?: number;
}): CustomTaskCommandResult {
  const parsed = parseCustomTaskCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatCustomTaskHelp(parsed.error) };
  const command = parsed.command ?? { kind: "help" as const };
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);

  if (command.kind === "help") return { handled: true, reply: formatCustomTaskHelp() };
  if (command.kind === "create") {
    const result = params.tasks.createTask({
      accountId: params.accountId,
      peer,
      actor,
      prompt: command.prompt,
      config: params.taskConfig,
      now: params.now,
    });
    if (!result.allowed || !result.task) {
      return { handled: true, reply: formatTaskDecision(result.reason), changed: false };
    }
    return { handled: true, reply: formatTaskCreated(result.task), keyboard: buildCustomTaskKeyboard(result.task), changed: true, task: result.task, intents: result.intents, change: "created" };
  }
  if (command.kind === "list") {
    const tasks = params.tasks.listTasks({ accountId: params.accountId, peer, limit: 8 });
    return { handled: true, reply: formatTaskList(tasks) };
  }
  if (command.kind === "cleanup-plan") {
    const plan = buildCustomTaskCleanupPlan(params.tasks.getState(), {
      accountId: params.accountId,
      peer,
      olderThanMs: command.olderThanMs,
      limit: command.limit,
      now: params.now,
    });
    return { handled: true, reply: formatTaskCleanupPlan(plan) };
  }
  if (command.kind === "status") {
    const task = resolveTask(params.tasks.getState(), command.taskId);
    if (!task || !canReadTask(task, params.accountId, peer, actor)) {
      return { handled: true, reply: formatCustomTaskOutOfScope(command.taskId) };
    }
    return { handled: true, reply: formatTaskStatus(task), keyboard: buildCustomTaskKeyboard(task) };
  }
  if (command.kind === "add") {
    const task = resolveTask(params.tasks.getState(), command.taskId);
    if (!task) return { handled: true, reply: `⚠️ 未找到任务：${command.taskId}` };
    const result = params.tasks.addRequirement({ taskId: task.id, actor, content: command.content, now: params.now });
    return {
      handled: true,
      reply: result.allowed && result.task ? formatTaskRequirementAdded(result.task) : formatTaskDecision(result.reason),
      keyboard: result.allowed && result.task ? buildCustomTaskKeyboard(result.task) : undefined,
      changed: result.allowed,
      task: result.task,
      requirement: result.requirement,
      intents: result.intents,
      change: result.allowed ? "requirement-added" : undefined,
    };
  }
  if (command.kind === "cancel") {
    const task = resolveTask(params.tasks.getState(), command.taskId);
    if (!task) return { handled: true, reply: `⚠️ 未找到任务：${command.taskId}` };
    const result = params.tasks.cancelTask({ taskId: task.id, actor, now: params.now });
    return {
      handled: true,
      reply: result.allowed && result.task ? formatTaskCancelled(result.task) : formatTaskDecision(result.reason),
      keyboard: result.allowed && result.task ? buildCustomTaskKeyboard(result.task) : undefined,
      changed: result.allowed,
      task: result.task,
      intents: result.intents,
      change: result.allowed ? "cancelled" : undefined,
    };
  }

  return { handled: true, reply: formatCustomTaskHelp() };
}

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

function formatCustomTaskHelp(error?: string): string {
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

function parseCleanupPlanOptions(tokens: string[]): { olderThanMs?: number; limit?: number; error?: string } {
  const result: { olderThanMs?: number; limit?: number; error?: string } = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const readValue = () => {
      if (i + 1 >= tokens.length) return undefined;
      i += 1;
      return tokens[i];
    };
    if (token === "--older-than" || token === "--age") {
      const value = readValue();
      const duration = parseCustomTaskCleanupDuration(value);
      if (!duration) return { error: "--older-than 需要正数时长，例如 7d、12h、30m" };
      result.olderThanMs = duration;
    } else if (token.startsWith("--older-than=")) {
      const duration = parseCustomTaskCleanupDuration(token.slice("--older-than=".length));
      if (!duration) return { error: "--older-than 需要正数时长，例如 7d、12h、30m" };
      result.olderThanMs = duration;
    } else if (token.startsWith("--age=")) {
      const duration = parseCustomTaskCleanupDuration(token.slice("--age=".length));
      if (!duration) return { error: "--age 需要正数时长，例如 7d、12h、30m" };
      result.olderThanMs = duration;
    } else if (token === "--limit") {
      const value = readValue();
      const limit = parseCustomTaskCleanupLimit(value);
      if (!limit) return { error: "--limit 需要 1-50 之间的整数" };
      result.limit = limit;
    } else if (token.startsWith("--limit=")) {
      const limit = parseCustomTaskCleanupLimit(token.slice("--limit=".length));
      if (!limit) return { error: "--limit 需要 1-50 之间的整数" };
      result.limit = limit;
    } else {
      return { error: `未知 cleanup 参数：${token}` };
    }
  }
  return result;
}

function formatTaskCreated(task: CustomSandboxTask): string {
  return [
    `🧪 长任务已创建`,
    ``,
    `任务：${task.id}`,
    `状态：${task.status}`,
    `标题：${task.title}`,
    `工作区：${task.workspace}`,
    ``,
    `已写入独立工作区并进入执行队列；当前版本会保持主对话可用，等待执行器认领。`,
    ``,
    formatTaskCommandHints(task, { includeCreate: false }),
  ].join("\n");
}

function formatTaskList(tasks: CustomSandboxTask[]): string {
  if (tasks.length === 0) return `🧪 当前会话暂无长任务。`;
  const lines = [`🧪 当前会话长任务`, ``];
  for (const task of tasks) {
    lines.push(`- ${task.id} [${task.status}] ${task.title}`);
    lines.push(`  ${cmdInput(`/bot-task status ${task.id}`, "查看")}`);
  }
  return lines.join("\n");
}

function formatTaskCleanupPlan(plan: CustomTaskCleanupPlan): string {
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
    lines.push(`- ${item.taskId} [${item.status}] ${item.title}`);
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

function formatTaskStatus(task: CustomSandboxTask): string {
  const lines = [
    `🧪 长任务状态`,
    ``,
    `任务：${task.id}`,
    `状态：${task.status}`,
    `标题：${task.title}`,
    `发起人：${task.owner.label || task.owner.id}`,
    `工作区：${task.workspace}`,
    `追加需求：${task.requirements.length}`,
  ];
  if (task.execution?.executorId) lines.push(`执行器：${task.execution.executorId}`);
  if (task.execution?.runId) lines.push(`运行：${task.execution.runId}`);
  if (task.execution?.agentId) lines.push(`Agent：${task.execution.agentId}`);
  if (task.execution?.lastHeartbeatAt) lines.push(`心跳：${new Date(task.execution.lastHeartbeatAt).toISOString()}`);
  if (task.progress) {
    lines.push(...formatTaskProgressLines(task.progress));
  }
  if (task.result) lines.push(`结果：${task.result}`);
  if (task.error) lines.push(`错误：${task.error}`);
  lines.push(``, formatTaskCommandHints(task, { includeCreate: true }));
  return lines.join("\n");
}

function formatTaskRequirementAdded(task: CustomSandboxTask): string {
  return [
    `✅ 已追加需求到 ${task.id}，当前追加需求数：${task.requirements.length}`,
    ``,
    formatTaskCommandHints(task, { includeCreate: false }),
  ].join("\n");
}

function formatTaskCancelled(task: CustomSandboxTask): string {
  return `✅ 已取消长任务：${task.id}`;
}

function formatTaskDecision(reason: string): string {
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

function resolveTask(state: CustomTaskSandboxRuntimeState, input: string): CustomSandboxTask | null {
  if (state.tasks[input]) return state.tasks[input];
  const matches = Object.values(state.tasks).filter((task) => task.id.startsWith(input) || task.id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function canReadTask(
  task: CustomSandboxTask,
  accountId: string,
  peer: ReturnType<typeof toCustomPeerFromQueuedMessage>,
  actor: ReturnType<typeof toCustomActorFromQueuedMessage>,
): boolean {
  return evaluateCustomTaskPeerAccess({
    task,
    accountId,
    peer,
    actor,
    operation: "read",
  }).allowed;
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
