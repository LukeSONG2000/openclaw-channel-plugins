import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard } from "../types.js";
import { toCustomPeerFromQueuedMessage } from "./queued-message-context.js";
import { resolveCustomRuntimeConfig } from "./config.js";
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
import type { CustomRuntimeConfig, CustomSceneConfig } from "./types.js";

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
      scene: command.scene,
      agentId: sceneConfig.agentId,
    }),
  };
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
