import type { MessageTarget } from "../reply-dispatcher.js";
import type { CustomTaskNotificationEffect } from "./task-notification-adapter.js";
import type { CustomSandboxTask } from "./types.js";

export interface CustomTaskNotificationDelivery {
  target: MessageTarget;
  text: string;
  taskId: string;
  audience: CustomTaskNotificationEffect["audience"];
}

export function deliveryFromCustomTaskNotification(params: {
  task: CustomSandboxTask;
  notification: CustomTaskNotificationEffect;
  passiveMessageId?: string;
}): CustomTaskNotificationDelivery | null {
  if (params.notification.taskId !== params.task.id) return null;
  const target = targetForAudience({
    task: params.task,
    audience: params.notification.audience,
    passiveMessageId: params.passiveMessageId,
  });
  if (!target) return null;
  return {
    target,
    text: params.notification.text,
    taskId: params.task.id,
    audience: params.notification.audience,
  };
}

export function deliveriesFromCustomTaskNotifications(params: {
  task: CustomSandboxTask;
  notifications: CustomTaskNotificationEffect[];
  passiveMessageId?: string;
}): CustomTaskNotificationDelivery[] {
  const deliveries: CustomTaskNotificationDelivery[] = [];
  const seen = new Set<string>();
  for (const notification of params.notifications) {
    const delivery = deliveryFromCustomTaskNotification({
      task: params.task,
      notification,
      passiveMessageId: params.passiveMessageId,
    });
    if (!delivery) continue;
    const key = `${delivery.audience}:${delivery.target.type}:${delivery.target.senderId}:${delivery.target.groupOpenid ?? ""}:${delivery.target.channelId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deliveries.push(delivery);
  }
  return deliveries;
}

function targetForAudience(params: {
  task: CustomSandboxTask;
  audience: CustomTaskNotificationEffect["audience"];
  passiveMessageId?: string;
}): MessageTarget | null {
  const messageId = params.passiveMessageId ?? "";
  if (params.audience === "owner") {
    return {
      type: "c2c",
      senderId: params.task.owner.id,
      messageId,
    };
  }

  const peer = params.task.peer;
  if (peer.kind === "group") {
    return {
      type: "group",
      senderId: params.task.owner.id,
      messageId,
      groupOpenid: peer.id,
    };
  }
  if (peer.kind === "channel") {
    return {
      type: "guild",
      senderId: params.task.owner.id,
      messageId,
      channelId: peer.id,
    };
  }
  if (peer.kind === "dm") {
    return {
      type: "dm",
      senderId: peer.id,
      messageId,
    };
  }
  if (peer.kind === "c2c") {
    return {
      type: "c2c",
      senderId: peer.id,
      messageId,
    };
  }
  return null;
}
