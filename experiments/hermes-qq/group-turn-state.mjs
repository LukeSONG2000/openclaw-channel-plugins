import { groupHistoryMs, readGroupWindow } from './inbox-view.mjs';

export const groupPollIntervalsMs = Object.freeze([1, 2, 5, 10, 15].map(minutes => minutes * 60_000));

// The event log remains read-only here. Only cadence and message IDs are persisted.
export function makeGroupTurnState({ inbox, ledger, account, groupId, start, resume = true, intervals = groupPollIntervalsMs }) {
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
    CREATE TABLE IF NOT EXISTS group_turn_read (
      account TEXT NOT NULL, group_id TEXT NOT NULL, message_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(account, group_id, message_id)
    );
  `);
  const scope = [account, groupId];
  ledger.prepare('INSERT OR IGNORE INTO group_turn_poll (account,group_id,started_at,due_at) VALUES (?,?,?,?)')
    .run(...scope, start, start + intervals[0]);
  const state = ledger.prepare('SELECT * FROM group_turn_poll WHERE account=? AND group_id=?');
  const startedAt = resume ? state.get(...scope).started_at : start;
  const reset = ledger.prepare(`UPDATE group_turn_poll SET due_at=?, level=0, revision=revision+1
    WHERE account=? AND group_id=?`);
  const advance = ledger.prepare(`UPDATE group_turn_poll SET due_at=?, level=?, revision=revision+1
    WHERE account=? AND group_id=? AND revision=?`);
  const mark = ledger.prepare('INSERT OR IGNORE INTO group_turn_read VALUES (?,?,?,?)');
  const isMarked = ledger.prepare('SELECT 1 FROM group_turn_read WHERE account=? AND group_id=? AND message_id=?');
  const prune = ledger.prepare('DELETE FROM group_turn_read WHERE account=? AND group_id=? AND received_at<?');
  let nextPrune = 0;

  function isRead(messageId, at) {
    return at <= startedAt || Boolean(isMarked.get(...scope, messageId));
  }
  function unread(through, beforeMessageId) {
    const after = Math.max(startedAt, through - groupHistoryMs);
    if (after >= through) return [];
    return readGroupWindow(inbox, {
      account, groupId, after, through, beforeMessageId, ordinaryOnly: true, limit: 2000,
    }).filter(row => !isRead(row.messageId, row.at));
  }
  const isCurrent = revision => state.get(...scope).revision === revision;
  return {
    startedAt, unread, isRead,
    mention(at) { reset.run(at + intervals[0], ...scope); },
    poll(now, eligible = () => true) {
      const { due_at: due, level, revision } = state.get(...scope);
      if (now < due || (!resume && now < start + intervals[0])) return;
      const messages = unread(now);
      const hit = messages.some(eligible);
      const nextLevel = hit ? 0 : Math.min(level + 1, intervals.length - 1);
      if (!advance.run(now + intervals[nextLevel], nextLevel, ...scope, revision).changes) return;
      return { messages: hit ? messages : [], revision: revision + 1 };
    },
    isCurrent,
    markRead(messages, now, revision) {
      ledger.exec('BEGIN IMMEDIATE');
      try {
        const current = revision === undefined || isCurrent(revision);
        if (current) for (const row of messages) {
          if (row.account === account && row.groupId === groupId) mark.run(...scope, row.messageId, row.at);
        }
        if (now >= nextPrune) {
          prune.run(...scope, now - groupHistoryMs);
          nextPrune = now + 3_600_000;
        }
        ledger.exec('COMMIT');
        return current;
      } catch (error) { ledger.exec('ROLLBACK'); throw error; }
    },
  };
}
