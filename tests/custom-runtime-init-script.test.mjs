import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyCustomRuntimeInitializationToConfig,
  applyCustomRuntimeAdminGroupSceneBinding,
  inspectCustomRuntimeInitialization,
  findLikelyRawQQNumericAdminIds,
  isLikelyRawQQNumericId,
  normalizeCustomRuntimeAdminGroup,
  normalizeCustomRuntimeAdminList,
  runCli,
} from "../scripts/apply-custom-runtime-init.mjs";

assert.deepEqual(normalizeCustomRuntimeAdminList("ADMIN, admin ,SECOND"), ["ADMIN", "SECOND"]);
assert.equal(normalizeCustomRuntimeAdminGroup("GROUP_OPENID"), "qqbot:group:GROUP_OPENID");
assert.equal(normalizeCustomRuntimeAdminGroup("group:GROUP_OPENID"), "qqbot:group:GROUP_OPENID");
assert.equal(normalizeCustomRuntimeAdminGroup("qqbot:group:GROUP_OPENID"), "qqbot:group:GROUP_OPENID");
assert.equal(normalizeCustomRuntimeAdminGroup("qqbot:c2c:USER_OPENID"), undefined);
assert.equal(isLikelyRawQQNumericId("945739251"), true);
assert.equal(isLikelyRawQQNumericId("group:945739251"), true);
assert.equal(isLikelyRawQQNumericId("GROUP_OPENID"), false);
assert.deepEqual(findLikelyRawQQNumericAdminIds("1137586795,ADMIN_OPENID,1137586795"), ["1137586795"]);

const original = {
  channels: {
    qqbot: {
      appId: "APPID",
      clientSecret: "SECRET",
      customRuntime: {
        enabled: false,
        admins: ["OLD_ADMIN"],
        scenes: {
          "qqbot:group:SCENE_GROUP": { scene: "chat" },
        },
      },
    },
  },
};

const applied = applyCustomRuntimeInitializationToConfig(original, {
  admins: "ADMIN_OPENID,admin_openid,SECOND_ADMIN",
  adminGroup: "GROUP_OPENID",
});
assert.deepEqual(applied.channels.qqbot.customRuntime.admins, ["ADMIN_OPENID", "SECOND_ADMIN"]);
assert.equal(applied.channels.qqbot.customRuntime.adminGroup, "qqbot:group:GROUP_OPENID");
assert.equal(applied.channels.qqbot.customRuntime.enabled, false);
assert.equal(applied.channels.qqbot.customRuntime.scenes["qqbot:group:SCENE_GROUP"].scene, "chat");
assert.equal(applied.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].scene, "system-admin");

const preservedAdminGroupScene = applyCustomRuntimeAdminGroupSceneBinding({
  scenes: {
    "qqbot:group:GROUP_OPENID": { scene: "dev-lab", label: "custom admin group" },
  },
}, "qqbot:group:GROUP_OPENID");
assert.equal(preservedAdminGroupScene.scenes["qqbot:group:GROUP_OPENID"].scene, "dev-lab");
assert.equal(preservedAdminGroupScene.scenes["qqbot:group:GROUP_OPENID"].label, "custom admin group");

const status = inspectCustomRuntimeInitialization(applied);
assert.equal(status.ready, true);
assert.deepEqual(status.missing, []);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-init-"));
const configPath = path.join(tmpDir, "openclaw.json");
fs.writeFileSync(configPath, JSON.stringify({ channels: { qqbot: { appId: "APPID" } } }, null, 2));

const code = await runCli([
  "--config",
  configPath,
  "--admins",
  "CLI_ADMIN",
  "--admin-group",
  "CLI_GROUP",
  "--json",
], {});
assert.equal(code, 0);
const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
assert.deepEqual(written.channels.qqbot.customRuntime.admins, ["CLI_ADMIN"]);
assert.equal(written.channels.qqbot.customRuntime.adminGroup, "qqbot:group:CLI_GROUP");
assert.equal(written.channels.qqbot.customRuntime.scenes["qqbot:group:CLI_GROUP"].scene, "system-admin");

const readyCode = await runCli(["--config", configPath, "--status-only", "--require-ready"], {});
assert.equal(readyCode, 0);

const missingPath = path.join(tmpDir, "missing.json");
fs.writeFileSync(missingPath, JSON.stringify({ channels: { qqbot: {} } }, null, 2));
const missingCode = await runCli(["--config", missingPath, "--status-only", "--require-ready"], {});
assert.equal(missingCode, 2);

await assert.rejects(
  () => runCli(["--config", missingPath, "--admins", "1137586795", "--admin-group", "CLI_GROUP"], {}),
  /not raw QQ number/,
);
await assert.rejects(
  () => runCli(["--config", missingPath, "--admins", "CLI_ADMIN", "--admin-group", "945739251"], {}),
  /not raw QQ group number/,
);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("custom runtime init script tests passed");
