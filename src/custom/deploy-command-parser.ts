import { normalizeDeployCommand } from "./deploy-confirmation.js";

export type CustomDeployCommand =
  | { kind: "help" }
  | { kind: "confirm"; command: string }
  | { kind: "list" }
  | { kind: "status"; confirmationId: string }
  | { kind: "preflight" };

export type CustomDeployCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomDeployCommand; error?: string };

export type CustomDeployButtonDecision = "confirm" | "cancel";

export interface CustomDeployButtonPayload {
  confirmationId: string;
  decision: CustomDeployButtonDecision;
}

export function parseCustomDeployCommand(rawContent: string): CustomDeployCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-deploy") return { matched: false };
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls") return { matched: true, command: { kind: "list" } };
  if (action === "preflight" || action === "check" || action === "safety") return { matched: true, command: { kind: "preflight" } };
  if (action === "status" || action === "show") {
    const confirmationId = tokens.shift();
    if (!confirmationId) return { matched: true, error: "缺少 confirmationId" };
    return { matched: true, command: { kind: "status", confirmationId } };
  }
  if (action === "confirm" || action === "plan") {
    const command = tokens.join(" ").trim();
    if (!command) return { matched: true, error: "缺少需要确认的升级命令，例如 /bot-deploy confirm /bot-upgrade --latest" };
    if (!normalizeDeployCommand(command)) return { matched: true, error: "当前只支持确认 /bot-upgrade 的带参数命令" };
    return { matched: true, command: { kind: "confirm", command } };
  }
  return { matched: true, error: `未知子命令：${action}` };
}

export function parseCustomDeployButtonData(buttonData: string): CustomDeployButtonPayload | null {
  const m = buttonData.match(/^custom-deploy:([^:]+):(confirm|cancel)$/i);
  if (!m) return null;
  return { confirmationId: m[1]!, decision: m[2]!.toLowerCase() as CustomDeployButtonDecision };
}
