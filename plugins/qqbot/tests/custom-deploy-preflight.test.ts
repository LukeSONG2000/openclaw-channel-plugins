import assert from "node:assert";
import {
  buildCustomDeployPreflightKeyboard,
  buildCustomDeployPreflightSummary,
  formatCustomDeployPreflightSummary,
} from "../src/custom/deploy-preflight.js";
import {
  buildCustomDeployPreflightKeyboard as buildCustomDeployPreflightKeyboardDirect,
  formatCustomDeployPreflightSummary as formatCustomDeployPreflightSummaryDirect,
} from "../src/custom/deploy-preflight-presentation.js";

const ready = buildCustomDeployPreflightSummary({
  channels: {
    qqbot: {
      appId: "APPID",
      clientSecret: "SECRET",
      upgradePkg: "lukesong/openclaw-qqbot",
      upgradeMode: "doc",
      allowUpgradePkgOverride: false,
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
    installs: { "openclaw-qqbot": { source: "npm", spec: "@lukesong/openclaw-qqbot" } },
    allow: ["openclaw-qqbot"],
  },
} as any);
assert.equal(ready.ok, true);
assert.equal(ready.blockers, 0);
assert.equal(ready.adminGroup, "qqbot:group:GROUP_OPENID");
assert.equal(ready.upgradePkg, "@lukesong/openclaw-qqbot");
assert.equal(ready.findings.some((finding) => finding.code === "preflight_read_only"), true);
assert.equal(formatCustomDeployPreflightSummary(ready).includes("QQBot 二开部署预检（只读）"), true);
assert.equal(formatCustomDeployPreflightSummaryDirect(ready), formatCustomDeployPreflightSummary(ready));
const readyKeyboard = buildCustomDeployPreflightKeyboard(ready);
assert.deepEqual(buildCustomDeployPreflightKeyboardDirect(ready), readyKeyboard);
assert.equal(readyKeyboard.content?.rows[0]?.buttons[0]?.action?.data, "/bot-deploy preflight");
assert.equal(readyKeyboard.content?.rows[0]?.buttons[1]?.action?.data, "/bot-version");
assert.equal(readyKeyboard.content?.rows[1]?.buttons[0]?.action?.data, "/bot-deploy confirm /bot-upgrade --latest");

const unsafe = buildCustomDeployPreflightSummary({
  channels: {
    qqbot: {
      appId: "APPID",
      clientSecret: "SECRET",
      upgradePkg: "@tencent-connect/openclaw-qqbot",
      upgradeMode: "hot-reload",
      allowUpgradePkgOverride: true,
      customUpdateCheck: { enabled: false },
      customRuntime: {
        enabled: false,
        admins: [],
      },
    },
  },
  plugins: {
    entries: {
      "openclaw-qqbot": {},
      "@tencent-connect/openclaw-qqbot": {},
    },
    installs: {
      "openclaw-qqbot": { source: "npm", spec: "@tencent-connect/openclaw-qqbot" },
    },
    allow: ["@tencent-connect/openclaw-qqbot"],
  },
} as any);
assert.equal(unsafe.ok, false);
assert.equal(unsafe.findings.some((finding) => finding.code === "custom_runtime_admins_missing"), true);
assert.equal(unsafe.findings.some((finding) => finding.code === "custom_runtime_admin_group_missing"), true);
assert.equal(unsafe.findings.some((finding) => finding.code === "official_upgrade_package"), true);
assert.equal(unsafe.findings.some((finding) => finding.code === "official_qqbot_package_source"), true);
assert.equal(unsafe.findings.some((finding) => finding.code === "multiple_qqbot_plugins_configured"), true);
assert.equal(unsafe.findings.some((finding) => finding.code === "legacy_qqbot_plugin_allowed"), true);
assert.equal(formatCustomDeployPreflightSummary(unsafe).includes("发现"), true);
const unsafeKeyboard = buildCustomDeployPreflightKeyboard(unsafe);
assert.equal(unsafeKeyboard.content?.rows[1]?.buttons[0]?.action?.data, "/bot-auth status");
assert.equal(unsafeKeyboard.content?.rows[1]?.buttons[1]?.action?.data, "/bot-scene bindings");

const missing = buildCustomDeployPreflightSummary({ channels: {} } as any);
assert.equal(missing.ok, false);
assert.equal(missing.findings.some((finding) => finding.code === "missing_qqbot_channel"), true);
assert.equal(missing.findings.some((finding) => finding.code === "qqbot_credentials_missing"), true);

console.log("custom deploy preflight tests passed");
