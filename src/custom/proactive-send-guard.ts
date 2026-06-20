export type CustomProactiveSendTargetType = "c2c" | "group";
export type CustomProactiveSendPayloadKind = "text" | "image" | "voice" | "video" | "file" | "media";

export type CustomProactiveSendGuardDecision =
  | { allowed: true; commit?: () => void }
  | { allowed: false; reason: string };

export type CustomProactiveSendGuard = (params: {
  targetType: CustomProactiveSendTargetType;
  targetId: string;
  text: string;
  kind?: CustomProactiveSendPayloadKind;
  mediaUrl?: string;
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

export type CustomProactiveSendPayload =
  | string
  | {
      kind: CustomProactiveSendPayloadKind;
      text?: string;
      mediaUrl?: string;
    };

export function prepareCustomProactiveSend(
  event: CustomProactiveGuardEvent,
  context: CustomProactiveGuardContext,
  payload: CustomProactiveSendPayload,
): CustomProactiveSendGuardDecision {
  if (event.replyToId) return { allowed: true };
  if (!context.proactiveGuard) return { allowed: true };
  const normalized = normalizePayload(payload);
  if (event.type === "c2c") {
    return context.proactiveGuard({ targetType: "c2c", targetId: event.senderId, ...normalized });
  }
  if (event.type === "group" && event.groupOpenid) {
    return context.proactiveGuard({ targetType: "group", targetId: event.groupOpenid, ...normalized });
  }
  return { allowed: true };
}

function normalizePayload(payload: CustomProactiveSendPayload): {
  text: string;
  kind: CustomProactiveSendPayloadKind;
  mediaUrl?: string;
} {
  if (typeof payload === "string") {
    return { kind: "text", text: payload };
  }
  return {
    kind: payload.kind,
    text: payload.text?.trim() || formatPayloadText(payload.kind, payload.mediaUrl),
    mediaUrl: payload.mediaUrl,
  };
}

function formatPayloadText(kind: CustomProactiveSendPayloadKind, mediaUrl?: string): string {
  if (kind === "text") return "";
  const suffix = mediaUrl ? ` ${mediaUrl}` : "";
  return `[${kind}]${suffix}`;
}
