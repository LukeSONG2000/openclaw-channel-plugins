import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateBackgroundRequest } from './pilot.mjs';

const cardId = /^t_[a-f0-9]{8,32}$/;
const titleFor = key => 'QQ background work ' + key.slice(0, 16);
const tenantFor = (account, groupId) => 'qq-' + createHash('sha256')
  .update(JSON.stringify([account, groupId])).digest('hex').slice(0, 32);

export function runKanbanCommand(file, args, body) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 12_000, maxBuffer: 256_000 },
      (error, stdout) => {
        if (error) return reject(new Error('Hermes Kanban command failed'));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('invalid Hermes Kanban response')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

const cli = (args, body) => runKanbanCommand('hermes', ['kanban', ...args], body);

export function kanbanTasks({ command = cli, assignee = 'default' } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(assignee)) throw new Error('invalid Kanban worker profile');
  function check(card, { key, tenant, id }) {
    if (!cardId.test(card?.id) || (id && card.id !== id) || card.tenant !== tenant ||
      card.title !== titleFor(key) || card.assignee !== assignee || card.workspace_kind !== 'scratch' ||
      card.completion_contract !== 'local-only') throw new Error('Kanban card identity mismatch');
    return card;
  }
  return {
    async create({ key, tenant, input }) {
      const body = input + '\nComplete your Kanban card with the final user-facing answer as the result. '
        + 'Do not send messages or include plans, progress, or hidden reasoning in the result.';
      return check(await command(['create', titleFor(key), '--body-file', '-', '--tenant', tenant, '--assignee', assignee,
        '--workspace', 'scratch', '--idempotency-key', key, '--max-runtime', '30m', '--json'], body), { key, tenant }).id;
    },
    async read({ key, tenant, id }) {
      if (!cardId.test(id)) throw new Error('invalid Kanban card ID');
      return check((await command(['show', id, '--json']))?.task, { key, tenant, id });
    },
  };
}

export function makeKanbanBridge({ db, tasks, account, groupId, now = Date.now, onError = () => {} }) {
  const tenant = tenantFor(account, groupId);
  db.exec(`CREATE TABLE IF NOT EXISTS kanban_receipts (
    key TEXT PRIMARY KEY, tenant TEXT NOT NULL, source TEXT NOT NULL, input TEXT, card_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending', checked_at INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare('INSERT OR IGNORE INTO kanban_receipts (key, tenant, source, input) VALUES (?, ?, ?, ?)');
  const pending = db.prepare(`SELECT * FROM kanban_receipts WHERE tenant = ? AND state IN ('pending', 'watching')
    ORDER BY checked_at, rowid LIMIT 8`);
  const check = db.prepare('UPDATE kanban_receipts SET checked_at = ? WHERE key = ?');
  const attach = db.prepare("UPDATE kanban_receipts SET card_id = ?, input = NULL, state = 'watching' WHERE key = ? AND state = 'pending'");
  const move = db.prepare('UPDATE kanban_receipts SET state = ? WHERE key = ? AND state = ?');
  let sweeping = false;

  function owns(source) {
    return source?.channel === 'qqbot' && source.account === account && source.groupId === groupId;
  }
  return {
    enqueue(decision) {
      const { source, request } = validateBackgroundRequest(decision);
      if (!owns(source)) throw new Error('Kanban work outside QQ binding');
      const key = request.requestKey;
      const inserted = insert.run(key, tenant, JSON.stringify(source), request.input).changes === 1;
      return { key, inserted };
    },
    async sweep({ canDeliver, deliver }) {
      if (typeof canDeliver !== 'function' || typeof deliver !== 'function') throw new Error('explicit receipt delivery required');
      if (sweeping) return;
      sweeping = true;
      try {
        for (const row of pending.all(tenant)) {
          const { key, card_id: id } = row;
          check.run(now(), key);
          try {
            if (!id) {
              const card = await tasks.create({ key, tenant, input: row.input });
              attach.run(card, key);
              continue;
            }
            const card = await tasks.read({ key, tenant, id });
            if (card.status === 'archived') { move.run('withheld', key, 'watching'); continue; }
            if (card.status !== 'done') continue;
            const text = typeof card.result === 'string' ? card.result.trim() : '';
            const source = JSON.parse(row.source);
            if (!owns(source) || !text || text.length > 1800 || /<[^>]+>|\[CQ:|\bNO_REPLY\b/i.test(text)) {
              move.run('withheld', key, 'watching');
              continue;
            }
            const available = await canDeliver(source);
            if (available === 'expired') { move.run('retained', key, 'watching'); continue; }
            if (available !== true || !move.run('sending', key, 'watching').changes) continue;
            // Do not replay a post whose receipt was lost, including on process restart.
            try { move.run((await deliver({ source, text, receiptKey: key }))?.id ? 'accepted' : 'uncertain', key, 'sending'); }
            catch { move.run('uncertain', key, 'sending'); }
          } catch { onError(id ? 'read' : 'create'); }
        }
      } finally { sweeping = false; }
    },
  };
}
