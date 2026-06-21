import { clearTokenCache, getAccessToken, sendC2CMessageWithInlineKeyboard, sendGroupMessageWithInlineKeyboard } from "../api.js";
import { isGroupAllowed, resolveGroupName, resolveGroupPrompt, resolveHistoryLimit, resolveIgnoreOtherMentions, resolveMentionPatterns } from "../config.js";
import { formatMessageContent, type HistoryEntry } from "../group-history.js";
import { formatVoiceText, processAttachments } from "../inbound-attachments.js";
import type { QueuedMessage } from "../message-queue.js";
import { getRefIndex, formatMessageReferenceForAgent, formatRefEntryForAgent, setRefIndex } from "../ref-index-store.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { resolveTTSConfig } from "../utils/audio-convert.js";
import { parseFaceTags } from "../utils/text-parsing.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import type { CustomAdminGroupNotificationService } from "./admin-group-notification-service-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import { runCustomMessageContextGateway } from "./message-context-gateway-adapter.js";
import { runCustomMessageDispatchGateway } from "./message-dispatch-gateway-adapter.js";
import { runCustomMessageIngressGateway } from "./message-ingress-gateway-adapter.js";
import type { CustomRuntimeServicesGatewayResult } from "./runtime-services-gateway-adapter.js";
import type { CustomUnreadScheduler } from "./unread-scheduler.js";

export interface CustomMessageHandlerGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CreateCustomMessageHandlerGatewayParams {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  pluginRuntime: any;
  runtime: CustomMessageFlowRuntime;
  groupHistories: Map<string, HistoryEntry[]>;
  customRuntimeServices: Pick<CustomRuntimeServicesGatewayResult, "resolveUnreadForEvent">;
  getQueueSnapshot: (peerId: string) => unknown;
  getUnreadScheduler: () => CustomUnreadScheduler | null;
  persistAuthState: () => void;
  persistCustomUnreadState: () => void;
  buildProactiveGuard: Parameters<typeof runCustomMessageDispatchGateway>[0]["buildProactiveGuard"];
  sendMedia: Parameters<typeof runCustomMessageDispatchGateway>[0]["sendMedia"];
  createDebouncer: Parameters<typeof runCustomMessageDispatchGateway>[0]["createDebouncer"];
  parseAndSendMediaTags: Parameters<typeof runCustomMessageDispatchGateway>[0]["parseAndSendMediaTags"];
  handleStructuredPayload: Parameters<typeof runCustomMessageDispatchGateway>[0]["handleStructuredPayload"];
  sendPlainReply: Parameters<typeof runCustomMessageDispatchGateway>[0]["sendPlainReply"];
  adminGroupNotifications: Pick<
    CustomAdminGroupNotificationService,
    "sendFallbackAdminGroupAlert" | "sendAuthAdminGroupNotification"
  >;
  isCustomRuntimeEnabled: () => boolean;
  isControlCommand: (text: string) => boolean;
  stripMentionText: (text: string, mentions: NonNullable<QueuedMessage["mentions"]>) => string | undefined;
  detectWasMentioned: Parameters<typeof runCustomMessageContextGateway>[0]["groupDispatch"]["detectWasMentioned"];
  resolveRequireMention: (input: { cfg: unknown; accountId: string; groupOpenid: string }) => boolean;
  resolveGroupIntroHint?: (input: { cfg: unknown; accountId: string; groupOpenid: string }) => string | undefined;
  log?: CustomMessageHandlerGatewayLogger;
  runIngress?: typeof runCustomMessageIngressGateway;
  runContext?: typeof runCustomMessageContextGateway;
  runDispatch?: typeof runCustomMessageDispatchGateway;
}

export type CustomMessageHandlerGateway = (event: QueuedMessage) => Promise<void>;

export function createCustomMessageHandlerGateway(
  params: CreateCustomMessageHandlerGatewayParams,
): CustomMessageHandlerGateway {
  return async (event) => {
    const { account, cfg, pluginRuntime, log } = params;
    const ingress = (params.runIngress ?? runCustomMessageIngressGateway)({
      account,
      event,
      cfg,
      getToken: () => getAccessToken(account.appId, account.clientSecret),
      clearTokenCache: () => clearTokenCache(account.appId),
      recordInboundActivity: () => pluginRuntime.channel.activity.record({
        channel: "qqbot",
        accountId: account.accountId,
        direction: "inbound",
      }),
      resolveBaseRoute: (input) => pluginRuntime.channel.routing.resolveAgentRoute(input) as any,
      routing: pluginRuntime.channel.routing as any,
      customRuntimeEnabled: params.isCustomRuntimeEnabled(),
      resolveEnvelopeOptions: (config) => pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(config),
      log,
    });
    if (ingress.action === "stop") return;

    const typing = ingress.typing;
    const messageRoute = ingress.messageRoute;
    const { peerId } = messageRoute;
    const route = ingress.route;
    const envelopeOptions = ingress.envelopeOptions;
    const qualifiedTarget = messageRoute.requestTarget;
    let agentHistoryEnvelopeOpts: unknown;

    const messageContext = await (params.runContext ?? runCustomMessageContextGateway)({
      cfg: cfg as any,
      account,
      event,
      ingress,
      unread: params.runtime.unread,
      groupHistories: params.groupHistories,
      initialCustomUnreadCfg: event._customUnreadSnapshotId
        ? params.customRuntimeServices.resolveUnreadForEvent(event)
        : null,
      hasTTS: !!resolveTTSConfig(cfg as Record<string, unknown>),
      processAttachments,
      formatVoiceText,
      parseFaceTags,
      stripMentionText: (text, mentions) => params.stripMentionText(text, mentions as any) ?? text,
      getRefEntry: getRefIndex,
      setRefEntry: setRefIndex,
      formatRefEntry: formatRefEntryForAgent,
      formatMessageReference: (ref) =>
        formatMessageReferenceForAgent(ref, { appId: account.appId, peerId, cfg, log: log as any }),
      formatInboundEnvelope: (input) =>
        pluginRuntime.channel.reply.formatInboundEnvelope(input as Parameters<typeof pluginRuntime.channel.reply.formatInboundEnvelope>[0]),
      groupDispatch: {
        isGroupAllowed: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          isGroupAllowed(groupCfg as any, groupOpenid, accountId),
        resolveMentionPatterns: ({ cfg: groupCfg, agentId }) =>
          resolveMentionPatterns(groupCfg as any, agentId),
        detectWasMentioned: (input) => params.detectWasMentioned(input),
        resolveRequireMention: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          params.resolveRequireMention({ cfg: groupCfg, accountId, groupOpenid }),
        resolveIgnoreOtherMentions: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          resolveIgnoreOtherMentions(groupCfg as any, groupOpenid, accountId),
        resolveHistoryLimit: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          resolveHistoryLimit(groupCfg as any, groupOpenid, accountId),
        resolveGroupName: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          resolveGroupName(groupCfg as any, groupOpenid, accountId),
        resolveGroupIntroHint: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          params.resolveGroupIntroHint?.({ cfg: groupCfg, accountId, groupOpenid }),
        resolveGroupPrompt: ({ cfg: groupCfg, accountId, groupOpenid }) =>
          resolveGroupPrompt(groupCfg as any, groupOpenid, accountId),
        getRefEntry: getRefIndex,
        isControlCommand: params.isControlCommand,
        applySchedulerEffects: (effects, schedulerCfg) => params.getUnreadScheduler()?.apply(effects, schedulerCfg),
        persistCustomUnreadState: params.persistCustomUnreadState,
      },
      resolveHistoryLimit: (groupOpenid, accountId) => resolveHistoryLimit(cfg as any, groupOpenid, accountId),
      formatSubMessageContent: (m) =>
        formatMessageContent({
          content: m.content ?? "",
          chatType: m.type,
          mentions: m.mentions as unknown[],
          attachments: m.attachments,
          parseFaceTags,
          stripMentionText: (text, mentions) =>
            params.stripMentionText(text, mentions as any) ?? text,
        }),
      formatMergedEnvelope: (input) =>
        pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: input.sender,
          timestamp: input.timestampMs,
          body: input.body,
          chatType: "group",
          envelope: envelopeOptions,
        }),
      formatHistoryEnvelope: (entry) => {
        agentHistoryEnvelopeOpts ??= pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);
        return pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: entry.sender,
          timestamp: entry.timestamp,
          body: entry.body,
          chatType: "group",
          envelope: agentHistoryEnvelopeOpts,
        });
      },
      finalizeInboundContext: (payload) => pluginRuntime.channel.reply.finalizeInboundContext(payload),
      log,
    });
    if (messageContext.action === "stop") return;

    await (params.runDispatch ?? runCustomMessageDispatchGateway)({
      account,
      event,
      cfg,
      route,
      qualifiedTarget,
      ctxPayload: messageContext.ctxPayload,
      userContent: messageContext.userContent,
      wasMentioned: messageContext.wasMentioned,
      shouldCatchUpUnreadAfterReply: messageContext.shouldCatchUpUnreadAfterReply,
      customUnreadCfgForEvent: messageContext.customUnreadCfgForEvent,
      runtime: {
        auth: params.runtime.auth,
        unread: params.runtime.unread,
      },
      groupHistories: params.groupHistories,
      persistAuthState: params.persistAuthState,
      persistCustomUnreadState: params.persistCustomUnreadState,
      applyUnreadSchedulerEffects: (effects, schedulerCfg) => params.getUnreadScheduler()?.apply(effects, schedulerCfg),
      buildProactiveGuard: params.buildProactiveGuard,
      sendMedia: params.sendMedia,
      getRuntime: () => resolveCustomRuntimeConfig(cfg as any),
      getQueueSnapshot: () => params.getQueueSnapshot(peerId) as any,
      sendFallbackAdminGroupAlert: (alert) => params.adminGroupNotifications.sendFallbackAdminGroupAlert(alert),
      notifyAuthAdminGroup: params.adminGroupNotifications.sendAuthAdminGroupNotification,
      sendApprovalCardWithRetry: async (sendWithRetry, target, text, keyboard) => sendWithRetry(async (token) => {
        if (target.kind === "c2c") {
          await sendC2CMessageWithInlineKeyboard(token, target.userOpenid, text, keyboard, target.messageId);
        } else {
          await sendGroupMessageWithInlineKeyboard(token, target.groupOpenid, text, keyboard, target.messageId);
        }
      }),
      createDebouncer: params.createDebouncer,
      recordOutboundActivity: () => pluginRuntime.channel.activity.record({
        channel: "qqbot",
        accountId: account.accountId,
        direction: "outbound",
      }),
      parseAndSendMediaTags: params.parseAndSendMediaTags,
      handleStructuredPayload: params.handleStructuredPayload,
      sendPlainReply: params.sendPlainReply,
      stopTyping: () => typing.stop(),
      resolveEffectiveMessagesConfig: (config, agentId) =>
        pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(config, agentId),
      dispatchReply: (input) =>
        pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(input as Parameters<typeof pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher>[0]),
      resolveHistoryLimit: (groupOpenid, accountId) => resolveHistoryLimit(cfg as any, groupOpenid, accountId),
      log,
    });
  };
}
