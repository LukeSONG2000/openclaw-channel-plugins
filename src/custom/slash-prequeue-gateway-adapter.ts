import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type {
  QueueSnapshot,
  SlashCommandContext,
  SlashCommandDelegateResult,
  SlashCommandFileResult,
  SlashCommandResult,
} from "../slash-commands.js";
import { matchSlashCommand as defaultMatchSlashCommand } from "../slash-commands.js";
import type { InlineKeyboard, QQBotAccountConfig } from "../types.js";
import type { CustomFallbackEvent } from "./fallbacks.js";
import { applyCustomSlashGatewayEffects, type ApplyCustomSlashGatewayEffectsParams } from "./slash-effects-gateway-adapter.js";
import { handleCustomSlashGatewayCommand, type CustomSlashGatewayResult } from "./slash-gateway-adapter.js";
import {
  resolveCustomSlashReplyMediaTarget,
  resolveCustomSlashReplyTarget,
  type CustomSlashReplyTarget,
} from "./slash-reply-target.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import type { CustomTaskExecutor } from "./task-executor-adapter.js";
import { applyCustomUrgentQueueBypass, type CustomUrgentQueueBypassQueue } from "./urgent-queue-bypass-gateway-adapter.js";
import {
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "./queued-message-context.js";
import {
  isCustomPollCreateNeedingModel,
  isCustomPollNaturalLanguageCreate,
  resolveCustomPollCreateWithModel,
} from "./poll-llm-parser.js";
import { dispatchRemoteCodexMessage } from "./remote-codex.js";

export interface CustomSlashPrequeueLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomSlashPrequeueQueue extends CustomUrgentQueueBypassQueue {
  enqueue: (msg: QueuedMessage) => void;
  getSnapshot: (peerId: string) => QueueSnapshot;
}

export interface CustomSlashPrequeueAccountContext {
  accountId: string;
  appId: string;
  accountConfig?: QQBotAccountConfig;
}

export type CustomSlashPrequeueEffects = Omit<
  ApplyCustomSlashGatewayEffectsParams,
  "accountId" | "cfg" | "result" | "sendText" | "sendKeyboard" | "log"
>;

export interface CustomSlashPrequeueSendFileTarget {
  targetType: "c2c" | "group" | "channel";
  targetId: string;
}

export interface HandleCustomSlashPrequeueGatewayParams {
  cfg: OpenClawConfig;
  account: CustomSlashPrequeueAccountContext;
  runtime: CustomMessageFlowRuntime;
  message: QueuedMessage;
  queue: CustomSlashPrequeueQueue;
  effects: CustomSlashPrequeueEffects;
  taskExecutor?: CustomTaskExecutor;
  stripMentionText?: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
  recordFallbackEvent?: (event: CustomFallbackEvent) => void;
  sendText: (target: CustomSlashReplyTarget, text: string, message: QueuedMessage) => Promise<void>;
  sendKeyboard: (target: Extract<CustomSlashReplyTarget, { kind: "c2c" | "group" }>, text: string, keyboard: InlineKeyboard, message: QueuedMessage) => Promise<void>;
  sendFile: (target: CustomSlashPrequeueSendFileTarget, filePath: string, message: QueuedMessage) => Promise<void>;
  matchSlashCommand?: (ctx: SlashCommandContext) => Promise<SlashCommandResult>;
  handleCustomSlashCommand?: typeof handleCustomSlashGatewayCommand;
  resolvePollCreateWithModel?: typeof resolveCustomPollCreateWithModel;
  now?: () => number;
  log?: CustomSlashPrequeueLogger;
}

export type HandleCustomSlashPrequeueGatewayResult =
  | { kind: "not-slash-enqueued"; content: string }
  | { kind: "urgent-bypass"; command: string; peerId: string; droppedQueuedMessages: number }
  | { kind: "custom-slash"; content: string; result: Extract<CustomSlashGatewayResult, { handled: true }> }
  | { kind: "model-poll-parse-reply"; content: string }
  | { kind: "framework-null-enqueued"; content: string }
  | { kind: "framework-delegate-enqueued"; content: string; delegatePrompt: string }
  | { kind: "framework-reply"; content: string; fileSent: boolean }
  | { kind: "reply-target-missing"; content: string }
  | { kind: "file-target-missing"; content: string; filePath: string }
  | { kind: "error-enqueued"; content: string; error: unknown };

export async function handleCustomSlashPrequeueGateway(
  params: HandleCustomSlashPrequeueGatewayParams,
): Promise<HandleCustomSlashPrequeueGatewayResult> {
  let content = normalizeCustomSlashPrequeueContent({
    message: params.message,
    stripMentionText: params.stripMentionText,
  });
  const receivedAt = params.now?.() ?? Date.now();
  const peerId = params.queue.getMessagePeerId(params.message);

  if (!content.startsWith("/")) {
    const shouldRouteRemoteCodex = shouldDispatchRemoteCodexPlainText(params.message);
    if (shouldRouteRemoteCodex) {
      const remoteCodex = await dispatchRemoteCodexMessage({
        cfg: params.cfg,
        accountId: params.account.accountId,
        message: params.message,
        content,
      });
      if (remoteCodex.handled) {
        if (remoteCodex.error) {
          params.log?.error?.(`[qqbot:${params.account.accountId}] remote codex dispatch failed: ${remoteCodex.error}`);
        }
        await sendSlashTextReply(params, remoteCodex.reply ?? "✅ Remote Codex 请求已处理。");
        return { kind: "framework-reply", content, fileSent: false };
      }
    }

    const customPlainTextCommand = (params.handleCustomSlashCommand ?? handleCustomSlashGatewayCommand)({
      cfg: params.cfg,
      accountId: params.account.accountId,
      runtime: params.runtime,
      message: params.message,
      rawContent: content,
      now: receivedAt,
      queueStatus: {
        peerId,
        snapshot: params.queue.getSnapshot(peerId),
      },
      taskExecutor: params.taskExecutor,
    });
    if (customPlainTextCommand.handled) {
      await applyCustomSlashGatewayEffects({
        accountId: params.account.accountId,
        cfg: params.cfg,
        result: customPlainTextCommand,
        ...params.effects,
        sourcePeer: toCustomPeerFromQueuedMessage(params.message, { queuePeerId: peerId }),
        feedbackActor: toCustomActorFromQueuedMessage(params.message),
        sendText: async (text) => { await sendSlashTextReply(params, text); },
        sendKeyboard: (text, keyboard) => sendSlashKeyboardReply(params, text, keyboard),
        log: params.log,
      });
      return { kind: "custom-slash", content, result: customPlainTextCommand };
    }

    if (isCustomPollNaturalLanguageCreate(content)) {
      const modelParsed = await (params.resolvePollCreateWithModel ?? resolveCustomPollCreateWithModel)({
        cfg: params.cfg,
        rawContent: `/bot-poll ${content}`,
      });
      if (modelParsed.handled && modelParsed.reply) {
        await sendSlashTextReply(params, modelParsed.reply);
        return { kind: "model-poll-parse-reply", content };
      }
      if (modelParsed.handled && modelParsed.content) {
        params.log?.info?.(`[qqbot:${params.account.accountId}] natural poll model parsed: ${content.slice(0, 80)} -> ${modelParsed.content.slice(0, 120)}`);
        content = modelParsed.content;
        params.message.content = modelParsed.content;
        const customPollCommand = (params.handleCustomSlashCommand ?? handleCustomSlashGatewayCommand)({
          cfg: params.cfg,
          accountId: params.account.accountId,
          runtime: params.runtime,
          message: params.message,
          rawContent: content,
          now: receivedAt,
          queueStatus: {
            peerId,
            snapshot: params.queue.getSnapshot(peerId),
          },
          taskExecutor: params.taskExecutor,
        });
        if (customPollCommand.handled) {
          await applyCustomSlashGatewayEffects({
            accountId: params.account.accountId,
            cfg: params.cfg,
            result: customPollCommand,
            ...params.effects,
            sourcePeer: toCustomPeerFromQueuedMessage(params.message, { queuePeerId: peerId }),
            feedbackActor: toCustomActorFromQueuedMessage(params.message),
            sendText: async (text) => { await sendSlashTextReply(params, text); },
            sendKeyboard: (text, keyboard) => sendSlashKeyboardReply(params, text, keyboard),
            log: params.log,
          });
          return { kind: "custom-slash", content, result: customPollCommand };
        }
      } else {
        const message = "⚠️ 投票自然语言解析暂时不可用，请稍后再试。";
        if (modelParsed.error) {
          params.log?.error?.(`[qqbot:${params.account.accountId}] natural poll model parse failed: ${modelParsed.error}`);
        }
        await sendSlashTextReply(params, message);
        return { kind: "model-poll-parse-reply", content };
      }
    }

    params.queue.enqueue(params.message);
    return { kind: "not-slash-enqueued", content };
  }

  if (/^\/codex(?:\s|$)/i.test(content)) {
    const remoteCodex = await dispatchRemoteCodexMessage({
      cfg: params.cfg,
      accountId: params.account.accountId,
      message: params.message,
      content,
    });
    if (remoteCodex.handled) {
      if (remoteCodex.error) {
        params.log?.error?.(`[qqbot:${params.account.accountId}] remote codex dispatch failed: ${remoteCodex.error}`);
      }
      await sendSlashTextReply(params, remoteCodex.reply ?? "✅ Remote Codex 请求已处理。");
      return { kind: "framework-reply", content, fileSent: false };
    }
  }

  const urgentBypass = applyCustomUrgentQueueBypass({
    accountId: params.account.accountId,
    content,
    message: params.message,
    queue: params.queue,
    recordFallbackEvent: params.recordFallbackEvent,
    log: params.log,
  });
  if (urgentBypass.handled) {
    return {
      kind: "urgent-bypass",
      command: urgentBypass.command,
      peerId: urgentBypass.peerId,
      droppedQueuedMessages: urgentBypass.droppedQueuedMessages,
    };
  }

  if (isCustomPollCreateNeedingModel(content)) {
    const modelParsed = await (params.resolvePollCreateWithModel ?? resolveCustomPollCreateWithModel)({
      cfg: params.cfg,
      rawContent: content,
    });
    if (modelParsed.handled && modelParsed.reply) {
      await sendSlashTextReply(params, modelParsed.reply);
      return { kind: "model-poll-parse-reply", content };
    }
    if (modelParsed.handled && modelParsed.content) {
      params.log?.info?.(`[qqbot:${params.account.accountId}] /bot-poll model parsed: ${content.slice(0, 80)} -> ${modelParsed.content.slice(0, 120)}`);
      content = modelParsed.content;
      params.message.content = modelParsed.content;
    } else {
      const message = "⚠️ 投票自然语言解析暂时不可用，请稍后再试。";
      if (modelParsed.error) {
        params.log?.error?.(`[qqbot:${params.account.accountId}] /bot-poll model parse failed: ${modelParsed.error}`);
      }
      await sendSlashTextReply(params, message);
      return { kind: "model-poll-parse-reply", content };
    }
  }

  const commandContext = buildSlashCommandContext({
    account: params.account,
    message: params.message,
    content,
    peerId,
    receivedAt,
    queue: params.queue,
  });

  try {
    const customSlashCommand = (params.handleCustomSlashCommand ?? handleCustomSlashGatewayCommand)({
      cfg: params.cfg,
      accountId: params.account.accountId,
      runtime: params.runtime,
      message: params.message,
      rawContent: content,
      now: receivedAt,
      queueStatus: {
        peerId,
        snapshot: commandContext.queueSnapshot,
      },
      taskExecutor: params.taskExecutor,
    });
    if (customSlashCommand.handled) {
      await applyCustomSlashGatewayEffects({
        accountId: params.account.accountId,
        cfg: params.cfg,
        result: customSlashCommand,
        ...params.effects,
        sourcePeer: toCustomPeerFromQueuedMessage(params.message, { queuePeerId: peerId }),
        feedbackActor: toCustomActorFromQueuedMessage(params.message),
        sendText: async (text) => { await sendSlashTextReply(params, text); },
        sendKeyboard: (text, keyboard) => sendSlashKeyboardReply(params, text, keyboard),
        log: params.log,
      });
      return { kind: "custom-slash", content, result: customSlashCommand };
    }

    const reply = await (params.matchSlashCommand ?? defaultMatchSlashCommand)(commandContext);
    if (reply === null) {
      params.queue.enqueue(params.message);
      return { kind: "framework-null-enqueued", content };
    }

    if (isSlashDelegateResult(reply)) {
      params.log?.info?.(`[qqbot:${params.account.accountId}] Slash command delegated to AI: ${content.slice(0, 40)}`);
      params.message.content = reply.delegatePrompt;
      params.queue.enqueue(params.message);
      return { kind: "framework-delegate-enqueued", content, delegatePrompt: reply.delegatePrompt };
    }

    params.log?.info?.(`[qqbot:${params.account.accountId}] Slash command matched: ${content}, replying directly`);
    const replyText = isSlashFileResult(reply) ? reply.text : reply;
    const replyFile = isSlashFileResult(reply) ? reply.filePath : null;
    const sent = await sendSlashTextReply(params, replyText);
    if (!sent) return { kind: "reply-target-missing", content };

    if (!replyFile) {
      return { kind: "framework-reply", content, fileSent: false };
    }

    const mediaTarget = resolveCustomSlashReplyMediaTarget(params.message);
    if (!mediaTarget) {
      params.log?.error?.(`[qqbot:${params.account.accountId}] Slash command file result is not supported for ${params.message.type} message ${params.message.messageId}`);
      return { kind: "file-target-missing", content, filePath: replyFile };
    }

    try {
      await params.sendFile(mediaTarget, replyFile, params.message);
      params.log?.info?.(`[qqbot:${params.account.accountId}] Slash command file sent: ${replyFile}`);
      return { kind: "framework-reply", content, fileSent: true };
    } catch (fileErr) {
      params.log?.error?.(`[qqbot:${params.account.accountId}] Failed to send slash command file: ${fileErr}`);
      return { kind: "framework-reply", content, fileSent: false };
    }
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.account.accountId}] Slash command error: ${err}`);
    params.queue.enqueue(params.message);
    return { kind: "error-enqueued", content, error: err };
  }
}

function shouldDispatchRemoteCodexPlainText(message: QueuedMessage): boolean {
  if (message.type !== "group") return true;
  return Boolean(message.mentions?.some((mention) => mention.is_you === true));
}

export function normalizeCustomSlashPrequeueContent(params: {
  message: QueuedMessage;
  stripMentionText?: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
}): string {
  const rawContent = (params.message.content ?? "").trim();
  if (params.message.type === "group" && params.message.mentions?.length) {
    return (params.stripMentionText?.(rawContent, params.message.mentions) ?? rawContent).trim();
  }
  return rawContent;
}

function buildSlashCommandContext(params: {
  account: CustomSlashPrequeueAccountContext;
  message: QueuedMessage;
  content: string;
  peerId: string;
  receivedAt: number;
  queue: CustomSlashPrequeueQueue;
}): SlashCommandContext {
  return {
    type: params.message.type,
    senderId: params.message.senderId,
    senderName: params.message.senderName,
    messageId: params.message.messageId,
    eventTimestamp: params.message.timestamp,
    receivedAt: params.receivedAt,
    rawContent: params.content,
    args: "",
    channelId: params.message.channelId,
    groupOpenid: params.message.groupOpenid,
    accountId: params.account.accountId,
    appId: params.account.appId,
    accountConfig: params.account.accountConfig,
    queueSnapshot: params.queue.getSnapshot(params.peerId),
  };
}

async function sendSlashTextReply(
  params: HandleCustomSlashPrequeueGatewayParams,
  text: string,
): Promise<boolean> {
  const target = resolveCustomSlashReplyTarget(params.message);
  if (!target) {
    params.log?.error?.(`[qqbot:${params.account.accountId}] Unable to resolve slash reply target for ${params.message.type} message ${params.message.messageId}`);
    return false;
  }
  await params.sendText(target, text, params.message);
  return true;
}

async function sendSlashKeyboardReply(
  params: HandleCustomSlashPrequeueGatewayParams,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (!keyboard) {
    await sendSlashTextReply(params, text);
    return;
  }
  const target = resolveCustomSlashReplyTarget(params.message);
  if (!target) {
    params.log?.error?.(`[qqbot:${params.account.accountId}] Unable to resolve slash reply target for ${params.message.type} message ${params.message.messageId}`);
    return;
  }
  if (target.kind === "c2c" || target.kind === "group") {
    await params.sendKeyboard(target, text, keyboard, params.message);
    return;
  }
  await params.sendText(target, text, params.message);
}

function isSlashFileResult(reply: SlashCommandResult): reply is SlashCommandFileResult {
  return typeof reply === "object" && reply !== null && "filePath" in reply;
}

function isSlashDelegateResult(reply: SlashCommandResult): reply is SlashCommandDelegateResult {
  return typeof reply === "object" && reply !== null && "delegatePrompt" in reply;
}
