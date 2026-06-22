import assert from "node:assert";
import {
  buildCustomDeployConfirmationKeyboard,
  handleCustomDeployCommand,
  handleCustomDeployInteraction,
  parseCustomDeployButtonData,
  parseCustomDeployCommand,
} from "../src/custom/deploy-confirmation-gateway-adapter.js";
import {
  parseCustomDeployButtonData as parseCustomDeployButtonDataDirect,
  parseCustomDeployCommand as parseCustomDeployCommandDirect,
} from "../src/custom/deploy-command-parser.js";
import {
  buildCustomDeployConfirmationKeyboard as buildCustomDeployConfirmationKeyboardDirect,
  formatDeployConfirmationStatus as formatDeployConfirmationStatusDirect,
} from "../src/custom/deploy-presentation.js";
import { CustomDeployConfirmationRuntime } from "../src/custom/deploy-confirmation.js";
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
  content: "/bot-deploy confirm /bot-upgrade --latest",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(parseCustomDeployCommand("hello"), { matched: false });
assert.deepEqual(parseCustomDeployCommand("/bot-deploy"), {
  matched: true,
  command: { kind: "help" },
});
assert.deepEqual(parseCustomDeployCommand("/bot-deploy confirm /bot-upgrade --latest"), {
  matched: true,
  command: { kind: "confirm", command: "/bot-upgrade --latest" },
});
assert.deepEqual(
  parseCustomDeployCommandDirect("/bot-deploy confirm /bot-upgrade --latest"),
  parseCustomDeployCommand("/bot-deploy confirm /bot-upgrade --latest"),
);
assert.deepEqual(parseCustomDeployCommand("/bot-deploy plan /bot-upgrade --version 1.7.2-luke.3"), {
  matched: true,
  command: { kind: "confirm", command: "/bot-upgrade --version 1.7.2-luke.3" },
});
assert.deepEqual(parseCustomDeployCommand("/bot-deploy status deploy-1"), {
  matched: true,
  command: { kind: "status", confirmationId: "deploy-1" },
});
assert.deepEqual(parseCustomDeployCommand("/bot-deploy preflight"), {
  matched: true,
  command: { kind: "preflight" },
});
assert.deepEqual(parseCustomDeployCommand("/bot-deploy confirm /bot-upgrade"), {
  matched: true,
  error: `当前只支持确认 <qqbot-cmd-input text="/bot-upgrade --latest" show="/bot-upgrade"/> 的带参数命令`,
});
assert.deepEqual(parseCustomDeployCommand("/bot-deploy confirm /bot-upgradefoo --latest"), {
  matched: true,
  error: `当前只支持确认 <qqbot-cmd-input text="/bot-upgrade --latest" show="/bot-upgrade"/> 的带参数命令`,
});
assert.deepEqual(parseCustomDeployButtonData("custom-deploy:deploy-default-group-GROUP_OPENID-1000-1:confirm"), {
  confirmationId: "deploy-default-group-GROUP_OPENID-1000-1",
  decision: "confirm",
});
assert.deepEqual(
  parseCustomDeployButtonDataDirect("custom-deploy:deploy-default-group-GROUP_OPENID-1000-1:confirm"),
  parseCustomDeployButtonData("custom-deploy:deploy-default-group-GROUP_OPENID-1000-1:confirm"),
);
assert.equal(parseCustomDeployButtonData("custom-game:game-1:guess:1"), null);

const disabled = handleCustomDeployCommand({
  cfg: disabledCfg,
  accountId: "default",
  confirmations: new CustomDeployConfirmationRuntime(),
  message,
  rawContent: "/bot-deploy list",
  now: 500,
});
assert.equal(disabled.handled, true);
assert.equal(disabled.reply?.includes("customRuntime 未启用"), true);

const confirmations = new CustomDeployConfirmationRuntime();
const create = handleCustomDeployCommand({
  cfg,
  accountId: "default",
  confirmations,
  message,
  rawContent: "/bot-deploy confirm /bot-upgrade --latest",
  now: 1_000,
});
assert.equal(create.handled, true);
assert.equal(create.changed, true);
assert.equal(create.reply?.includes("部署确认已创建"), true);
assert.equal(create.reply?.includes("不会自动执行热更新"), true);
assert.equal(create.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, "custom-deploy:deploy-default-group-GROUP_OPENID-1000-1:confirm");

const confirmationId = Object.keys(confirmations.getState().confirmations)[0]!;
assert.equal(confirmationId, "deploy-default-group-GROUP_OPENID-1000-1");
const keyboard = buildCustomDeployConfirmationKeyboard(confirmations.get(confirmationId)!);
assert.equal(keyboard.content?.rows[0]?.buttons[1]?.action?.data, `custom-deploy:${confirmationId}:cancel`);
assert.deepEqual(buildCustomDeployConfirmationKeyboardDirect(confirmations.get(confirmationId)!), keyboard);

const list = handleCustomDeployCommand({
  cfg,
  accountId: "default",
  confirmations,
  message,
  rawContent: "/bot-deploy list",
  now: 1_500,
});
assert.equal(list.handled, true);
assert.equal(list.reply?.includes(confirmationId), true);

const preflight = handleCustomDeployCommand({
  cfg: {
    channels: {
      qqbot: {
        appId: "APPID",
        clientSecret: "SECRET",
        upgradePkg: "lukesong/openclaw-qqbot",
        customUpdateCheck: { enabled: true },
        customRuntime: {
          enabled: true,
          admins: ["ADMIN_OPENID"],
          adminGroup: "GROUP_OPENID",
          scenes: {
            "qqbot:group:GROUP_OPENID": { scene: "system-admin" },
          },
        },
      },
    },
    plugins: {
      entries: { "openclaw-qqbot": {} },
    },
  } as any,
  accountId: "default",
  confirmations,
  message,
  rawContent: "/bot-deploy preflight",
  now: 1_550,
});
assert.equal(preflight.handled, true);
assert.equal(preflight.changed, undefined);
assert.equal(preflight.reply?.includes("QQBot 二开部署预检（只读）"), true);
assert.equal(preflight.reply?.includes("无阻断项"), true);
assert.equal(preflight.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, "/bot-deploy preflight");
assert.equal(preflight.keyboard?.content?.rows[0]?.buttons[1]?.action?.data, "/bot-version");
assert.equal(preflight.keyboard?.content?.rows[1]?.buttons[0]?.action?.data, "/bot-deploy confirm /bot-upgrade --latest");

const otherGroupStatus = handleCustomDeployCommand({
  cfg,
  accountId: "default",
  confirmations,
  message: { ...message, groupOpenid: "OTHER_GROUP_OPENID", senderId: "OTHER_MEMBER_OPENID" },
  rawContent: `/bot-deploy status ${confirmationId}`,
  now: 1_600,
});
assert.equal(otherGroupStatus.handled, true);
assert.equal(otherGroupStatus.reply?.includes("不属于当前会话"), true);
assert.equal(otherGroupStatus.reply?.includes("/bot-upgrade --latest"), false);

const creatorDmStatus = handleCustomDeployCommand({
  cfg,
  accountId: "default",
  confirmations,
  message: { ...message, type: "c2c", groupOpenid: undefined },
  rawContent: `/bot-deploy status ${confirmationId}`,
  now: 1_700,
});
assert.equal(creatorDmStatus.handled, true);
assert.equal(creatorDmStatus.reply?.includes("部署确认状态"), true);
assert.equal(creatorDmStatus.keyboard?.content?.rows[0]?.buttons.length, 2);
assert.equal(formatDeployConfirmationStatusDirect(confirmations.get(confirmationId)!, 1_700).includes("部署确认状态"), true);

const crossPeerConfirm = handleCustomDeployInteraction({
  accountId: "default",
  confirmations,
  buttonData: `custom-deploy:${confirmationId}:confirm`,
  actorId: "OTHER_MEMBER_OPENID",
  actorLabel: "Other",
  sourcePeer: { kind: "group", id: "OTHER_GROUP_OPENID" },
  now: 1_800,
});
assert.equal(crossPeerConfirm.handled, true);
assert.equal(crossPeerConfirm.changed, false);
assert.equal(crossPeerConfirm.reply?.includes("不属于当前会话"), true);
assert.equal(confirmations.get(confirmationId)?.status, "pending");

const confirm = handleCustomDeployInteraction({
  accountId: "default",
  confirmations,
  buttonData: `custom-deploy:${confirmationId}:confirm`,
  actorId: "ADMIN_OPENID",
  actorLabel: "Admin",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_000,
});
assert.equal(confirm.handled, true);
assert.equal(confirm.changed, true);
assert.equal(confirm.reply?.includes("已确认部署操作"), true);
assert.equal(confirm.reply?.includes("请管理员在私聊中手动发送该命令"), true);
assert.equal(confirmations.get(confirmationId)?.status, "confirmed");

const repeat = handleCustomDeployInteraction({
  accountId: "default",
  confirmations,
  buttonData: `custom-deploy:${confirmationId}:cancel`,
  actorId: "ADMIN_OPENID",
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_100,
});
assert.equal(repeat.handled, true);
assert.equal(repeat.changed, false);
assert.equal(repeat.reply?.includes("部署确认已处理"), true);

console.log("custom deploy confirmation gateway adapter tests passed");
