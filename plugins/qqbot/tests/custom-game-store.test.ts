import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCustomGameStatePath,
  loadCustomGameState,
  saveCustomGameState,
} from "../src/custom/game-store.js";
import type { CustomGameRuntimeState } from "../src/custom/types.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-games-"));
try {
  const accountId = "default/account";
  const state: CustomGameRuntimeState = {
    guessGames: {
      "guess-default-group-GROUP_OPENID-1000-1": {
        id: "guess-default-group-GROUP_OPENID-1000-1",
        accountId,
        peer: { kind: "group", id: "GROUP_OPENID" },
        creator: { id: "CREATOR_OPENID", label: "Creator" },
        secret: 4,
        guesses: {},
        status: "open",
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    },
  };

  assert.equal(saveCustomGameState(accountId, state, { dir: tmpDir }), true);
  const filePath = getCustomGameStatePath(accountId, { dir: tmpDir });
  assert.equal(path.basename(filePath), "games-default_account.json");
  assert.equal(fs.existsSync(filePath), true);
  const loaded = loadCustomGameState(accountId, { dir: tmpDir });
  assert.equal(loaded?.guessGames["guess-default-group-GROUP_OPENID-1000-1"]?.secret, 4);

  fs.writeFileSync(filePath, "{bad json", "utf8");
  assert.equal(loadCustomGameState(accountId, { dir: tmpDir }), null);
  fs.writeFileSync(filePath, JSON.stringify({ version: 999, accountId, state }), "utf8");
  assert.equal(loadCustomGameState(accountId, { dir: tmpDir }), null);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom game store tests passed");
