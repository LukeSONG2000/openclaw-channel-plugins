import type {
  CustomActor,
  CustomAuthorizationDecision,
  CustomCapability,
  CustomPeer,
  CustomRuntimeConfig,
  CustomSceneConfig,
} from "./types.js";

const ADMIN_CAPABILITIES: CustomCapability[] = [
  "chat.send",
  "codex.run",
  "codex.longTask",
  "system.status",
  "system.restart",
  "config.read",
  "config.write",
  "auth.grant",
  "deploy.check",
  "deploy.apply",
  "proactive.send",
  "game.interact",
];

const DEFAULT_SCENE_CAPABILITIES: Record<CustomSceneConfig["scene"], CustomCapability[]> = {
  "codex-only": ["codex.run", "codex.longTask"],
  chat: ["chat.send"],
  "system-admin": ["system.status", "deploy.check"],
  "dev-lab": ["chat.send", "codex.run", "codex.longTask", "system.status", "deploy.check"],
  "default-dm": ["chat.send", "codex.run"],
};

export function isCustomRuntimeAdmin(runtime: CustomRuntimeConfig, actor: CustomActor): boolean {
  return (runtime.admins ?? []).some((admin) => admin === "*" || admin.toUpperCase() === actor.id.toUpperCase());
}

export function evaluateCustomAuthorization(params: {
  runtime: CustomRuntimeConfig;
  scene: CustomSceneConfig;
  peer: CustomPeer;
  actor: CustomActor;
  capability: CustomCapability;
}): CustomAuthorizationDecision {
  const { runtime, scene, peer, actor, capability } = params;

  if (runtime.enabled === false) {
    return { allowed: false, reason: "scene_disabled", capability, actorId: actor.id, peerId: peer.id };
  }

  const capabilities = isCustomRuntimeAdmin(runtime, actor)
    ? ADMIN_CAPABILITIES
    : (scene.capabilities ?? DEFAULT_SCENE_CAPABILITIES[scene.scene] ?? []);
  const allowed = capabilities.includes(capability);

  return {
    allowed,
    reason: allowed ? "allowed" : "missing_capability",
    capability,
    actorId: actor.id,
    peerId: peer.id,
  };
}
