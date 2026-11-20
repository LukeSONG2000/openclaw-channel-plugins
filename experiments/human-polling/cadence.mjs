export const humanPollIntervalsMs = Object.freeze([1, 2, 5, 10, 15].map(minutes => minutes * 60_000));

// Keeps the existing ledger schema; the channel owns unread selection and delivery.
export function makeHumanPolling({ ledger, account, groupId, start, resume = true, intervals = humanPollIntervalsMs }) {
  if (!Array.isArray(intervals) || !intervals.length ||
      intervals.some((ms, i) => !Number.isSafeInteger(ms) || ms < 1 || (i && ms <= intervals[i - 1]))) {
    throw new Error('invalid group poll cadence');
  }
  ledger.exec(`
    CREATE TABLE IF NOT EXISTS group_turn_poll (
      account TEXT NOT NULL, group_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account, group_id)
    );
  `);
  const scope = [account, groupId];
  ledger.prepare('INSERT OR IGNORE INTO group_turn_poll (account,group_id,started_at,due_at) VALUES (?,?,?,?)')
    .run(...scope, start, start + intervals[0]);
  const state = ledger.prepare('SELECT started_at,due_at,level,revision FROM group_turn_poll WHERE account=? AND group_id=?');
  const reset = ledger.prepare(`UPDATE group_turn_poll SET due_at=?, level=0, revision=revision+1
    WHERE account=? AND group_id=?`);
  const advance = ledger.prepare(`UPDATE group_turn_poll SET due_at=?, level=?, revision=revision+1
    WHERE account=? AND group_id=? AND revision=?`);
  return {
    startedAt: resume ? state.get(...scope).started_at : start,
    mention(at) { reset.run(at + intervals[0], ...scope); },
    poll(now, readUnread, eligible = () => true) {
      const { due_at: due, level, revision } = state.get(...scope);
      if (now < due || (!resume && now < start + intervals[0])) return;
      const messages = readUnread(now);
      const hit = messages.some(eligible);
      const nextLevel = hit ? 0 : Math.min(level + 1, intervals.length - 1);
      if (!advance.run(now + intervals[nextLevel], nextLevel, ...scope, revision).changes) return;
      return { messages: hit ? messages : [], revision: revision + 1 };
    },
    isCurrent(revision) { return state.get(...scope).revision === revision; },
  };
}
