import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard } from "../types.js";
import { toCustomActorFromQueuedMessage, toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import { isCustomRuntimeAdmin } from "./auth-admin.js";
import { resolveCustomRuntimeConfig } from "./config.js";
import { formatCustomActorIdentity, formatCustomPeerIdentity } from "./identity-presentation.js";
import { formatCustomPeerKey } from "./scenes.js";
import { parseCustomSceneCommand, type CustomSceneCommand } from "./scene-command-parser.js";
import {
  buildCustomSceneSwitchKeyboard,
  formatCustomSceneBindings,
  formatCustomSceneBoundReply,
  formatCustomSceneHelp,
  formatCustomSceneList,
  formatCustomSceneStatus,
} from "./scene-presentation.js";
import type { CustomActor, CustomPeer, CustomRuntimeConfig, CustomSceneConfig, CustomSceneKind } from "./types.js";

export {
  CUSTOM_SCENE_KINDS,
  parseCustomSceneCommand,
  type CustomSceneCommand,
  type CustomSceneCommandParseResult,
} from "./scene-command-parser.js";

export {
  buildCustomSceneSwitchKeyboard,
  formatCustomSceneBindings,
  formatCustomSceneBoundReply,
  formatCustomSceneHelp,
  formatCustomSceneList,
  formatCustomSceneStatus,
} from "./scene-presentation.js";

export interface CustomSceneCommandResult {
  handled: boolean;
  reply?: string;
  keyboard?: InlineKeyboard;
  changed?: boolean;
  sceneKey?: string;
  sceneConfig?: CustomSceneConfig;
}

export interface CustomSceneInteractionResult {
  handled: boolean;
  reply?: string;
  changed?: boolean;
  sceneKey?: string;
  sceneConfig?: CustomSceneConfig;
}

export function handleCustomSceneCommand(params: {
  cfg: OpenClawConfig;
  message: QueuedMessage;
  rawContent: string;
}): CustomSceneCommandResult {
  const parsed = parseCustomSceneCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatCustomSceneHelp(parsed.error) };
  const command = parsed.command ?? { kind: "status" as const };
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const runtime = resolveCustomRuntimeConfig(params.cfg);

  if (command.kind === "help") return { handled: true, reply: formatCustomSceneHelp() };
  if (command.kind === "list") return { handled: true, reply: formatCustomSceneList(), keyboard: buildCustomSceneSwitchKeyboard() };
  if (command.kind === "bindings") return { handled: true, reply: formatCustomSceneBindings(runtime) };
  if (command.kind === "status") {
    return { handled: true, reply: formatCustomSceneStatus(params.cfg, peer), keyboard: buildCustomSceneSwitchKeyboard() };
  }

  const key = formatCustomPeerKey(peer);
  const actor = toCustomActorFromQueuedMessage(params.message);
  if (runtime.enabled === true && !isCustomRuntimeAdmin(runtime, actor)) {
    return {
      handled: true,
      reply: [
        "⛔ 只有 customRuntime.admins 中的管理员可以绑定场景。",
        "",
        `当前用户：${formatCustomActorIdentity(actor, { idLabel: params.message.type === "group" ? "member_openid" : "user_openid" })}`,
      ].join("\n"),
    };
  }
  const sceneConfig: CustomSceneConfig = {
    ...runtime.scenes?.[key],
    scene: command.scene,
  };
  if (command.agentId !== undefined) {
    if (command.agentId === null) {
      delete sceneConfig.agentId;
    } else {
      sceneConfig.agentId = command.agentId;
    }
  }
  upsertCustomSceneConfig(params.cfg, key, sceneConfig, runtime);

  return {
    handled: true,
    changed: true,
    sceneKey: key,
    sceneConfig,
    keyboard: buildCustomSceneSwitchKeyboard(command.scene),
    reply: formatCustomSceneBoundReply({
      key,
      target: formatCustomPeerIdentity(peer, params.cfg),
      scene: command.scene,
      agentId: sceneConfig.agentId,
    }),
  };
}


export function handleCustomSceneInteraction(params: {
  cfg: OpenClawConfig;
  buttonData: string;
  actor: CustomActor;
  sourcePeer?: CustomPeer;
}): CustomSceneInteractionResult {
  const payload = parseCustomSceneButtonData(params.buttonData);
  if (!payload) return { handled: false };

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (runtime.enabled !== true) {
    return { handled: true, reply: "ℹ️ customRuntime 未启用，无法通过按钮切换场景。" };
  }
  if (!isCustomRuntimeAdmin(runtime, params.actor)) {
    return {
      handled: true,
      reply: [
        "⛔ 只有 customRuntime.admins 中的管理员可以通过按钮切换场景。",
        "",
        `当前用户：${formatCustomActorIdentity(params.actor, { idLabel: params.sourcePeer?.kind === "group" ? "member_openid" : "user_openid" })}`,
      ].join("\n"),
    };
  }
  if (!params.sourcePeer) {
    return { handled: true, reply: "⚠️ 无法识别按钮来源会话，不能切换场景。" };
  }

  const key = formatCustomPeerKey(params.sourcePeer);
  const sceneConfig: CustomSceneConfig = {
    ...runtime.scenes?.[key],
    scene: payload.scene,
  };
  upsertCustomSceneConfig(params.cfg, key, sceneConfig, runtime);
  return {
    handled: true,
    changed: true,
    sceneKey: key,
    sceneConfig,
    reply: formatCustomSceneBoundReply({
      key,
      target: formatCustomPeerIdentity(params.sourcePeer, params.cfg),
      scene: payload.scene,
      agentId: sceneConfig.agentId,
    }),
  };
}

export function parseCustomSceneButtonData(buttonData: string): { scene: CustomSceneKind } | null {
  const m = buttonData.match(/^custom-scene:set:([a-z0-9-]+)$/i);
  if (!m) return null;
  const parsed = parseCustomSceneCommand(`/bot-scene set ${m[1]}`);
  if (!parsed.matched || parsed.error || parsed.command?.kind !== "set") return null;
  return { scene: parsed.command.scene };
}

export function upsertCustomSceneConfig(
  cfg: OpenClawConfig,
  key: string,
  sceneConfig: CustomSceneConfig,
  runtime: CustomRuntimeConfig,
): void {
  const root = cfg as Record<string, any>;
  root.channels = root.channels ?? {};
  root.channels.qqbot = root.channels.qqbot ?? {};
  const qqbot = root.channels.qqbot;
  qqbot.customRuntime = {
    ...runtime,
    enabled: runtime.enabled ?? true,
    scenes: {
      ...(runtime.scenes ?? {}),
      [key]: sceneConfig,
    },
  };
}
