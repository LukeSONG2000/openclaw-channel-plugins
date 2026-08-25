import type { QueuedMessage } from "../message-queue.js";
import {
  StreamingController,
  shouldUseStreaming as defaultShouldUseStreaming,
  type StreamingControllerDeps,
} from "../streaming.js";
import type { ResolvedQQBotAccount } from "../types.js";

export interface CustomDispatchStreamingSetupLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export type CustomDispatchStreamingTargetType = "c2c" | "group" | "channel";

export interface SetupCustomDispatchStreamingGatewayParams<
  TController = StreamingController,
> {
  account: ResolvedQQBotAccount;
  event: QueuedMessage;
  replyAnchorId?: string;
  log?: CustomDispatchStreamingSetupLogger;
  shouldUseStreaming?: typeof defaultShouldUseStreaming;
  createController?: (deps: StreamingControllerDeps) => TController;
}

export interface SetupCustomDispatchStreamingGatewayResult<
  TController = StreamingController,
> {
  targetType: CustomDispatchStreamingTargetType;
  useStreaming: boolean;
  streamingController: TController | null;
}

export function setupCustomDispatchStreamingGateway<
  TController = StreamingController,
>(
  params: SetupCustomDispatchStreamingGatewayParams<TController>,
): SetupCustomDispatchStreamingGatewayResult<TController> {
  const targetType = resolveStreamingTargetType(params.event);
  const shouldUseStreaming = params.shouldUseStreaming ?? defaultShouldUseStreaming;
  const useStreaming = shouldUseStreaming(params.account, targetType);
  params.log?.info(`[qqbot:${params.account.accountId}] Streaming ${useStreaming ? "enabled" : "disabled"} for ${targetType} message from ${params.event.senderId}`);

  if (!useStreaming || !params.replyAnchorId) {
    return {
      targetType,
      useStreaming,
      streamingController: null,
    };
  }

  params.log?.info(`[qqbot:${params.account.accountId}] Streaming mode enabled for ${targetType} target`);
  const createController = params.createController
    ?? ((deps: StreamingControllerDeps) => new StreamingController(deps) as unknown as TController);
  return {
    targetType,
    useStreaming,
    streamingController: createController({
      account: params.account,
      userId: params.event.senderId,
      replyToMsgId: params.replyAnchorId,
      eventId: params.event.messageId,
      logPrefix: `[qqbot:${params.account.accountId}:streaming]`,
      log: params.log,
      mediaContext: {
        account: params.account,
        event: {
          type: params.event.type as "c2c" | "group" | "channel",
          senderId: params.event.senderId,
          messageId: params.event.messageId,
          groupOpenid: params.event.groupOpenid,
          channelId: params.event.channelId,
        },
        log: params.log,
      },
    }),
  };
}

export function resolveStreamingTargetType(
  event: Pick<QueuedMessage, "type">,
): CustomDispatchStreamingTargetType {
  if (event.type === "c2c") return "c2c";
  if (event.type === "group") return "group";
  return "channel";
}
