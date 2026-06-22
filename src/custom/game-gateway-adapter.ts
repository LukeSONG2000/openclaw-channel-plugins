import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { CustomGameRuntime } from "./game.js";
import { slashCommandInput } from "./command-link.js";
import { parseCustomGameButtonData, parseCustomGameCommand } from "./game-command-parser.js";
import {
  buildCustomGuessGameKeyboard,
  formatCustomGameHelp,
  formatGameDecision,
  formatGuessGameClosed,
  formatGuessGameCreated,
  formatGuessGameGuessAck,
  formatGuessGameList,
  formatGuessGameStatus,
} from "./game-presentation.js";
import type { CustomActor, CustomGuessGame, CustomPeer } from "./types.js";

export {
  parseCustomGameButtonData,
  parseCustomGameCommand,
  type CustomGameButtonPayload,
  type CustomGameCommand,
  type CustomGameCommandParseResult,
} from "./game-command-parser.js";

export {
  buildCustomGuessGameKeyboard,
  formatCustomGameHelp,
  formatGameDecision,
  formatGuessGameClosed,
  formatGuessGameCreated,
  formatGuessGameGuessAck,
  formatGuessGameList,
  formatGuessGameStatus,
} from "./game-presentation.js";

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
  if (!runtime.enabled) return { handled: true, reply: `ℹ️ customRuntime 未启用，无法使用 ${slashCommandInput("/bot-game")}。` };
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
