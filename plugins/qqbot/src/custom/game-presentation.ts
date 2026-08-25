import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { CustomGuessGame } from "./types.js";
import { slashCommandInput } from "./command-link.js";
import { formatGameStatusForDisplay } from "./presentation-labels.js";

export function buildCustomGuessGameKeyboard(game: CustomGuessGame): InlineKeyboard {
  return {
    content: {
      rows: [1, 2, 3, 4].map((value) => ({
        buttons: [makeGuessButton(game.id, value)],
      })),
    },
  };
}

export function formatCustomGameHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🎮 自定义小游戏命令`,
    ``,
    slashCommandInput(`/bot-game guess`),
    slashCommandInput(`/bot-game list`),
    slashCommandInput(`/bot-game status <gameId>`),
    slashCommandInput(`/bot-game close <gameId>`),
    ``,
    `当前内置小游戏：猜数字 1-4。`,
  );
  return lines.join("\n");
}

export function formatGuessGameCreated(game: CustomGuessGame): string {
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

export function formatGuessGameList(games: CustomGuessGame[]): string {
  if (games.length === 0) return "🎮 当前会话暂无小游戏。";
  const lines = ["🎮 当前会话小游戏", ""];
  for (const game of games) {
    lines.push(`- ${game.id} [${formatGameStatusForDisplay(game.status)}] 猜数字，参与=${Object.keys(game.guesses).length}`);
  }
  return lines.join("\n");
}

export function formatGuessGameStatus(game: CustomGuessGame): string {
  const lines = [
    `🎮 猜数字状态`,
    ``,
    `游戏：${game.id}`,
    `状态：${formatGameStatusForDisplay(game.status)}`,
    `参与人数：${Object.keys(game.guesses).length}`,
  ];
  if (game.status !== "open") lines.push(`答案：${game.secret}`);
  if (game.winner) lines.push(`胜者：${game.winner.label || game.winner.id}`);
  return lines.join("\n");
}

export function formatGuessGameClosed(game: CustomGuessGame): string {
  return [`✅ 小游戏已关闭：${game.id}`, `答案：${game.secret}`].join("\n");
}

export function formatGuessGameGuessAck(game: CustomGuessGame, actorId: string): string {
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

export function formatGameDecision(reason: string): string {
  if (reason === "invalid_secret") return "⚠️ 小游戏答案生成失败。";
  if (reason === "invalid_guess") return "⚠️ 猜测必须是 1 到 4。";
  if (reason === "closed") return "⚠️ 小游戏已结束。";
  if (reason === "not_found") return "⚠️ 小游戏不存在。";
  return `⚠️ 操作失败：${reason}`;
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
