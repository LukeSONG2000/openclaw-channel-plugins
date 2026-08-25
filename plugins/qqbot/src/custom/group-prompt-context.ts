import type { QueuedMessage } from "../message-queue.js";

export interface CustomGroupPromptContextParams<TConfig = unknown> {
  cfg: TConfig;
  accountId: string;
  event: Pick<QueuedMessage, "senderId" | "senderName" | "groupOpenid">;
  resolveGroupName: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => string;
  resolveGroupIntroHint?: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => string | undefined;
  resolveGroupPrompt: (params: { cfg: TConfig; accountId: string; groupOpenid: string }) => string | undefined;
}

export interface CustomGroupPromptContext {
  senderLabel: string;
  groupSubject: string;
  baseHint: string;
  behaviorPrompt: string;
  groupSystemPrompt: string;
}

export function formatCustomGroupSenderLabel(params: {
  senderId: string;
  senderName?: string;
}): string {
  return params.senderName ? `${params.senderName} (${params.senderId})` : params.senderId;
}

export function joinCustomPromptParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

export function mergeCustomSystemPromptParts(parts: readonly unknown[]): string | undefined {
  const merged = joinCustomPromptParts(parts);
  return merged || undefined;
}

export function buildCustomGroupPromptContext<TConfig = unknown>(
  params: CustomGroupPromptContextParams<TConfig>,
): CustomGroupPromptContext {
  const groupOpenid = params.event.groupOpenid ?? "";
  const resolverCtx = {
    cfg: params.cfg,
    accountId: params.accountId,
    groupOpenid,
  };
  const baseHint = params.resolveGroupIntroHint?.(resolverCtx) ?? "";
  const behaviorPrompt = params.resolveGroupPrompt(resolverCtx) ?? "";

  return {
    senderLabel: formatCustomGroupSenderLabel(params.event),
    groupSubject: params.resolveGroupName(resolverCtx),
    baseHint,
    behaviorPrompt,
    groupSystemPrompt: joinCustomPromptParts([baseHint, behaviorPrompt]),
  };
}
