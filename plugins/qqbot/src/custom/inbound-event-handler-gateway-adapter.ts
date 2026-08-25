import type { InteractionEvent } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import { recordKnownUser as defaultRecordKnownUser } from "../known-users.js";
import {
  dispatchCustomInboundGatewayEvent as defaultDispatchCustomInboundGatewayEvent,
  type CustomInboundGatewayEventLogger,
  type DispatchCustomInboundGatewayEventResult,
} from "./inbound-event-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";

export interface CustomInboundEventHandlerGatewayParams {
  accountId: string;
  runtime: Pick<CustomMessageFlowRuntime, "proactiveBudget">;
  enqueueMessage: (message: QueuedMessage) => Promise<void> | void;
  persistProactiveBudgetState: () => void;
  handleInteraction: (event: InteractionEvent) => Promise<void> | void;
  recordKnownUser?: typeof defaultRecordKnownUser;
  dispatchInboundEvent?: typeof defaultDispatchCustomInboundGatewayEvent;
  log?: CustomInboundGatewayEventLogger;
}

export type CustomInboundEventHandlerGateway = (
  eventType: string,
  data: unknown,
) => Promise<DispatchCustomInboundGatewayEventResult>;

export function createCustomInboundEventHandlerGateway(
  params: CustomInboundEventHandlerGatewayParams,
): CustomInboundEventHandlerGateway {
  return async (eventType, data) => {
    return (params.dispatchInboundEvent ?? defaultDispatchCustomInboundGatewayEvent)({
      eventType,
      data,
      accountId: params.accountId,
      recordKnownUser: params.recordKnownUser ?? defaultRecordKnownUser,
      enqueueMessage: params.enqueueMessage,
      setProactiveAcceptance: (acceptance) => {
        params.runtime.proactiveBudget.setAcceptance(acceptance);
      },
      persistProactiveBudgetState: params.persistProactiveBudgetState,
      handleInteraction: params.handleInteraction,
      log: params.log,
    });
  };
}
