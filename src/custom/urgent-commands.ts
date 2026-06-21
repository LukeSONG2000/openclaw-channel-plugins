const CUSTOM_URGENT_QUEUE_BYPASS_COMMAND_SET = new Set([
  "/stop",
  "/approve",
  "/new",
  "/compact",
]);

export const CUSTOM_URGENT_QUEUE_BYPASS_COMMANDS = [...CUSTOM_URGENT_QUEUE_BYPASS_COMMAND_SET];

export function isCustomUrgentQueueBypassCommand(content: string | null | undefined): boolean {
  const commandToken = firstSlashCommandToken(content);
  return commandToken ? CUSTOM_URGENT_QUEUE_BYPASS_COMMAND_SET.has(commandToken) : false;
}

function firstSlashCommandToken(content: string | null | undefined): string | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}
