import { slashCommandInput } from "./command-link.js";

const CUSTOM_POLL_INTERNAL_CREATE_ACTION = "__create";

export type CustomPollCommand =
  | { kind: "help" }
  | { kind: "create"; question: string; options: string[]; multiple?: boolean; anonymous?: boolean; durationMs?: number }
  | { kind: "list"; page?: number }
  | { kind: "status"; pollId: string }
  | { kind: "close"; pollId: string };

export type CustomPollCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomPollCommand; error?: string };

export type CustomPollButtonPayload =
  | { kind: "vote"; pollId: string; optionId: string }
  | { kind: "list"; page: number }
  | { kind: "detail"; pollId: string; page: number }
  | { kind: "close-request"; pollId: string; page: number }
  | { kind: "close-confirm"; pollId: string; page: number };

export function parseCustomPollCommand(rawContent: string): CustomPollCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-poll") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list", page: parsePage(tokens[0]) } };
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
  if (action === CUSTOM_POLL_INTERNAL_CREATE_ACTION) {
    const command = decodeCustomPollCreateCommand(tokens.join(" "));
    return command
      ? { matched: true, command }
      : { matched: true, error: formatMissingCreateFields() };
  }
  return { matched: true, error: formatNaturalLanguageCreateOnly() };
}

export function parseCustomPollButtonData(buttonData: string): CustomPollButtonPayload | null {
  const vote = buttonData.match(/^custom-poll:([^:]+):vote:(\d+)$/i);
  if (vote) return { kind: "vote", pollId: vote[1]!, optionId: vote[2]! };
  const list = buttonData.match(/^custom-poll:list:(\d+)$/i);
  if (list) return { kind: "list", page: parsePage(list[1]) };
  const detail = buttonData.match(/^custom-poll:([^:]+):detail:(\d+)$/i);
  if (detail) return { kind: "detail", pollId: detail[1]!, page: parsePage(detail[2]) };
  const closeRequest = buttonData.match(/^custom-poll:([^:]+):close-request:(\d+)$/i);
  if (closeRequest) return { kind: "close-request", pollId: closeRequest[1]!, page: parsePage(closeRequest[2]) };
  const closeConfirm = buttonData.match(/^custom-poll:([^:]+):close-confirm:(\d+)$/i);
  if (closeConfirm) return { kind: "close-confirm", pollId: closeConfirm[1]!, page: parsePage(closeConfirm[2]) };
  return null;
}

export function normalizeCustomPollCreateCommand(params: {
  question: string;
  options: string[];
  multiple?: boolean;
  anonymous?: boolean;
  durationMs?: number;
}): Extract<CustomPollCommand, { kind: "create" }> | null {
  const question = params.question.replace(/\s+/g, " ").trim();
  const options = params.options.map((option) => option.trim()).filter(Boolean);
  if (!question || options.length < 2) return null;
  return {
    kind: "create",
    question,
    options,
    ...(params.multiple !== undefined ? { multiple: params.multiple } : {}),
    ...(params.anonymous !== undefined ? { anonymous: params.anonymous } : {}),
    ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
  };
}

export function encodeCustomPollCreateCommand(command: Extract<CustomPollCommand, { kind: "create" }>): string {
  const payload = Buffer.from(JSON.stringify(command), "utf8").toString("base64url");
  return `/bot-poll ${CUSTOM_POLL_INTERNAL_CREATE_ACTION} ${payload}`;
}

export function formatMissingCreateFields(): string {
  return `我还没识别到完整投票信息：请至少提供标题和 2 个选项。\n\n例如：${slashCommandInput("/bot-poll 晚上吃什么，肯德基，麦当劳，德克士，2分钟后收集")}`;
}

function formatNaturalLanguageCreateOnly(): string {
  return [
    "请直接用自然语言描述投票需求，我会自动解析标题、选项、单/多选、匿名和持续时间。",
    "",
    `例如：${slashCommandInput("/bot-poll 晚上吃什么，肯德基、麦当劳、德克士，十分钟后结束")}`,
  ].join("\n");
}

function parsePage(value: string | undefined): number {
  if (!value) return 0;
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 0;
}

function decodeCustomPollCreateCommand(payload: string): Extract<CustomPollCommand, { kind: "create" }> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Extract<CustomPollCommand, { kind: "create" }>>;
    if (parsed.kind !== "create") return null;
    return normalizeCustomPollCreateCommand({
      question: typeof parsed.question === "string" ? parsed.question : "",
      options: Array.isArray(parsed.options) ? parsed.options.filter((item): item is string => typeof item === "string") : [],
      multiple: typeof parsed.multiple === "boolean" ? parsed.multiple : undefined,
      anonymous: typeof parsed.anonymous === "boolean" ? parsed.anonymous : undefined,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
    });
  } catch {
    return null;
  }
}
