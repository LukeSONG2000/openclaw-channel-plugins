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

assert.deepEqual(getDefaultCustomInteractionRoutes().map((route) => route.name), ["auth", "poll", "game"]);

const unknown = routeCustomInteractionButton({
  cfg,
  runtime,
  buttonData: "unknown:payload",
  actor: { id: "USER_OPENID" },
});
assert.deepEqual(unknown, { handled: false });

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
