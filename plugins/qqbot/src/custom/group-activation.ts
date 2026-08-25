import fs from "node:fs";
import path from "node:path";

export type CustomGroupActivationMode = "mention" | "always";

export interface CustomGroupActivationEnv {
  HOME?: string;
  USERPROFILE?: string;
  OPENCLAW_STATE_DIR?: string;
  CLAWDBOT_STATE_DIR?: string;
}

export interface CustomGroupActivationFileReader {
  existsSync: (filePath: string) => boolean;
  readFileSync: (filePath: string) => string;
}

export function defaultCustomGroupActivationMode(configRequireMention: boolean): CustomGroupActivationMode {
  return configRequireMention ? "mention" : "always";
}

export function normalizeCustomGroupActivationMode(
  raw: unknown,
  fallback: CustomGroupActivationMode,
): CustomGroupActivationMode {
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === "mention" || normalized === "always" ? normalized : fallback;
}

export function resolveCustomSessionStorePath(params: {
  cfg: Record<string, unknown>;
  agentId?: string;
  env?: CustomGroupActivationEnv;
}): string {
  const env = params.env ?? process.env;
  const agentId = params.agentId || "default";
  const sessionCfg = objectOrEmpty(params.cfg.session);
  const store = typeof sessionCfg.store === "string" ? sessionCfg.store.trim() : "";

  if (store) {
    let expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      const home = env.HOME || env.USERPROFILE || "";
      expanded = expanded.replace(/^~/, home);
    }
    return path.resolve(expanded);
  }

  const stateDir = env.OPENCLAW_STATE_DIR?.trim()
    || env.CLAWDBOT_STATE_DIR?.trim()
    || path.join(env.HOME || env.USERPROFILE || "", ".openclaw");
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

export function resolveCustomGroupActivation(params: {
  cfg: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
  env?: CustomGroupActivationEnv;
  fileReader?: CustomGroupActivationFileReader;
}): CustomGroupActivationMode {
  const fallback = defaultCustomGroupActivationMode(params.configRequireMention);
  try {
    const fileReader = params.fileReader ?? defaultFileReader;
    const storePath = resolveCustomSessionStorePath({
      cfg: params.cfg,
      agentId: params.agentId,
      env: params.env,
    });
    if (!fileReader.existsSync(storePath)) return fallback;
    const raw = fileReader.readFileSync(storePath);
    return resolveCustomGroupActivationFromSessionStore(raw, params.sessionKey, fallback);
  } catch {
    return fallback;
  }
}

export function resolveCustomGroupActivationFromSessionStore(
  raw: string,
  sessionKey: string,
  fallback: CustomGroupActivationMode,
): CustomGroupActivationMode {
  const store = JSON.parse(raw) as Record<string, { groupActivation?: unknown } | undefined>;
  return normalizeCustomGroupActivationMode(store[sessionKey]?.groupActivation, fallback);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const defaultFileReader: CustomGroupActivationFileReader = {
  existsSync: fs.existsSync,
  readFileSync: (filePath) => fs.readFileSync(filePath, "utf-8"),
};
