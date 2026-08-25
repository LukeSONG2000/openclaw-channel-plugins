import assert from "node:assert";
import {
  CUSTOM_INTERACTION_TYPE_CONFIG_QUERY,
  CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE,
  buildConfigQueryClawCfg,
  buildConfigUpdateAckClawCfg,
  handleCustomConfigInteractionGateway,
} from "../src/custom/config-interaction-gateway-adapter.js";

const cfg = {
  channels: {
    qqbot: {
      appId: "APPID",
      groupPolicy: "allow_all",
      groups: {
        GROUP_OPENID: { requireMention: false },
      },
      customRuntime: {
        enabled: true,
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "dev-lab",
            agentId: "agent-two",
          },
        },
      },
    },
  },
  agents: {
    list: [
      { id: "agent-one", groupChat: { mentionPatterns: ["AgentOne"] } },
      { id: "agent-two", groupChat: { mentionPatterns: ["AgentTwo", "BotTwo"] } },
    ],
  },
} as any;

const route = {
  agentId: "agent-one",
  channel: "qqbot",
  accountId: "default",
  sessionKey: "agent:agent-one:group:GROUP_OPENID",
  mainSessionKey: "agent:agent-one:main",
  lastRoutePolicy: "session" as const,
  matchedBy: "test",
};
const routing = {
  resolveAgentRoute: () => route,
  buildAgentSessionKey: ({ agentId }: any) => `agent:${agentId}:rebuilt`,
};

const queryClawCfg = buildConfigQueryClawCfg({
  cfg,
  accountId: "default",
  groupOpenid: "GROUP_OPENID",
  routing,
  pluginVersion: "1.2.3",
  frameworkVersion: "OpenClaw 2026.3.13 (abc)",
});
assert.equal(queryClawCfg.channel_type, "qqbot");
assert.equal(queryClawCfg.channel_ver, "1.2.3");
assert.equal(queryClawCfg.claw_ver, "2026.3.13");
assert.equal(queryClawCfg.require_mention, "always");
assert.equal(queryClawCfg.group_policy, "allow_all");
assert.equal(queryClawCfg.mention_patterns, "AgentTwo,BotTwo");
assert.equal(queryClawCfg.online_state, "online");

const fallbackVersionCfg = buildConfigUpdateAckClawCfg({
  cfg,
  accountId: "default",
  groupOpenid: "GROUP_OPENID",
  pluginVersion: "1.2.3",
  frameworkVersion: "dev-build",
});
assert.equal(fallbackVersionCfg.claw_ver, "dev-build");
assert.equal(fallbackVersionCfg.require_mention, "always");

const acks: any[] = [];
const infoLogs: string[] = [];
let loadCfg: any = cfg;
let writtenCfg: any = null;
const queryResult = await handleCustomConfigInteractionGateway({
  accountId: "default",
  interaction: {
    id: "interaction-query",
    dataType: CUSTOM_INTERACTION_TYPE_CONFIG_QUERY,
    sceneDesc: "group",
    buttonData: "",
    actorId: "MEMBER_OPENID",
    groupOpenid: "GROUP_OPENID",
  },
  getConfigApi: () => ({
    loadConfig: () => loadCfg,
    writeConfigFile: async (next) => { writtenCfg = next; loadCfg = next; },
  }),
  routing,
  acknowledge: async (code, payload) => { acks.push({ code, payload }); },
  pluginVersion: "1.2.3",
  frameworkVersion: "OpenClaw 2026.3.13 (abc)",
  log: { info: (message) => { infoLogs.push(message); } },
});
assert.equal(queryResult.handled, true);
assert.equal(queryResult.handled && queryResult.kind, "query");
assert.equal(queryResult.handled && queryResult.changed, false);
assert.equal(acks.at(-1)?.code, 0);
assert.equal(acks.at(-1)?.payload.claw_cfg.require_mention, "always");
assert.equal(writtenCfg, null);
assert.equal(infoLogs.some((line) => line.includes("Interaction ACK (type=2001) sent")), true);

const updateCfg = {
  channels: {
    qqbot: {
      appId: "APPID",
      groups: {
        GROUP_OPENID: { requireMention: true, name: "Main Group" },
      },
    },
  },
} as any;
let updateLoadCfg = updateCfg;
const updateResult = await handleCustomConfigInteractionGateway({
  accountId: "default",
  interaction: {
    id: "interaction-update",
    dataType: CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE,
    sceneDesc: "group",
    buttonData: "",
    actorId: "MEMBER_OPENID",
    groupOpenid: "GROUP_OPENID",
    resolved: { claw_cfg: { require_mention: "always" } },
  },
  getConfigApi: () => ({
    loadConfig: () => updateLoadCfg,
    writeConfigFile: async (next) => { updateLoadCfg = next; },
  }),
  acknowledge: async (code, payload) => { acks.push({ code, payload }); },
  pluginVersion: "1.2.3",
  frameworkVersion: "OpenClaw 2026.3.13 (abc)",
  log: { info: (message) => { infoLogs.push(message); } },
});
assert.equal(updateResult.handled, true);
assert.equal(updateResult.handled && updateResult.kind, "update");
assert.equal(updateResult.handled && updateResult.changed, true);
assert.equal(updateLoadCfg.channels.qqbot.groups.GROUP_OPENID.requireMention, false);
assert.equal(updateLoadCfg.channels.qqbot.groups.GROUP_OPENID.name, "Main Group");
assert.equal(acks.at(-1)?.payload.claw_cfg.require_mention, "always");
assert.equal(infoLogs.some((line) => line.includes("Config updated via interaction interaction-update")), true);
assert.equal(infoLogs.some((line) => line.includes("Interaction ACK (type=2002) sent")), true);

const namedCfg = {
  channels: {
    qqbot: {
      accounts: {
        bot2: {
          appId: "APPID2",
          groups: {
            GROUP_OPENID: { requireMention: false, name: "Named Group" },
          },
        },
      },
    },
  },
} as any;
let namedLoadCfg = namedCfg;
const namedResult = await handleCustomConfigInteractionGateway({
  accountId: "bot2",
  interaction: {
    id: "interaction-named-update",
    dataType: CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE,
    sceneDesc: "group",
    buttonData: "",
    actorId: "MEMBER_OPENID",
    groupOpenid: "GROUP_OPENID",
    resolved: { claw_cfg: { require_mention: "mention" } },
  },
  getConfigApi: () => ({
    loadConfig: () => namedLoadCfg,
    writeConfigFile: async (next) => { namedLoadCfg = next; },
  }),
  acknowledge: async (code, payload) => { acks.push({ code, payload }); },
  pluginVersion: "1.2.3",
  frameworkVersion: "OpenClaw 2026.3.13 (abc)",
});
assert.equal(namedResult.handled, true);
assert.equal(namedResult.handled && namedResult.changed, true);
assert.equal(namedLoadCfg.channels.qqbot.accounts.bot2.groups.GROUP_OPENID.requireMention, true);
assert.equal(namedLoadCfg.channels.qqbot.accounts.bot2.groups.GROUP_OPENID.name, "Named Group");
assert.equal(acks.at(-1)?.payload.claw_cfg.require_mention, "mention");

const noChange = await handleCustomConfigInteractionGateway({
  accountId: "default",
  interaction: {
    id: "interaction-no-change",
    dataType: CUSTOM_INTERACTION_TYPE_CONFIG_UPDATE,
    sceneDesc: "group",
    buttonData: "",
    actorId: "MEMBER_OPENID",
    groupOpenid: "GROUP_OPENID",
    resolved: { claw_cfg: {} },
  },
  getConfigApi: () => ({
    loadConfig: () => updateLoadCfg,
    writeConfigFile: async () => { throw new Error("should not write"); },
  }),
  acknowledge: async (code, payload) => { acks.push({ code, payload }); },
  pluginVersion: "1.2.3",
  frameworkVersion: "OpenClaw 2026.3.13 (abc)",
});
assert.equal(noChange.handled, true);
assert.equal(noChange.handled && noChange.changed, false);

const unhandled = await handleCustomConfigInteractionGateway({
  accountId: "default",
  interaction: {
    id: "interaction-button",
    dataType: 11,
    sceneDesc: "group",
    buttonData: "custom-auth:req:allow-once",
    actorId: "MEMBER_OPENID",
  },
  getConfigApi: () => { throw new Error("should not load"); },
  acknowledge: async () => { throw new Error("should not ack"); },
  pluginVersion: "1.2.3",
  frameworkVersion: "OpenClaw 2026.3.13 (abc)",
});
assert.deepEqual(unhandled, { handled: false });

console.log("custom config interaction gateway adapter tests passed");
