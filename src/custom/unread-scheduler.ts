import type { QueuedMessage } from "../message-queue.js";
import type { CustomPeer } from "./types.js";
import {
  effectsFromCustomUnreadIntents,
  type CustomUnreadGatewayEffect,
} from "./unread-gateway-adapter.js";
import type { CustomUnreadIntent, CustomUnreadRuntime, CustomUnreadRuntimeState, ResolvedCustomUnreadConfig } from "./unread-runtime.js";

export interface CustomUnreadSchedulerLogger {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomUnreadSchedulerOptions {
  accountId: string;
  unread: CustomUnreadRuntime;
  enqueue: (message: QueuedMessage) => void | Promise<void>;
  persist: () => void;
  resolveConfigForPeer: (peerId: string) => ResolvedCustomUnreadConfig | null;
  log?: CustomUnreadSchedulerLogger;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

type TimerKind = "followup" | "sleep-digest";

export class CustomUnreadScheduler {
  private readonly timers: Record<TimerKind, Map<string, unknown>> = {
    followup: new Map(),
    "sleep-digest": new Map(),
  };

  constructor(private readonly options: CustomUnreadSchedulerOptions) {}

  apply(
    effects: CustomUnreadGatewayEffect[],
    fallbackCfg?: ResolvedCustomUnreadConfig,
  ): void {
    let changed = false;
    for (const effect of effects) {
      if (effect.kind === "clear-timer") {
        this.clear(effect.timer, effect.peerId);
        changed = true;
        continue;
      }
      if (effect.kind === "set-timer") {
        const cfg = this.resolveConfig(effect.peerId, fallbackCfg);
        if (!cfg) continue;
        this.set(effect.timer, effect.peerId, effect.dueAt, cfg);
        changed = true;
        continue;
      }
      if (effect.kind === "enqueue") {
        void Promise.resolve(this.options.enqueue(effect.message)).catch((err) => {
          this.options.log?.error?.(`Custom unread enqueue failed for ${effect.message.groupOpenid}: ${err}`);
        });
        changed = true;
        continue;
      }
      if (effect.kind === "policy-gated") {
        this.options.log?.debug?.(`Custom unread ${effect.source ?? "unknown"} gated for ${effect.peerId}: ${effect.reason ?? "policy"}`);
        changed = true;
      }
    }
    if (changed) {
      this.options.persist();
    }
  }

  restore(state: CustomUnreadRuntimeState): void {
    for (const [peerId, peerState] of Object.entries(state.peers)) {
      const intents: CustomUnreadIntent[] = [];
      if (peerState.scheduledFollowupDueAt !== undefined) {
        intents.push({
          kind: "schedule-followup",
          peerId,
          dueAt: peerState.scheduledFollowupDueAt,
          source: "followup",
        });
      }
      if (peerState.scheduledSleepDigestDueAt !== undefined) {
        intents.push({
          kind: "schedule-sleep-digest",
          peerId,
          dueAt: peerState.scheduledSleepDigestDueAt,
          source: "sleep-timer",
        });
      }
      if (intents.length === 0) continue;
      const cfg = this.options.resolveConfigForPeer(peerId);
      if (!cfg) continue;
      this.apply(
        effectsFromCustomUnreadIntents({
          accountId: this.options.accountId,
          peer: { kind: "group", id: peerId },
          intents,
        }),
        cfg,
      );
    }
  }

  dispose(): void {
    for (const kind of Object.keys(this.timers) as TimerKind[]) {
      for (const timer of this.timers[kind].values()) {
        this.clearTimer(timer);
      }
      this.timers[kind].clear();
    }
  }

  timerCount(kind?: TimerKind): number {
    if (kind) return this.timers[kind].size;
    return this.timers.followup.size + this.timers["sleep-digest"].size;
  }

  private set(
    kind: TimerKind,
    peerId: string,
    dueAt: number,
    cfg: ResolvedCustomUnreadConfig,
  ): void {
    this.clear(kind, peerId);
    const delay = Math.max(1_000, dueAt - this.now());
    const timer = this.setTimer(() => {
      this.timers[kind].delete(peerId);
      const intents = kind === "followup"
        ? this.options.unread.fireScheduledFollowup({ peerId, cfg })
        : this.options.unread.fireSleepDigest({ peerId, cfg });
      const peer: CustomPeer = { kind: "group", id: peerId };
      this.apply(
        effectsFromCustomUnreadIntents({
          accountId: this.options.accountId,
          peer,
          intents,
        }),
        cfg,
      );
      this.options.persist();
    }, delay);
    this.timers[kind].set(peerId, timer);
    this.options.log?.info?.(`Custom unread ${kind} timer set for ${peerId} in ${delay}ms`);
  }

  private clear(kind: TimerKind, peerId: string): void {
    const oldTimer = this.timers[kind].get(peerId);
    if (oldTimer) this.clearTimer(oldTimer);
    this.timers[kind].delete(peerId);
  }

  private resolveConfig(peerId: string, fallbackCfg?: ResolvedCustomUnreadConfig): ResolvedCustomUnreadConfig | null {
    return fallbackCfg ?? this.options.resolveConfigForPeer(peerId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    return this.options.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: unknown): void {
    if (this.options.clearTimer) {
      this.options.clearTimer(timer);
      return;
    }
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
}
