import type { InteractionEvent } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import {
  normalizeQQBotInboundEvent,
  type CustomInboundKnownUserRecord,
} from "./inbound-event-normalizer.js";
import { normalizeQQBotInteractionEvent } from "./interaction-event-normalizer.js";
import {
  formatCustomMessageDeleteDiagnostics,
  inspectCustomMessageDeleteEvent,
  isCustomMessageDeleteEventType,
} from "./message-delete-events.js";

export interface CustomInboundGatewayEventLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomInboundGatewayProactiveAcceptance {
  accountId: string;
  peer: { kind: "c2c" | "group"; id: string };
  accepted: boolean;
  updatedBy?: string;
  now: number;
}

export interface DispatchCustomInboundGatewayEventParams {
  accountId: string;
  eventType: string;
  data: unknown;
  recordKnownUser: (user: CustomInboundKnownUserRecord) => void;
  enqueueMessage: (message: QueuedMessage) => Promise<void> | void;
  setProactiveAcceptance: (acceptance: CustomInboundGatewayProactiveAcceptance) => void;
  persistProactiveBudgetState: () => void;
  handleInteraction: (event: InteractionEvent) => Promise<void> | void;
  log?: CustomInboundGatewayEventLogger;
}

export type DispatchCustomInboundGatewayEventResult =
  | { kind: "message"; knownUsers: number }
  | { kind: "proactive-acceptance"; accepted: boolean }
  | { kind: "group-robot"; knownUsers: number }
  | { kind: "delete-diagnostics"; logged: boolean }
  | { kind: "interaction"; id: string }
  | { kind: "unsupported" };

export async function dispatchCustomInboundGatewayEvent(
  params: DispatchCustomInboundGatewayEventParams,
): Promise<DispatchCustomInboundGatewayEventResult> {
  const normalized = normalizeQQBotInboundEvent({
    eventType: params.eventType,
    data: params.data,
    accountId: params.accountId,
  });

  if (normalized.kind === "message") {
    for (const user of normalized.knownUsers) {
      params.recordKnownUser(user);
    }
    await params.enqueueMessage(normalized.message);
    return { kind: "message", knownUsers: normalized.knownUsers.length };
  }

  if (normalized.kind === "proactive-acceptance") {
    params.log?.info?.(`[qqbot:${params.accountId}] ${normalized.logMessage}`);
    params.setProactiveAcceptance({
      accountId: params.accountId,
      peer: normalized.peer,
      accepted: normalized.accepted,
      updatedBy: normalized.updatedBy,
      now: normalized.timestampMs,
    });
    params.persistProactiveBudgetState();
    return { kind: "proactive-acceptance", accepted: normalized.accepted };
  }

  if (normalized.kind === "group-robot") {
    params.log?.info?.(`[qqbot:${params.accountId}] ${normalized.logMessage}`);
    for (const user of normalized.knownUsers) {
      params.recordKnownUser(user);
    }
    return { kind: "group-robot", knownUsers: normalized.knownUsers.length };
  }

  if (isCustomMessageDeleteEventType(params.eventType)) {
    const diagnostics = inspectCustomMessageDeleteEvent(params.eventType, params.data);
    if (diagnostics) {
      params.log?.info?.(`[qqbot:${params.accountId}] Message delete diagnostics: ${formatCustomMessageDeleteDiagnostics(diagnostics)}`);
    }
    return { kind: "delete-diagnostics", logged: Boolean(diagnostics) };
  }

  if (params.eventType === "INTERACTION_CREATE") {
    const event = params.data as InteractionEvent;
    const normalizedInteraction = normalizeQQBotInteractionEvent(event);
    params.log?.info?.(`[qqbot:${params.accountId}] Interaction: scene=${normalizedInteraction.sceneDesc}, type=${normalizedInteraction.dataType}, button_id=${normalizedInteraction.buttonId}, button_data=${normalizedInteraction.buttonData}`);
    void Promise.resolve(params.handleInteraction(event)).catch((err) => {
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to handle interaction ${event.id}: ${err}`);
    });
    return { kind: "interaction", id: event.id };
  }

  return { kind: "unsupported" };
}
