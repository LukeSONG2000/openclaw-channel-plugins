import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./auth-gateway-adapter.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { CustomGameRuntime } from "./game.js";
import type { CustomActor, CustomGuessGame, CustomPeer } from "./types.js";

export type CustomGameCommand =
  | { kind: "help" }
  | { kind: "guess" }
  | { kind: "list" }
  | { kind: "status"; gameId: string }
  | { kind: "close"; gameId: string };

export type CustomGameCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomGameCommand; error?: string };

export interface CustomGameCommandResult {
  handled: boolean;
  reply?: string;
  keyboard?: InlineKeyboard;
  changed?: boolean;
}

export interface CustomGameInteractionResult {
  handled: boolean;
  reply?: string;
  changed?: boolean;
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

export function handleCustomGameCommand(params: {
  cfg: OpenClawConfig;
  accountId: string;
  games: CustomGameRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomGameCommandResult {
  const parsed = parseCustomGameCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) return { handled: true, reply: "ℹ️ customRuntime 未启用，无法使用 /bot-game。" };
  if (parsed.error) return { handled: true, reply: formatCustomGameHelp(parsed.error) };
  const command = parsed.command ?? { kind: "help" as const };
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);

  if (command.kind === "help") return { handled: true, reply: formatCustomGameHelp() };
  if (command.kind === "list") {
    return { handled: true, reply: formatGuessGameList(params.games.listGuessGames({ accountId: params.accountId, peer, limit: 8 })) };
  }
  if (command.kind === "status") {
    const game = resolveGuessGame(params.games, command.gameId);
    if (!game || !canReadGame(game, params.accountId, peer, actor)) {
      return { handled: true, reply: `⚠️ 未找到小游戏，或该小游戏不属于当前会话：${command.gameId}` };
    }
    return { handled: true, reply: formatGuessGameStatus(game), keyboard: game.status === "open" ? buildCustomGuessGameKeyboard(game) : undefined };
  }
  if (command.kind === "close") {
    const game = resolveGuessGame(params.games, command.gameId);
    if (!game || !canReadGame(game, params.accountId, peer, actor)) {
      return { handled: true, reply: `⚠️ 未找到小游戏，或该小游戏不属于当前会话：${command.gameId}` };
    }
    const result = params.games.closeGuessGame({ gameId: game.id, now: params.now });
    return {
      handled: true,
      changed: result.allowed,
      reply: result.allowed && result.game ? formatGuessGameClosed(result.game) : formatGameDecision(result.reason),
    };
  }
  if (command.kind === "guess") {
    const result = params.games.createGuessGame({
      accountId: params.accountId,
      peer,
      creator: actor,
      now: params.now,
    });
    if (!result.allowed || !result.game) return { handled: true, reply: formatGameDecision(result.reason) };
    return {
      handled: true,
      changed: true,
      reply: formatGuessGameCreated(result.game),
      keyboard: buildCustomGuessGameKeyboard(result.game),
    };
  }
  return { handled: true, reply: formatCustomGameHelp() };
}

export function parseCustomGameButtonData(buttonData: string): { gameId: string; value: number } | null {
  const m = buttonData.match(/^custom-game:([^:]+):guess:([1-4])$/i);
  if (!m) return null;
  return { gameId: m[1]!, value: Number.parseInt(m[2]!, 10) };
}

export function handleCustomGameInteraction(params: {
  accountId?: string;
  games: CustomGameRuntime;
  buttonData: string;
  actorId: string;
  actorLabel?: string;
  sourcePeer?: CustomPeer;
  now?: number;
}): CustomGameInteractionResult {
  const payload = parseCustomGameButtonData(params.buttonData);
  if (!payload) return { handled: false };
  const actor: CustomActor = { id: params.actorId, label: params.actorLabel };
  const game = params.games.getGuessGame(payload.gameId);
  if (!canInteractWithGame({
    game,
    accountId: params.accountId,
    sourcePeer: params.sourcePeer,
    actor,
  })) {
    return {
      handled: true,
      changed: false,
      reply: "⚠️ 小游戏不存在，或该小游戏不属于当前会话。",
    };
  }
  const result = params.games.guessNumber({
    gameId: payload.gameId,
    value: payload.value,
    actor,
    now: params.now,
  });
  return {
    handled: true,
    changed: result.allowed,
    reply: result.allowed && result.game ? formatGuessGameGuessAck(result.game, actor.id) : formatGameDecision(result.reason),
  };
}

export function buildCustomGuessGameKeyboard(game: CustomGuessGame): InlineKeyboard {
  return {
    content: {
      rows: [1, 2, 3, 4].map((value) => ({
        buttons: [makeGuessButton(game.id, value)],
      })),
    },
  };
}

function makeGuessButton(gameId: string, value: number): KeyboardButton {
  return {
    id: `guess_${value}`,
    render_data: { label: String(value), visited_label: `已猜 ${value}`, style: 1 },
    action: {
      type: 1,
      data: `custom-game:${gameId}:guess:${value}`,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: `custom-game-${gameId}`,
  };
}

function formatCustomGameHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🎮 自定义小游戏命令`,
    ``,
    `/bot-game guess`,
    `/bot-game list`,
    `/bot-game status <gameId>`,
    `/bot-game close <gameId>`,
    ``,
    `当前内置小游戏：猜数字 1-4。`,
  );
  return lines.join("\n");
}

function formatGuessGameCreated(game: CustomGuessGame): string {
  return [
    `🎮 猜数字已开始`,
    ``,
    `游戏：${game.id}`,
    `范围：1-4`,
    `发起人：${game.creator.label || game.creator.id}`,
    ``,
    `点击按钮猜一个数字。`,
  ].join("\n");
}

function formatGuessGameList(games: CustomGuessGame[]): string {
  if (games.length === 0) return "🎮 当前会话暂无小游戏。";
  const lines = ["🎮 当前会话小游戏", ""];
  for (const game of games) {
    lines.push(`- ${game.id} [${game.status}] guess 参与=${Object.keys(game.guesses).length}`);
  }
  return lines.join("\n");
}

function formatGuessGameStatus(game: CustomGuessGame): string {
  const lines = [
    `🎮 猜数字状态`,
    ``,
    `游戏：${game.id}`,
    `状态：${game.status}`,
    `参与人数：${Object.keys(game.guesses).length}`,
  ];
  if (game.status !== "open") lines.push(`答案：${game.secret}`);
  if (game.winner) lines.push(`胜者：${game.winner.label || game.winner.id}`);
  return lines.join("\n");
}

function formatGuessGameClosed(game: CustomGuessGame): string {
  return [`✅ 小游戏已关闭：${game.id}`, `答案：${game.secret}`].join("\n");
}

function formatGuessGameGuessAck(game: CustomGuessGame, actorId: string): string {
  const guess = game.guesses[actorId];
  if (!guess) return `⚠️ 未记录本次猜测。`;
  if (guess.correct) {
    return [
      `🎉 猜对了：${guess.value}`,
      ``,
      `游戏：${game.id}`,
      `胜者：${guess.actor.label || guess.actor.id}`,
    ].join("\n");
  }
  return [
    `❌ ${guess.value} 不对，再试试。`,
    ``,
    `游戏：${game.id}`,
    `已参与：${Object.keys(game.guesses).length}`,
  ].join("\n");
}

function formatGameDecision(reason: string): string {
  if (reason === "invalid_secret") return "⚠️ 小游戏答案生成失败。";
  if (reason === "invalid_guess") return "⚠️ 猜测必须是 1 到 4。";
  if (reason === "closed") return "⚠️ 小游戏已结束。";
  if (reason === "not_found") return "⚠️ 小游戏不存在。";
  return `⚠️ 操作失败：${reason}`;
}

function resolveGuessGame(games: CustomGameRuntime, input: string): CustomGuessGame | null {
  const exact = games.getGuessGame(input);
  if (exact) return exact;
  const matches = games.listGuessGames({ limit: Number.MAX_SAFE_INTEGER })
    .filter((game) => game.id.startsWith(input) || game.id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function canReadGame(
  game: CustomGuessGame,
  accountId: string,
  peer: ReturnType<typeof toCustomPeerFromQueuedMessage>,
  actor: ReturnType<typeof toCustomActorFromQueuedMessage>,
): boolean {
  if (game.accountId !== accountId) return false;
  if (game.creator.id.toUpperCase() === actor.id.toUpperCase()) return true;
  return game.peer.kind === peer.kind && game.peer.id === peer.id;
}

function canInteractWithGame(params: {
  game: CustomGuessGame | null;
  accountId?: string;
  sourcePeer?: CustomPeer;
  actor: CustomActor;
}): boolean {
  const { game } = params;
  if (!game) return false;
  if (params.accountId && game.accountId !== params.accountId) return false;
  if (game.creator.id.toUpperCase() === params.actor.id.toUpperCase()) return true;
  if (!params.sourcePeer) return true;
  return game.peer.kind === params.sourcePeer.kind && game.peer.id === params.sourcePeer.id;
}
