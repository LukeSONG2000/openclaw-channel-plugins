import type { QueuedMessage } from "../message-queue.js";
import { clearCustomFallbackEvents, loadCustomFallbackEvents } from "./fallback-event-store.js";
import type { CustomFallbackEvent } from "./fallbacks.js";
import {
  CUSTOM_FALLBACK_DEFAULT_LIST_LIMIT,
  parseCustomFallbackCommand,
} from "./fallback-command-parser.js";
import {
  formatCustomFallbackClearHelp,
  formatCustomFallbackHelp,
  formatCustomFallbackList,
  formatCustomFallbackSummary,
} from "./fallback-presentation.js";

export {
  CUSTOM_FALLBACK_DEFAULT_LIST_LIMIT,
  CUSTOM_FALLBACK_DEFAULT_SUMMARY_LIMIT,
  CUSTOM_FALLBACK_MAX_LIST_LIMIT,
  CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT,
  parseCustomFallbackCommand,
  type CustomFallbackCommand,
  type CustomFallbackCommandParseResult,
} from "./fallback-command-parser.js";

export {
  formatCustomFallbackClearHelp,
  formatCustomFallbackHelp,
  formatCustomFallbackList,
  formatCustomFallbackSummary,
} from "./fallback-presentation.js";

export interface CustomFallbackCommandResult {
  handled: boolean;
  reply?: string;
}

export interface CustomFallbackCommandStore {
  loadEvents: (accountId: string, limit: number) => CustomFallbackEvent[];
  clearEvents?: (accountId: string) => boolean;
}

export function handleCustomFallbackCommand(params: {
  accountId: string;
  message: QueuedMessage;
  rawContent: string;
  store?: CustomFallbackCommandStore;
}): CustomFallbackCommandResult {
  const parsed = parseCustomFallbackCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatCustomFallbackHelp(parsed.error) };
  const command = parsed.command ?? { kind: "list" as const, limit: CUSTOM_FALLBACK_DEFAULT_LIST_LIMIT };

  if (command.kind === "help") return { handled: true, reply: formatCustomFallbackHelp() };
  if (command.kind === "clear") {
    if (!command.force) return { handled: true, reply: formatCustomFallbackClearHelp() };
    const clear = params.store?.clearEvents ?? clearCustomFallbackEvents;
    const ok = clear(params.accountId);
    return {
      handled: true,
      reply: ok
        ? `✅ 已清空最近兜底事件。`
        : `⚠️ 清空最近兜底事件失败，请查看 gateway 日志。`,
    };
  }

  const events = (params.store?.loadEvents ?? loadFallbackEvents)(params.accountId, command.limit);
  if (command.kind === "summary") {
    return { handled: true, reply: formatCustomFallbackSummary(events, command.limit) };
  }
  return { handled: true, reply: formatCustomFallbackList(events, command.limit) };
}

function loadFallbackEvents(accountId: string, limit: number): CustomFallbackEvent[] {
  return loadCustomFallbackEvents(accountId, { limit });
}
