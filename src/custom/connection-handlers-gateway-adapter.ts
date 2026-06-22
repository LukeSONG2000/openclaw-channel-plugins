import type { ResolvedQQBotAccount } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import type { HistoryEntry } from "../group-history.js";
import type { CustomAdminGroupNotificationService } from "./admin-group-notification-service-gateway-adapter.js";
import type { CustomTaskCommandExecutor } from "./task-command-executor.js";
import type { CustomTaskNotificationSendText } from "./task-notification-gateway-adapter.js";
import type { CustomUnreadScheduler } from "./unread-scheduler.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import {
  createCustomRuntimeServicesGateway,
  type CustomRuntimeServicesGatewayResult,
} from "./runtime-services-gateway-adapter.js";
import {
  createCustomMessageHandlerGateway,
  type CreateCustomMessageHandlerGatewayParams,
  type CustomMessageHandlerGateway,
} from "./message-handler-gateway-adapter.js";
import {
  createCustomInteractionCreateHandlerGateway,
  type CustomInteractionCreateHandlerGateway,
  type CustomInteractionCreateHandlerGatewayParams,
} from "./interaction-create-handler-gateway-adapter.js";
import {
  createCustomInboundEventHandlerGateway,
  type CustomInboundEventHandlerGateway,
} from "./inbound-event-handler-gateway-adapter.js";

export interface CustomConnectionHandlersGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CreateCustomConnectionHandlersGatewayParams {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  pluginRuntime: any;
  runtime: CustomMessageFlowRuntime;
  previousTaskExecutor: CustomTaskCommandExecutor | null;
  enqueueMessage: (message: QueuedMessage) => Promise<void> | void;
  getQueueSnapshot: (peerId: string) => unknown;
  persistAuthState: () => void;
  persistProactiveBudgetState: () => void;
  persistTaskState: () => void;
  persistPollState: () => void;
  persistGameState: () => void;
  persistDeployConfirmationState: () => void;
  persistUnreadState: () => void;
  sendTaskStatusText: CustomTaskNotificationSendText;
  buildProactiveGuard: CreateCustomMessageHandlerGatewayParams["buildProactiveGuard"];
  sendMedia: CreateCustomMessageHandlerGatewayParams["sendMedia"];
  createDebouncer: CreateCustomMessageHandlerGatewayParams["createDebouncer"];
  parseAndSendMediaTags: CreateCustomMessageHandlerGatewayParams["parseAndSendMediaTags"];
  handleStructuredPayload: CreateCustomMessageHandlerGatewayParams["handleStructuredPayload"];
  sendPlainReply: CreateCustomMessageHandlerGatewayParams["sendPlainReply"];
  adminGroupNotifications: Pick<
    CustomAdminGroupNotificationService,
    "sendFallbackAdminGroupAlert" | "sendAuthAdminGroupNotification"
  >;
  isCustomRuntimeEnabled: () => boolean;
  isControlCommand: (text: string) => boolean;
  stripMentionText: CreateCustomMessageHandlerGatewayParams["stripMentionText"];
  detectWasMentioned: CreateCustomMessageHandlerGatewayParams["detectWasMentioned"];
  resolveRequireMention: CreateCustomMessageHandlerGatewayParams["resolveRequireMention"];
  resolveGroupIntroHint?: CreateCustomMessageHandlerGatewayParams["resolveGroupIntroHint"];
  getConfigApi: CustomInteractionCreateHandlerGatewayParams["getConfigApi"];
  getRouting?: CustomInteractionCreateHandlerGatewayParams["getRouting"];
  getLegacyApprovalHandler?: CustomInteractionCreateHandlerGatewayParams["getLegacyApprovalHandler"];
  log?: CustomConnectionHandlersGatewayLogger;
  groupHistories?: Map<string, HistoryEntry[]>;
  createRuntimeServices?: typeof createCustomRuntimeServicesGateway;
  createMessageHandler?: typeof createCustomMessageHandlerGateway;
  createInteractionHandler?: typeof createCustomInteractionCreateHandlerGateway;
  createInboundEventHandler?: typeof createCustomInboundEventHandlerGateway;
}

export interface CustomConnectionHandlersGatewayResult {
  taskExecutor: CustomTaskCommandExecutor;
  unreadScheduler: CustomUnreadScheduler;
  customRuntimeServices: CustomRuntimeServicesGatewayResult;
  groupHistories: Map<string, HistoryEntry[]>;
  handleMessage: CustomMessageHandlerGateway;
  handleInteraction: CustomInteractionCreateHandlerGateway;
  dispatchInboundEvent: (eventType: string, data: unknown) => Promise<void>;
}

export function createCustomConnectionHandlersGateway(
  params: CreateCustomConnectionHandlersGatewayParams,
): CustomConnectionHandlersGatewayResult {
  const customRuntimeServices = (params.createRuntimeServices ?? createCustomRuntimeServicesGateway)({
    cfg: params.cfg as any,
    accountId: params.account.accountId,
    runtime: params.runtime,
    previousTaskExecutor: params.previousTaskExecutor,
    enqueueMessage: params.enqueueMessage,
    persistTaskState: params.persistTaskState,
    persistPollState: params.persistPollState,
    persistUnreadState: params.persistUnreadState,
    sendTaskStatusText: params.sendTaskStatusText,
    sendPollResultText: params.sendTaskStatusText as any,
    log: params.log,
  }) as CustomRuntimeServicesGatewayResult;

  const groupHistories = params.groupHistories ?? new Map<string, HistoryEntry[]>();
  const unreadScheduler = customRuntimeServices.unreadScheduler as CustomUnreadScheduler;

  const handleMessage = (params.createMessageHandler ?? createCustomMessageHandlerGateway)({
    account: params.account,
    cfg: params.cfg,
    pluginRuntime: params.pluginRuntime,
    runtime: params.runtime,
    groupHistories,
    customRuntimeServices,
    getQueueSnapshot: params.getQueueSnapshot,
    getUnreadScheduler: () => unreadScheduler,
    persistAuthState: params.persistAuthState,
    persistCustomUnreadState: params.persistUnreadState,
    buildProactiveGuard: params.buildProactiveGuard,
    sendMedia: params.sendMedia,
    createDebouncer: params.createDebouncer,
    parseAndSendMediaTags: params.parseAndSendMediaTags,
    handleStructuredPayload: params.handleStructuredPayload,
    sendPlainReply: params.sendPlainReply,
    adminGroupNotifications: params.adminGroupNotifications,
    isCustomRuntimeEnabled: params.isCustomRuntimeEnabled,
    isControlCommand: params.isControlCommand,
    stripMentionText: params.stripMentionText,
    detectWasMentioned: params.detectWasMentioned,
    resolveRequireMention: params.resolveRequireMention,
    resolveGroupIntroHint: params.resolveGroupIntroHint,
    log: params.log,
  });

  const handleInteraction = (params.createInteractionHandler ?? createCustomInteractionCreateHandlerGateway)({
    account: params.account,
    cfg: params.cfg,
    runtime: {
      auth: params.runtime.auth,
      polls: params.runtime.polls,
      games: params.runtime.games,
      deployConfirmations: params.runtime.deployConfirmations,
    },
    persistAuthState: params.persistAuthState,
    persistPollState: params.persistPollState,
    persistGameState: params.persistGameState,
    persistDeployConfirmationState: params.persistDeployConfirmationState,
    getConfigApi: params.getConfigApi,
    getRouting: params.getRouting,
    getLegacyApprovalHandler: params.getLegacyApprovalHandler,
    log: params.log,
  });

  const inboundEventHandler: CustomInboundEventHandlerGateway = (params.createInboundEventHandler ?? createCustomInboundEventHandlerGateway)({
    accountId: params.account.accountId,
    runtime: params.runtime,
    enqueueMessage: params.enqueueMessage,
    persistProactiveBudgetState: params.persistProactiveBudgetState,
    handleInteraction: async (event) => {
      await handleInteraction(event);
    },
    log: params.log,
  });

  return {
    taskExecutor: customRuntimeServices.taskExecutor as CustomTaskCommandExecutor,
    unreadScheduler,
    customRuntimeServices,
    groupHistories,
    handleMessage,
    handleInteraction,
    dispatchInboundEvent: async (eventType, data) => {
      await inboundEventHandler(eventType, data);
    },
  };
}
