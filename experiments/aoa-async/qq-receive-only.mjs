import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readQqAppSecret } from './qq-credential.mjs';

const day = 86_400_000;
const groupEvents = new Set(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE']);

const eventsSchema = `
  CREATE TABLE IF NOT EXISTS events (
    group_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_id TEXT NOT NULL,
    received_at INTEGER NOT NULL, event_type TEXT NOT NULL, mentioned INTEGER NOT NULL,
    body TEXT NOT NULL, attachment_count INTEGER NOT NULL,
    PRIMARY KEY (group_id, message_id)
  );
`;

function migrate(db) {
  db.exec(`
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS group_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), group_id TEXT NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA table_info(events)').all();
  if (columns.length && !columns.some(column => column.name === 'group_id')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        ALTER TABLE events RENAME TO events_bound;
        ${eventsSchema}
        INSERT INTO events
          SELECT (SELECT group_id FROM group_binding WHERE singleton = 1), events_bound.*
          FROM events_bound;
        DROP TABLE events_bound;
        COMMIT;
      `);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else db.exec(eventsSchema);
  db.exec(`
    CREATE INDEX IF NOT EXISTS events_received_at ON events(received_at);
    CREATE INDEX IF NOT EXISTS events_by_group ON events(group_id, received_at);
    CREATE TABLE IF NOT EXISTS event_quotes (
      group_id TEXT NOT NULL, message_id TEXT NOT NULL, message_index TEXT,
      quoted_index TEXT, quoted_text TEXT NOT NULL, quoted_attachments INTEGER NOT NULL,
      PRIMARY KEY (group_id, message_id),
      FOREIGN KEY (group_id, message_id) REFERENCES events(group_id, message_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS event_quotes_by_index ON event_quotes(group_id, message_index);
  `);
}

const quoteIndex = value => typeof value === 'string' && value.length <= 256 && value.trim() ? value : null;

export function inbox(db, { mode = 'bound-group', challenge, now = Date.now }) {
  if (mode !== 'bound-group' && mode !== 'all-groups') throw new Error('invalid receive mode');
  migrate(db);
  const binding = db.prepare('SELECT group_id FROM group_binding WHERE singleton = 1');
  const bind = db.prepare('INSERT OR IGNORE INTO group_binding VALUES (1, ?)');
  const insert = db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertQuote = db.prepare('INSERT INTO event_quotes VALUES (?, ?, ?, ?, ?, ?)');
  const expire = db.prepare('DELETE FROM events WHERE received_at < ?');
  const trim = db.prepare(`DELETE FROM events WHERE rowid IN (
    SELECT rowid FROM events WHERE group_id = ? ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET 2000
  )`);
  const prune = () => expire.run(now() - day);
  prune();
  return {
    prune,
    record(msg, quote) {
      if (!msg || msg.kind !== 'group' || msg.senderIsBot || !groupEvents.has(msg.rawEventType)
        || !msg.groupOpenid || !msg.senderId || !msg.messageId) return false;
      const mentioned = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || msg.mentions?.some(m => m.is_you === true);
      const body = typeof msg.content === 'string' ? msg.content : '';
      if (mode === 'bound-group') {
        if (!binding.get() && mentioned && challenge
          && body.replace(/<@!?[^>]+>/g, ' ').split(/\s+/).includes(challenge)) bind.run(msg.groupOpenid);
        if (binding.get()?.group_id !== msg.groupOpenid) return false;
      }
      const messageIndex = quoteIndex(msg.msgIdx);
      const quotedIndex = quoteIndex(msg.refMsgIdx);
      const pushedQuote = quotedIndex && quote?.refKey === quotedIndex && quote.source === 'msg_elements' ? quote : null;
      let result;
      db.exec('SAVEPOINT group_event');
      try {
        result = insert.run(msg.groupOpenid, msg.messageId, msg.senderId, now(), msg.rawEventType, mentioned ? 1 : 0,
          body.slice(0, 4096), Array.isArray(msg.attachments) ? msg.attachments.length : 0);
        if (result.changes && (messageIndex || quotedIndex)) {
          insertQuote.run(msg.groupOpenid, msg.messageId, messageIndex, quotedIndex,
            typeof pushedQuote?.rawContent === 'string' ? pushedQuote.rawContent.slice(0, 4096) : '',
            Array.isArray(pushedQuote?.attachments) ? pushedQuote.attachments.length : 0);
        }
      } catch (error) {
        db.exec('ROLLBACK TO group_event');
        throw error;
      } finally { db.exec('RELEASE group_event'); }
      prune();
      trim.run(msg.groupOpenid);
      return result.changes === 1;
    },
  };
}

async function main() {
  const [rootArg, sdkPath, appId, keychainService, scope] = process.argv.slice(2);
  const mode = scope === 'all-groups' ? 'all-groups' : 'bound-group';
  if (!rootArg || !sdkPath || !/^\d+$/.test(appId ?? '') || !keychainService
    || (mode === 'bound-group' && !/^AOA-[A-Z0-9]{8,32}$/.test(scope ?? ''))) {
    throw new Error('invalid pilot configuration');
  }
  process.umask(0o077);
  mkdirSync(rootArg, { recursive: true, mode: 0o700 });
  const root = realpathSync(rootArg);
  const stat = statSync(root);
  if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('pilot state must be private');
  const { QQBot, quoteRef } = await import(pathToFileURL(sdkPath));
  const appSecret = readQqAppSecret(appId, keychainService);
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  const receiver = inbox(db, { mode, challenge: scope });
  const stop = new AbortController();
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
  const bot = new QQBot({ appId, appSecret, transport: 'websocket', logger });
  // Resolve pushed quote elements using the SDK; stored messages are looked up in SQLite by group.
  bot.use(quoteRef({ store: { get: noop, set: noop } }));
  bot.on('ready', () => console.log('qq_receive_ready mode=' + mode));
  bot.on('error', () => console.error('qq_receive_error'));
  bot.on('message', (ctx, msg) => {
    try { receiver.record(msg, ctx.state.quote); } catch { console.error('qq_receive_store_error'); }
  });
  const retention = setInterval(receiver.prune, 60_000);
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  try { await bot.start(stop.signal); }
  finally { clearInterval(retention); await bot.stop(); db.close(); }
}

if (import.meta.main) main().catch(() => {
  console.error('qq_receive_failed');
  process.exitCode = 1;
});
