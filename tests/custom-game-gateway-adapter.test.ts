import assert from "node:assert";
import {
  buildCustomGuessGameKeyboard,
  handleCustomGameCommand,
  handleCustomGameInteraction,
  parseCustomGameButtonData,
  parseCustomGameCommand,
} from "../src/custom/game-gateway-adapter.js";
import {
  parseCustomGameButtonData as parseCustomGameButtonDataDirect,
  parseCustomGameCommand as parseCustomGameCommandDirect,
} from "../src/custom/game-command-parser.js";
import {
  buildCustomGuessGameKeyboard as buildCustomGuessGameKeyboardDirect,
  formatGuessGameStatus as formatGuessGameStatusDirect,
} from "../src/custom/game-presentation.js";
import { CustomGameRuntime } from "../src/custom/game.js";
import type { QueuedMessage } from "../src/message-queue.js";

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
      },
    },
  },
} as any;

const disabledCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: false,
      },
    },
  },
} as any;

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-game guess",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(parseCustomGameCommand("hello"), { matched: false });
assert.deepEqual(parseCustomGameCommand("/bot-game guess"), {
  matched: true,
  command: { kind: "guess" },
});
assert.deepEqual(
  parseCustomGameCommandDirect("/bot-game guess"),
  parseCustomGameCommand("/bot-game guess"),
);
assert.deepEqual(parseCustomGameCommand("/bot-game status guess-1"), {
  matched: true,
  command: { kind: "status", gameId: "guess-1" },
});
assert.deepEqual(parseCustomGameCommand("/bot-game close"), {
  matched: true,
  error: "缺少 gameId",
});
assert.deepEqual(parseCustomGameButtonData("custom-game:guess-default-group-GROUP_OPENID-1000-1:guess:4"), {
  gameId: "guess-default-group-GROUP_OPENID-1000-1",
  value: 4,
});
assert.deepEqual(
  parseCustomGameButtonDataDirect("custom-game:guess-default-group-GROUP_OPENID-1000-1:guess:4"),
  parseCustomGameButtonData("custom-game:guess-default-group-GROUP_OPENID-1000-1:guess:4"),
);
assert.equal(parseCustomGameButtonData("custom-poll:poll-1:vote:1"), null);

const disabled = handleCustomGameCommand({
  cfg: disabledCfg,
  accountId: "default",
  games: new CustomGameRuntime(),
  message,
  rawContent: "/bot-game list",
  now: 500,
});
assert.equal(disabled.handled, true);
assert.equal(disabled.reply?.includes("customRuntime 未启用"), true);

const games = new CustomGameRuntime();
const create = handleCustomGameCommand({
  cfg,
  accountId: "default",
  games,
  message,
  rawContent: "/bot-game guess",
  now: 1_000,
});
assert.equal(create.handled, true);
assert.equal(create.changed, true);
assert.equal(create.reply?.includes("猜数字已开始"), true);
assert.equal(create.keyboard?.content?.rows.length, 4);

const gameId = Object.keys(games.getState().guessGames)[0]!;
assert.equal(gameId, "guess-default-group-GROUP_OPENID-1000-1");
const game = games.getGuessGame(gameId)!;
const keyboard = buildCustomGuessGameKeyboard(game);
assert.equal(keyboard.content?.rows[2]?.buttons[0]?.action?.data, `custom-game:${gameId}:guess:3`);
assert.deepEqual(buildCustomGuessGameKeyboardDirect(game), keyboard);

const wrongValue = game.secret === 1 ? 2 : 1;
const wrong = handleCustomGameInteraction({
  accountId: "default",
  games,
  buttonData: `custom-game:${gameId}:guess:${wrongValue}`,
  actorId: "PLAYER_OPENID",
  actorLabel: "Player",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_000,
});
assert.equal(wrong.handled, true);
assert.equal(wrong.changed, true);
assert.equal(wrong.reply?.includes("不对"), true);

const crossPeerGuess = handleCustomGameInteraction({
  accountId: "default",
  games,
  buttonData: `custom-game:${gameId}:guess:${game.secret}`,
  actorId: "OTHER_MEMBER_OPENID",
  actorLabel: "Other",
  sourcePeer: { kind: "group", id: "OTHER_GROUP_OPENID" },
  now: 2_100,
});
assert.equal(crossPeerGuess.handled, true);
assert.equal(crossPeerGuess.changed, false);
assert.equal(crossPeerGuess.reply?.includes("不属于当前会话"), true);
assert.equal(games.getGuessGame(gameId)?.winner, undefined);

const correct = handleCustomGameInteraction({
  accountId: "default",
  games,
  buttonData: `custom-game:${gameId}:guess:${game.secret}`,
  actorId: "PLAYER_OPENID",
  actorLabel: "Player",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_500,
});
assert.equal(correct.handled, true);
assert.equal(correct.changed, true);
assert.equal(correct.reply?.includes("猜对了"), true);
assert.equal(games.getGuessGame(gameId)?.status, "won");

const status = handleCustomGameCommand({
  cfg,
  accountId: "default",
  games,
  message,
  rawContent: `/bot-game status ${gameId}`,
  now: 3_000,
});
assert.equal(status.handled, true);
assert.equal(status.reply?.includes("猜数字状态"), true);
assert.equal(status.reply?.includes(`答案：${game.secret}`), true);
assert.equal(formatGuessGameStatusDirect(games.getGuessGame(gameId)!).includes(`答案：${game.secret}`), true);

const noMatch = handleCustomGameCommand({
  cfg,
  accountId: "default",
  games,
  message,
  rawContent: "/bot-ping",
  now: 4_000,
});
assert.deepEqual(noMatch, { handled: false });

console.log("custom game gateway adapter tests passed");
