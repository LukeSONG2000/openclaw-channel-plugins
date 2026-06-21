import assert from "node:assert";
import { getSlashCommandCapability, matchSlashCommand, parseSlashCommandRequest } from "../src/slash-commands.js";

assert.deepEqual(parseSlashCommandRequest("/bot-upgrade --latest"), {
  name: "bot-upgrade",
  args: "--latest",
});
assert.equal(parseSlashCommandRequest("bot-upgrade"), null);

assert.equal(getSlashCommandCapability("/bot-help"), null);
assert.equal(getSlashCommandCapability("/unknown"), null);
assert.equal(getSlashCommandCapability("/bot-version"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-upgrade"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-upgrade --pkg lukesong/openclaw-qqbot"), "deploy.apply");
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
assert.equal(getSlashCommandCapability("/bot-poll"), "system.status");
assert.equal(getSlashCommandCapability("/bot-poll list"), "system.status");
assert.equal(getSlashCommandCapability("/bot-poll status poll-default-group-GROUP_OPENID-1000-1"), "system.status");
assert.equal(getSlashCommandCapability("/bot-poll create Pick one | A | B"), "game.interact");
assert.equal(getSlashCommandCapability("/bot-poll close poll-default-group-GROUP_OPENID-1000-1"), "game.interact");
assert.equal(getSlashCommandCapability("/bot-game"), "system.status");
assert.equal(getSlashCommandCapability("/bot-game list"), "system.status");
assert.equal(getSlashCommandCapability("/bot-game status guess-default-group-GROUP_OPENID-1000-1"), "system.status");
assert.equal(getSlashCommandCapability("/bot-game guess"), "game.interact");
assert.equal(getSlashCommandCapability("/bot-game close guess-default-group-GROUP_OPENID-1000-1"), "game.interact");
assert.equal(getSlashCommandCapability("/bot-deploy"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-deploy list"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-deploy status deploy-default-group-GROUP_OPENID-1000-1"), "deploy.check");
assert.equal(getSlashCommandCapability("/bot-deploy confirm /bot-upgrade --latest"), "deploy.apply");
assert.equal(getSlashCommandCapability("/bot-deploy plan /bot-upgrade --version 1.7.2-luke.3"), "deploy.apply");
assert.equal(getSlashCommandCapability("/bot-scene"), "system.status");
assert.equal(getSlashCommandCapability("/bot-scene status"), "system.status");
assert.equal(getSlashCommandCapability("/bot-scene list"), "system.status");
assert.equal(getSlashCommandCapability("/bot-scene bindings"), "system.status");
assert.equal(getSlashCommandCapability("/bot-scene set dev-lab"), "config.write");
assert.equal(getSlashCommandCapability("/bot-scene dev-lab"), "config.write");
assert.equal(getSlashCommandCapability("/bot-fallback"), "system.status");
assert.equal(getSlashCommandCapability("/bot-fallback list 5"), "system.status");
assert.equal(getSlashCommandCapability("/bot-fallback summary 20"), "system.status");
assert.equal(getSlashCommandCapability("/bot-fallback clear"), "config.write");
assert.equal(getSlashCommandCapability("/bot-fallback clear --force"), "config.write");
assert.equal(getSlashCommandCapability("/bot-queue"), "system.status");
assert.equal(getSlashCommandCapability("/bot-queue status"), "system.status");
assert.equal(getSlashCommandCapability("/bot-unread"), "system.status");
assert.equal(getSlashCommandCapability("/bot-unread status 5"), "system.status");
assert.equal(getSlashCommandCapability("/bot-unread summary 5"), "system.status");

const blockedPkgOverride = await matchSlashCommand({
  type: "c2c",
  senderId: "USER_OPENID",
  messageId: "MSG_ID",
  eventTimestamp: new Date(0).toISOString(),
  receivedAt: 0,
  rawContent: "/bot-upgrade --pkg tencent-connect/openclaw-qqbot",
  args: "",
  accountId: "default",
  appId: "APP_ID",
  accountConfig: {},
  queueSnapshot: {
    totalPending: 0,
    activeUsers: 0,
    maxConcurrentUsers: 1,
    senderPending: 0,
  },
});
assert.equal(typeof blockedPkgOverride, "string");
assert.match(blockedPkgOverride as string, /已锁定二开更新源/);

console.log("slash command capability tests passed");
