import type { CustomPeer } from "./types.js";
import {
  effectsFromCustomUnreadIntents,
  type CustomUnreadGatewayEffect,
} from "./unread-gateway-adapter.js";
import type { CustomUnreadRuntime, ResolvedCustomUnreadConfig } from "./unread-runtime.js";

export interface CustomUnreadCompletionLog {
  level: "info";
  message: string;
}

export interface CustomUnreadCompletionResult {
  handled: boolean;
  effects: CustomUnreadGatewayEffect[];
  persist: boolean;
  logs: CustomUnreadCompletionLog[];
}

export function completeCustomUnreadAfterDispatch(params: {
  accountId: string;
  unread: CustomUnreadRuntime;
  groupOpenid: string;
  cfg?: ResolvedCustomUnreadConfig | null;
  snapshotId?: string;
  hasModelBlockOutput: boolean;
  shouldCatchUpAfterReply: boolean;
  wasMentioned: boolean;
}): CustomUnreadCompletionResult {
  const logs: CustomUnreadCompletionLog[] = [];
  const peer: CustomPeer = { kind: "group", id: params.groupOpenid };

  if (params.snapshotId) {
    if (!params.hasModelBlockOutput) {
      logs.push({
        level: "info",
        message: `Group ${params.groupOpenid}: custom unread catch-up produced no model output; snapshot kept (${params.snapshotId})`,
      });
      return { handled: true, effects: [], persist: false, logs };
    }

    const consumed = params.unread.consumeSnapshot(params.snapshotId);
    logs.push({
      level: "info",
      message: `Group ${params.groupOpenid}: custom unread catch-up completed, consumed=${consumed.consumed}, remaining=${consumed.remaining}`,
    });
    const effects = params.cfg
      ? effectsFromCustomUnreadIntents({
          accountId: params.accountId,
          peer,
          intents: params.unread.markOutputComplete({
            peerId: params.groupOpenid,
            cfg: params.cfg,
            resetToMin: consumed.source === "mention-followup",
          }),
        })
      : [];
    return { handled: true, effects, persist: true, logs };
  }

  if (!params.hasModelBlockOutput || !params.cfg) {
    return { handled: false, effects: [], persist: false, logs };
  }

  if (params.shouldCatchUpAfterReply) {
    return {
      handled: true,
      effects: effectsFromCustomUnreadIntents({
        accountId: params.accountId,
        peer,
        intents: params.unread.createCatchup({
          peerId: params.groupOpenid,
          cfg: params.cfg,
          source: "mention-followup",
        }),
      }),
      persist: false,
      logs,
    };
  }

  if (params.wasMentioned) {
    return {
      handled: true,
      effects: effectsFromCustomUnreadIntents({
        accountId: params.accountId,
        peer,
        intents: params.unread.markOutputComplete({ peerId: params.groupOpenid, cfg: params.cfg, resetToMin: true }),
      }),
      persist: false,
      logs,
    };
  }

  return { handled: false, effects: [], persist: false, logs };
}
