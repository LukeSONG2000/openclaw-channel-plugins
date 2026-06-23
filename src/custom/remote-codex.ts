import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";

export interface RemoteCodexBinding {
  enabled?: boolean;
  sessionId?: string;
}

export interface RemoteCodexSettings {
  relayUrl: string;
  token: string;
  sessionId: string;
  conversationId: string;
  waitMs: number;
}

export interface RemoteCodexDispatchResult {
  handled: boolean;
  reply?: string;
  error?: unknown;
}

const DEFAULT_RELAY_URL = "http://127.0.0.1:17322";
const DEFAULT_TOKEN_FILE = "/opt/codex-relay/.env.openclaw-relay";
const DEFAULT_WAIT_MS = 55000;

export function resolveRemoteCodexBinding(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  message: Pick<QueuedMessage, "type" | "groupOpenid" | "senderId">;
}): RemoteCodexSettings | null {
  if (params.message.type !== "group" || !params.message.groupOpenid) return null;
  const account = resolveQQBotConfigForAccount(params.cfg, params.accountId);
  const groups = objectRecord(account?.groups) ?? {};
  const groupCfg = objectRecord(groups[params.message.groupOpenid]);
  const binding = objectRecord(groupCfg?.remoteCodex) as RemoteCodexBinding | undefined;
  if (!binding?.enabled) return null;

  const base = objectRecord(account?.remoteCodex) ?? objectRecord((params.cfg as any)?.channels?.qqbot?.remoteCodex) ?? {};
  const relayUrl = stringValue(base.relayUrl) || stringValue(process.env.CODEX_RELAY_URL) || DEFAULT_RELAY_URL;
  const token = stringValue(base.token)
    || stringValue(process.env.CODEX_RELAY_TOKEN)
    || readRelayToken(stringValue(base.tokenFile) || DEFAULT_TOKEN_FILE);
  if (!token) return null;

  return {
    relayUrl: relayUrl.replace(/\/+$/, ""),
    token,
    sessionId: stringValue(binding.sessionId) || stringValue(base.sessionId) || "current-host",
    conversationId: `qqbot:group:${params.message.groupOpenid}`,
    waitMs: numberValue(base.waitMs, DEFAULT_WAIT_MS),
  };
}

export async function dispatchRemoteCodexMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  message: QueuedMessage;
  content: string;
}): Promise<RemoteCodexDispatchResult> {
  const settings = resolveRemoteCodexBinding({ cfg: params.cfg, accountId: params.accountId, message: params.message });
  if (!settings) return { handled: false };

  try {
    const response = await postRelayMessage(settings, params.message, params.content);
    const immediate = formatRelayImmediateResponse(response);
    const commandId = stringValue(response?.command?.id);
    if (!commandId) return { handled: true, reply: immediate };

    const waited = await waitForRelayCommand(settings, commandId);
    if (waited.completed || waited.failed) {
      return { handled: true, reply: formatRelayCompletion(response, waited) };
    }
    return {
      handled: true,
      reply: [
        immediate || "✅ 已发送到 remote Codex。",
        "",
        `⏳ 远端仍在执行，commandId: ${commandId}`,
        `可稍后使用 /codex current 或 /codex list 查看当前 thread 绑定。`,
      ].filter(Boolean).join("\n"),
    };
  } catch (error) {
    return {
      handled: true,
      error,
      reply: `❌ Remote Codex 调用失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function formatRemoteCodexStatus(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  groupOpenid?: string;
}): string {
  if (!params.groupOpenid) return "💡 请在 QQ 群里查看 remote Codex 绑定状态。";
  const account = resolveQQBotConfigForAccount(params.cfg, params.accountId);
  const groups = objectRecord(account?.groups) ?? {};
  const groupCfg = objectRecord(groups[params.groupOpenid]);
  const binding = objectRecord(groupCfg?.remoteCodex) as RemoteCodexBinding | undefined;
  const base = objectRecord(account?.remoteCodex) ?? objectRecord((params.cfg as any)?.channels?.qqbot?.remoteCodex) ?? {};
  if (!binding?.enabled) return "Remote Codex：未绑定";
  return [
    "Remote Codex：已绑定",
    `sessionId：${stringValue(binding.sessionId) || stringValue(base.sessionId) || "current-host"}`,
    `relay：${stringValue(base.relayUrl) || DEFAULT_RELAY_URL}`,
  ].join("\n");
}

async function postRelayMessage(settings: RemoteCodexSettings, message: QueuedMessage, content: string): Promise<any> {
  const body = {
    sessionId: settings.sessionId,
    platform: "openclaw",
    conversationId: settings.conversationId,
    userId: message.senderId,
    messageId: message.messageId,
    text: content,
  };
  const response = await fetch(`${settings.relayUrl}/v1/relay/platform/openclaw/message`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `relay HTTP ${response.status}`);
  return payload;
}

function formatRelayImmediateResponse(response: any): string {
  if (response?.control) {
    const control = response.control;
    if (!control.ok) return `❌ ${control.error || "Remote Codex 指令失败"}`;
    return formatControlResult(control.action, control.result);
  }
  if (response?.command?.id) {
    const type = response.command.type === "codex.thread.start" ? "创建远端 Codex thread" : "发送到 remote Codex";
    return `✅ 已${type}，commandId: ${response.command.id}`;
  }
  return "✅ Remote Codex 请求已处理。";
}

function formatControlResult(action: string, result: unknown): string {
  if (typeof result === "string") return `✅ /codex ${action}\n${result}`;
  return `✅ /codex ${action}\n${JSON.stringify(result, null, 2)}`;
}

interface WaitResult {
  completed: boolean;
  failed: boolean;
  commandId: string;
  threadId?: string;
  text: string;
  error?: string;
}

async function waitForRelayCommand(settings: RemoteCodexSettings, commandId: string): Promise<WaitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.waitMs);
  const chunks: string[] = [];
  try {
    const response = await fetch(`${settings.relayUrl}/v1/relay/sessions/${encodeURIComponent(settings.sessionId)}/events?replay=0`, {
      headers: { authorization: `Bearer ${settings.token}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return { completed: false, failed: false, commandId, text: "" };

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseFrame(frame);
        if (event) {
          const text = extractRelayEventText(event);
          if (text) chunks.push(text);
          const payload = event.payload ?? {};
          if (event.type === "relay.command.failed" && payload.commandId === commandId) {
            return { completed: false, failed: true, commandId, text: joinEventText(chunks), error: stringValue(payload.message) || "remote command failed" };
          }
          if (event.type === "relay.command.completed" && payload.commandId === commandId) {
            return {
              completed: true,
              failed: false,
              commandId,
              threadId: extractThreadId(payload.result),
              text: joinEventText(chunks),
            };
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      return { completed: false, failed: true, commandId, text: joinEventText(chunks), error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    clearTimeout(timer);
  }
  return { completed: false, failed: false, commandId, text: joinEventText(chunks) };
}

function formatRelayCompletion(response: any, waited: WaitResult): string {
  if (waited.failed) {
    return [`❌ Remote Codex 执行失败`, waited.error, waited.text].filter(Boolean).join("\n\n");
  }
  const lines = ["✅ Remote Codex 执行完成"];
  const threadId = waited.threadId || extractThreadId(response);
  if (threadId) lines.push(`threadId: ${threadId}`);
  if (waited.text) lines.push("", waited.text);
  return lines.join("\n");
}

function parseSseFrame(frame: string): any | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

function extractRelayEventText(event: any): string {
  if (event?.type === "relay.thread.bound") {
    const payload = event.payload ?? {};
    const alias = stringValue(payload.alias);
    return `已绑定 thread: ${stringValue(payload.threadId)}${alias ? `（alias: ${alias}）` : ""}`;
  }
  const rpc = event?.payload?.rpc ?? {};
  const params = rpc.params ?? {};
  const item = params.item ?? {};
  const text = stringValue(params.delta)
    || stringValue(params.text)
    || stringValue(params.message)
    || stringValue(item.text)
    || stringValue(item.message)
    || stringValue(event?.payload?.text);
  return text;
}

function extractThreadId(value: any): string | undefined {
  return stringValue(value?.threadId)
    || stringValue(value?.result?.threadId)
    || stringValue(value?.result?.thread?.id)
    || stringValue(value?.thread?.result?.thread?.id)
    || stringValue(value?.thread?.result?.threadId)
    || stringValue(value?.thread?.id)
    || undefined;
}

function joinEventText(chunks: string[]): string {
  const joined = chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk, index, arr) => arr.indexOf(chunk) === index)
    .join("\n");
  return joined.length > 3500 ? `${joined.slice(0, 3500)}\n...` : joined;
}

function resolveQQBotConfigForAccount(cfg: OpenClawConfig, accountId?: string): Record<string, any> | undefined {
  const qqbot = objectRecord((cfg as any)?.channels?.qqbot);
  if (!qqbot) return undefined;
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  const accounts = objectRecord(qqbot.accounts);
  return normalized && normalized !== "default" && objectRecord(accounts?.[normalized]) ? objectRecord(accounts?.[normalized]) : qqbot;
}

function readRelayToken(filePath: string): string {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const line = text.split(/\r?\n/).find((entry) => entry.trim().startsWith("CODEX_RELAY_TOKEN="));
    return line?.split("=").slice(1).join("=").trim().replace(/^['\"]|['\"]$/g, "") ?? "";
  } catch {
    return "";
  }
}

function objectRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
