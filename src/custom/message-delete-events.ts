export type CustomMessageDeleteEventType =
  | "MESSAGE_DELETE"
  | "PUBLIC_MESSAGE_DELETE"
  | "DIRECT_MESSAGE_DELETE";

export interface CustomMessageDeleteDiagnostics {
  eventType: CustomMessageDeleteEventType;
  scope: "channel" | "channel-dm";
  messageId?: string;
  channelId?: string;
  guildId?: string;
  authorId?: string;
  operatorId?: string;
  timestamp?: string;
  rawKeys: string[];
}

const DELETE_EVENT_TYPES = new Set<string>([
  "MESSAGE_DELETE",
  "PUBLIC_MESSAGE_DELETE",
  "DIRECT_MESSAGE_DELETE",
]);

const SAFE_RAW_KEYS = [
  "id",
  "channel_id",
  "guild_id",
  "op_user_id",
  "operator_id",
  "user_id",
  "timestamp",
  "message",
];

export function isCustomMessageDeleteEventType(eventType: string): eventType is CustomMessageDeleteEventType {
  return DELETE_EVENT_TYPES.has(eventType);
}

export function inspectCustomMessageDeleteEvent(
  eventType: string,
  payload: unknown,
): CustomMessageDeleteDiagnostics | null {
  if (!isCustomMessageDeleteEventType(eventType)) return null;

  const body = asRecord(payload);
  const message = asRecord(body?.message) ?? body;
  const author = asRecord(message?.author) ?? asRecord(body?.author);
  const operator = asRecord(body?.op_user) ?? asRecord(body?.operator) ?? asRecord(body?.user);

  return {
    eventType,
    scope: eventType === "DIRECT_MESSAGE_DELETE" ? "channel-dm" : "channel",
    messageId: firstString(message?.id, body?.message_id, body?.msg_id, body?.id),
    channelId: firstString(message?.channel_id, body?.channel_id),
    guildId: firstString(message?.guild_id, body?.guild_id),
    authorId: firstString(author?.id, author?.user_openid, body?.author_id),
    operatorId: firstString(
      body?.op_user_id,
      body?.operator_id,
      body?.user_id,
      operator?.id,
      operator?.user_openid,
    ),
    timestamp: firstString(message?.timestamp, body?.timestamp),
    rawKeys: body ? safeRawKeys(body) : [],
  };
}

export function formatCustomMessageDeleteDiagnostics(diag: CustomMessageDeleteDiagnostics): string {
  const fields = [
    `event=${diag.eventType}`,
    `scope=${diag.scope}`,
    diag.messageId ? `message=${diag.messageId}` : undefined,
    diag.channelId ? `channel=${diag.channelId}` : undefined,
    diag.guildId ? `guild=${diag.guildId}` : undefined,
    diag.authorId ? `author=${diag.authorId}` : undefined,
    diag.operatorId ? `operator=${diag.operatorId}` : undefined,
    diag.timestamp ? `timestamp=${diag.timestamp}` : undefined,
    diag.rawKeys.length ? `rawKeys=${diag.rawKeys.join(",")}` : undefined,
  ].filter((field): field is string => Boolean(field));
  return fields.join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
  }
  return undefined;
}

function safeRawKeys(body: Record<string, unknown>): string[] {
  const keys = new Set(Object.keys(body));
  return SAFE_RAW_KEYS.filter((key) => keys.has(key));
}
