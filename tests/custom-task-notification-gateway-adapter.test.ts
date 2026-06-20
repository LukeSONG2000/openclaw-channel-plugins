import assert from "node:assert";
import {
  deliveriesFromCustomTaskNotifications,
  deliveryFromCustomTaskNotification,
} from "../src/custom/task-notification-gateway-adapter.js";
import type { CustomTaskNotificationEffect } from "../src/custom/task-notification-adapter.js";
import type { CustomSandboxTask } from "../src/custom/types.js";

const task: CustomSandboxTask = {
  id: "task-1",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  owner: { id: "OWNER_OPENID", label: "Owner" },
  title: "Notify gateway task",
  prompt: "Prompt",
  status: "completed",
  workspace: "/tmp/task-1",
  createdAt: 1_000,
  updatedAt: 2_000,
  requirements: [],
  result: "Done",
};

const peerNotification: CustomTaskNotificationEffect = {
  kind: "notify",
  audience: "peer",
  taskId: task.id,
  title: "done",
  text: "peer text",
};
const ownerNotification: CustomTaskNotificationEffect = {
  ...peerNotification,
  audience: "owner",
  text: "owner text",
};

const groupDelivery = deliveryFromCustomTaskNotification({
  task,
  notification: peerNotification,
  passiveMessageId: "msg-1",
});
assert.equal(groupDelivery?.target.type, "group");
assert.equal(groupDelivery?.target.groupOpenid, "GROUP_OPENID");
assert.equal(groupDelivery?.target.messageId, "msg-1");
assert.equal(groupDelivery?.text, "peer text");

const ownerDelivery = deliveryFromCustomTaskNotification({
  task,
  notification: ownerNotification,
});
assert.equal(ownerDelivery?.target.type, "c2c");
assert.equal(ownerDelivery?.target.senderId, "OWNER_OPENID");
assert.equal(ownerDelivery?.target.messageId, "");
assert.equal(ownerDelivery?.text, "owner text");

const c2cDelivery = deliveryFromCustomTaskNotification({
  task: { ...task, peer: { kind: "c2c", id: "USER_OPENID" } },
  notification: peerNotification,
});
assert.equal(c2cDelivery?.target.type, "c2c");
assert.equal(c2cDelivery?.target.senderId, "USER_OPENID");

const channelDelivery = deliveryFromCustomTaskNotification({
  task: { ...task, peer: { kind: "channel", id: "CHANNEL_ID" } },
  notification: peerNotification,
});
assert.equal(channelDelivery?.target.type, "guild");
assert.equal(channelDelivery?.target.channelId, "CHANNEL_ID");

assert.equal(deliveryFromCustomTaskNotification({
  task,
  notification: { ...peerNotification, taskId: "other-task" },
}), null);

const deliveries = deliveriesFromCustomTaskNotifications({
  task,
  notifications: [peerNotification, ownerNotification, peerNotification],
});
assert.equal(deliveries.length, 2);
assert.deepEqual(deliveries.map((item) => item.audience), ["peer", "owner"]);

console.log("custom task notification gateway adapter tests passed");
