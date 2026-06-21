import type { CustomActor, CustomGameRuntimeState, CustomGuessGame, CustomPeer } from "./types.js";

export interface CustomCreateGuessGameParams {
  accountId: string;
  peer: CustomPeer;
  creator: CustomActor;
  secret?: number;
  now?: number;
}

export interface CustomGameDecision {
  allowed: boolean;
  reason: "allowed" | "invalid_secret" | "invalid_guess" | "not_found" | "closed";
  game?: CustomGuessGame;
}

export class CustomGameRuntime {
  private readonly guessGames = new Map<string, CustomGuessGame>();
  private seq = 0;

  createGuessGame(params: CustomCreateGuessGameParams): CustomGameDecision {
    const secret = normalizeSecret(params.secret ?? randomSecret());
    if (!secret) return { allowed: false, reason: "invalid_secret" };
    const now = params.now ?? Date.now();
    const game: CustomGuessGame = {
      id: this.nextGuessGameId(params.accountId, params.peer, now),
      accountId: params.accountId,
      peer: { ...params.peer },
      creator: { ...params.creator },
      secret,
      guesses: {},
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    this.guessGames.set(game.id, game);
    return { allowed: true, reason: "allowed", game: cloneGuessGame(game) };
  }

  guessNumber(params: {
    gameId: string;
    value: number;
    actor: CustomActor;
    now?: number;
  }): CustomGameDecision {
    const game = this.guessGames.get(params.gameId);
    if (!game) return { allowed: false, reason: "not_found" };
    if (game.status !== "open") return { allowed: false, reason: "closed", game: cloneGuessGame(game) };
    const value = normalizeSecret(params.value);
    if (!value) return { allowed: false, reason: "invalid_guess", game: cloneGuessGame(game) };
    const now = params.now ?? Date.now();
    const correct = value === game.secret;
    game.guesses[params.actor.id] = {
      actor: { ...params.actor },
      value,
      correct,
      guessedAt: now,
    };
    if (correct) {
      game.status = "won";
      game.winner = { ...params.actor };
      game.closedAt = now;
    }
    game.updatedAt = now;
    return { allowed: true, reason: "allowed", game: cloneGuessGame(game) };
  }

  closeGuessGame(params: { gameId: string; now?: number }): CustomGameDecision {
    const game = this.guessGames.get(params.gameId);
    if (!game) return { allowed: false, reason: "not_found" };
    if (game.status !== "open") return { allowed: false, reason: "closed", game: cloneGuessGame(game) };
    const now = params.now ?? Date.now();
    game.status = "closed";
    game.updatedAt = now;
    game.closedAt = now;
    return { allowed: true, reason: "allowed", game: cloneGuessGame(game) };
  }

  getGuessGame(gameId: string): CustomGuessGame | null {
    const game = this.guessGames.get(gameId);
    return game ? cloneGuessGame(game) : null;
  }

  listGuessGames(params: {
    accountId?: string;
    peer?: CustomPeer;
    status?: CustomGuessGame["status"] | "active";
    limit?: number;
  } = {}): CustomGuessGame[] {
    let games = Array.from(this.guessGames.values());
    if (params.accountId) games = games.filter((game) => game.accountId === params.accountId);
    if (params.peer) games = games.filter((game) => game.peer.kind === params.peer!.kind && game.peer.id === params.peer!.id);
    if (params.status) {
      games = params.status === "active"
        ? games.filter((game) => game.status === "open")
        : games.filter((game) => game.status === params.status);
    }
    games.sort((a, b) => b.updatedAt - a.updatedAt);
    return games.slice(0, Math.max(1, params.limit ?? 10)).map(cloneGuessGame);
  }

  getState(): CustomGameRuntimeState {
    const guessGames: CustomGameRuntimeState["guessGames"] = {};
    for (const [id, game] of this.guessGames) {
      guessGames[id] = cloneGuessGame(game);
    }
    return { guessGames };
  }

  loadState(state: CustomGameRuntimeState): void {
    this.guessGames.clear();
    this.seq = 0;
    for (const [id, game] of Object.entries(state.guessGames ?? {})) {
      this.guessGames.set(id, cloneGuessGame(game));
      this.bumpSeq(id);
    }
  }

  private nextGuessGameId(accountId: string, peer: CustomPeer, now: number): string {
    return `guess-${accountPart(accountId)}-${peer.kind}-${peerPart(peer)}-${now}-${++this.seq}`;
  }

  private bumpSeq(gameId: string): void {
    const m = gameId.match(/-(\d+)$/);
    if (!m) return;
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > this.seq) this.seq = n;
  }
}

function normalizeSecret(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}

function randomSecret(): number {
  return Math.floor(Math.random() * 4) + 1;
}

function cloneGuessGame(game: CustomGuessGame): CustomGuessGame {
  const guesses: CustomGuessGame["guesses"] = {};
  for (const [actorId, guess] of Object.entries(game.guesses)) {
    guesses[actorId] = {
      ...guess,
      actor: { ...guess.actor },
    };
  }
  return {
    ...game,
    peer: { ...game.peer },
    creator: { ...game.creator },
    guesses,
    winner: game.winner ? { ...game.winner } : undefined,
  };
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function accountPart(accountId: string): string {
  return sanitizePart(accountId) || "default";
}

function peerPart(peer: CustomPeer): string {
  return sanitizePart(peer.id).slice(0, 16) || "peer";
}
