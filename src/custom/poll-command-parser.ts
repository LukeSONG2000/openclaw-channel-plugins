import { slashCommandInput } from "./command-link.js";

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
  if (action === "create" || action === "new") {
    const rest = tokens.join(" ");
    const command = parseCreateCommand(rest);
    return command
      ? { matched: true, command }
      : { matched: true, error: formatMissingCreateFields() };
  }
  const command = parseCreateCommand([action, ...tokens].join(" "));
  if (command) return { matched: true, command };
  return { matched: true, error: formatMissingCreateFields() };
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

function parseCreateCommand(input: string): Extract<CustomPollCommand, { kind: "create" }> | null {
  let text = input.trim();
  if (!text) return null;
  const durationMs = parseDurationMs(text);
  text = stripDuration(text);
  const anonymous = /不匿名|实名/.test(text) ? false : /匿名/.test(text) ? true : undefined;
  const multiple = /多选|可多选|复选/.test(text) ? true : /单选/.test(text) ? false : undefined;
  text = text.replace(/不匿名|实名|匿名|可多选|多选|复选|单选/g, " ").replace(/\s+/g, " ").trim();

  const pipeParts = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length >= 3) {
    const [question, ...options] = pipeParts;
    return compactCreateCommand({ question: question!, options, multiple, anonymous, durationMs });
  }

  const optionBlock = extractOptionBlock(text) ?? inferOptionBlockFromSegments(text);
  if (!optionBlock) return null;
  const options = splitOptions(optionBlock.optionsText);
  const question = summarizeQuestion(optionBlock.questionText, options);
  return compactCreateCommand({ question, options, multiple, anonymous, durationMs });
}

function compactCreateCommand(params: {
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

function extractOptionBlock(text: string): { questionText: string; optionsText: string } | null {
  const m = text.match(/^(.*?)(?:选项|候选|可选)[:：\s]+(.+)$/);
  if (m) return { questionText: m[1]!.trim(), optionsText: m[2]!.trim() };
  const colon = text.match(/^(.+?)[?？:：]\s*(.+)$/);
  if (colon && splitOptions(colon[2]!).length >= 2) return { questionText: colon[1]!.trim(), optionsText: colon[2]!.trim() };
  return null;
}

function inferOptionBlockFromSegments(text: string): { questionText: string; optionsText: string } | null {
  const segments = splitLooseSegments(text)
    .map(stripSegmentNoise)
    .filter(Boolean);
  if (segments.length < 3) return null;

  const questionIndex = segments.findIndex(isQuestionLikeSegment);
  const titleIndex = questionIndex >= 0 ? questionIndex : 0;
  const questionText = segments[titleIndex]!;
  const options = segments.filter((_, index) => index !== titleIndex);
  if (options.length < 2) return null;
  return { questionText, optionsText: options.join("、") };
}

function splitOptions(text: string): string[] {
  return text
    .split(/\s*(?:[、,，;；/]|或|还是|\n)\s*/)
    .map((part) => part.replace(/^[A-Da-d][.、:：\s-]+/, "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

function summarizeQuestion(questionText: string, options: string[]): string {
  const question = questionText.replace(/[?？:：\s]+$/g, "").trim();
  if (question) return question;
  return `投票：${options.slice(0, 3).join(" / ")}`;
}

function parseDurationMs(text: string): number | undefined {
  const m = text.match(/([0-9]+(?:\.[0-9]+)?|一|二|两|三|四|五|六|七|八|九|十|半)\s*(分钟|分|min|m|小时|时|h|天|日|d)/i);
  if (!m) return undefined;
  const value = parseDurationNumber(m[1]!);
  const unit = m[2]!.toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (unit === "小时" || unit === "时" || unit === "h") return Math.round(value * 60 * 60 * 1000);
  if (unit === "天" || unit === "日" || unit === "d") return Math.round(value * 24 * 60 * 60 * 1000);
  return Math.round(value * 60 * 1000);
}

function stripDuration(text: string): string {
  return text
    .replace(/(?:持续|时长|限时|截止|收集|投票|统计|结束)?\s*(?:[0-9]+(?:\.[0-9]+)?|一|二|两|三|四|五|六|七|八|九|十|半)\s*(?:分钟|分|min|m|小时|时|h|天|日|d)(?:后)?(?:收集|统计|结束|截止)?/gi, " ")
    .replace(/(?:后)?(?:收集|统计|结束|截止)$/g, " ")
    .trim();
}

function splitLooseSegments(text: string): string[] {
  return text.split(/\s*(?:[、,，;；|\n])\s*/).filter(Boolean);
}

function stripSegmentNoise(segment: string): string {
  return segment
    .replace(/^(?:请|帮我|麻烦)?\s*(?:创建|发起|新建)?\s*(?:一个|个)?\s*投票(?:一下)?\s*/g, "")
    .replace(/(?:选项|候选|可选)[:：\s]*/g, "")
    .replace(/[?？:：\s]+$/g, "")
    .trim();
}

function isQuestionLikeSegment(segment: string): boolean {
  return /[?？]|什么|哪[个些种]?|是否|要不要|能不能|可不可以|谁|几|多少|吗|嘛/.test(segment);
}

function parseDurationNumber(value: string): number {
  if (/^[0-9]/.test(value)) return Number.parseFloat(value);
  if (value === "半") return 0.5;
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return map[value] ?? Number.NaN;
}

function formatMissingCreateFields(): string {
  return `我还没识别到完整投票信息：请至少提供标题和 2 个选项。\n\n例如：${slashCommandInput("/bot-poll 晚上吃什么，肯德基，麦当劳，德克士，2分钟后收集")}`;
}

function parsePage(value: string | undefined): number {
  if (!value) return 0;
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 0;
}
