import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const day = 86_400_000;
const groupEvents = new Set(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE']);

export function inbox(db, { challenge, now = Date.now }) {
  db.exec(`
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS group_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), group_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      message_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      event_type TEXT NOT NULL, mentioned INTEGER NOT NULL, body TEXT NOT NULL,
      attachment_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_received_at ON events(received_at);
  `);
  const binding = db.prepare('SELECT group_id FROM group_binding WHERE singleton = 1');
  const bind = db.prepare('INSERT OR IGNORE INTO group_binding VALUES (1, ?)');
  const insert = db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?)');
  const expire = db.prepare('DELETE FROM events WHERE received_at < ?');
  const trim = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET 2000)');
  const prune = () => { expire.run(now() - day); trim.run(); };
  prune();
  return {
    prune,
    record(msg) {
      if (!msg || msg.kind !== 'group' || msg.senderIsBot || !groupEvents.has(msg.rawEventType)
        || !msg.groupOpenid || !msg.senderId || !msg.messageId) return false;
      const mentioned = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || msg.mentions?.some(m => m.is_you === true);
      const body = typeof msg.content === 'string' ? msg.content : '';
      // A private setup phrase binds one group, not every group the bot receives.
      if (!binding.get() && mentioned && challenge
        && body.replace(/<@!?[^>]+>/g, ' ').split(/\s+/).includes(challenge)) bind.run(msg.groupOpenid);
      if (binding.get()?.group_id !== msg.groupOpenid) return false;
      const result = insert.run(msg.messageId, msg.senderId, now(), msg.rawEventType, mentioned ? 1 : 0,
        body.slice(0, 4096), Array.isArray(msg.attachments) ? msg.attachments.length : 0);
      prune();
      return result.changes === 1;
    },
  };
}

async function main() {
  const [rootArg, sdkPath, appId, keychainService, challenge] = process.argv.slice(2);
  if (!rootArg || !sdkPath || !/^\d+$/.test(appId ?? '') || !keychainService || !/^AOA-[A-Z0-9]{8,32}$/.test(challenge ?? '')) {
    throw new Error('invalid pilot configuration');
  }
  process.umask(0o077);
  mkdirSync(rootArg, { recursive: true, mode: 0o700 });
  const root = realpathSync(rootArg);
  const stat = statSync(root);
  if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('pilot state must be private');
  const { QQBot } = await import(pathToFileURL(sdkPath));
  const appSecret = execFileSync('/usr/bin/security', [
    'find-generic-password', '-a', appId, '-s', keychainService, '-w',
  ], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!appSecret) throw new Error('empty keychain credential');
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  const receiver = inbox(db, { challenge });
  const stop = new AbortController();
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
  const bot = new QQBot({ appId, appSecret, transport: 'websocket', logger });
  bot.on('ready', () => console.log('qq_receive_ready'));
  bot.on('error', () => console.error('qq_receive_error'));
  bot.on('message', (_ctx, msg) => {
    try { receiver.record(msg); } catch { console.error('qq_receive_store_error'); }
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
