import type { CustomActor, CustomPeer, CustomPoll, CustomPollRuntimeState } from "./types.js";

export interface CustomCreatePollParams {
  accountId: string;
  peer: CustomPeer;
  creator: CustomActor;
  question: string;
  options: string[];
  now?: number;
}

export interface CustomPollDecision {
  allowed: boolean;
  reason: "allowed" | "invalid_question" | "invalid_options" | "not_found" | "closed";
  poll?: CustomPoll;
}

export class CustomPollRuntime {
  private readonly polls = new Map<string, CustomPoll>();
  private seq = 0;

  createPoll(params: CustomCreatePollParams): CustomPollDecision {
    const question = params.question.replace(/\s+/g, " ").trim();
    if (!question) return { allowed: false, reason: "invalid_question" };
    const optionLabels = normalizeOptions(params.options);
    if (optionLabels.length < 2 || optionLabels.length > 4) return { allowed: false, reason: "invalid_options" };
    const now = params.now ?? Date.now();
    const poll: CustomPoll = {
      id: this.nextPollId(params.accountId, params.peer, now),
      accountId: params.accountId,
      peer: { ...params.peer },
      creator: { ...params.creator },
      question,
      options: optionLabels.map((label, index) => ({ id: String(index + 1), label })),
      votes: {},
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    this.polls.set(poll.id, poll);
    return { allowed: true, reason: "allowed", poll: clonePoll(poll) };
  }

  vote(params: {
    pollId: string;
    optionId: string;
    actor: CustomActor;
    now?: number;
  }): CustomPollDecision {
    const poll = this.polls.get(params.pollId);
    if (!poll) return { allowed: false, reason: "not_found" };
    if (poll.status !== "open") return { allowed: false, reason: "closed", poll: clonePoll(poll) };
    const option = poll.options.find((item) => item.id === params.optionId);
    if (!option) return { allowed: false, reason: "invalid_options", poll: clonePoll(poll) };
    const now = params.now ?? Date.now();
    poll.votes[params.actor.id] = {
      actor: { ...params.actor },
      optionId: option.id,
      votedAt: now,
    };
    poll.updatedAt = now;
    return { allowed: true, reason: "allowed", poll: clonePoll(poll) };
  }

  closePoll(params: { pollId: string; now?: number }): CustomPollDecision {
    const poll = this.polls.get(params.pollId);
    if (!poll) return { allowed: false, reason: "not_found" };
    if (poll.status === "closed") return { allowed: false, reason: "closed", poll: clonePoll(poll) };
    const now = params.now ?? Date.now();
    poll.status = "closed";
    poll.updatedAt = now;
    poll.closedAt = now;
    return { allowed: true, reason: "allowed", poll: clonePoll(poll) };
  }

  getPoll(pollId: string): CustomPoll | null {
    const poll = this.polls.get(pollId);
    return poll ? clonePoll(poll) : null;
  }

  listPolls(params: {
    accountId?: string;
    peer?: CustomPeer;
    status?: CustomPoll["status"];
    limit?: number;
  } = {}): CustomPoll[] {
    let polls = Array.from(this.polls.values());
    if (params.accountId) polls = polls.filter((poll) => poll.accountId === params.accountId);
    if (params.peer) polls = polls.filter((poll) => poll.peer.kind === params.peer!.kind && poll.peer.id === params.peer!.id);
    if (params.status) polls = polls.filter((poll) => poll.status === params.status);
    polls.sort((a, b) => b.updatedAt - a.updatedAt);
    return polls.slice(0, Math.max(1, params.limit ?? 10)).map(clonePoll);
  }

  getState(): CustomPollRuntimeState {
    const polls: CustomPollRuntimeState["polls"] = {};
    for (const [id, poll] of this.polls) {
      polls[id] = clonePoll(poll);
    }
    return { polls };
  }

  loadState(state: CustomPollRuntimeState): void {
    this.polls.clear();
    this.seq = 0;
    for (const [id, poll] of Object.entries(state.polls ?? {})) {
      this.polls.set(id, clonePoll(poll));
      this.bumpSeq(id);
    }
  }

  private nextPollId(accountId: string, peer: CustomPeer, now: number): string {
    return makePollId(accountId, peer, now, ++this.seq);
  }

  private bumpSeq(pollId: string): void {
    const seq = nextSeqFromId(pollId);
    if (Number.isFinite(seq) && seq > this.seq) this.seq = seq;
  }
}

export function summarizePollResults(poll: CustomPoll): Array<{ optionId: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const vote of Object.values(poll.votes)) {
    counts.set(vote.optionId, (counts.get(vote.optionId) ?? 0) + 1);
  }
  return poll.options.map((option) => ({
    optionId: option.id,
    label: option.label,
    count: counts.get(option.id) ?? 0,
  }));
}

function normalizeOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of options) {
    const label = option.replace(/\s+/g, " ").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    result.push(label.slice(0, 30));
  }
  return result.slice(0, 4);
}

function clonePoll(poll: CustomPoll): CustomPoll {
  const votes: CustomPoll["votes"] = {};
  for (const [actorId, vote] of Object.entries(poll.votes)) {
    votes[actorId] = {
      ...vote,
      actor: { ...vote.actor },
    };
  }
  return {
    ...poll,
    peer: { ...poll.peer },
    creator: { ...poll.creator },
    options: poll.options.map((item) => ({ ...item })),
    votes,
  };
}

function sanitizePollPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function nextSeqFromId(id: string): number {
  const m = id.match(/-(\d+)$/);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

function pollPeerPart(peer: CustomPeer): string {
  return sanitizePollPart(peer.id).slice(0, 16) || "peer";
}

function accountPart(accountId: string): string {
  return sanitizePollPart(accountId) || "default";
}

function makePollId(accountId: string, peer: CustomPeer, now: number, seq: number): string {
  return `poll-${accountPart(accountId)}-${peer.kind}-${pollPeerPart(peer)}-${now}-${seq}`;
}
