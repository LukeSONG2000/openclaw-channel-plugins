import type { MessageTarget } from "../reply-dispatcher.js";
import { formatPollFinalResult } from "./poll-presentation.js";
import { CustomPollRuntime } from "./poll.js";
import { prefixCustomUsersFeedbackMention } from "./identity-presentation.js";
import type { CustomPoll } from "./types.js";

export interface CustomPollResultDelivery {
  target: MessageTarget;
  text: string;
  poll: CustomPoll;
}

export type CustomPollResultSendText = (delivery: CustomPollResultDelivery) => Promise<void> | void;

export interface CustomPollExpirationSchedulerOptions {
  accountId: string;
  polls: CustomPollRuntime;
  sendText: CustomPollResultSendText;
  persist: () => void;
  intervalMs?: number;
  now?: () => number;
  log?: {
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export class CustomPollExpirationScheduler {
  private readonly accountId: string;
  private readonly polls: CustomPollRuntime;
  private readonly sendText: CustomPollResultSendText;
  private readonly persist: () => void;
  private readonly now: () => number;
  private readonly log?: CustomPollExpirationSchedulerOptions["log"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: CustomPollExpirationSchedulerOptions) {
    this.accountId = options.accountId;
    this.polls = options.polls;
    this.sendText = options.sendText;
    this.persist = options.persist;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
    const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const closed = this.polls.closeExpiredPolls({ accountId: this.accountId, now });
      if (closed.length > 0) this.persist();
      const due = [...closed, ...this.polls.listUnannouncedClosedPolls({ accountId: this.accountId })];
      const seen = new Set<string>();
      for (const poll of due) {
        if (seen.has(poll.id)) continue;
        seen.add(poll.id);
        await this.deliverPollResult(poll, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async deliverPollResult(poll: CustomPoll, now: number): Promise<void> {
    const target = targetFromPoll(poll);
    if (!target) {
      this.log?.debug?.(`custom poll result skipped: unsupported peer kind=${poll.peer.kind} poll=${poll.id}`);
      return;
    }
    const text = prefixCustomUsersFeedbackMention(formatPollFinalResult(poll), {
      peer: poll.peer,
      actors: Object.values(poll.votes).map((vote) => vote.actor),
    });
    try {
      await this.sendText({ target, text, poll });
      this.polls.markResultAnnounced({ pollId: poll.id, now });
      this.persist();
      this.log?.info?.(`custom poll result delivered: poll=${poll.id}`);
    } catch (err) {
      this.log?.error?.(`custom poll result delivery failed: poll=${poll.id} error=${err}`);
    }
  }
}

function targetFromPoll(poll: CustomPoll): MessageTarget | null {
  if (poll.peer.kind === "group") {
    return {
      type: "group",
      senderId: poll.creator.id,
      groupOpenid: poll.peer.id,
      messageId: "",
    };
  }
  if (poll.peer.kind === "c2c") {
    return {
      type: "c2c",
      senderId: poll.peer.id,
      messageId: "",
    };
  }
  if (poll.peer.kind === "channel") {
    return {
      type: "guild",
      senderId: poll.creator.id,
      channelId: poll.peer.id,
      messageId: "",
    };
  }
  if (poll.peer.kind === "dm") {
    return {
      type: "dm",
      senderId: poll.peer.id,
      messageId: "",
    };
  }
  return null;
}
