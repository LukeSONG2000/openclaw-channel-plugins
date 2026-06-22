export type CustomPollCommand =
  | { kind: "help" }
  | { kind: "create"; question: string; options: string[] }
  | { kind: "list" }
  | { kind: "status"; pollId: string }
  | { kind: "close"; pollId: string };

export type CustomPollCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomPollCommand; error?: string };

export interface CustomPollButtonPayload {
  pollId: string;
  optionId: string;
}

export function parseCustomPollCommand(rawContent: string): CustomPollCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-poll") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "status" || action === "show") {
    const pollId = tokens.shift();
    if (!pollId) return { matched: true, error: "缺少 pollId" };
    return { matched: true, command: { kind: "status", pollId } };
  }
  if (action === "close" || action === "end") {
    const pollId = tokens.shift();
    if (!pollId) return { matched: true, error: "缺少 pollId" };
    return { matched: true, command: { kind: "close", pollId } };
  }
  if (action === "create" || action === "new") {
    const rest = tokens.join(" ");
    const parts = rest.split("|").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) return { matched: true, error: "格式：/bot-poll create 问题 | 选项A | 选项B [| 选项C | 选项D]" };
    const [question, ...options] = parts;
    return { matched: true, command: { kind: "create", question: question!, options } };
  }
  return { matched: true, error: `未知子命令：${action}` };
}

export function parseCustomPollButtonData(buttonData: string): CustomPollButtonPayload | null {
  const m = buttonData.match(/^custom-poll:([^:]+):vote:([1-4])$/i);
  if (!m) return null;
  return { pollId: m[1]!, optionId: m[2]! };
}
