import type { QueuedMessage } from "../message-queue.js";
import type { QueueSnapshot } from "../slash-commands.js";
import type { CustomFallbackDispatchStateSnapshot } from "./fallback-dispatch-state.js";
import type {
  CustomFallbackEventInputDetails,
  CustomFallbackEventKind,
} from "./fallbacks.js";
import type { CustomFallbackRecordInput } from "./fallback-record-gateway-adapter.js";
import { resolveCustomGatewayMessageRouteContext } from "./gateway-message-routing.js";
import { toCustomActorFromQueuedMessage } from "./queued-message-context.js";

export function buildCustomFallbackRecordInput(params: {
  kind: CustomFallbackEventKind;
  message: QueuedMessage;
  sessionKey?: string;
  queueSnapshot: QueueSnapshot;
  dispatchSnapshot: CustomFallbackDispatchStateSnapshot;
  reason?: string;
  timeoutMs?: number;
  details?: CustomFallbackEventInputDetails;
}): CustomFallbackRecordInput {
  const route = resolveCustomGatewayMessageRouteContext(params.message);
  return {
    kind: params.kind,
    peer: {
      ...route.customScenePeer,
      label: route.isGroupChat ? undefined : params.message.senderName,
    },
    actor: toCustomActorFromQueuedMessage(params.message),
    sessionKey: params.sessionKey,
    runId: params.message.messageId,
    messageId: params.message.messageId,
    reason: params.reason,
    timeoutMs: params.timeoutMs,
    toolDeliverCount: params.dispatchSnapshot.toolDeliverCount,
    toolTextCount: params.dispatchSnapshot.toolTextCount,
    toolMediaCount: params.dispatchSnapshot.toolMediaCount,
    hasResponse: params.dispatchSnapshot.hasResponse,
    hasBlockResponse: params.dispatchSnapshot.hasBlockResponse,
    details: {
      ...params.details,
      queueTotalPending: params.queueSnapshot.totalPending,
      queueActiveUsers: params.queueSnapshot.activeUsers,
      queueMaxConcurrentUsers: params.queueSnapshot.maxConcurrentUsers,
      queueSenderPending: params.queueSnapshot.senderPending,
      queueSenderActiveMs: params.queueSnapshot.senderActiveMs,
      queueMaxActiveMs: params.queueSnapshot.maxActiveMs,
    },
  };
}
