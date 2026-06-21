import assert from "node:assert";
import {
  DEFAULT_CUSTOM_UPDATE_CHECK_INTERVAL_MS,
  MIN_CUSTOM_UPDATE_CHECK_INTERVAL_MS,
  resolveCustomUpdateCheckConfig,
  runCustomUpdateCheck,
} from "../src/custom/update-check.js";
import type { UpdateInfo } from "../src/update-checker.js";

const updateInfo: UpdateInfo = {
  packageName: "@lukesong/openclaw-qqbot",
  current: "1.7.2-luke.1",
  latest: "1.7.2-luke.2",
  stable: "1.7.2-luke.2",
  alpha: null,
  hasUpdate: true,
  checkedAt: 10_000,
};

assert.deepEqual(resolveCustomUpdateCheckConfig({} as any), {
  enabled: true,
  packageName: "@lukesong/openclaw-qqbot",
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
assert.equal(failed.packageName, "@lukesong/openclaw-qqbot");
assert.equal(failed.checkedAt, 13_000);
assert.match(failed.error ?? "", /registry offline/);

console.log("custom update check tests passed");
