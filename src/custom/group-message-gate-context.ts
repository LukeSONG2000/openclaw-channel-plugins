import type { QueuedMessage } from "../message-queue.js";
import {
  resolveGroupMessageGate,
  type GroupMessageGateResult,
} from "../message-gating.js";

export type CustomGroupMention = NonNullable<QueuedMessage["mentions"]>[number];

export interface CustomGroupMessageGateContextParams {
  content?: string | null;
  contentForCommand?: string;
  mentions?: readonly CustomGroupMention[];
  wasMentioned: boolean;
  implicitMention: boolean;
  isCustomUnreadSynthetic?: boolean;
  ignoreOtherMentions: boolean;
  allowTextCommands: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  requireMention: boolean;
  canDetectMention?: boolean;
}

export interface CustomGroupMessageGateContext {
  contentForCommand: string;
  hasAnyMention: boolean;
  wasMentionedForGate: boolean;
  ignoreOtherMentionsForGate: boolean;
  requireMentionForGate: boolean;
  allowTextCommands: boolean;
  isControlCommand: boolean;
  gate: GroupMessageGateResult;
}

export function normalizeGroupMessageContentForCommand(content: unknown): string {
  return String(content ?? "").trim();
}

export function shouldHandleCustomTextCommands(cfg: Record<string, unknown>): boolean {
  const commands = cfg.commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return true;
  return (commands as { text?: unknown }).text !== false;
}

export function hasAnyCustomGroupMention(params: {
  mentions?: readonly CustomGroupMention[];
  content?: string | null;
}): boolean {
  if (params.mentions && params.mentions.length > 0) return true;
  if (params.content && /<@!?\w+>/.test(params.content)) return true;
  return false;
}

export function resolveCustomGroupImplicitMention(params: {
  refMsgIdx?: string;
  getRefEntry: (idx: string) => { isBot?: boolean } | null | undefined;
}): boolean {
  if (!params.refMsgIdx) return false;
  return params.getRefEntry(params.refMsgIdx)?.isBot === true;
}

export function buildCustomGroupMessageGateContext(
  params: CustomGroupMessageGateContextParams,
): CustomGroupMessageGateContext {
  const synthetic = params.isCustomUnreadSynthetic === true;
  const contentForCommand = params.contentForCommand
    ?? normalizeGroupMessageContentForCommand(params.content);
  const hasAnyMention = hasAnyCustomGroupMention({
    mentions: params.mentions,
    content: params.content,
  });
  const wasMentionedForGate = synthetic ? true : params.wasMentioned;
  const ignoreOtherMentionsForGate = synthetic ? false : params.ignoreOtherMentions;
  const requireMentionForGate = synthetic ? false : params.requireMention;
  const allowTextCommands = params.allowTextCommands;
  const isControlCommand = params.isControlCommand;

  return {
    contentForCommand,
    hasAnyMention,
    wasMentionedForGate,
    ignoreOtherMentionsForGate,
    requireMentionForGate,
    allowTextCommands,
    isControlCommand,
    gate: resolveGroupMessageGate({
      ignoreOtherMentions: ignoreOtherMentionsForGate,
      hasAnyMention,
      wasMentioned: wasMentionedForGate,
      implicitMention: params.implicitMention,
      allowTextCommands,
      isControlCommand,
      commandAuthorized: params.commandAuthorized,
      requireMention: requireMentionForGate,
      canDetectMention: params.canDetectMention ?? true,
    }),
  };
}
