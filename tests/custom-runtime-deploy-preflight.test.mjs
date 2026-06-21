import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPreflightReport,
  classifyPackageReference,
  collectQQBotPluginReferences,
  inspectCustomRuntimeDeployPreflight,
  inspectOpenClawHome,
  inspectPluginReferences,
  normalizePackageName,
  parseCliArgs,
  runCli,
} from "../scripts/preflight-custom-runtime-deploy.mjs";

assert.equal(normalizePackageName("lukesong/openclaw-qqbot"), "@lukesong/openclaw-qqbot");
assert.equal(normalizePackageName("@lukesong/openclaw-qqbot@1.7.2-luke.1"), "@lukesong/openclaw-qqbot");
assert.equal(classifyPackageReference("@lukesong/openclaw-qqbot"), "personal");
assert.equal(classifyPackageReference("github:LukeSONG2000/openclaw-qqbot"), "personal");
assert.equal(classifyPackageReference("@tencent-connect/openclaw-qqbot"), "official");
assert.equal(classifyPackageReference({ source: "path", path: "/tmp/openclaw-qqbot" }), "path-or-custom");

const readyCfg = {
  channels: {
    qqbot: {
      appId: "APPID",
      clientSecret: "SECRET",
      upgradePkg: "lukesong/openclaw-qqbot",
      upgradeMode: "doc",
      allowUpgradePkgOverride: false,
      customUpdateCheck: { enabled: true, intervalMs: 21_600_000 },
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        adminGroup: "qqbot:group:ADMIN_GROUP",
        scenes: {
          "qqbot:group:ADMIN_GROUP": { scene: "system-admin" },
        },
      },
    },
  },
  plugins: {
    entries: {
      "openclaw-qqbot": { enabled: true },
    },
    installs: {
      "openclaw-qqbot": { source: "npm", spec: "@lukesong/openclaw-qqbot" },
    },
    allow: ["openclaw-qqbot"],
  },
};

const readyResult = inspectCustomRuntimeDeployPreflight({
  cfg: readyCfg,
  configPath: "/tmp/openclaw.json",
  openclawHome: "/tmp/not-existing-openclaw-home",
  generatedAt: "2026-06-21T00:00:00.000Z",
});
assert.equal(readyResult.ok, true);
assert.equal(readyResult.counts.blocker, 0);
assert.deepEqual(readyResult.summary.admins, ["ADMIN_OPENID"]);
assert.equal(readyResult.summary.adminGroup, "qqbot:group:ADMIN_GROUP");
assert.equal(readyResult.summary.upgradePkg, "@lukesong/openclaw-qqbot");
assert.equal(buildPreflightReport(readyResult).includes("只读检查"), true);

const missingAnchors = inspectCustomRuntimeDeployPreflight({
  cfg: {
    channels: {
      qqbot: {
        appId: "APPID",
        clientSecret: "SECRET",
        customRuntime: { enabled: true },
      },
    },
  },
});
assert.equal(missingAnchors.ok, false);
assert.equal(missingAnchors.findings.some((item) => item.code === "custom_runtime_admins_missing"), true);
assert.equal(missingAnchors.findings.some((item) => item.code === "custom_runtime_admin_group_missing"), true);

const unsafeCfg = {
  channels: {
    qqbot: {
      appId: "APPID",
      clientSecret: "SECRET",
      upgradePkg: "@tencent-connect/openclaw-qqbot",
      upgradeMode: "hot-reload",
      allowUpgradePkgOverride: true,
      customUpdateCheck: { enabled: false },
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        adminGroup: "ADMIN_GROUP",
        scenes: {
          "qqbot:group:ADMIN_GROUP": { scene: "system-admin" },
        },
      },
    },
  },
  plugins: {
    entries: {
      "openclaw-qqbot": {},
      "@tencent-connect/openclaw-qqbot": {},
    },
    installs: {
      "@tencent-connect/openclaw-qqbot": { source: "npm", spec: "@tencent-connect/openclaw-qqbot" },
    },
    allow: ["@tencent-connect/openclaw-qqbot"],
  },
};
const pluginRefs = collectQQBotPluginReferences(unsafeCfg.plugins);
assert.equal(pluginRefs.length, 4);
const pluginFindings = inspectPluginReferences(pluginRefs);
assert.equal(pluginFindings.some((item) => item.code === "multiple_qqbot_plugins_configured"), true);
assert.equal(pluginFindings.some((item) => item.code === "legacy_qqbot_plugin_active"), true);
assert.equal(pluginFindings.some((item) => item.code === "official_qqbot_package_source"), true);
assert.equal(pluginFindings.some((item) => item.code === "legacy_qqbot_plugin_allowed"), true);

const unsafeResult = inspectCustomRuntimeDeployPreflight({ cfg: unsafeCfg });
assert.equal(unsafeResult.ok, false);
assert.equal(unsafeResult.findings.some((item) => item.code === "official_upgrade_package"), true);
assert.equal(unsafeResult.findings.some((item) => item.code === "hot_reload_enabled"), true);
assert.equal(unsafeResult.findings.some((item) => item.code === "upgrade_pkg_override_enabled"), true);
assert.equal(unsafeResult.findings.some((item) => item.code === "custom_update_check_disabled"), true);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-preflight-"));
const openclawHome = path.join(tmpDir, ".openclaw");
fs.mkdirSync(path.join(openclawHome, "extensions", "qqbot"), { recursive: true });
fs.mkdirSync(path.join(openclawHome, "extensions", "node_modules", "@tencent-connect", "openclaw-qqbot"), { recursive: true });
const homeFindings = inspectOpenClawHome(openclawHome);
assert.equal(homeFindings.some((item) => item.code === "legacy_extension_dir_present"), true);
assert.equal(homeFindings.some((item) => item.code === "official_extension_package_present"), true);

const configPath = path.join(tmpDir, "openclaw.json");
fs.writeFileSync(configPath, JSON.stringify(readyCfg, null, 2));
let stdout = "";
const okCode = runCli(["--config", configPath, "--home", openclawHome, "--json", "--require-ready"], {}, {
  stdout: { write: (chunk) => { stdout += chunk; } },
});
assert.equal(okCode, 0);
const cliResult = JSON.parse(stdout);
assert.equal(cliResult.ok, true);

const badPath = path.join(tmpDir, "bad.json");
fs.writeFileSync(badPath, JSON.stringify({ channels: { qqbot: {} } }, null, 2));
stdout = "";
const badCode = runCli(["--config", badPath, "--require-ready"], {}, {
  stdout: { write: (chunk) => { stdout += chunk; } },
});
assert.equal(badCode, 2);
assert.equal(stdout.includes("阻断项"), true);

assert.deepEqual(parseCliArgs([
  "--config", "/tmp/openclaw.json",
  "--home=/tmp/.openclaw",
  "--allow-env-credentials",
  "--json",
  "--require-ready",
], {}), {
  configPath: "/tmp/openclaw.json",
  openclawHome: "/tmp/.openclaw",
  requireReady: true,
  json: true,
  help: false,
  allowEnvCredentials: true,
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("custom runtime deploy preflight tests passed");
