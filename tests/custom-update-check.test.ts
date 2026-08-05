import assert from "node:assert";
import {
  buildCustomUpdateAvailableNotification,
  DEFAULT_CUSTOM_UPDATE_CHECK_INTERVAL_MS,
  MIN_CUSTOM_UPDATE_CHECK_INTERVAL_MS,
  resolveCustomUpdateCheckConfig,
  runCustomUpdateCheck,
  startCustomUpdateCheckLoop,
} from "../src/custom/update-check.js";
import {
  buildCustomUpdateAvailableKeyboard,
  buildCustomUpdateAvailableNotification as buildCustomUpdateAvailableNotificationDirect,
} from "../src/custom/update-check-presentation.js";
import type { UpdateInfo } from "../src/update-checker.js";

const updateInfo: UpdateInfo = {
  packageName: "@lukesong/luke-qqbot",
  current: "1.7.2-luke.1",
  latest: "1.7.2-luke.2",
  stable: "1.7.2-luke.2",
  alpha: null,
  hasUpdate: true,
  checkedAt: 10_000,
};

assert.deepEqual(resolveCustomUpdateCheckConfig({} as any), {
  enabled: true,
  packageName: "@lukesong/luke-qqbot",
  intervalMs: DEFAULT_CUSTOM_UPDATE_CHECK_INTERVAL_MS,
});

assert.deepEqual(resolveCustomUpdateCheckConfig({
  upgradePkg: "custom/openclaw-qqbot",
  customUpdateCheck: {
    enabled: false,
    intervalMs: 1,
  },
} as any), {
  enabled: false,
  packageName: "@custom/openclaw-qqbot",
  intervalMs: MIN_CUSTOM_UPDATE_CHECK_INTERVAL_MS,
});

let fetchedPackage = "";
const logs: string[] = [];
const result = await runCustomUpdateCheck({
  accountId: "default",
  accountConfig: {
    upgradePkg: "lukesong/openclaw-qqbot",
  } as any,
  log: {
    info: (msg) => logs.push(msg),
  },
  fetchUpdateInfo: async (pkgName) => {
    fetchedPackage = pkgName;
    return updateInfo;
  },
});
assert.equal(fetchedPackage, "@lukesong/openclaw-qqbot");
assert.equal(result.status, "update-available");
assert.equal(result.latest, "1.7.2-luke.2");
assert.equal(logs.length, 1);
assert.match(logs[0]!, /no automatic install/);

const notification = buildCustomUpdateAvailableNotification({
  accountId: "default",
  runtime: {
    enabled: true,
    admins: ["ADMIN_OPENID"],
    adminGroup: "GROUP_OPENID",
  },
  result,
  now: 11_000,
});
const directNotification = buildCustomUpdateAvailableNotificationDirect({
  accountId: "default",
  runtime: {
    enabled: true,
    admins: ["ADMIN_OPENID"],
    adminGroup: "GROUP_OPENID",
  },
  result,
  now: 11_000,
});
assert.deepEqual(notification, directNotification);
assert.equal(notification?.groupOpenid, "GROUP_OPENID");
assert.equal(notification?.text.includes("不会自动安装"), true);
assert.equal(notification?.text.includes("/bot-deploy preflight"), true);
assert.equal(notification?.text.includes("/bot-deploy confirm /bot-upgrade --latest"), true);
assert.equal(notification?.keyboard.content?.rows[1]?.buttons[0]?.action?.data, "/bot-deploy preflight");
assert.equal(notification?.keyboard.content?.rows[2]?.buttons[0]?.action?.data, "/bot-deploy confirm /bot-upgrade --latest");
assert.equal(buildCustomUpdateAvailableKeyboard().content?.rows[0]?.buttons[0]?.action?.data, "/bot-version");

assert.equal(buildCustomUpdateAvailableNotification({
  accountId: "default",
  runtime: { enabled: false, adminGroup: "GROUP_OPENID" },
  result,
}), null);
assert.equal(buildCustomUpdateAvailableNotification({
  accountId: "default",
  runtime: { enabled: true },
  result,
}), null);

let disabledFetchCount = 0;
const disabled = await runCustomUpdateCheck({
  accountId: "default",
  accountConfig: {
    customUpdateCheck: { enabled: false },
  } as any,
  fetchUpdateInfo: async () => {
    disabledFetchCount += 1;
    return updateInfo;
  },
  now: () => 12_000,
});
assert.equal(disabled.status, "disabled");
assert.equal(disabled.checkedAt, 12_000);
assert.equal(disabledFetchCount, 0);

const failed = await runCustomUpdateCheck({
  accountId: "default",
  accountConfig: {} as any,
  fetchUpdateInfo: async () => {
    throw new Error("registry offline");
  },
  now: () => 13_000,
});
assert.equal(failed.status, "error");
assert.equal(failed.packageName, "@lukesong/luke-qqbot");
assert.equal(failed.checkedAt, 13_000);
assert.match(failed.error ?? "", /registry offline/);

let notifyCount = 0;
let loopFetchCount = 0;
const controller = startCustomUpdateCheckLoop({
  accountId: "default",
  accountConfig: {
    customUpdateCheck: { intervalMs: 60_000 },
  } as any,
  initialDelayMs: 60_000,
  log: {},
  fetchUpdateInfo: async () => {
    loopFetchCount += 1;
    return updateInfo;
  },
  onUpdateAvailable: async (available) => {
    notifyCount += 1;
    assert.equal(available.latest, "1.7.2-luke.2");
  },
});
const loopFirst = await controller.checkNow();
const loopSecond = await controller.checkNow();
controller.stop();
assert.equal(loopFetchCount, 2);
assert.equal(loopFirst.status, "update-available");
assert.equal(loopSecond.status, "update-available");
assert.equal(notifyCount, 1);

console.log("custom update check tests passed");
