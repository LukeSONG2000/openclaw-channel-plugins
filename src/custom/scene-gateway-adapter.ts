import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import { toCustomPeerFromQueuedMessage } from "./auth-gateway-adapter.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneState } from "./config.js";
import {
  formatCustomPeerKey,
  getCustomSceneProfile,
} from "./scenes.js";
import type { CustomRuntimeConfig, CustomSceneConfig, CustomSceneKind } from "./types.js";

export type CustomSceneCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "bindings" }
  | { kind: "status" }
  | { kind: "set"; scene: CustomSceneKind };

export type CustomSceneCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomSceneCommand; error?: string };

export interface CustomSceneCommandResult {
  handled: boolean;
  reply?: string;
  changed?: boolean;
  sceneKey?: string;
  sceneConfig?: CustomSceneConfig;
}

const CUSTOM_SCENE_KINDS: CustomSceneKind[] = [
  "codex-only",
  "chat",
  "system-admin",
  "dev-lab",
  "default-dm",
];

export function parseCustomSceneCommand(rawContent: string): CustomSceneCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-scene") return { matched: false };

  const action = (tokens.shift() ?? "status").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "bindings" || action === "binds" || action === "configured") return { matched: true, command: { kind: "bindings" } };
  if (action === "status" || action === "show") return { matched: true, command: { kind: "status" } };
  if (action === "set" || action === "bind") {
    const scene = tokens.shift();
    if (!scene) return { matched: true, error: "缺少 scene 名称" };
    if (!isCustomSceneKind(scene)) return { matched: true, error: `未知 scene：${scene}` };
    return { matched: true, command: { kind: "set", scene } };
  }

  if (isCustomSceneKind(action)) {
    return { matched: true, command: { kind: "set", scene: action } };
  }

  return { matched: true, error: `未知子命令：${action}` };
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
  if (command.kind === "list") return { handled: true, reply: formatCustomSceneList() };
  if (command.kind === "bindings") return { handled: true, reply: formatCustomSceneBindings(runtime) };
  if (command.kind === "status") {
    return { handled: true, reply: formatCustomSceneStatus(params.cfg, peer) };
  }

  const key = formatCustomPeerKey(peer);
  const sceneConfig: CustomSceneConfig = {
    ...runtime.scenes?.[key],
    scene: command.scene,
  };
  upsertCustomSceneConfig(params.cfg, key, sceneConfig, runtime);

  return {
    handled: true,
    changed: true,
    sceneKey: key,
    sceneConfig,
    reply: [
      `✅ 当前会话场景已绑定`,
      ``,
      `目标：${key}`,
      `场景：${command.scene}`,
      `说明：${getCustomSceneProfile(command.scene).description}`,
      ``,
      `配置已写入当前运行时，并将由 gateway 持久化到 openclaw.json。`,
    ].join("\n"),
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

function formatCustomSceneHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🧭 自定义场景命令`,
    ``,
    `/bot-scene status`,
    `/bot-scene list`,
    `/bot-scene bindings`,
    `/bot-scene set <scene>`,
    ``,
    `可选 scene：${CUSTOM_SCENE_KINDS.join(", ")}`,
  );
  return lines.join("\n");
}

function formatCustomSceneList(): string {
  const lines = [`🧭 可用自定义场景`, ``];
  for (const scene of CUSTOM_SCENE_KINDS) {
    const profile = getCustomSceneProfile(scene);
    lines.push(`- ${scene}: ${profile.description}`);
  }
  return lines.join("\n");
}

function formatCustomSceneBindings(runtime: CustomRuntimeConfig): string {
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
    const capabilities = scene.capabilities?.length
      ? scene.capabilities.join(", ")
      : profile.capabilities.join(", ");
    lines.push(
      ``,
      `- ${key}`,
      `  scene=${scene.scene}, enabled=${scene.enabled === false ? "no" : "yes"}`,
      `  label=${scene.label ?? profile.label}`,
      `  capabilities=${capabilities || "none"}`,
    );
  }
  return lines.join("\n");
}

function formatCustomSceneStatus(cfg: OpenClawConfig, peer: ReturnType<typeof toCustomPeerFromQueuedMessage>): string {
  const resolved = resolveCustomSceneState(cfg, peer);
  return [
    `🧭 当前会话场景`,
    ``,
    `目标：${formatCustomPeerKey(peer)}`,
    `场景：${resolved.config.scene}`,
    `来源：${resolved.source}`,
    `配置键：${resolved.key}`,
    `启用：${resolved.enabled ? "是" : "否"}`,
    `能力：${resolved.capabilities.length ? resolved.capabilities.join(", ") : "none"}`,
    `说明：${resolved.profile.description}`,
  ].join("\n");
}

function isCustomSceneKind(value: string): value is CustomSceneKind {
  return (CUSTOM_SCENE_KINDS as string[]).includes(value);
}
