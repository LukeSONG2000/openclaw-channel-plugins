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

console.log("slash command capability tests passed");
