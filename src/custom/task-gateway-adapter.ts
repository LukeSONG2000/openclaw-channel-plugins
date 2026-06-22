import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard } from "../types.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import type { CustomSandboxTask, CustomTaskIntent, CustomTaskRequirement, CustomTaskSandboxRuntimeState } from "./types.js";
import { CustomTaskSandboxRuntime } from "./task-sandbox.js";
import type { CustomTaskSandboxConfig } from "./task-sandbox.js";
import { evaluateCustomTaskPeerAccess, formatCustomTaskOutOfScope } from "./task-access.js";
import { buildCustomTaskCleanupPlan } from "./task-cleanup.js";
import { parseCustomTaskCommand } from "./task-command-parser.js";
import {
  buildCustomTaskKeyboard,
  formatCustomTaskHelp,
  formatTaskCleanupPlan,
  formatTaskCancelled,
  formatTaskCreated,
  formatTaskDecision,
  formatTaskList,
  formatTaskRequirementAdded,
  formatTaskStatus,
} from "./task-presentation.js";
export { buildCustomTaskKeyboard } from "./task-presentation.js";
export {
  parseCustomTaskCommand,
  type CustomTaskCommand,
  type CustomTaskCommandParseResult,
} from "./task-command-parser.js";

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
