import assert from "node:assert/strict";
import test from "node:test";
import { GROUP_ID, configureChannels, scopeAgentsRules, scopeSkill, clearNonQQSnapshots } from "./configure-dingtalk-channel-scope.mjs";

test("enable only the target group, preserve auth, secrets, models and other channels", () => {
  const original = {
    channels: { ddingtalk: { clientSecret: "test-secret", adminUserId: "admin", groupPolicy: "open", groups: { other: { enabled: false }, [GROUP_ID]: { tools: { deny: ["exec"] } } } }, qqbot: { enabled: true } },
    agents: { defaults: { model: "unchanged" } },
    skills: { entries: { unrelated: { enabled: true }, "dongwuyuan-skill": { apiKey: "preserved" } } },
  };
  const result = configureChannels(original);
  assert.equal(result.channels.ddingtalk.groups[GROUP_ID].enabled, true);
  assert.deepEqual(result.channels.ddingtalk.groups[GROUP_ID].tools, { deny: ["exec"] });
  assert.deepEqual(result.channels.ddingtalk.groups.other, original.channels.ddingtalk.groups.other);
  assert.equal(result.channels.ddingtalk.clientSecret, original.channels.ddingtalk.clientSecret);
  assert.equal(result.channels.ddingtalk.adminUserId, "admin");
  assert.deepEqual(result.agents, original.agents);
  assert.deepEqual(result.channels.qqbot, original.channels.qqbot);
  assert.equal(result.skills.entries["dongwuyuan-skill"].enabled, false);
  assert.equal(result.skills.entries["dongwuyuan-skill"].apiKey, "preserved");
  assert.deepEqual(result.skills.entries.unrelated, { enabled: true });
  assert.equal(original.channels.ddingtalk.groups[GROUP_ID].enabled, undefined);
  assert.deepEqual(configureChannels(result), result);
});

test("shared rule replacement leaves other sections untouched and is repeatable", () => {
  const before = "# Agents\n\n## Mandatory Dongwuyuan Preflight\n\nold global rule\n\n## Memory\n\nkeep history rules\n";
  const after = scopeAgentsRules(before);
  assert.ok(after.startsWith("# Agents\n\n"));
  assert.ok(after.endsWith("## Memory\n\nkeep history rules\n"));
  assert.equal(scopeAgentsRules(after), after);
  assert.throws(() => scopeAgentsRules("# Unexpected layout"));
});

test("scope addition preserves frontmatter and curated body", () => {
  const before = "---\nname: dongwuyuan-skill\nmetadata: {always: true}\n---\n\n# Curated body\nunchanged\n";
  const after = scopeSkill(before);
  assert.ok(after.startsWith("---\nname: dongwuyuan-skill\nmetadata: {always: true}\n---\n"));
  assert.ok(after.endsWith("# Curated body\nunchanged\n"));
  assert.equal(scopeSkill(after), after);
});

test("invalidate only non-QQ meme discovery caches, never history/session identity", () => {
  const snapshot = { skills: [{ name: "dongwuyuan-skill" }], prompt: "cached" };
  const before = {
    "agent:main:qqbot:group:g:qqmention:1": { skillsSnapshot: snapshot, sessionId: "qq" },
    "agent:main:ddingtalk:group:g": { skillsSnapshot: snapshot, sessionId: "ding", sessionFile: "/keep.jsonl", updatedAt: 1 },
    "agent:main:feishu:group:g": { skillsSnapshot: { skills: [{ name: "other" }] }, sessionId: "feishu" },
  };
  const result = clearNonQQSnapshots(before);
  assert.equal(result.cleared, 1);
  assert.deepEqual(result.sessions["agent:main:qqbot:group:g:qqmention:1"], before["agent:main:qqbot:group:g:qqmention:1"]);
  assert.deepEqual(result.sessions["agent:main:ddingtalk:group:g"], { sessionId: "ding", sessionFile: "/keep.jsonl", updatedAt: 1 });
  assert.deepEqual(result.sessions["agent:main:feishu:group:g"], before["agent:main:feishu:group:g"]);
  assert.ok(before["agent:main:ddingtalk:group:g"].skillsSnapshot);
});
