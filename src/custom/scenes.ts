import type {
  CustomCapability,
  CustomPeer,
  CustomRuntimeConfig,
  CustomSceneConfig,
  CustomSceneKind,
} from "./types.js";

export interface CustomSceneProfile {
  scene: CustomSceneKind;
  label: string;
  description: string;
  capabilities: Exclude<CustomCapability, "*">[];
  allowAutonomousReply: boolean;
  allowProactiveSend: boolean;
  prompt: string;
}

export interface ResolvedCustomScene {
  key: string;
  source: "exact" | "kind-wildcard" | "wildcard" | "default";
  config: CustomSceneConfig;
  profile: CustomSceneProfile;
  capabilities: CustomCapability[];
  enabled: boolean;
}

type ConcreteCapability = Exclude<CustomCapability, "*">;

const DEFAULT_SCENE_PROFILES: Record<CustomSceneKind, CustomSceneProfile> = {
  "codex-only": {
    scene: "codex-only",
    label: "Codex only",
    description: "Only Codex CLI/task work is expected; casual chat and system mutation stay gated.",
    capabilities: ["codex.run", "codex.longTask"],
    allowAutonomousReply: false,
    allowProactiveSend: false,
    prompt: [
      "当前 QQBot 场景是 codex-only。",
      "聚焦明确的 Codex/开发任务；不要主动闲聊。",
      "配置、部署、重启、授权等管理动作必须经过权限判断。",
    ].join("\n"),
  },
  chat: {
    scene: "chat",
    label: "Chat",
    description: "Normal chat group with safe conversational replies.",
    capabilities: ["chat.send"],
    allowAutonomousReply: false,
    allowProactiveSend: false,
    prompt: [
      "当前 QQBot 场景是 chat。",
      "可以自然参与聊天，但不要执行系统管理、配置修改、部署更新或长程任务，除非权限机制明确放行。",
    ].join("\n"),
  },
  "system-admin": {
    scene: "system-admin",
    label: "System admin",
    description: "System status, authorization, and guarded administration.",
    capabilities: ["system.status", "deploy.check", "config.read"],
    allowAutonomousReply: false,
    allowProactiveSend: false,
    prompt: [
      "当前 QQBot 场景是 system-admin。",
      "优先处理状态查询、授权申请、部署检查和系统管理对话。",
      "重启、配置写入、权限授予和部署执行必须由管理员或临时授权触发。",
    ].join("\n"),
  },
  "dev-lab": {
    scene: "dev-lab",
    label: "Development lab",
    description: "Self-development group with Codex work and guarded operations.",
    capabilities: ["chat.send", "codex.run", "codex.longTask", "system.status", "deploy.check", "config.read"],
    allowAutonomousReply: false,
    allowProactiveSend: false,
    prompt: [
      "当前 QQBot 场景是 dev-lab。",
      "可以协助二次开发、代码检查、计划拆解和状态查询。",
      "配置写入、重启、授权、部署执行等高风险动作必须经过权限判断。",
      "长程任务应进入独立沙盒，不阻塞主对话；当前未启用沙盒时应先说明需要排队或拆分。",
    ].join("\n"),
  },
  "default-dm": {
    scene: "default-dm",
    label: "Direct message",
    description: "Default direct-message behavior.",
    capabilities: ["chat.send", "codex.run", "system.status", "deploy.check", "config.read"],
    allowAutonomousReply: false,
    allowProactiveSend: false,
    prompt: [
      "当前 QQBot 场景是 default-dm。",
      "可以进行私聊问答、轻量 Codex 协助和状态查询。",
      "高风险管理动作仍需要管理员权限。",
    ].join("\n"),
  },
};

export function formatCustomPeerKey(peer: CustomPeer): string {
  return `qqbot:${peer.kind}:${peer.id}`;
}

export function formatCustomPeerKindWildcard(peer: Pick<CustomPeer, "kind">): string {
  return `qqbot:${peer.kind}:*`;
}

export function defaultSceneCapabilities(scene: CustomSceneKind): ConcreteCapability[] {
  return (DEFAULT_SCENE_PROFILES[scene]?.capabilities ?? []).slice();
}

export function getCustomSceneProfile(scene: CustomSceneKind): CustomSceneProfile {
  const profile = DEFAULT_SCENE_PROFILES[scene] ?? DEFAULT_SCENE_PROFILES["default-dm"];
  return cloneProfile(profile);
}

export function resolveCustomSceneConfigFromRuntime(
  runtime: CustomRuntimeConfig,
  peer: CustomPeer,
): CustomSceneConfig {
  return resolveCustomScene(runtime, peer).config;
}

export function resolveCustomScene(
  runtime: CustomRuntimeConfig,
  peer: CustomPeer,
): ResolvedCustomScene {
  const scenes = runtime.scenes ?? {};
  const exactKey = formatCustomPeerKey(peer);
  const kindWildcardKey = formatCustomPeerKindWildcard(peer);
  const resolved = scenes[exactKey]
    ? { key: exactKey, source: "exact" as const, config: scenes[exactKey]! }
    : scenes[kindWildcardKey]
      ? { key: kindWildcardKey, source: "kind-wildcard" as const, config: scenes[kindWildcardKey]! }
      : scenes["*"]
        ? { key: "*", source: "wildcard" as const, config: scenes["*"]! }
        : {
            key: defaultSceneKey(peer, runtime.defaultScene),
            source: "default" as const,
            config: { scene: defaultSceneKind(peer, runtime.defaultScene) },
          };

  return applySceneDefaults(resolved.config, resolved.key, resolved.source);
}

export function applySceneDefaults(
  sceneConfig: CustomSceneConfig,
  key: string = sceneConfig.scene,
  source: ResolvedCustomScene["source"] = "default",
): ResolvedCustomScene {
  const base = getCustomSceneProfile(sceneConfig.scene);
  const capabilities = sceneConfig.capabilities
    ? normalizeCapabilities(sceneConfig.capabilities)
    : base.capabilities.slice();
  const enabled = sceneConfig.enabled !== false;
  const profile: CustomSceneProfile = {
    ...base,
    label: sceneConfig.label ?? base.label,
    description: sceneConfig.description ?? base.description,
    capabilities: capabilities.filter((capability): capability is ConcreteCapability => capability !== "*"),
    allowAutonomousReply: sceneConfig.allowAutonomousReply ?? base.allowAutonomousReply,
    allowProactiveSend: sceneConfig.allowProactiveSend ?? base.allowProactiveSend,
    prompt: sceneConfig.systemPrompt ?? base.prompt,
  };

  return {
    key,
    source,
    config: {
      ...sceneConfig,
      label: profile.label,
      capabilities,
      allowAutonomousReply: profile.allowAutonomousReply,
      allowProactiveSend: profile.allowProactiveSend,
    },
    profile,
    capabilities,
    enabled,
  };
}

export function buildCustomSceneSystemPrompt(resolved: ResolvedCustomScene): string {
  if (!resolved.enabled) {
    return [
      `QQBot 自定义场景：${resolved.profile.label} (${resolved.profile.scene})`,
      "当前场景已禁用，不应继续执行对话或工具调用。",
    ].join("\n");
  }
  const capabilityText = resolved.capabilities.length > 0
    ? resolved.capabilities.join(", ")
    : "none";
  const autonomy = [
    `autonomousReply=${resolved.profile.allowAutonomousReply ? "on" : "off"}`,
    `proactiveSend=${resolved.profile.allowProactiveSend ? "on" : "off"}`,
  ].join(", ");
  return [
    `QQBot 自定义场景：${resolved.profile.label} (${resolved.profile.scene})`,
    `能力边界：${capabilityText}`,
    `主动策略：${autonomy}`,
    resolved.profile.prompt,
  ].filter(Boolean).join("\n");
}

function defaultSceneKind(peer: CustomPeer, runtimeDefault?: CustomSceneKind): CustomSceneKind {
  if (peer.kind === "group") return "chat";
  return runtimeDefault ?? "default-dm";
}

function defaultSceneKey(peer: CustomPeer, runtimeDefault?: CustomSceneKind): string {
  const scene: CustomSceneKind = defaultSceneKind(peer, runtimeDefault);
  return `default:${scene}`;
}

function normalizeCapabilities(capabilities: CustomCapability[]): CustomCapability[] {
  const seen = new Set<string>();
  const normalized: CustomCapability[] = [];
  for (const capability of capabilities) {
    if (!capability || seen.has(capability)) continue;
    seen.add(capability);
    normalized.push(capability);
  }
  return normalized;
}

function cloneProfile(profile: CustomSceneProfile): CustomSceneProfile {
  return {
    ...profile,
    capabilities: profile.capabilities.slice(),
  };
}
