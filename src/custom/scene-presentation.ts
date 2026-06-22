import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import { resolveCustomSceneState } from "./config.js";
import { CUSTOM_SCENE_KINDS } from "./scene-command-parser.js";
import {
  formatCustomPeerKey,
  getCustomSceneProfile,
} from "./scenes.js";
import {
  formatBooleanYesNo,
  formatCapabilitiesForDisplay,
  formatSceneKind,
  formatSceneSource,
} from "./presentation-labels.js";
import type { CustomPeer, CustomRuntimeConfig, CustomSceneConfig, CustomSceneKind } from "./types.js";

export function buildCustomSceneSwitchKeyboard(currentScene?: CustomSceneKind): InlineKeyboard {
  return {
    content: {
      rows: CUSTOM_SCENE_KINDS.map((scene) => ({
        buttons: [makeSceneSwitchButton(scene, currentScene === scene)],
      })),
    },
  };
}

export function formatCustomSceneHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🧭 自定义场景命令`,
    ``,
    `/bot-scene status`,
    `/bot-scene list`,
    `/bot-scene bindings`,
    `/bot-scene set <scene> [--agent <agentId>]`,
    `/bot-scene set <scene> --clear-agent`,
    ``,
    `可选场景：${CUSTOM_SCENE_KINDS.map(formatSceneKind).join(", ")}`,
  );
  return lines.join("\n");
}

export function formatCustomSceneList(): string {
  const lines = [`🧭 可用自定义场景`, ``];
  for (const scene of CUSTOM_SCENE_KINDS) {
    const profile = getCustomSceneProfile(scene);
    lines.push(`- ${formatSceneKind(scene)}：${profile.description}`);
  }
  return lines.join("\n");
}

export function formatCustomSceneBindings(runtime: CustomRuntimeConfig): string {
  const entries = Object.entries(runtime.scenes ?? {})
    .filter((entry): entry is [string, CustomSceneConfig] =>
      Boolean(entry[0])
      && typeof entry[1] === "object"
      && entry[1] !== null
      && !Array.isArray(entry[1])
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    `🧭 已配置自定义场景绑定`,
    ``,
    `数量：${entries.length}`,
  ];
  if (entries.length === 0) {
    lines.push(``, `暂无显式场景绑定。当前会话仍会使用默认场景规则。`);
    return lines.join("\n");
  }

  for (const [key, scene] of entries) {
    const profile = getCustomSceneProfile(scene.scene);
    lines.push(
      ``,
      `- ${key}`,
      `  场景：${formatSceneKind(scene.scene)}；启用：${formatBooleanYesNo(scene.enabled !== false)}`,
      `  名称：${scene.label ?? profile.label}`,
      `  智能体：${scene.agentId ?? "默认路由"}`,
      `  能力：${formatCapabilitiesForDisplay(scene.capabilities?.length ? scene.capabilities : profile.capabilities)}`,
    );
  }
  return lines.join("\n");
}

export function formatCustomSceneStatus(cfg: OpenClawConfig, peer: CustomPeer): string {
  const resolved = resolveCustomSceneState(cfg, peer);
  return [
    `🧭 当前会话场景`,
    ``,
    `目标：${formatCustomPeerKey(peer)}`,
    `场景：${formatSceneKind(resolved.config.scene)}`,
    `来源：${formatSceneSource(resolved.source)}`,
    `配置键：${resolved.key}`,
    `启用：${formatBooleanYesNo(resolved.enabled)}`,
    `智能体：${resolved.config.agentId ?? "默认路由"}`,
    `能力：${formatCapabilitiesForDisplay(resolved.capabilities)}`,
    `说明：${resolved.profile.description}`,
  ].join("\n");
}

export function formatCustomSceneBoundReply(params: {
  key: string;
  scene: CustomSceneKind;
  agentId?: string;
}): string {
  return [
    `✅ 当前会话场景已绑定`,
    ``,
    `目标：${params.key}`,
    `场景：${formatSceneKind(params.scene)}`,
    `智能体：${params.agentId ?? "默认路由"}`,
    `说明：${getCustomSceneProfile(params.scene).description}`,
    ``,
    `配置已写入当前运行时，并将由 gateway 持久化到 openclaw.json。`,
  ].join("\n");
}

function makeSceneSwitchButton(scene: CustomSceneKind, current: boolean): KeyboardButton {
  const profile = getCustomSceneProfile(scene);
  return {
    id: `scene_${scene.replace(/[^a-z0-9_]/gi, "_")}`,
    render_data: {
      label: current ? `当前：${profile.label}` : profile.label,
      visited_label: `切换到 ${profile.label}`,
      style: current ? 4 : 1,
    },
    action: {
      type: 1,
      data: `custom-scene:set:${scene}`,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "custom-scene",
  };
}
