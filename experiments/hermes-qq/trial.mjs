import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { readGroupWindow } from './inbox-view.mjs';

const maxAge = 180_000;
// The QQ client clipped a 308-byte native-mention payload despite accepting the send.
const mentionMarkdownBudget = 280;
const plainTextBudget = 1800;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const rawMention = /<@!?([a-z0-9_-]{1,128})>/gi;
const nativeMention = /(<qqbot-at-user id="[a-z0-9_-]{1,128}" \/>)/gi;
const mentionTag = id => '<qqbot-at-user id="' + id + '" />';
const memberLabel = '\u90a3\u4f4d\u7fa4\u53cb';
const sameSource = (event, source) => ['channel', 'account', 'groupId', 'messageId', 'senderId']
  .every(key => event[key] === source?.[key]);

export function trialInput(body) {
  return body.replace(/^\s*(?:<@!?[\w-]+>|@Luke(?=\s|$))\s*/iu, '')
    .trim().replace(/^\[Hermes\]\s*/u, '').slice(0, 1600);
}

function* textUnits(content) {
  for (const [index, part] of content.split(nativeMention).entries()) {
    if (index % 2) yield { segment: part, mention: true };
    else yield* graphemes.segment(part);
  }
}

function takeText(content, budget) {
  if (Buffer.byteLength(content) <= budget) return [content, ''];
  let bytes = 0;
  let end = 0;
  let sentenceEnd = 0;
  let softEnd = 0;
  for (const { segment, mention } of textUnits(content)) {
    bytes += Buffer.byteLength(segment);
    if (bytes > budget) break;
    end += segment.length;
    if (mention) continue;
    if (/[。！？.!?；;\n]/u.test(segment)) sentenceEnd = end;
    if (/[，、：,:\s]/u.test(segment)) softEnd = end;
  }
  const cut = [sentenceEnd, softEnd, end].find(offset => offset && content.slice(0, offset).trim());
  if (!cut) throw new Error('no QQ-safe reply boundary');
  return [content.slice(0, cut), content.slice(cut)];
}

export async function sendMentionReply(bot, event, content, ApiError, onDowngrade = () => {}) {
  if (!/^[a-z0-9_-]{1,128}$/i.test(event.senderId)) throw new Error('invalid QQ mention target');
  const target = { scope: 'group', targetId: event.groupId, msgId: event.messageId };
  const targets = new Map(Array.from((event.text ?? '').matchAll(rawMention), ([, id]) => [id.toLowerCase(), id]));
  let remaining = content.replace(rawMention, (_, id) => {
    const targetId = targets.get(id.toLowerCase());
    return targetId ? mentionTag(targetId) : memberLabel;
  });
  let receipt;
  let seq = 1;
  let markdownEnabled = true;
  while (remaining.trim()) {
    const prefix = markdownEnabled && seq === 1 ? mentionTag(event.senderId) + ' ' : '';
    const markdown = markdownEnabled && (prefix !== '' || remaining.includes('<qqbot-at-user id="'));
    const [part, tail] = takeText(remaining, markdown ? mentionMarkdownBudget - Buffer.byteLength(prefix) : plainTextBudget);
    const extra = { msg_seq: seq };
    try {
      receipt = await bot.send(markdown
        ? { target, msgType: 2, markdown: { content: prefix + part }, extra }
        : { target, msgType: 0, content: part, extra });
    } catch (error) {
      // A definite permission rejection is the only case where a send can be repeated.
      if (!markdown || !(error instanceof ApiError) || error.httpStatus >= 500 ||
        error.path !== '/v2/groups/' + event.groupId + '/messages' ||
        ![304036, 40034127].includes(Number(error.bizCode))) throw error;
      onDowngrade();
      markdownEnabled = false;
      remaining = remaining.replace(nativeMention, memberLabel);
      continue;
    }
    if (!receipt?.id) return receipt;
    seq++;
    remaining = tail;
  }
  return receipt;
}

export function makeTrial({
  inbox, ledger, account, groupId, senderId, start, until, signal,
  now = Date.now, windowMs = 60_000, plan, startWork, finish, send, planWindow, sendWindow, log = () => {},
}) {
  ledger.exec(`CREATE TABLE IF NOT EXISTS trial_receipts (
    group_id TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(group_id, message_id)
  )`);
  const claim = ledger.prepare("INSERT OR IGNORE INTO trial_receipts VALUES (?, ?, 'claimed')");
  const mark = ledger.prepare('UPDATE trial_receipts SET state = ? WHERE group_id = ? AND message_id = ?');
  const known = ledger.prepare('SELECT 1 FROM trial_receipts WHERE group_id = ? AND message_id = ?');
  const rows = inbox.prepare(`SELECT * FROM events WHERE group_id=? AND sender_id=? AND mentioned=1
    AND received_at>? AND received_at<=? ORDER BY received_at,rowid LIMIT 32`);
  const firstPlain = inbox.prepare(`SELECT MIN(received_at) AS at FROM events
    WHERE group_id=? AND sender_id=? AND mentioned=0 AND received_at>?
      AND length(trim(body))>0`);
  const latestMention = inbox.prepare('SELECT MAX(received_at) AS at FROM events WHERE group_id=? AND sender_id=? AND mentioned=1');
  const active = new Set();
  let routing = 0;
  let budget = 6;
  let coveredThrough = start;
  let ambient = false;
  const isLive = () => !signal?.aborted && now() < until;
  const record = (event, status, key = event.messageId) => { mark.run(status, event.groupId, key); log(status); return status; };
  function track(promise) {
    const task = promise.finally(() => active.delete(task));
    active.add(task);
  }
  function prior(at, omit) {
    return readGroupWindow(inbox, { account, groupId, after: Math.max(0, at - 86_400_000), through: at })
      .filter(item => item.messageId !== omit).slice(-8)
      .map(item => ({ speaker: item.senderId, text: item.text }));
  }
  async function deliver(event, result) {
    if (!sameSource(event, result?.source) || typeof result?.text !== 'string') return record(event, 'withheld');
    const text = result.text.trim();
    if (!text || text.length > 1800 || /<[^>]+>|\[CQ:|\bNO_REPLY\b/i.test(text.replace(rawMention, '')) ||
      !isLive() || now() - event.at > maxAge) return record(event, 'withheld');
    record(event, 'sending');
    try { record(event, (await send(event, text))?.id ? 'accepted' : 'uncertain'); }
    catch { record(event, 'uncertain'); }
  }
  async function route(event) {
    try {
      const decision = await plan(event, prior(event.at, event.messageId));
      if (!sameSource(event, decision?.source)) { record(event, 'withheld'); return; }
      if (decision.kind === 'chat') await deliver(event, decision);
      else if (decision.kind === 'work-request' || decision.kind === 'work') {
        record(event, 'working');
        track(Promise.resolve().then(async () => {
          if (!isLive()) return record(event, 'withheld');
          const job = decision.kind === 'work-request' ? await startWork(decision) : decision;
          if (!sameSource(event, job?.source) || job.kind !== 'work') return record(event, 'withheld');
          return deliver(event, await finish(job));
        })
          .catch(() => record(event, 'failed')));
      } else record(event, 'withheld');
    } catch { record(event, 'failed'); }
  }
  function startWindow() {
    if (!planWindow || !sendWindow || ambient || !budget || !isLive()) return;
    const since = Math.max(coveredThrough, now() - maxAge);
    const first = firstPlain.get(groupId, senderId, since)?.at;
    if (!Number.isSafeInteger(first) || now() < first + windowMs) return;
    const through = first + windowMs;
    coveredThrough = through;
    const events = readGroupWindow(inbox, { account, groupId, after: since, through }).filter(item => !item.mentioned);
    if (!events.some(item => item.senderId === senderId)) return;
    const tail = events.at(-1);
    const anchors = new Set(events.map(item => item.messageId));
    ambient = true;
    budget--;
    track(Promise.resolve().then(() => planWindow(events, since > 0 ? prior(since) : [])).then(async actions => {
      if (!Array.isArray(actions)) return;
      for (const action of actions.slice(0, 2)) {
        if (!isLive() || now() - through > maxAge || latestMention.get(groupId, senderId)?.at >= through) break;
        if (!['natural', 'reply'].includes(action?.mode) ||
          (action.mode === 'reply' && !anchors.has(action.replyToId)) ||
          typeof action.text !== 'string' || !action.text.trim() || action.text.length > 180 ||
          /[<\r\n]|\[CQ:|[@＠]|\bNO_REPLY\b/i.test(action.text)) continue;
        const key = 'window:' + tail.messageId + ':' + action.mode;
        if (!claim.run(groupId, key).changes) continue;
        record(tail, 'sending', key);
        try {
          if (record(tail, (await sendWindow(groupId, action))?.id ? 'accepted' : 'uncertain', key) !== 'accepted') break;
        } catch { record(tail, 'uncertain', key); break; }
      }
    }).catch(() => log('window_failed')).finally(() => { ambient = false; }));
  }
  return {
    tick() {
      if (!budget || signal?.aborted || now() >= until) return;
      for (const row of rows.all(groupId, senderId, Math.max(start, now() - maxAge), now())) {
        if (!budget || signal?.aborted || now() >= until || routing >= 3) break;
        const text = trialInput(row.body);
        if (!text || known.get(groupId, row.message_id) || !claim.run(groupId, row.message_id).changes) continue;
        budget--;
        coveredThrough = Math.max(coveredThrough, row.received_at);
        const event = {
          channel: 'qqbot', account, groupId, messageId: row.message_id,
          senderId: row.sender_id, mentioned: true, text, at: row.received_at,
        };
        routing++;
        track(route(event).finally(() => { routing--; }));
      }
      startWindow();
    },
    async drain() { while (active.size) await Promise.all(active); },
  };
}

function callRuntime(container, mode, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/local/bin/docker', ['exec', '-i', '-u', 'hermes', container,
      'node', '/pilot/hermes-qq/shadow.mjs', mode], { timeout: 155_000, maxBuffer: 48_000 }, (error, stdout) => {
      if (error) return reject(new Error('Hermes trial call failed'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('invalid Hermes response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const [root, sdk, account, keychainService, container, bindPhrase, worker] = process.argv.slice(2);
  const containerName = /^[a-z0-9][a-z0-9-]{1,80}$/i;
  if (!root || !sdk || !/^\d+$/.test(account ?? '') || !keychainService
    || !containerName.test(container ?? '') || !containerName.test(worker ?? '') || container === worker
    || !/^AOA-[A-Z0-9]{8,32}$/.test(bindPhrase ?? '')) {
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
  const { QQBot, ApiError } = await import(pathToFileURL(sdk));
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
    plan: (event, context) => callRuntime(container, 'trial-plan', { events: [event], context }),
    startWork: decision => callRuntime(worker, 'trial-start', { decision }),
    finish: job => callRuntime(worker, 'trial-settle', { job }),
    planWindow: (events, context) => callRuntime(container, 'trial-window', { events, context }),
    sendWindow: (to, action) => bot.send({
      target: { scope: 'group', targetId: to, ...(action.mode === 'reply' ? { msgId: action.replyToId } : {}) },
      msgType: 0, content: action.text, extra: { msg_seq: 1 },
    }),
    send: (event, content) => sendMentionReply(bot, event, content, ApiError,
      () => console.log('qq_trial_mention_plain_fallback')),
    log: status => console.log('qq_trial_' + status),
  });
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  console.log('qq_trial_ready');
  try {
    while (!stop.signal.aborted && Date.now() < until) {
      trial.tick();
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
