import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultCustomGroupActivationMode,
  normalizeCustomGroupActivationMode,
  resolveCustomGroupActivation,
  resolveCustomGroupActivationFromSessionStore,
  resolveCustomSessionStorePath,
} from "../src/custom/group-activation.js";

assert.equal(defaultCustomGroupActivationMode(true), "mention");
assert.equal(defaultCustomGroupActivationMode(false), "always");
assert.equal(normalizeCustomGroupActivationMode("MENTION", "always"), "mention");
assert.equal(normalizeCustomGroupActivationMode(" always ", "mention"), "always");
assert.equal(normalizeCustomGroupActivationMode("invalid", "mention"), "mention");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-group-activation-"));
try {
  assert.equal(
    resolveCustomSessionStorePath({
      cfg: {},
      agentId: "agent-a",
      env: { OPENCLAW_STATE_DIR: tmpDir, HOME: "/unused" },
    }),
    path.join(tmpDir, "agents", "agent-a", "sessions", "sessions.json"),
  );

  assert.equal(
    resolveCustomSessionStorePath({
      cfg: { session: { store: path.join(tmpDir, "{agentId}", "sessions.json") } },
      agentId: "agent-b",
      env: { HOME: "/unused" },
    }),
    path.join(tmpDir, "agent-b", "sessions.json"),
  );

  assert.equal(
    resolveCustomSessionStorePath({
      cfg: { session: { store: "~/.custom/{agentId}/sessions.json" } },
      agentId: "agent-c",
      env: { HOME: tmpDir },
    }),
    path.join(tmpDir, ".custom", "agent-c", "sessions.json"),
  );

  const storePath = path.join(tmpDir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify({
    "qqbot:group:GROUP": { groupActivation: "always" },
    "qqbot:group:OTHER": { groupActivation: "mention" },
    invalid: { groupActivation: "sometimes" },
  }));

  assert.equal(resolveCustomGroupActivation({
    cfg: { session: { store: storePath } },
    agentId: "agent-a",
    sessionKey: "qqbot:group:GROUP",
    configRequireMention: true,
  }), "always");

  assert.equal(resolveCustomGroupActivation({
    cfg: { session: { store: storePath } },
    agentId: "agent-a",
    sessionKey: "qqbot:group:OTHER",
    configRequireMention: false,
  }), "mention");

  assert.equal(resolveCustomGroupActivation({
    cfg: { session: { store: storePath } },
    agentId: "agent-a",
    sessionKey: "missing",
    configRequireMention: true,
  }), "mention");

  assert.equal(resolveCustomGroupActivation({
    cfg: { session: { store: storePath } },
    agentId: "agent-a",
    sessionKey: "invalid",
    configRequireMention: false,
  }), "always");

  assert.equal(resolveCustomGroupActivation({
    cfg: { session: { store: path.join(tmpDir, "missing.json") } },
    agentId: "agent-a",
    sessionKey: "qqbot:group:GROUP",
    configRequireMention: true,
  }), "mention");

  assert.equal(resolveCustomGroupActivation({
    cfg: { session: { store: storePath } },
    agentId: "agent-a",
    sessionKey: "qqbot:group:GROUP",
    configRequireMention: true,
    fileReader: {
      existsSync: () => true,
      readFileSync: () => "{not-json",
    },
  }), "mention");

  assert.equal(resolveCustomGroupActivationFromSessionStore(
    JSON.stringify({ session: { groupActivation: "always" } }),
    "session",
    "mention",
  ), "always");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("custom group activation tests passed");
