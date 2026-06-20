export type CustomProactiveSendTargetType = "c2c" | "group";

export type CustomProactiveSendGuardDecision =
  | { allowed: true; commit?: () => void }
  | { allowed: false; reason: string };

export type CustomProactiveSendGuard = (params: {
  targetType: CustomProactiveSendTargetType;
  targetId: string;
  text: string;
}) => CustomProactiveSendGuardDecision;

export interface CustomProactiveGuardEvent {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  replyToId?: string;
  groupOpenid?: string;
}

export interface CustomProactiveGuardContext {
  proactiveGuard?: CustomProactiveSendGuard;
}

export function prepareCustomProactiveSend(
  event: CustomProactiveGuardEvent,
  context: CustomProactiveGuardContext,
  text: string,
): CustomProactiveSendGuardDecision {
  if (event.replyToId) return { allowed: true };
  if (!context.proactiveGuard) return { allowed: true };
  if (event.type === "c2c") {
    return context.proactiveGuard({ targetType: "c2c", targetId: event.senderId, text });
  }
  if (event.type === "group" && event.groupOpenid) {
    return context.proactiveGuard({ targetType: "group", targetId: event.groupOpenid, text });
  }
  return { allowed: true };
}
