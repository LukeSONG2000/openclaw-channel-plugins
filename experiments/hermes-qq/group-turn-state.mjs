import { groupHistoryMs, readGroupWindow } from './inbox-view.mjs';
import { makeHumanPolling } from '../human-polling/cadence.mjs';

// The event log remains read-only here. Only cadence and message IDs are persisted.
export function makeGroupTurnState({ inbox, ledger, account, groupId, start, resume = true, intervals }) {
  const cadence = makeHumanPolling({ ledger, account, groupId, start, resume, intervals });
  const { startedAt } = cadence;
  ledger.exec(`
    CREATE TABLE IF NOT EXISTS group_turn_read (
      account TEXT NOT NULL, group_id TEXT NOT NULL, message_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(account, group_id, message_id)
    );
  `);
  const scope = [account, groupId];
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
  return {
    startedAt, unread, isRead,
    mention: cadence.mention,
    poll: (now, eligible) => cadence.poll(now, unread, eligible),
    isCurrent: cadence.isCurrent,
    markRead(messages, now, revision) {
      ledger.exec('BEGIN IMMEDIATE');
      try {
        const current = revision === undefined || cadence.isCurrent(revision);
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
