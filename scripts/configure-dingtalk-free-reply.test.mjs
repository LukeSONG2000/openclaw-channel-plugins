import assert from "node:assert/strict";
import test from "node:test";
import { configureFreeReply, scopeDefaultRules } from "./configure-dingtalk-free-reply.mjs";

test("all current groups and new groups are open without changing auth, secrets or other channels", () => {
  const before = { channels: { ddingtalk: { enabled: true, clientSecret: "fixture", adminUserId: "admin",
    groupPolicy: "allowlist", groupAllowFrom: ["known"], allowFrom: ["admin"],
    groups: { known: { enabled: false, tools: { deny: ["exec"] }, allowFrom: ["member"], systemPrompt: "custom" } } },
    qqbot: { enabled: true } }, agents: { defaults: { model: "unchanged" } } };
  const after = configureFreeReply(before);
  assert.equal(after.channels.ddingtalk.groupPolicy, "open");
  assert.equal(after.channels.ddingtalk.groups.known.enabled, true);
  const expected = structuredClone(before);
  expected.channels.ddingtalk.groupPolicy = "open";
  expected.channels.ddingtalk.groups.known.enabled = true;
  assert.deepEqual(after, expected);
  assert.equal(before.channels.ddingtalk.groups.known.enabled, false);
  assert.deepEqual(configureFreeReply(after), after);
});

test("no per-group registration is required for future groups", () => {
  const after = configureFreeReply({ channels: { ddingtalk: { enabled: true } } });
  assert.equal(after.channels.ddingtalk.groupPolicy, "open");
  assert.equal(after.channels.ddingtalk.groups, undefined);
});

test("rules are channel-scoped, preserve other instructions and are idempotent", () => {
  const before = "# Agents\n\n## Existing Rules\nkeep unchanged\n";
  const after = scopeDefaultRules(before);
  assert.ok(after.startsWith(before));
  assert.match(after, /一分钟未读轮询/);
  assert.match(after, /不授予工具/);
  assert.match(after, /不改变 QQ、飞书/);
  assert.equal(scopeDefaultRules(after), after);
  const withNext = after + "\n## Later\npreserve\n";
  assert.equal(scopeDefaultRules(withNext), withNext);
});

test("does not guess among multiple bot accounts or enable a disabled channel", () => {
  assert.throws(() => configureFreeReply({}), /Enabled/);
  assert.throws(() => configureFreeReply({ channels: { ddingtalk: { enabled: false } } }), /Enabled/);
  assert.throws(() => configureFreeReply({ channels: { ddingtalk: { enabled: true, accounts: { other: {} } } } }), /account/);
});
