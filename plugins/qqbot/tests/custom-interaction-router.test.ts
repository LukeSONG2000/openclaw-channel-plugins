import assert from "node:assert";
import {
  getDefaultCustomInteractionRoutes,
  routeCustomInteractionButton,
  type CustomInteractionRoute,
} from "../src/custom/interaction-router.js";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";

const runtime = createCustomMessageFlowRuntime();
const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
      },
    },
  },
} as any;

assert.deepEqual(getDefaultCustomInteractionRoutes().map((route) => route.name), ["auth", "scene", "poll", "game", "deploy"]);

const unknown = routeCustomInteractionButton({
  cfg,
  runtime,
  buttonData: "unknown:payload",
  actor: { id: "USER_OPENID" },
});
assert.deepEqual(unknown, { handled: false });

const created = runtime.deployConfirmations.create({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  creator: { id: "ADMIN_OPENID", label: "Admin" },
  command: "/bot-upgrade --latest",
  now: 1_000,
});
assert.equal(created.allowed, true);
const deploy = routeCustomInteractionButton({
  cfg,
  accountId: "default",
  runtime,
  buttonData: `custom-deploy:${created.confirmation!.id}:confirm`,
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 2_000,
});
assert.equal(deploy.handled, true);
assert.equal(deploy.handled && deploy.persist?.deployConfirmations, true);
assert.equal(deploy.handled && deploy.reply?.includes("已确认部署操作"), true);

const scene = routeCustomInteractionButton({
  cfg,
  accountId: "default",
  runtime,
  buttonData: "custom-scene:set:dev-lab",
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
});
assert.equal(scene.handled, true);
assert.equal(scene.handled && scene.persist?.config?.sceneKey, "qqbot:group:GROUP_OPENID");
assert.equal(scene.handled && scene.persist?.config?.sceneConfig.scene, "dev-lab");
assert.equal(scene.handled && scene.reply?.includes("场景：开发实验室（dev-lab）"), true);

const sceneDenied = routeCustomInteractionButton({
  cfg,
  accountId: "default",
  runtime,
  buttonData: "custom-scene:set:chat",
  actor: { id: "USER_OPENID", label: "Member" },
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
});
assert.equal(sceneDenied.handled, true);
assert.equal(sceneDenied.handled && sceneDenied.persist, undefined);
assert.equal(sceneDenied.handled && sceneDenied.reply?.includes("只有 customRuntime.admins 中的管理员"), true);

const customRoute: CustomInteractionRoute = {
  name: "custom-confirm",
  handle: (ctx) => ctx.buttonData === "custom-confirm:deploy:yes"
    ? {
        handled: true,
        reply: `handled by ${ctx.actor.id}`,
      }
    : { handled: false },
};
const custom = routeCustomInteractionButton({
  cfg,
  runtime,
  buttonData: "custom-confirm:deploy:yes",
  actor: { id: "ADMIN_OPENID" },
  routes: [customRoute],
});
assert.equal(custom.handled, true);
assert.equal(custom.handled && custom.reply, "handled by ADMIN_OPENID");

const routeOrder: string[] = [];
const first: CustomInteractionRoute = {
  name: "first",
  handle: () => {
    routeOrder.push("first");
    return { handled: false };
  },
};
const second: CustomInteractionRoute = {
  name: "second",
  handle: () => {
    routeOrder.push("second");
    return { handled: true, reply: "second handled" };
  },
};
const third: CustomInteractionRoute = {
  name: "third",
  handle: () => {
    routeOrder.push("third");
    return { handled: true, reply: "third should not run" };
  },
};
const ordered = routeCustomInteractionButton({
  cfg,
  runtime,
  buttonData: "anything",
  actor: { id: "USER_OPENID" },
  routes: [first, second, third],
});
assert.equal(ordered.handled, true);
assert.equal(ordered.handled && ordered.reply, "second handled");
assert.deepEqual(routeOrder, ["first", "second"]);

console.log("custom interaction router tests passed");
