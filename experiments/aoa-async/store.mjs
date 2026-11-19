import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const WORK_LEASE = 12 * 60_000;
const SEND_LEASE = 60_000;

export function testRoot(root) {
  if (!root || !isAbsolute(root) || !realpathSync(root).endsWith('/.lab')) throw new Error('an isolated .lab directory is required');
  return realpathSync(root);
}

export function openStore(root) {
  const path = join(testRoot(root), 'bridge', 'tasks.sqlite');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 500 });
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS history (
      route TEXT NOT NULL, message TEXT NOT NULL, sender TEXT NOT NULL,
      text TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (route, message)
    );
    CREATE INDEX IF NOT EXISTS history_route_at ON history(route, at);
    CREATE INDEX IF NOT EXISTS history_at ON history(at);
    CREATE TABLE IF NOT EXISTS grants (
      route TEXT PRIMARY KEY, policy TEXT NOT NULL, valid_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, route TEXT NOT NULL, message TEXT NOT NULL,
      policy TEXT NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL, input TEXT,
      state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      lease INTEGER, result TEXT, receipt TEXT, reason TEXT,
      UNIQUE (route, message)
    );
    CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state, created);
  `);

  function reconcile(now) {
    db.prepare(`UPDATE jobs SET state='uncertain', reason=state||'_lease_expired', updated=?, lease=NULL, input=NULL
      WHERE state IN ('running','sending') AND lease<=?`).run(now, now);
    db.prepare(`UPDATE jobs SET state='revoked', reason='policy_changed', updated=?, input=NULL, result=NULL
      WHERE state IN ('queued','ready') AND EXISTS (
        SELECT 1 FROM grants WHERE grants.route=jobs.route AND grants.policy<>jobs.policy
      )`).run(now);
    db.prepare(`UPDATE jobs SET state='failed', reason='expired', updated=?, input=NULL, result=NULL
      WHERE state IN ('queued','ready') AND created<=?`).run(now, now - DAY);
  }

  return {
    close: () => db.close(),
    remember: ({ key, message, sender, text, at }) => db.prepare(
      'INSERT OR IGNORE INTO history(route, message, sender, text, at) VALUES(?,?,?,?,?)',
    ).run(key, message, sender, text, at),
    history(route, message, now) {
      const result = db.prepare(`
        WITH candidates AS (
          SELECT sender,text,at, ROW_NUMBER() OVER (
            PARTITION BY CAST((at-?)/7200000 AS INTEGER) ORDER BY at DESC, message DESC
          ) AS rank
          FROM history WHERE route=? AND at>=? AND at<=? AND message<>?
        )
        SELECT sender,text,at FROM candidates WHERE rank<=6 ORDER BY at
      `).all(now - DAY, route, now - DAY, now, message);
      const actors = new Map();
      return result.map(({ sender, text, at }) => {
        if (!actors.has(sender)) actors.set(sender, `成员${actors.size + 1}`);
        return { sender: actors.get(sender), text: text.slice(0, 160), at: new Date(at).toISOString() };
      });
    },
    prune(now) {
      db.prepare('DELETE FROM history WHERE at<?').run(now - DAY);
      db.prepare(`UPDATE jobs SET input=NULL, result=NULL
        WHERE updated<? AND state NOT IN ('queued','running','ready','sending')`).run(now - DAY);
    },
    grant(route, policy, validUntil) {
      db.prepare(`INSERT INTO grants VALUES(?,?,?) ON CONFLICT(route)
        DO UPDATE SET policy=excluded.policy, valid_until=excluded.valid_until`).run(route, policy, validUntil);
    },
    routes() { return db.prepare('SELECT route FROM grants').all().map(({ route }) => route); },
    known(route, message) {
      return !!db.prepare('SELECT 1 FROM jobs WHERE route=? AND message=?').get(route, message);
    },
    enqueue({ route, message, sender, kind, policy, input }, now) {
      const id = randomUUID();
      const fresh = db.prepare(`INSERT OR IGNORE INTO jobs(id, route, message, sender, kind, policy, input, state, created, updated)
        VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(id, route, message, sender, kind, policy, JSON.stringify(input), now, now);
      return fresh.changes ? id : undefined;
    },
    claimWork(now) {
      reconcile(now);
      return db.prepare(`UPDATE jobs SET state='running', updated=?, lease=? WHERE id=(
        SELECT id FROM jobs WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM jobs WHERE state='running')
        AND EXISTS (SELECT 1 FROM grants WHERE grants.route=jobs.route AND grants.policy=jobs.policy AND valid_until>?)
        ORDER BY created,id LIMIT 1
      ) RETURNING id,kind,input,lease`).get(now, now + WORK_LEASE, now);
    },
    complete(id, result, reason, now) {
      return db.prepare(`UPDATE jobs SET state='ready', input=NULL, result=?, reason=?, updated=?, lease=NULL
        WHERE id=? AND state='running' AND lease>?`).run(result, reason ?? null, now, id, now).changes === 1;
    },
    claimDelivery(now) {
      reconcile(now);
      return db.prepare(`UPDATE jobs SET state='sending', updated=?, lease=? WHERE id=(
        SELECT id FROM jobs WHERE state='ready'
        AND EXISTS(SELECT 1 FROM grants WHERE grants.route=jobs.route AND grants.policy=jobs.policy AND valid_until>?)
        ORDER BY updated,id LIMIT 1
      ) RETURNING id,route,message,policy,result`).get(now, now + SEND_LEASE, now);
    },
    finishDelivery(id, state, receipt, reason, now) {
      if (!['sent', 'revoked', 'uncertain'].includes(state)) throw new Error('invalid delivery state');
      db.prepare(`UPDATE jobs SET state=?, receipt=?, reason=COALESCE(?,reason), updated=?, lease=NULL, result=NULL
        WHERE id=? AND state='sending' AND lease>?`).run(state, receipt, reason, now, id, now);
    },
    status() {
      return db.prepare('SELECT id,kind,state,created,updated,reason,receipt IS NOT NULL AS hasReceipt FROM jobs ORDER BY created DESC LIMIT 100').all();
    },
  };
}
