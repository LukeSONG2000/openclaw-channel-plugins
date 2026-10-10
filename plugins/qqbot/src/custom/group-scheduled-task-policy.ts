import { getRequestTarget } from "../request-context.js";

interface ScheduledTaskToolEvent {
  toolName: string;
  params: Record<string, unknown>;
}

interface ScheduledTaskToolContext {
  sessionKey?: string;
}

interface ScheduledTaskPolicyApi {
  on: (
    hookName: "before_tool_call",
    handler: (event: ScheduledTaskToolEvent, context: ScheduledTaskToolContext) => unknown,
  ) => void;
  logger?: { info?: (message: string) => void };
}

export function checkCustomGroupScheduledTaskToolCall(
  event: ScheduledTaskToolEvent,
  context: ScheduledTaskToolContext,
  requestTarget = getRequestTarget(),
): { block: true; blockReason: string } | undefined {
  if (event.params.action !== "add" || (event.toolName !== "cron" && event.toolName !== "qqbot_remind")) return;

  // Judge the originating conversation, not the task's delivery destination.
  const source = context.sessionKey?.trim() || requestTarget || "";
  if (!/(?:^|:)qqbot:(?:[^:]+:)?group:[^:]+(?:$|:)/i.test(source)) return;

  return {
    block: true,
    blockReason: "QQ群已关闭通过自然语言创建定时任务。请继续正常对话；需要创建时请使用私聊或其他渠道。",
  };
}

export function registerCustomGroupScheduledTaskPolicy(api: ScheduledTaskPolicyApi): void {
  api.on("before_tool_call", (event, context) => {
    const result = checkCustomGroupScheduledTaskToolCall(event, context);
    if (result) api.logger?.info?.(`[qqbot] Blocked group scheduled task creation: tool=${event.toolName}`);
    return result;
  });
}
