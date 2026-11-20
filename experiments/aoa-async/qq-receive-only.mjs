import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readQqAppSecret } from './qq-credential.mjs';
import { qqImageLocators } from './qq-image-source.mjs';

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
  const eventColumns = new Set(db.prepare('PRAGMA table_info(events)').all().map(row => row.name));
  if (!eventColumns.has('sender_is_bot')) db.exec('ALTER TABLE events ADD COLUMN sender_is_bot INTEGER NOT NULL DEFAULT 0');
  if (!eventColumns.has('addressed_elsewhere')) db.exec('ALTER TABLE events ADD COLUMN addressed_elsewhere INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS events_received_at ON events(received_at);
    CREATE INDEX IF NOT EXISTS events_by_group ON events(group_id, received_at);
    CREATE TABLE IF NOT EXISTS direct_events (
      message_id TEXT NOT NULL, sender_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      body TEXT NOT NULL, has_media INTEGER NOT NULL, PRIMARY KEY (sender_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS direct_events_received ON direct_events(received_at);
    CREATE TABLE IF NOT EXISTS direct_media (
      sender_id TEXT NOT NULL, message_id TEXT NOT NULL, message_index TEXT,
      quoted_index TEXT, current_images TEXT NOT NULL, quoted_images TEXT NOT NULL,
      PRIMARY KEY (sender_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS event_quotes (
      group_id TEXT NOT NULL, message_id TEXT NOT NULL, message_index TEXT,
      quoted_index TEXT, quoted_text TEXT NOT NULL, quoted_attachments INTEGER NOT NULL,
      PRIMARY KEY (group_id, message_id),
      FOREIGN KEY (group_id, message_id) REFERENCES events(group_id, message_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS event_quotes_by_index ON event_quotes(group_id, message_index);
    CREATE TABLE IF NOT EXISTS event_images (
      group_id TEXT NOT NULL, message_id TEXT NOT NULL, origin TEXT NOT NULL,
      position INTEGER NOT NULL, locator TEXT NOT NULL,
      PRIMARY KEY (group_id, message_id, origin, position),
      FOREIGN KEY (group_id, message_id) REFERENCES events(group_id, message_id) ON DELETE CASCADE
    );
  `);
}

const quoteIndex = value => typeof value === 'string' && value.length <= 256 && value.trim() ? value : null;

export function inbox(db, { mode = 'bound-group', challenge, enableDirect = false, retainGroupImages = () => false,
  retainDirectImages = () => false, now = Date.now }) {
  if (mode !== 'bound-group' && mode !== 'all-groups') throw new Error('invalid receive mode');
  migrate(db);
  const binding = db.prepare('SELECT group_id FROM group_binding WHERE singleton = 1');
  const bind = db.prepare('INSERT OR IGNORE INTO group_binding VALUES (1, ?)');
  const insert = db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertQuote = db.prepare('INSERT INTO event_quotes VALUES (?, ?, ?, ?, ?, ?)');
  const insertImage = db.prepare('INSERT INTO event_images VALUES (?, ?, ?, ?, ?)');
  const expire = db.prepare('DELETE FROM events WHERE received_at < ?');
  const trim = db.prepare(`DELETE FROM events WHERE rowid IN (
    SELECT rowid FROM events WHERE group_id = ? ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET 2000
  )`);
  const expireDirect = db.prepare('DELETE FROM direct_events WHERE received_at < ?');
  const putDirect = db.prepare('INSERT OR IGNORE INTO direct_events VALUES (?, ?, ?, ?, ?)');
  const putDirectMedia = db.prepare('INSERT INTO direct_media VALUES (?, ?, ?, ?, ?, ?)');
  const expireDirectMedia = db.prepare(`DELETE FROM direct_media WHERE NOT EXISTS (
    SELECT 1 FROM direct_events e WHERE e.sender_id=direct_media.sender_id AND e.message_id=direct_media.message_id)`);
  const prune = () => {
    const cutoff = now() - day;
    expire.run(cutoff);
    expireDirect.run(cutoff);
    expireDirectMedia.run();
  };
  prune();
  return {
    prune,
    record(msg, quote) {
      if (enableDirect && msg?.kind === 'c2c' && msg.rawEventType === 'C2C_MESSAGE_CREATE' && !msg.senderIsBot &&
        typeof msg.senderId === 'string' && /^[a-z0-9_-]{1,256}$/i.test(msg.senderId) &&
        typeof msg.messageId === 'string' && msg.messageId && msg.messageId.length <= 256 &&
        (typeof msg.content === 'string' && msg.content.trim() || msg.attachments?.length)) {
        db.exec('SAVEPOINT direct_event');
        let saved;
        try {
          saved = putDirect.run(msg.messageId, msg.senderId, now(), (msg.content ?? '').slice(0, 1600),
            msg.refMsgIdx || msg.attachments?.length ? 1 : 0).changes === 1;
          if (saved && retainDirectImages(msg.senderId) && (msg.attachments?.length || msg.refMsgIdx)) {
            const index = quoteIndex(msg.refMsgIdx);
            const pushed = index && quote?.refKey === index && quote.source === 'msg_elements' ? quote.attachments : null;
            putDirectMedia.run(msg.senderId, msg.messageId, quoteIndex(msg.msgIdx), index,
              JSON.stringify(qqImageLocators(msg.attachments)), JSON.stringify(qqImageLocators(pushed)));
          }
        } catch (error) { db.exec('ROLLBACK TO direct_event'); throw error; }
        finally { db.exec('RELEASE direct_event'); }
        prune();
        return saved;
      }
      if (!msg || msg.kind !== 'group' || !groupEvents.has(msg.rawEventType)
        || !msg.groupOpenid || !msg.senderId || !msg.messageId) return false;
      const personalMentions = (msg.mentions ?? []).filter(m => m.scope !== 'all');
      const directMention = personalMentions.some(m => m.is_you === true);
      const addressedElsewhere = !directMention && personalMentions.some(m => m.is_you === false);
      const mentioned = directMention || (!addressedElsewhere && msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE');
      const body = typeof msg.content === 'string' ? msg.content : '';
      if (mode === 'bound-group') {
        if (!binding.get() && mentioned && !msg.senderIsBot && challenge
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
          body.slice(0, 4096), Array.isArray(msg.attachments) ? msg.attachments.length : 0,
          msg.senderIsBot === true ? 1 : 0, addressedElsewhere ? 1 : 0);
        if (result.changes && (messageIndex || quotedIndex)) {
          insertQuote.run(msg.groupOpenid, msg.messageId, messageIndex, quotedIndex,
            typeof pushedQuote?.rawContent === 'string' ? pushedQuote.rawContent.slice(0, 4096) : '',
            Array.isArray(pushedQuote?.attachments) ? pushedQuote.attachments.length : 0);
        }
        if (result.changes && (msg.attachments?.length || pushedQuote?.attachments?.length) &&
          (binding.get()?.group_id === msg.groupOpenid || retainGroupImages(msg.groupOpenid))) {
          for (const [origin, attachments] of [['current', msg.attachments], ['quote', pushedQuote?.attachments]]) {
            qqImageLocators(attachments).forEach((url, position) => insertImage.run(msg.groupOpenid, msg.messageId, origin, position, url));
          }
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
  const configFile = process.env.LUKE_QQ_GROUP_POLICY;
  const configured = process.env.LUKE_QQ_IMAGEN === '1' && configFile ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
  const receiver = inbox(db, { mode, challenge: scope, enableDirect: process.env.LUKE_QQ_DIRECT === '1',
    retainGroupImages: id => configured?.conversations?.['group:' + id]?.imageGeneration === true,
    retainDirectImages: id => (configured?.conversations?.['direct:' + id]?.imageGeneration ??
      configured?.directDefaults?.imageGeneration) === true });
  const stop = new AbortController();
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
  const bot = new QQBot({ appId, appSecret, transport: 'websocket', logger });
  // Resolve pushed quote elements using the SDK; stored messages are looked up in SQLite by group.
  const resolveQuote = quoteRef({ store: { get: noop, set: noop } });
  bot.use(async (ctx, next) => {
    if (['group', 'c2c'].includes(ctx.message.kind) && ctx.message.refMsgIdx) {
      try { await resolveQuote(ctx, noop); } catch { console.error('qq_receive_quote_error'); }
    }
    await next();
  });
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
