export type CustomGameCommand =
  | { kind: "help" }
  | { kind: "guess" }
  | { kind: "list" }
  | { kind: "status"; gameId: string }
  | { kind: "close"; gameId: string };

export type CustomGameCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomGameCommand; error?: string };

export interface CustomGameButtonPayload {
  gameId: string;
  value: number;
}

export function parseCustomGameCommand(rawContent: string): CustomGameCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-game") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "guess" || action === "number" || action === "start" || action === "new") {
    return { matched: true, command: { kind: "guess" } };
  }
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "status" || action === "show") {
    const gameId = tokens.shift();
    if (!gameId) return { matched: true, error: "缺少 gameId" };
    return { matched: true, command: { kind: "status", gameId } };
  }
  if (action === "close" || action === "end") {
    const gameId = tokens.shift();
    if (!gameId) return { matched: true, error: "缺少 gameId" };
    return { matched: true, command: { kind: "close", gameId } };
  }
  return { matched: true, error: `未知子命令：${action}` };
}

export function parseCustomGameButtonData(buttonData: string): CustomGameButtonPayload | null {
  const m = buttonData.match(/^custom-game:([^:]+):guess:([1-4])$/i);
  if (!m) return null;
  return { gameId: m[1]!, value: Number.parseInt(m[2]!, 10) };
}
