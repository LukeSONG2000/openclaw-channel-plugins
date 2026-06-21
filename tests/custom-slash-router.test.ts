import assert from "node:assert";
import {
  getDefaultCustomSlashRoutes,
  routeCustomSlashCommand,
  type CustomSlashRoute,
} from "../src/custom/slash-router.js";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";
import type { QueuedMessage } from "../src/message-queue.js";

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-game guess",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            capabilities: ["chat.send", "system.status", "game.interact", "codex.longTask", "config.write"],
          },
        },
      },
    },
  },
} as any;

assert.deepEqual(getDefaultCustomSlashRoutes().map((route) => route.name), [
  "scene",
  "fallback",
  "queue",
  "unread",
  "task",
  "poll",
  "game",
]);

const unknown = routeCustomSlashCommand({
  cfg,
  accountId: "default",
  runtime: createCustomMessageFlowRuntime(),
  message: { ...message, content: "/bot-ping" },
  rawContent: "/bot-ping",
});
assert.deepEqual(unknown, { handled: false });

const runtime = createCustomMessageFlowRuntime();
const game = routeCustomSlashCommand({
  cfg,
  accountId: "default",
  runtime,
  message,
  rawContent: "/bot-game guess",
  now: 1_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(game.handled, true);
assert.equal(game.handled && game.persist?.games, true);
assert.equal(game.handled && game.reply?.kind, "keyboard");
assert.equal(Object.keys(runtime.games.getState().guessGames)[0], "guess-default-group-GROUP_OPENID-1000-1");

const routeOrder: string[] = [];
const first: CustomSlashRoute = {
  name: "first",
  handle: () => {
    routeOrder.push("first");
    return { handled: false };
  },
};
const second: CustomSlashRoute = {
  name: "second",
  handle: () => {
    routeOrder.push("second");
    return { handled: true, reply: { kind: "text", text: "second handled" } };
  },
};
const third: CustomSlashRoute = {
  name: "third",
  handle: () => {
    routeOrder.push("third");
    return { handled: true, reply: { kind: "text", text: "third should not run" } };
  },
};
const ordered = routeCustomSlashCommand({
  cfg,
  accountId: "default",
  runtime: createCustomMessageFlowRuntime(),
  message,
  rawContent: "/anything",
  routes: [first, second, third],
});
assert.equal(ordered.handled, true);
assert.equal(ordered.handled && ordered.reply?.kind === "text" && ordered.reply.text, "second handled");
assert.deepEqual(routeOrder, ["first", "second"]);

console.log("custom slash router tests passed");
