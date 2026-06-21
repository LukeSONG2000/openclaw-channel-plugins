import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  getAccessToken as defaultGetAccessToken,
  sendC2CMessage as defaultSendC2CMessage,
  sendC2CMessageWithInlineKeyboard as defaultSendC2CMessageWithInlineKeyboard,
  sendChannelMessage as defaultSendChannelMessage,
  sendDmMessage as defaultSendDmMessage,
  sendGroupMessage as defaultSendGroupMessage,
  sendGroupMessageWithInlineKeyboard as defaultSendGroupMessageWithInlineKeyboard,
} from "../api.js";
import type { QueuedMessage } from "../message-queue.js";
import { sendDocument as defaultSendDocument, type MediaTargetContext } from "../outbound.js";
import { sendTextToTarget as defaultSendTextToTarget } from "../reply-dispatcher.js";
import type { InlineKeyboard, ResolvedQQBotAccount } from "../types.js";
import { recordCustomFallbackEventGateway as defaultRecordCustomFallbackEventGateway } from "./fallback-record-gateway-adapter.js";
import type { CustomFallbackEvent } from "./fallbacks.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import {
  handleCustomSlashPrequeueGateway as defaultHandleCustomSlashPrequeueGateway,
  type CustomSlashPrequeueQueue,
  type CustomSlashPrequeueSendFileTarget,
  type HandleCustomSlashPrequeueGatewayParams,
  type HandleCustomSlashPrequeueGatewayResult,
} from "./slash-prequeue-gateway-adapter.js";
import type { CustomSlashReplyTarget } from "./slash-reply-target.js";
import type { CustomTaskExecutor } from "./task-executor-adapter.js";

export interface CustomSlashPrequeueHandlerGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomSlashPrequeueHandlerGatewayParams {
  cfg: OpenClawConfig;
  account: ResolvedQQBotAccount;
  runtime: CustomMessageFlowRuntime;
  queue: CustomSlashPrequeueQueue;
  getTaskExecutor?: () => CustomTaskExecutor | undefined;
  stripMentionText?: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
  getConfigApi: () => {
    loadConfig?: () => Record<string, unknown>;
    writeConfigFile: (cfg: unknown) => Promise<void>;
  };
  persistAuthState: () => void;
  persistTaskState: () => void;
  persistPollState: () => void;
  persistGameState: () => void;
  persistDeployConfirmationState: () => void;
  sendAdminGroupNotification: HandleCustomSlashPrequeueGatewayParams["effects"]["sendAdminGroupNotification"];
  log?: CustomSlashPrequeueHandlerGatewayLogger;
  getAccessToken?: typeof defaultGetAccessToken;
  sendC2CMessage?: typeof defaultSendC2CMessage;
  sendGroupMessage?: typeof defaultSendGroupMessage;
  sendChannelMessage?: typeof defaultSendChannelMessage;
  sendDmMessage?: typeof defaultSendDmMessage;
  sendC2CMessageWithInlineKeyboard?: typeof defaultSendC2CMessageWithInlineKeyboard;
  sendGroupMessageWithInlineKeyboard?: typeof defaultSendGroupMessageWithInlineKeyboard;
  sendDocument?: typeof defaultSendDocument;
  sendTextToTarget?: typeof defaultSendTextToTarget;
  recordFallbackEventGateway?: typeof defaultRecordCustomFallbackEventGateway;
  handleSlashPrequeue?: typeof defaultHandleCustomSlashPrequeueGateway;
}

export type CustomSlashPrequeueHandlerGateway = (message: QueuedMessage) => Promise<HandleCustomSlashPrequeueGatewayResult>;

export function createCustomSlashPrequeueHandlerGateway(
  params: CustomSlashPrequeueHandlerGatewayParams,
): CustomSlashPrequeueHandlerGateway {
  return async (message) => {
    const handleSlashPrequeue = params.handleSlashPrequeue ?? defaultHandleCustomSlashPrequeueGateway;
    return handleSlashPrequeue({
      cfg: params.cfg,
      account: {
        accountId: params.account.accountId,
        appId: params.account.appId,
        accountConfig: params.account.config,
      },
      runtime: params.runtime,
      message,
      queue: params.queue,
      effects: {
        getConfigApi: params.getConfigApi,
        persistAuthState: params.persistAuthState,
        persistTaskState: params.persistTaskState,
        persistPollState: params.persistPollState,
        persistGameState: params.persistGameState,
        persistDeployConfirmationState: params.persistDeployConfirmationState,
        sendAdminGroupNotification: params.sendAdminGroupNotification,
        sendTaskNotificationText: async (delivery) => {
          await (params.sendTextToTarget ?? defaultSendTextToTarget)({
            target: delivery.target,
            account: params.account,
            cfg: params.cfg,
            log: params.log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } | undefined,
          }, delivery.text);
        },
      },
      taskExecutor: params.getTaskExecutor?.(),
      stripMentionText: params.stripMentionText,
      recordFallbackEvent: (event) => {
        (params.recordFallbackEventGateway ?? defaultRecordCustomFallbackEventGateway)({
          accountId: params.account.accountId,
          event,
          log: params.log,
        });
      },
      sendText: (target, text, sourceMessage) => sendSlashPrequeueText(params, target, text, sourceMessage),
      sendKeyboard: (target, text, keyboard, sourceMessage) => sendSlashPrequeueKeyboard(params, target, text, keyboard, sourceMessage),
      sendFile: (target, filePath, sourceMessage) => sendSlashPrequeueFile(params, target, filePath, sourceMessage),
      log: params.log,
    });
  };
}

async function sendSlashPrequeueText(
  params: CustomSlashPrequeueHandlerGatewayParams,
  target: CustomSlashReplyTarget,
  text: string,
  _message: QueuedMessage,
): Promise<void> {
  const token = await (params.getAccessToken ?? defaultGetAccessToken)(params.account.appId, params.account.clientSecret);
  if (target.kind === "c2c") {
    await (params.sendC2CMessage ?? defaultSendC2CMessage)(token, target.userOpenid, text, target.msgId);
  } else if (target.kind === "group") {
    await (params.sendGroupMessage ?? defaultSendGroupMessage)(token, target.groupOpenid, text, target.msgId);
  } else if (target.kind === "channel") {
    await (params.sendChannelMessage ?? defaultSendChannelMessage)(token, target.channelId, text, target.msgId);
  } else {
    await (params.sendDmMessage ?? defaultSendDmMessage)(token, target.guildId, text, target.msgId);
  }
}

async function sendSlashPrequeueKeyboard(
  params: CustomSlashPrequeueHandlerGatewayParams,
  target: Extract<CustomSlashReplyTarget, { kind: "c2c" | "group" }>,
  text: string,
  keyboard: InlineKeyboard,
  _message: QueuedMessage,
): Promise<void> {
  const token = await (params.getAccessToken ?? defaultGetAccessToken)(params.account.appId, params.account.clientSecret);
  if (target.kind === "c2c") {
    await (params.sendC2CMessageWithInlineKeyboard ?? defaultSendC2CMessageWithInlineKeyboard)(
      token,
      target.userOpenid,
      text,
      keyboard,
      target.msgId,
    );
  } else {
    await (params.sendGroupMessageWithInlineKeyboard ?? defaultSendGroupMessageWithInlineKeyboard)(
      token,
      target.groupOpenid,
      text,
      keyboard,
      target.msgId,
    );
  }
}

async function sendSlashPrequeueFile(
  params: CustomSlashPrequeueHandlerGatewayParams,
  target: CustomSlashPrequeueSendFileTarget,
  filePath: string,
  message: QueuedMessage,
): Promise<void> {
  const mediaCtx: MediaTargetContext = {
    targetType: target.targetType,
    targetId: target.targetId,
    account: params.account,
    replyToId: message.messageId,
    logPrefix: `[qqbot:${params.account.accountId}]`,
  };
  await (params.sendDocument ?? defaultSendDocument)(mediaCtx, filePath);
}
