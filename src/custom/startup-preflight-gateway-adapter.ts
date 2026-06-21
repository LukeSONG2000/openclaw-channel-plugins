import { initApiConfig as defaultInitApiConfig, setApiLogger as defaultSetApiLogger } from "../api.js";
import { isImageServerRunning, startImageServer, type ImageServerConfig } from "../image-server.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { resolveTTSConfig as defaultResolveTTSConfig } from "../utils/audio-convert.js";
import { getQQBotDataDir, runDiagnostics as defaultRunDiagnostics } from "../utils/platform.js";

const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || getQQBotDataDir("images");

export interface QQBotGatewayStartupPreflightLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface RunQQBotGatewayStartupPreflightParams {
  account: Pick<ResolvedQQBotAccount, "accountId" | "markdownSupport" | "imageServerBaseUrl">;
  cfg: unknown;
  log?: QQBotGatewayStartupPreflightLogger;
  getRuntime: () => unknown;
  runDiagnostics?: typeof defaultRunDiagnostics;
  setApiLogger?: typeof defaultSetApiLogger;
  initApiConfig?: typeof defaultInitApiConfig;
  resolveTTSConfig?: typeof defaultResolveTTSConfig;
  ensureImageServer?: (log?: QQBotGatewayStartupPreflightLogger, publicBaseUrl?: string) => Promise<string | null>;
}

export interface RunQQBotGatewayStartupPreflightResult {
  imageServerBaseUrl: string | null;
  hasTTS: boolean;
}

export async function runQQBotGatewayStartupPreflight(
  params: RunQQBotGatewayStartupPreflightParams,
): Promise<RunQQBotGatewayStartupPreflightResult> {
  const { account, log } = params;

  const diag = await (params.runDiagnostics ?? defaultRunDiagnostics)();
  for (const warning of diag.warnings) {
    log?.info?.(`[qqbot:${account.accountId}] ${warning}`);
  }

  runRuntimePreflight(params);

  if (log && params.setApiLogger) {
    params.setApiLogger(log as Parameters<typeof defaultSetApiLogger>[0]);
  } else if (log) {
    defaultSetApiLogger(log as Parameters<typeof defaultSetApiLogger>[0]);
  }
  (params.initApiConfig ?? defaultInitApiConfig)({
    markdownSupport: account.markdownSupport,
  });
  log?.info?.(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  const ttsCfg = (params.resolveTTSConfig ?? defaultResolveTTSConfig)(params.cfg as Record<string, unknown>);
  logTTSConfig(account.accountId, ttsCfg, log);

  const imageServerBaseUrl = await setupImageServer({
    publicBaseUrl: account.imageServerBaseUrl,
    ensureImageServer: params.ensureImageServer,
    log,
    accountId: account.accountId,
  });

  return {
    imageServerBaseUrl,
    hasTTS: Boolean(ttsCfg),
  };
}

function runRuntimePreflight(params: RunQQBotGatewayStartupPreflightParams): void {
  try {
    const runtime = params.getRuntime() as {
      channel?: {
        reply?: {
          dispatchReplyWithBufferedBlockDispatcher?: unknown;
        };
      };
    } | null | undefined;
    if (runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
      params.log?.info?.(`[qqbot:${params.account.accountId}] Runtime module preflight: OK`);
    } else {
      params.log?.error?.(`[qqbot:${params.account.accountId}] ⚠️ Runtime preflight: dispatchReply API 不可用，AI 消息处理可能失败。请检查 openclaw 版本兼容性`);
    }
  } catch (preflightErr) {
    params.log?.error?.(`[qqbot:${params.account.accountId}] ⚠️ Runtime preflight failed: ${preflightErr}. AI 消息处理可能失败`);
  }
}

function logTTSConfig(
  accountId: string,
  ttsCfg: ReturnType<typeof defaultResolveTTSConfig>,
  log?: QQBotGatewayStartupPreflightLogger,
): void {
  if (!ttsCfg) {
    log?.info?.(`[qqbot:${accountId}] TTS not configured (voice messages will be unavailable)`);
    return;
  }
  const maskedKey = ttsCfg.apiKey.length > 8
    ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
    : "****";
  log?.info?.(`[qqbot:${accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`);
  log?.info?.(`[qqbot:${accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`);
}

async function setupImageServer(params: {
  publicBaseUrl?: string;
  ensureImageServer?: (log?: QQBotGatewayStartupPreflightLogger, publicBaseUrl?: string) => Promise<string | null>;
  log?: QQBotGatewayStartupPreflightLogger;
  accountId: string;
}): Promise<string | null> {
  if (!params.publicBaseUrl) {
    params.log?.info?.(`[qqbot:${params.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
    return null;
  }
  const imageServerBaseUrl = await (params.ensureImageServer ?? ensureQQBotImageServer)(
    params.log,
    params.publicBaseUrl,
  );
  params.log?.info?.(`[qqbot:${params.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  return imageServerBaseUrl;
}

export async function ensureQQBotImageServer(
  log?: QQBotGatewayStartupPreflightLogger,
  publicBaseUrl?: string,
): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600,
    };
    await startImageServer(config);
    log?.info?.(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error?.(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}
