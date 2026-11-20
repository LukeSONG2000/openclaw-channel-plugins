import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { readGroupContext } from './inbox-view.mjs';
import { makeGroupTurnState } from './group-turn-state.mjs';
import { backgroundRequest } from './pilot.mjs';
import { kanbanTasks, makeKanbanBridge, runKanbanCommand } from './kanban.mjs';

const maxAge = 180_000;
const passiveWindowMs = 295_000;
const docker = '/usr/local/bin/docker';
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
  always = false, now = Date.now, pollIntervalsMs, plan, startWork, finish, queueWork, send, planWindow, sendWindow, log = () => {},
}) {
  ledger.exec(`CREATE TABLE IF NOT EXISTS trial_receipts (
    group_id TEXT NOT NULL, message_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(group_id, message_id)
  )`);
  const claim = ledger.prepare("INSERT OR IGNORE INTO trial_receipts VALUES (?, ?, 'claimed')");
  const mark = ledger.prepare('UPDATE trial_receipts SET state = ? WHERE group_id = ? AND message_id = ?');
  const known = ledger.prepare('SELECT 1 FROM trial_receipts WHERE group_id = ? AND message_id = ?');
  const rows = inbox.prepare(`SELECT rowid AS inbox_row, * FROM events WHERE group_id=? AND (? IS NULL OR sender_id=?)
    AND mentioned=1 AND received_at>? AND received_at<=?
    AND (received_at>? OR (received_at=? AND rowid>?)) ORDER BY received_at,rowid LIMIT 32`);
  const latestMention = inbox.prepare(`SELECT message_id AS id FROM events
    WHERE group_id=? AND (? IS NULL OR sender_id=?) AND mentioned=1
    ORDER BY received_at DESC, rowid DESC LIMIT 1`);
  const turnState = makeGroupTurnState({ inbox, ledger, account, groupId, start, resume: always, intervals: pollIntervalsMs });
  const { startedAt } = turnState;
  const allowedSender = always ? null : senderId;
  const active = new Set();
  let routing = 0;
  let budget = always ? Infinity : 6;
  let lastMentionAt = startedAt;
  let lastMentionRow = 0;
  let ambient = false;
  const isLive = () => !signal?.aborted && now() < until;
  const record = (event, status, key = event.messageId) => { mark.run(status, event.groupId, key); log(status); return status; };
  function track(promise) {
    const task = promise.finally(() => active.delete(task));
    active.add(task);
  }
  function contextAt(through, beforeMessageId, hours = null, include) {
    return readGroupContext(inbox, { groupId, through, beforeMessageId, hours, include });
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
      const unread = turnState.unread(event.at, event.messageId).slice(-12);
      const recent = contextAt(event.at, event.messageId, null, turnState.isRead);
      const decision = await plan(event, recent.messages, unread);
      if (!sameSource(event, decision?.source)) { record(event, 'withheld'); return; }
      const related = new Set(Array.isArray(decision.consumedMessageIds) ? decision.consumedMessageIds : []);
      const relatedRows = unread.filter(row => related.has(row.messageId));
      const consumeRelated = () => { if (relatedRows.length) turnState.markRead(relatedRows, now()); };
      if (decision.kind === 'chat') {
        consumeRelated();
        await deliver(event, decision);
      }
      else if (decision.kind === 'work-intent' || decision.kind === 'work') {
        record(event, 'working');
        track(Promise.resolve().then(async () => {
          if (!isLive() || now() - event.at > maxAge) return record(event, 'withheld');
          const context = decision.kind === 'work-intent' && decision.contextHours !== null
            ? contextAt(event.at, event.messageId, decision.contextHours)
            : { messages: [...recent.messages, ...relatedRows.map(row => ({
                speaker: row.senderId, text: row.text.slice(0, 320), at: row.at,
              }))].sort((a, b) => a.at - b.at).slice(-12) };
          const request = decision.kind === 'work-intent' ? backgroundRequest(event, decision, context) : null;
          if (queueWork && request) {
            await queueWork(request);
            consumeRelated();
            return record(event, 'queued');
          }
          const job = request ? await startWork(request) : decision;
          if (!sameSource(event, job?.source) || job.kind !== 'work') return record(event, 'withheld');
          consumeRelated();
          const result = await finish(job);
          const coverage = context.coverage;
          const notice = coverage && ('上下文：近 ' + coverage.hours + ' 小时收到 ' + coverage.available + ' 条可用文字'
            + (coverage.available > coverage.sampled ? '，按时段抽取 ' + coverage.sampled + ' 条' : '')
            + '。不含图片、附件和未收到的记录。');
          return deliver(event, notice && typeof result?.text === 'string'
            ? { ...result, text: result.text + '\n\n' + notice } : result);
        })
          .catch(() => record(event, 'failed')));
      } else record(event, 'withheld');
    } catch { record(event, 'failed'); }
  }
  function startWindow() {
    if (!planWindow || !sendWindow || ambient || routing || !budget || !isLive()) return;
    const currentMention = () => latestMention.get(groupId, allowedSender, allowedSender)?.id;
    const mentionAtStart = currentMention();
    const at = now();
    const batch = turnState.poll(at, item => always || item.senderId === senderId);
    if (!batch?.messages.length) return;
    const { messages, revision } = batch;
    const eligibleAnchor = row => row && now() - row.at < passiveWindowMs;
    const events = messages.filter(eligibleAnchor).slice(-24);
    if (!events.length) {
      turnState.markRead(messages, now(), revision);
      log('window_read_only');
      return;
    }
    const tail = events.at(-1);
    const anchors = new Map(events.map(item => [item.messageId, item]));
    const isCurrent = () => isLive() && turnState.isCurrent(revision) && currentMention() === mentionAtStart;
    const context = contextAt(at, undefined, null, (id, receivedAt) =>
      !anchors.has(id) && (turnState.isRead(id, receivedAt) || at - receivedAt >= passiveWindowMs)).messages;
    ambient = true;
    budget--;
    track(Promise.resolve().then(() => planWindow(events, context, revision)).then(async actions => {
      if (!Array.isArray(actions) || !isCurrent() || !turnState.markRead(messages, now(), revision)) return;
      for (const action of actions.slice(0, 2)) {
        if (!isCurrent()) break;
        if (!['natural', 'reply'].includes(action?.mode) ||
          !eligibleAnchor(action.mode === 'reply' ? anchors.get(action.replyToId) : tail) ||
          typeof action.text !== 'string' || !action.text.trim() || action.text.length > 180 ||
          /[<\r\n]|\[CQ:|[@＠]|\bNO_REPLY\b/i.test(action.text)) continue;
        const key = 'window:' + tail.messageId + ':' + action.mode;
        if (!claim.run(groupId, key).changes) continue;
        record(tail, 'sending', key);
        try {
          if (record(tail, (await sendWindow(groupId, action, tail))?.id ? 'accepted' : 'uncertain', key) !== 'accepted') break;
        } catch { record(tail, 'uncertain', key); break; }
      }
    }).catch(() => log('window_failed')).finally(() => { ambient = false; }));
  }
  return {
    tick() {
      if (!budget || signal?.aborted || now() >= until) return;
      for (const row of rows.all(groupId, allowedSender, allowedSender, Math.max(startedAt, now() - maxAge), now(),
        lastMentionAt, lastMentionAt, lastMentionRow)) {
        if (!budget || signal?.aborted || now() >= until || routing >= 3) break;
        lastMentionAt = row.received_at;
        lastMentionRow = row.inbox_row;
        const text = trialInput(row.body);
        if (known.get(groupId, row.message_id) || !claim.run(groupId, row.message_id).changes) continue;
        budget--;
        const event = {
          channel: 'qqbot', account, groupId, messageId: row.message_id,
          senderId: row.sender_id, mentioned: true, text, at: row.received_at,
        };
        turnState.mention(event.at);
        turnState.markRead([event], now());
        if (!text) { record(event, 'withheld'); continue; }
        routing++;
        track(route(event).finally(() => { routing--; }));
      }
      startWindow();
    },
    async drain() { while (active.size) await Promise.all(active); },
  };
}

export function qqReceiptPolicy(inbox, { account, groupId, signal, now = Date.now }) {
  const lookup = inbox.prepare('SELECT sender_id, received_at FROM events WHERE group_id=? AND message_id=? AND mentioned=1');
  return source => {
    if (signal?.aborted) return false;
    if (source.channel !== 'qqbot' || source.account !== account || source.groupId !== groupId) return 'expired';
    const row = lookup.get(groupId, source.messageId);
    const age = now() - (row?.received_at ?? 0);
    return row?.sender_id === source.senderId && age >= 0 && age < passiveWindowMs ? true : 'expired';
  };
}

function callRuntime(container, mode, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(docker, ['exec', '-i', '-u', 'hermes', container,
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
  const always = bindPhrase === '--always';
  const containerName = /^[a-z0-9][a-z0-9-]{1,80}$/i;
  if (!root || !sdk || !/^\d+$/.test(account ?? '') || !keychainService
    || !containerName.test(container ?? '') || !containerName.test(worker ?? '') || container === worker
    || (!always && !/^AOA-[A-Z0-9]{8,32}$/.test(bindPhrase ?? ''))) {
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
  if (!groupId) throw new Error('no verified QQ trial group');
  let senderId;
  if (!always) {
    const senders = inbox.prepare(`SELECT DISTINCT sender_id FROM events WHERE group_id=? AND mentioned=1 AND instr(body,?)>0`)
      .all(groupId, bindPhrase);
    senderId = senders.length === 1 ? senders[0].sender_id : null;
    if (!/^[a-z0-9_-]{1,128}$/i.test(senderId ?? '')) throw new Error('no verified QQ trial sender');
  }
  const { QQBot, ApiError } = await import(pathToFileURL(sdk));
  const appSecret = execFileSync('/usr/bin/security', ['find-generic-password', '-a', account,
    '-s', keychainService, '-w'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!appSecret) throw new Error('no QQ test credential');
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
  const bot = new QQBot({ appId: account, appSecret, logger });
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  const kanbanCommand = (args, input) => runKanbanCommand(docker, ['exec', '-i', '-u', 'hermes', worker,
    'hermes', 'kanban', ...args], input);
  if (always) await Promise.all([callRuntime(container, 'health', {}), kanbanCommand(['diagnostics', '--json'])]);
  const bridge = always ? makeKanbanBridge({
    db: ledger, tasks: kanbanTasks({ command: kanbanCommand }), account, groupId,
    onError: phase => console.error('qq_kanban_error phase=' + phase),
  }) : null;
  const start = Date.now();
  const until = always ? Infinity : start + 30 * 60_000;
  const safeSend = async operation => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ApiError) {
        console.error('qq_send_rejected http=' + (Number(error.httpStatus) || 0) + ' code=' + (Number(error.bizCode) || 0));
      }
      throw error;
    }
  };
  const send = (event, content) => safeSend(() => sendMentionReply(bot, event, content, ApiError,
    () => console.log('qq_trial_mention_plain_fallback')));
  const trial = makeTrial({
    inbox, ledger, account, groupId, senderId, start, until, always, signal: stop.signal,
    plan: (event, context, unread) => callRuntime(container, 'trial-plan', { events: [event], context, unread }),
    startWork: decision => callRuntime(worker, 'trial-start', { decision }),
    finish: job => callRuntime(worker, 'trial-settle', { job }),
    queueWork: bridge?.enqueue,
    planWindow: (events, context, attempt) => callRuntime(container, 'trial-window', { events, context, attempt }),
    sendWindow: (to, action, tail) => safeSend(() => bot.send({
      target: { scope: 'group', targetId: to, ...(action.mode === 'reply' ? { msgId: action.replyToId }
        : always ? { msgId: tail.messageId } : {}) },
      msgType: 0, content: action.text, extra: { msg_seq: always && action.mode === 'natural' ? 2 : 1 },
    })),
    send,
    log: status => console.log('qq_trial_' + status),
  });
  const canDeliver = qqReceiptPolicy(inbox, { account, groupId, signal: stop.signal });
  let sweep;
  let nextSweep = start;
  console.log('qq_trial_ready mode=' + (always ? 'always' : 'bounded'));
  try {
    while (!stop.signal.aborted && Date.now() < until) {
      trial.tick();
      if (bridge && !sweep && Date.now() >= nextSweep) {
        nextSweep = Date.now() + 5_000;
        sweep = bridge.sweep({
          canDeliver,
          deliver: async ({ source, text }) => {
            const receipt = await send(source, text);
            console.log('qq_kanban_' + (receipt?.id ? 'accepted' : 'uncertain'));
            return receipt;
          },
        }).catch(() => console.error('qq_kanban_sweep_failed')).finally(() => { sweep = null; });
      }
      await delay(700, undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    await trial.drain();
    await sweep;
    await bot.stop();
    inbox.close();
    ledger.close();
  }
}

if (import.meta.main) main().catch(() => {
  console.error('qq_trial_failed');
  process.exitCode = 1;
});
