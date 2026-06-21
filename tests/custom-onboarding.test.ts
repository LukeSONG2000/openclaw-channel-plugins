import assert from "node:assert";
import {
  applyQQBotSetupAccountConfig,
  applyQQBotCustomRuntimeInitialization,
  qqbotOnboardingAdapter,
  resolveQQBotCustomRuntimeInitializationInput,
  validateQQBotSetupInput,
  validateQQBotCustomRuntimeInitializationInput,
} from "../src/onboarding.js";
import { resolveCustomRuntimeConfig } from "../src/custom/config.js";

const initialized = applyQQBotCustomRuntimeInitialization({
  channels: {
    qqbot: {
      enabled: true,
      customRuntime: {
        enabled: false,
        admins: ["OLD_ADMIN"],
        scenes: {
          "qqbot:group:GROUP_OPENID": { scene: "chat" },
        },
      },
    },
  },
} as any, {
  admins: "ADMIN_OPENID, admin_openid , SECOND_ADMIN",
  adminGroup: "group:ADMIN_GROUP_OPENID",
});

const initializedRuntime = resolveCustomRuntimeConfig(initialized as any);
assert.equal(initializedRuntime.enabled, false);
assert.deepEqual(initializedRuntime.admins, ["ADMIN_OPENID", "SECOND_ADMIN"]);
assert.equal(initializedRuntime.adminGroup, "qqbot:group:ADMIN_GROUP_OPENID");
assert.equal(initializedRuntime.scenes?.["qqbot:group:GROUP_OPENID"]?.scene, "chat");
assert.equal(initializedRuntime.scenes?.["qqbot:group:ADMIN_GROUP_OPENID"]?.scene, "system-admin");

const preservedAdminGroupScene = applyQQBotCustomRuntimeInitialization({
  channels: {
    qqbot: {
      customRuntime: {
        scenes: {
          "qqbot:group:ADMIN_GROUP_OPENID": { scene: "dev-lab", label: "custom admin group" },
        },
      },
    },
  },
} as any, {
  admins: "ADMIN_OPENID",
  adminGroup: "ADMIN_GROUP_OPENID",
});
const preservedRuntime = resolveCustomRuntimeConfig(preservedAdminGroupScene as any);
assert.equal(preservedRuntime.scenes?.["qqbot:group:ADMIN_GROUP_OPENID"]?.scene, "dev-lab");
assert.equal(preservedRuntime.scenes?.["qqbot:group:ADMIN_GROUP_OPENID"]?.label, "custom admin group");

const incompleteStatus = await qqbotOnboardingAdapter.getStatus?.({
  cfg: {
    channels: {
      qqbot: {
        appId: "APPID",
        clientSecret: "SECRET",
        customRuntime: {
          enabled: true,
          admins: ["ADMIN_OPENID"],
        },
      },
    },
  },
} as any);
assert.equal(incompleteStatus?.configured, false);
assert.equal(incompleteStatus?.statusLines?.some((line) => line.includes("Custom Runtime 管理群: 未绑定")), true);

const disabledRuntimeMissingStatus = await qqbotOnboardingAdapter.getStatus?.({
  cfg: {
    channels: {
      qqbot: {
        appId: "APPID",
        clientSecret: "SECRET",
        customRuntime: {
          enabled: false,
        },
      },
    },
  },
} as any);
assert.equal(disabledRuntimeMissingStatus?.configured, false);

const prompts: string[] = [];
const result = await qqbotOnboardingAdapter.configure?.({
  cfg: {
    channels: {
      qqbot: {
        enabled: true,
        appId: "APPID",
        clientSecret: "SECRET",
      },
    },
  },
  prompter: {
    note: async () => {},
    confirm: async () => true,
    select: async <T>(opts: { initialValue?: T }) => opts.initialValue as T,
    text: async (opts: { message: string }) => {
      prompts.push(opts.message);
      if (opts.message.includes("管理员")) return "ADMIN_OPENID, SECOND_ADMIN";
      if (opts.message.includes("管理群")) return "ADMIN_GROUP_OPENID";
      return "";
    },
  },
} as any);

assert.equal(result?.success, true);
const configuredRuntime = resolveCustomRuntimeConfig((result as any).cfg);
assert.deepEqual(configuredRuntime.admins, ["ADMIN_OPENID", "SECOND_ADMIN"]);
assert.equal(configuredRuntime.adminGroup, "qqbot:group:ADMIN_GROUP_OPENID");
assert.equal(configuredRuntime.scenes?.["qqbot:group:ADMIN_GROUP_OPENID"]?.scene, "system-admin");
assert.equal(prompts.some((message) => message.includes("管理员")), true);
assert.equal(prompts.some((message) => message.includes("管理群")), true);

const setupInput = resolveQQBotCustomRuntimeInitializationInput({
  customRuntimeAdmins: "ADMIN_OPENID",
  customRuntimeAdminGroup: "ADMIN_GROUP_OPENID",
});
assert.equal(validateQQBotCustomRuntimeInitializationInput(setupInput), null);
assert.equal(validateQQBotCustomRuntimeInitializationInput(resolveQQBotCustomRuntimeInitializationInput({
  customRuntimeAdminGroup: "ADMIN_GROUP_OPENID",
}, {}))?.includes("customRuntime admins"), true);
assert.equal(validateQQBotCustomRuntimeInitializationInput(resolveQQBotCustomRuntimeInitializationInput({
  customRuntimeAdmins: "1137586795",
  customRuntimeAdminGroup: "ADMIN_GROUP_OPENID",
}, {}))?.includes("not raw QQ number"), true);
assert.equal(validateQQBotCustomRuntimeInitializationInput(resolveQQBotCustomRuntimeInitializationInput({
  customRuntimeAdmins: "ADMIN_OPENID",
  customRuntimeAdminGroup: "945739251",
}, {}))?.includes("not raw QQ group number"), true);

const setupCfg = applyQQBotCustomRuntimeInitialization({ channels: {} } as any, setupInput);
const setupRuntime = resolveCustomRuntimeConfig(setupCfg as any);
assert.deepEqual(setupRuntime.admins, ["ADMIN_OPENID"]);
assert.equal(setupRuntime.adminGroup, "qqbot:group:ADMIN_GROUP_OPENID");
assert.equal(setupRuntime.scenes?.["qqbot:group:ADMIN_GROUP_OPENID"]?.scene, "system-admin");

assert.equal(validateQQBotSetupInput({
  token: "APPID:SECRET",
  customRuntimeAdmins: "ADMIN_OPENID",
  customRuntimeAdminGroup: "ADMIN_GROUP_OPENID",
}), null);
assert.equal(validateQQBotSetupInput({ token: "APPID:SECRET" }, {})?.includes("customRuntime admins"), true);
assert.equal(validateQQBotSetupInput({
  token: "APPID:SECRET",
  customRuntimeAdmins: "ADMIN_OPENID",
}, {})?.includes("customRuntime adminGroup"), true);

const setupAccountCfg = applyQQBotSetupAccountConfig({
  cfg: { channels: {} } as any,
  accountId: "default",
  input: {
    token: "SETUP_APPID:SETUP_SECRET",
    customRuntimeAdmins: "SETUP_ADMIN",
    customRuntimeAdminGroup: "SETUP_GROUP",
  },
});
assert.equal((setupAccountCfg.channels?.qqbot as any)?.appId, "SETUP_APPID");
assert.equal((setupAccountCfg.channels?.qqbot as any)?.clientSecret, "SETUP_SECRET");
const setupAccountRuntime = resolveCustomRuntimeConfig(setupAccountCfg as any);
assert.deepEqual(setupAccountRuntime.admins, ["SETUP_ADMIN"]);
assert.equal(setupAccountRuntime.adminGroup, "qqbot:group:SETUP_GROUP");
assert.equal(setupAccountRuntime.scenes?.["qqbot:group:SETUP_GROUP"]?.scene, "system-admin");

console.log("custom onboarding tests passed");
