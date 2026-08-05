import { getAccessToken, sendC2CMessage, sendC2CMessageWithInlineKeyboard, sendGroupMessage, sendGroupMessageWithInlineKeyboard } from "../api.js";
import type { QueuedMessage } from "../message-queue.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { buildCustomAuthAdminGroupNotification, buildCustomAuthApprovalKeyboard, buildCustomAuthApprovalText } from "./auth-presentation.js";
import { isCustomRuntimeAdmin } from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import { formatCustomGroupMention, prefixCustomUserFeedbackMention } from "./identity-presentation.js";
import { formatDurationZh } from "./presentation-labels.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import {
  extractScheduledMentionActors,
  parseCustomScheduledTaskCancelIntent,
  parseCustomScheduledTaskIntent,
} from "./scheduled-task.js";
import { resolveCustomScheduledTaskCreateWithModel } from "./scheduled-task-llm-parser.js";
import type { CustomAuthorizationRuntime } from "./auth.js";
import type { CustomScheduledTaskRuntime } from "./scheduled-task.js";
import type { CustomAuthAdminGroupNotification } from "./auth-presentation.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface CustomScheduledTaskGatewayResult {
  handled: boolean;
  changed?: boolean;
}

export async function handleCustomScheduledTaskNaturalLanguage(params: {
  cfg: OpenClawConfig;
  account: ResolvedQQBotAccount;
  auth: CustomAuthorizationRuntime;
  scheduledTasks: CustomScheduledTaskRuntime;
  message: QueuedMessage;
  content: string;
  now?: number;
  persistAuthState: () => void;
  persistScheduledTaskState: () => void;
  notifyAdminGroup?: (notification: CustomAuthAdminGroupNotification & { source: "dispatch" }) => Promise<void>;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<CustomScheduledTaskGatewayResult> {
  const now = params.now ?? Date.now();
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);
  const runtimeConfig = resolveCustomRuntimeConfig(params.cfg);
  const isAdmin = isCustomRuntimeAdmin(runtimeConfig, actor);

  const cancelTaskId = parseCustomScheduledTaskCancelIntent(params.content);
  if (cancelTaskId !== null) {
    const target = resolveTaskToCancel({
      tasks: params.scheduledTasks,
      accountId: params.account.accountId,
      peer,
      actor,
      taskId: cancelTaskId,
      isAdmin,
    });
    if (!target) {
      await sendPlain(params, prefixCustomUserFeedbackMention("⚠️ 没找到你可取消的定时任务。", { peer, actor }));
      return { handled: true };
    }
    params.scheduledTasks.cancelTask({ taskId: target.id, now });
    params.persistScheduledTaskState();
    await sendPlain(params, prefixCustomUserFeedbackMention([
      "✅ 已取消定时任务",
      `周期：${formatDurationZh(target.intervalMs)}`,
      `内容：${target.prompt}`,
      `任务：${target.id}`,
    ].join("\n"), { peer, actor }));
    return { handled: true, changed: true };
  }

  const fallbackParsed = parseCustomScheduledTaskIntent(params.content, params.message);
  if (!fallbackParsed) return { handled: false };
  const modelParsed = await resolveCustomScheduledTaskCreateWithModel({
    cfg: params.cfg,
    rawContent: params.content,
    targetActors: extractScheduledMentionActors(params.message).filter((item) => !item.isBot),
  });
  const parsed = modelParsed.parsed ?? fallbackParsed;
  if (!parsed) return { handled: false };

  const created = params.scheduledTasks.createTask({
    accountId: params.account.accountId,
    peer,
    creator: actor,
    targetActors: parsed.targetActors,
    intervalMs: parsed.intervalMs,
    durationMs: parsed.durationMs,
    prompt: parsed.prompt,
    requiredCapabilities: parsed.requiredCapabilities,
    actionKind: parsed.actionKind,
    now,
  });
  if (!created.allowed || !created.task) {
    await sendPlain(params, prefixCustomUserFeedbackMention("⚠️ 没有识别出有效的定时任务，请说明周期和要做的事。", { peer, actor }));
    return { handled: true };
  }

  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const authResult = params.auth.check({
    runtime: runtimeConfig,
    scene,
    peer,
    actor,
    capability: "schedule.run",
    taskId: created.task.id,
    now,
    consumeGrant: false,
    requestApproval: !isAdmin,
    requiredCapabilities: created.task.requiredCapabilities,
    actionSummary: summarizeScheduledTask(created.task.prompt, created.task.intervalMs, parsed.durationMs),
  });
  if (authResult.intents.length) params.persistAuthState();

  if (authResult.decision.allowed) {
    params.scheduledTasks.activateTask({ taskId: created.task.id, now });
    params.persistScheduledTaskState();
    await sendPlain(params, prefixCustomUserFeedbackMention(formatScheduledTaskCreated(created.task.id, parsed.intervalMs, parsed.prompt, parsed.targetActors.length, parsed.durationMs), { peer, actor }));
    return { handled: true, changed: true };
  }

  params.persistScheduledTaskState();
  const request = authResult.intents.find((intent) => intent.kind === "request-approval")?.request;
  if (!request) {
    await sendPlain(params, prefixCustomUserFeedbackMention("⚠️ 创建定时任务需要管理员授权，但当前没有可用管理员绑定。", { peer, actor }));
    return { handled: true, changed: true };
  }
  const approvalText = buildCustomAuthApprovalText(request, params.cfg);
  const keyboard = buildCustomAuthApprovalKeyboard(request);
  await sendApproval(params, approvalText, keyboard);
  const adminNotification = buildCustomAuthAdminGroupNotification({
    request,
    sourcePeer: peer,
    text: approvalText,
    keyboard,
    copyToAdminGroup: runtimeConfig.auth?.copyRequestsToAdminGroup !== false,
  });
  if (adminNotification) await params.notifyAdminGroup?.({ ...adminNotification, source: "dispatch" });
  return { handled: true, changed: true };
}

function formatScheduledTaskCreated(taskId: string, intervalMs: number, prompt: string, targetCount: number, durationMs?: number): string {
  return [
    "✅ 定时任务已创建",
    `周期：${formatDurationZh(intervalMs)}`,
    ...(durationMs ? [`持续：${formatDurationZh(durationMs)}`] : []),
    `对象：${targetCount > 0 ? `${targetCount}人` : "当前会话"}`,
    `内容：${prompt}`,
    `任务：${taskId}`,
  ].join("\n");
}

function summarizeScheduledTask(prompt: string, intervalMs: number, durationMs?: number): string {
  return `每${formatDurationZh(intervalMs)}发送：${prompt.slice(0, 60)}${durationMs ? `；持续${formatDurationZh(durationMs)}` : ""}`;
}

function resolveTaskToCancel(params: {
  tasks: CustomScheduledTaskRuntime;
  accountId: string;
  peer: ReturnType<typeof toCustomPeerFromQueuedMessage>;
  actor: ReturnType<typeof toCustomActorFromQueuedMessage>;
  taskId: string;
  isAdmin: boolean;
}) {
  if (params.taskId) {
    const task = params.tasks.getTask(params.taskId);
    if (!task || task.accountId !== params.accountId || (task.status !== "active" && task.status !== "pending_auth")) return null;
    if (!params.isAdmin && task.creator.id.toUpperCase() !== params.actor.id.toUpperCase()) return null;
    return task;
  }
  const tasks = params.tasks.listTasks({
    accountId: params.accountId,
    peer: params.peer,
    creator: params.isAdmin ? undefined : params.actor,
    status: "open",
    limit: 1,
  });
  return tasks[0] ?? null;
}

async function sendPlain(params: Parameters<typeof handleCustomScheduledTaskNaturalLanguage>[0], text: string): Promise<void> {
  const token = await getAccessToken(params.account.appId, params.account.clientSecret);
  if (params.message.type === "group" && params.message.groupOpenid) {
    await sendGroupMessage(token, params.message.groupOpenid, text, params.message.messageId);
  } else {
    await sendC2CMessage(token, params.message.senderId, text, params.message.messageId);
  }
}

async function sendApproval(
  params: Parameters<typeof handleCustomScheduledTaskNaturalLanguage>[0],
  text: string,
  keyboard: Parameters<typeof sendGroupMessageWithInlineKeyboard>[3],
): Promise<void> {
  const token = await getAccessToken(params.account.appId, params.account.clientSecret);
  if (params.message.type === "group" && params.message.groupOpenid) {
    await sendGroupMessageWithInlineKeyboard(token, params.message.groupOpenid, text, keyboard, params.message.messageId);
  } else {
    await sendC2CMessageWithInlineKeyboard(token, params.message.senderId, text, keyboard, params.message.messageId);
  }
}

export function formatScheduledTaskFireText(task: { prompt: string; targetActors: Array<{ id: string }> }): string {
  const mentions = task.targetActors.map((actor) => formatCustomGroupMention(actor)).filter(Boolean).join(" ");
  return [mentions, task.prompt].filter(Boolean).join("\n");
}
