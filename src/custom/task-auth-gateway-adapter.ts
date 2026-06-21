import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { QueuedMessage } from "../message-queue.js";
import type { CustomAuthorizationCheckResult, CustomAuthorizationRuntime } from "./auth.js";
import {
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "./auth-gateway-adapter.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import type { CustomActor, CustomPeer, CustomSandboxTask, CustomTaskSandboxRuntimeState } from "./types.js";
import type { CustomTaskSandboxRuntime } from "./task-sandbox.js";

export interface CustomTaskCommandAuthorizationDecision {
  handled: boolean;
  allowed: boolean;
  task?: CustomSandboxTask;
  taskId?: string;
  peer?: CustomPeer;
  actor?: CustomActor;
  result?: CustomAuthorizationCheckResult;
  reason?: "not_task_mutation" | "runtime_disabled" | "task_not_found" | "owner" | "authorized" | "denied";
}

export function checkCustomTaskCommandAuthorization(params: {
  cfg: OpenClawConfig;
  auth: CustomAuthorizationRuntime;
  tasks: CustomTaskSandboxRuntime;
  message: QueuedMessage;
  rawContent: string;
  now?: number;
}): CustomTaskCommandAuthorizationDecision {
  const target = parseTaskMutationTarget(params.rawContent);
  if (!target) return { handled: false, allowed: true, reason: "not_task_mutation" };

  const runtime = resolveCustomRuntimeConfig(params.cfg);
  if (!runtime.enabled) return { handled: false, allowed: true, reason: "runtime_disabled" };

  const task = resolveTask(params.tasks.getState(), target.taskId);
  const peer = toCustomPeerFromQueuedMessage(params.message);
  const actor = toCustomActorFromQueuedMessage(params.message);
  if (!task) {
    return {
      handled: true,
      allowed: true,
      taskId: target.taskId,
      peer,
      actor,
      reason: "task_not_found",
    };
  }

  if (matchesActor(task.owner.id, actor.id)) {
    return {
      handled: true,
      allowed: true,
      task,
      taskId: task.id,
      peer,
      actor,
      reason: "owner",
    };
  }

  const scene = resolveCustomSceneConfig(params.cfg, peer);
  const result = params.auth.check({
    runtime,
    scene: {
      ...scene,
      capabilities: [],
    },
    peer,
    actor,
    capability: "codex.longTask",
    taskId: task.id,
    now: params.now,
  });

  return {
    handled: true,
    allowed: result.decision.allowed,
    task,
    taskId: task.id,
    peer,
    actor,
    result,
    reason: result.decision.allowed ? "authorized" : "denied",
  };
}

function parseTaskMutationTarget(rawContent: string): { taskId: string } | null {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return null;
  const [rawName = "", rawAction = "", rawTaskId = ""] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-task") return null;
  const action = rawAction.toLowerCase();
  if (action !== "add" && action !== "append" && action !== "cancel" && action !== "stop") return null;
  return rawTaskId ? { taskId: rawTaskId } : null;
}

function resolveTask(state: CustomTaskSandboxRuntimeState, input: string): CustomSandboxTask | null {
  if (state.tasks[input]) return state.tasks[input];
  const matches = Object.values(state.tasks).filter((task) => task.id.startsWith(input) || task.id.endsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function matchesActor(expected: string, actual: string): boolean {
  return expected.toUpperCase() === actual.toUpperCase();
}
