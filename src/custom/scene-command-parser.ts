import type { CustomSceneKind } from "./types.js";

export type CustomSceneCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "bindings" }
  | { kind: "status" }
  | { kind: "set"; scene: CustomSceneKind; agentId?: string | null };

export type CustomSceneCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomSceneCommand; error?: string };

export const CUSTOM_SCENE_KINDS: readonly CustomSceneKind[] = [
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
    const agent = parseSceneAgentOption(tokens);
    if (agent.error) return { matched: true, error: agent.error };
    return { matched: true, command: { kind: "set", scene, agentId: agent.agentId } };
  }

  if (isCustomSceneKind(action)) {
    const agent = parseSceneAgentOption(tokens);
    if (agent.error) return { matched: true, error: agent.error };
    return { matched: true, command: { kind: "set", scene: action, agentId: agent.agentId } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

function parseSceneAgentOption(tokens: string[]): { agentId?: string | null; error?: string } {
  let agentId: string | null | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--clear-agent" || token === "--agent=none" || token === "--agent=default") {
      agentId = null;
      continue;
    }
    if (token === "--agent") {
      const value = tokens[++i];
      if (!value) return { error: "缺少 agentId" };
      const normalized = normalizeSceneAgentInput(value);
      agentId = normalized ?? null;
      continue;
    }
    if (token.startsWith("--agent=")) {
      const normalized = normalizeSceneAgentInput(token.slice("--agent=".length));
      if (normalized === undefined) return { error: "缺少 agentId" };
      agentId = normalized ?? null;
      continue;
    }
    return { error: `未知参数：${token}` };
  }
  return { agentId };
}

function normalizeSceneAgentInput(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "none" || lowered === "default" || lowered === "null" || lowered === "-") return null;
  return trimmed;
}

function isCustomSceneKind(value: string): value is CustomSceneKind {
  return (CUSTOM_SCENE_KINDS as readonly string[]).includes(value);
}
