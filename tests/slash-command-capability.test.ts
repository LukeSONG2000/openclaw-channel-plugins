import assert from "node:assert";
import { getSlashCommandCapability, parseSlashCommandRequest } from "../src/slash-commands.js";

assert.deepEqual(parseSlashCommandRequest("/bot-upgrade --latest"), {
  name: "bot-upgrade",
  args: "--latest",
});
assert.equal(parseSlashCommandRequest("bot-upgrade"), null);

assert.equal(getSlashCommandCapability("/bot-help"), null);
assert.equal(getSlashCommandCapability("/unknown"), null);
assert.equal(getSlashCommandCapability("/bot-version"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-upgrade"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-upgrade --pkg lukesong/openclaw-qqbot"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-upgrade --latest"), "deploy.apply");
assert.equal(getSlashCommandCapability("/bot-upgrade --version 1.7.2-luke.2"), "deploy.apply");
assert.equal(getSlashCommandCapability("/bot-upgrade 1.7.2-luke.2"), "deploy.apply");
assert.equal(getSlashCommandCapability("/bot-clear-storage"), "config.read");
assert.equal(getSlashCommandCapability("/bot-clear-storage --force"), "config.write");
assert.equal(getSlashCommandCapability("/bot-streaming"), "config.read");
assert.equal(getSlashCommandCapability("/bot-streaming on"), "config.write");
assert.equal(getSlashCommandCapability("/bot-approve status"), "config.read");
assert.equal(getSlashCommandCapability("/bot-approve on"), "auth.grant");
assert.equal(getSlashCommandCapability("/bot-group-allways off"), "config.write");
assert.equal(getSlashCommandCapability("/bot-task"), "system.status");
assert.equal(getSlashCommandCapability("/bot-task list"), "system.status");
assert.equal(getSlashCommandCapability("/bot-task status qqbot-default-group-GROUP_OPENID-1000-1"), "system.status");
assert.equal(getSlashCommandCapability("/bot-task create Build sandbox"), "codex.longTask");
assert.equal(getSlashCommandCapability("/bot-task add qqbot-default-group-GROUP_OPENID-1000-1 more requirements"), "codex.longTask");
assert.equal(getSlashCommandCapability("/bot-task cancel qqbot-default-group-GROUP_OPENID-1000-1"), "codex.longTask");

console.log("slash command capability tests passed");
