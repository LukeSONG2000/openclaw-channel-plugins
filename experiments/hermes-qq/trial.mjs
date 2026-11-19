import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { readGroupWindow } from './inbox-view.mjs';

const maxAge = 180_000;
const prefix = '[Hermes]';
const sameSource = (event, source) => ['channel', 'account', 'groupId', 'messageId', 'senderId']
  .every(key => event[key] === source?.[key]);

export function trialInput(body) {
  const text = body.replace(/^(?:\s*<@!?[\w-]+>\s*|\s*@Luke\s+)*/iu, '').trimStart();
  return text.startsWith(prefix) ? text.slice(prefix.length).trim().slice(0, 1600) : '';
}

export function makeTrial({
  inbox, ledger, account, groupId, senderId, start, until, signal,
  now = Date.now, plan, finish, send, log = () => {},
}) {
  ledger.exec(`CREATE TABLE IF NOT EXISTS trial_receipts (
    group_id TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(group_id, message_id)
  )`);
  const claim = ledger.prepare("INSERT OR IGNORE INTO trial_receipts VALUES (?, ?, 'claimed')");
  const mark = ledger.prepare('UPDATE trial_receipts SET state = ? WHERE group_id = ? AND message_id = ?');
  const known = ledger.prepare('SELECT 1 FROM trial_receipts WHERE group_id = ? AND message_id = ?');
  const rows = inbox.prepare(`SELECT * FROM events WHERE group_id=? AND sender_id=? AND mentioned=1
    AND received_at>? AND received_at<=? AND instr(body, '[Hermes]')>0 ORDER BY received_at,rowid LIMIT 32`);
  const active = new Set();
  let budget = 6;
  const record = (event, status) => { mark.run(status, event.groupId, event.messageId); log(status); };
  async function deliver(event, result) {
    if (!sameSource(event, result?.source) || typeof result?.text !== 'string' || !result.text.trim() ||
      result.text.length > 1800 || /<[^>]+>|\[CQ:|\bNO_REPLY\b/i.test(result.text) ||
      signal?.aborted || now() >= until || now() - event.at > maxAge) return record(event, 'withheld');
    record(event, 'sending');
    try { record(event, (await send(event, result.text))?.id ? 'accepted' : 'uncertain'); }
    catch { record(event, 'uncertain'); }
  }
  return {
    async tick() {
      if (!budget || signal?.aborted || now() >= until) return;
      for (const row of rows.all(groupId, senderId, Math.max(start, now() - maxAge), now())) {
        if (!budget || signal?.aborted || now() >= until) break;
        const text = trialInput(row.body);
        if (!text || known.get(groupId, row.message_id) || !claim.run(groupId, row.message_id).changes) continue;
        budget--;
        const event = {
          channel: 'qqbot', account, groupId, messageId: row.message_id,
          senderId: row.sender_id, mentioned: true, text, at: row.received_at,
        };
        try {
          const context = readGroupWindow(inbox, { account, groupId, after: Math.max(0, event.at - 86_400_000), through: event.at })
            .filter(item => item.messageId !== event.messageId && !trialInput(item.text)).slice(-8)
            .map(item => ({ speaker: item.senderId, text: item.text }));
          const decision = await plan(event, context);
          if (!sameSource(event, decision?.source)) { record(event, 'withheld'); continue; }
          if (decision.kind === 'chat') await deliver(event, decision);
          else if (decision.kind === 'work') {
            record(event, 'working');
            const task = Promise.resolve().then(() => finish(decision)).then(result => deliver(event, result))
              .catch(() => record(event, 'failed')).finally(() => active.delete(task));
            active.add(task);
          } else record(event, 'withheld');
        } catch { record(event, 'failed'); }
      }
    },
    async drain() { await Promise.all(active); },
  };
}

function callRuntime(container, mode, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/local/bin/docker', ['exec', '-i', '-u', 'hermes', container,
      'node', '/pilot/hermes-qq/shadow.mjs', mode], { timeout: 100_000, maxBuffer: 48_000 }, (error, stdout) => {
      if (error) return reject(new Error('Hermes trial call failed'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('invalid Hermes response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const [root, sdk, account, keychainService, container, bindPhrase] = process.argv.slice(2);
  if (!root || !sdk || !/^\d+$/.test(account ?? '') || !keychainService
    || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(container ?? '') || !/^AOA-[A-Z0-9]{8,32}$/.test(bindPhrase ?? '')) {
    throw new Error('invalid QQ trial configuration');
  }
  process.umask(0o077);
  const state = statSync(root);
  if (state.uid !== process.getuid() || state.mode & 0o077) throw new Error('trial state must be private');
  const trialDir = join(root, 'hermes-trial');
  mkdirSync(trialDir, { recursive: true, mode: 0o700 });
  const inbox = new DatabaseSync(join(root, 'inbox.sqlite'), { readOnly: true });
  const ledger = new DatabaseSync(join(trialDir, 'receipts.sqlite'));
  const groupId = inbox.prepare('SELECT group_id FROM group_binding WHERE singleton=1').get()?.group_id;
  const senders = inbox.prepare(`SELECT DISTINCT sender_id FROM events WHERE group_id=? AND mentioned=1 AND instr(body,?)>0`)
    .all(groupId ?? '', bindPhrase);
  if (!groupId || senders.length !== 1) throw new Error('no verified QQ trial sender');
  const senderId = senders[0].sender_id;
  if (!/^[a-z0-9_-]{1,128}$/i.test(senderId)) throw new Error('invalid QQ sender ID');
  const { QQBot } = await import(pathToFileURL(sdk));
  const appSecret = execFileSync('/usr/bin/security', ['find-generic-password', '-a', account,
    '-s', keychainService, '-w'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!appSecret) throw new Error('no QQ test credential');
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
  const bot = new QQBot({ appId: account, appSecret, logger });
  const start = Date.now();
  const until = start + 30 * 60_000;
  const stop = new AbortController();
  const trial = makeTrial({
    inbox, ledger, account, groupId, senderId, start, until, signal: stop.signal,
    plan: (event, context) => callRuntime(container, 'trial-mention', { events: [event], context }),
    finish: job => callRuntime(container, 'trial-settle', { job }),
    send: (event, content) => bot.send({
      target: { scope: 'group', targetId: event.groupId, msgId: event.messageId },
      msgType: 0, content: '<@' + event.senderId + '> ' + content, extra: { msg_seq: 1 },
    }),
    log: status => console.log('qq_trial_' + status),
  });
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  console.log('qq_trial_ready');
  try {
    while (!stop.signal.aborted && Date.now() < until) {
      await trial.tick();
      await delay(700, undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    await trial.drain();
    await bot.stop();
    inbox.close();
    ledger.close();
  }
}

if (import.meta.main) main().catch(() => {
  console.error('qq_trial_failed');
  process.exitCode = 1;
});
