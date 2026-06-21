import assert from "node:assert";
import { CustomGameRuntime } from "../src/custom/game.js";

const runtime = new CustomGameRuntime();
const created = runtime.createGuessGame({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID", label: "Creator" },
  secret: 3,
  now: 1_000,
});
assert.equal(created.allowed, true);
assert.equal(created.game?.id, "guess-default-group-GROUP_OPENID-1000-1");
assert.equal(created.game?.secret, 3);
assert.equal(created.game?.status, "open");

const wrong = runtime.guessNumber({
  gameId: created.game!.id,
  value: 2,
  actor: { id: "PLAYER_OPENID", label: "Player" },
  now: 1_500,
});
assert.equal(wrong.allowed, true);
assert.equal(wrong.game?.status, "open");
assert.equal(wrong.game?.guesses.PLAYER_OPENID?.correct, false);

const correct = runtime.guessNumber({
  gameId: created.game!.id,
  value: 3,
  actor: { id: "PLAYER_OPENID", label: "Player" },
  now: 2_000,
});
assert.equal(correct.allowed, true);
assert.equal(correct.game?.status, "won");
assert.equal(correct.game?.winner?.id, "PLAYER_OPENID");
assert.equal(correct.game?.closedAt, 2_000);

const afterClosed = runtime.guessNumber({
  gameId: created.game!.id,
  value: 3,
  actor: { id: "OTHER_OPENID" },
  now: 2_500,
});
assert.equal(afterClosed.allowed, false);
assert.equal(afterClosed.reason, "closed");

const badSecret = runtime.createGuessGame({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID" },
  secret: 9,
});
assert.equal(badSecret.allowed, false);
assert.equal(badSecret.reason, "invalid_secret");

const restored = new CustomGameRuntime();
restored.loadState(runtime.getState());
assert.equal(restored.getGuessGame(created.game!.id)?.winner?.id, "PLAYER_OPENID");
const next = restored.createGuessGame({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "CREATOR_OPENID" },
  secret: 1,
  now: 3_000,
});
assert.equal(next.game?.id.endsWith("-2"), true);

console.log("custom game tests passed");
