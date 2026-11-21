import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { makeDeliveryContext, makeDirectImageReader, makeGroupImageReader, makeGroupQuoteReader, readGroupContext } from './inbox-view.mjs';
import { makeGroupTurnState } from './group-turn-state.mjs';
import { backgroundRequest, qqImageBytes, qqRouteFailureNotice, workImages } from './pilot.mjs';
import { kanbanTasks, makeKanbanBridge, runKanbanCommand, runKanbanMediaUpload } from './kanban.mjs';
import { readQqAppSecret } from '../aoa-async/qq-credential.mjs';
import { readQqImages } from '../aoa-async/qq-image-source.mjs';
import { canUseQqReplyAnchor, qqReceiptPolicy } from './qq-reply-anchor.mjs';
import { makeMemberMemory } from './member-memory.mjs';
import { makeDirectChat, groupMemoryAuthorized } from './direct-chat.mjs';
import { conversationPolicy } from './group-policy.mjs';
import { imagenJobs, imagenReceiptStore, serveImagen } from './imagen.mjs';
import { qqFilePendingNotice, readCompletionFiles, sendQqFile } from './qq-attachments.mjs';

const maxAge = 180_000;
const engine = process.platform === 'linux' ? '/usr/bin/podman' : '/usr/local/bin/docker';
// The QQ client clipped a 308-byte native-mention payload despite accepting the send.
const mentionMarkdownBudget = 280;
const plainTextBudget = 1800;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const rawMention = /<@!?([a-z0-9_-]{1,128})>/gi;
const nativeMention = /(<qqbot-at-user id="[a-z0-9_-]{1,128}" \/>)/gi;
const linkUnit = /\[[^\]\r\n]{1,160}\]\(https?:\/\/[^\s<>()]+\)|https?:\/\/[^\s<>()\[\]"'，。！？；、：]+|(?:[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]{1,5})?/giu;
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
    if (index % 2) {
      yield { segment: part, atomic: true };
      continue;
    }
    let start = 0;
    for (const link of part.matchAll(linkUnit)) {
      yield* graphemes.segment(part.slice(start, link.index));
      yield { segment: link[0], atomic: true };
      start = link.index + link[0].length;
    }
    yield* graphemes.segment(part.slice(start));
  }
}

function takeText(content, budget) {
  if (Buffer.byteLength(content) <= budget) return [content, ''];
  let bytes = 0;
  let end = 0;
  let sentenceEnd = 0;
  let softEnd = 0;
  for (const { segment, atomic } of textUnits(content)) {
    bytes += Buffer.byteLength(segment);
    if (bytes > budget) break;
    end += segment.length;
    if (atomic) continue;
    if (/[。！？.!?；;\n]/u.test(segment)) sentenceEnd = end;
    if (/[，、：,:\s]/u.test(segment)) softEnd = end;
  }
  const cut = [sentenceEnd, softEnd, end].find(offset => offset && content.slice(0, offset).trim());
  if (!cut) return null;
  return [content.slice(0, cut), content.slice(cut)];
}

export async function sendMentionReply(bot, event, content, ApiError, onDowngrade = () => {}, firstSeq = 1) {
  if (!/^[a-z0-9_-]{1,128}$/i.test(event.senderId)) throw new Error('invalid QQ mention target');
  const target = { scope: 'group', targetId: event.groupId, msgId: event.messageId };
  const targets = new Map(Array.from((event.text ?? '').matchAll(rawMention), ([, id]) => [id.toLowerCase(), id]));
  let remaining = content.replace(rawMention, (_, id) => {
    const targetId = targets.get(id.toLowerCase());
    return targetId ? mentionTag(targetId) : memberLabel;
  });
  let receipt;
  let seq = firstSeq;
  let markdownEnabled = true;
  while (remaining.trim()) {
    if (seq > 5) throw new Error('QQ passive reply budget exhausted');
    const prefix = markdownEnabled && seq === firstSeq ? mentionTag(event.senderId) + ' ' : '';
    const hasInlineMention = remaining.includes('<qqbot-at-user id="');
    let markdown = markdownEnabled && (prefix !== '' || hasInlineMention);
    let chunk = takeText(remaining, markdown ? mentionMarkdownBudget - Buffer.byteLength(prefix) : plainTextBudget);
    if (!chunk && markdown && !hasInlineMention) {
      // An address at the start may not fit beside a mention. Use a single plain reply.
      markdown = false;
      chunk = takeText(remaining, plainTextBudget);
    }
    if (!chunk) throw new Error('no QQ-safe reply boundary');
    const [part, tail] = chunk;
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

export async function sendWorkImage(bot, target, artifact, seq, canSend = () => true) {
  if (!seq) return (await bot.sendImage(target, { buffer: artifact.bytes, fileName: 'imagen.' + artifact.format })).message;
  // sendImage allocates its own sequence; reserve the slot explicitly after a hint.
  const upload = await bot.uploadMedia({ target, fileType: 1, buffer: artifact.bytes,
    fileName: 'imagen.' + artifact.format, srvSendMsg: false });
  if (!upload?.file_info || !await canSend()) return;
  return bot.send({ target, msgType: 7, media: { file_info: upload.file_info }, extra: { msg_seq: seq } });
}

export function sendAmbientReply({ bot, sendMention, always }, { groupId, action, tail, anchor }) {
  if (anchor?.groupId !== groupId || tail?.groupId !== groupId ||
      (action.mode !== 'natural' && anchor.messageId !== action.replyToId)) {
    throw new Error('ambient reply anchor is outside the window');
  }
  if (action.mode === 'mention') return sendMention({ ...anchor, text: '' }, action.text);
  return bot.send({
    target: { scope: 'group', targetId: groupId,
      ...(action.mode === 'reply' || always ? { msgId: anchor.messageId } : {}) },
    msgType: 0, content: action.text, extra: { msg_seq: always && action.mode === 'natural' ? 2 : 1 },
  });
}

export function makeTrial({
  inbox, ledger, account, groupId, senderId, start, until, signal,
  always = false, now = Date.now, pollIntervalsMs, plan, startWork, finish, queueWork, send, planWindow, sendWindow,
  readImages, memberMemory, retrieveWork, deliveries, groupName, log = () => {},
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
  const quoteFor = makeGroupQuoteReader(inbox, groupId, deliveries);
  const withQuote = row => {
    const quote = quoteFor(row.messageId);
    return quote ? { ...row, quote } : row;
  };
  const { startedAt } = turnState;
  const allowedSender = always ? null : senderId;
  const active = new Set();
  let routing = 0;
  let budget = always ? Infinity : 6;
  let lastMentionAt = startedAt;
  let lastMentionRow = 0;
  let ambient = false;
  let botReplyTimes = [];
  const isLive = () => !signal?.aborted && now() < until;
  function admitBotReply(event) {
    if (!event.senderIsBot) return true;
    botReplyTimes = botReplyTimes.filter(at => at > now() - 60_000);
    if (botReplyTimes.length >= 2) return false;
    botReplyTimes.push(now());
    return true;
  }
  const record = (event, status, key = event.messageId) => { mark.run(status, event.groupId, key); log(status); return status; };
  function track(promise) {
    const task = promise.finally(() => active.delete(task));
    active.add(task);
  }
  function contextAt(through, beforeMessageId, selection = {}) {
    return readGroupContext(inbox, { ...selection, groupId, through, beforeMessageId, quoteFor });
  }
  async function deliver(event, result) {
    if (!sameSource(event, result?.source) || typeof result?.text !== 'string') return record(event, 'withheld');
    const text = result.text.trim();
    if (!text || text.length > 1800 || /<[^>]+>|\[CQ:|\bNO_REPLY\b/i.test(text.replace(rawMention, '')) ||
      !isLive() || now() - event.at > maxAge) return record(event, 'withheld');
    record(event, 'sending');
    try { return record(event, (await send(event, text))?.id ? 'accepted' : 'uncertain'); }
    catch { return record(event, 'uncertain'); }
  }
  async function route(event) {
    try {
      const unread = turnState.unread(event.at, event.messageId).slice(-12).map(withQuote);
      const recent = contextAt(event.at, event.messageId, { include: turnState.isRead });
      let images = [];
      if (readImages) {
        try { images = await readImages(event.messageId); } catch { log('media_read_failed'); }
      }
      let preferences = [];
      if (memberMemory && !event.senderIsBot) {
        try { preferences = await memberMemory.recall(event); } catch { log('memory_read_unavailable'); }
      }
      let decision;
      try { decision = await plan(event, recent.messages, unread, images, preferences); }
      catch {
        record(event, 'failed');
        if (event.senderIsBot || !isLive() || now() - event.at > maxAge) return;
        try { log((await send(event, qqRouteFailureNotice))?.id ? 'route_notice_sent' : 'route_notice_uncertain'); }
        catch { log('route_notice_uncertain'); }
        return;
      }
      if (!sameSource(event, decision?.source)) { record(event, 'withheld'); return; }
      const related = new Set(Array.isArray(decision.consumedMessageIds) ? decision.consumedMessageIds : []);
      const relatedRows = unread.filter(row => related.has(row.messageId));
      const consumeRelated = () => { if (relatedRows.length) turnState.markRead(relatedRows, now()); };
      if (decision.kind === 'retrieve' && retrieveWork && !event.senderIsBot) {
        const status = await retrieveWork(event);
        if (status === 'not_found') return deliver(event, {
          source: event, text: '我没找到你在这个群里还没送达的成品，可能还在做，也可能已经发过了。',
        });
        if (status === 'retained') return deliver(event, { source: event, text: qqFilePendingNotice });
        return record(event, status);
      }
      if (decision.kind === 'chat') {
        consumeRelated();
        const delivered = await deliver(event, decision);
        if (memberMemory && !event.senderIsBot && delivered === 'accepted') track(Promise.resolve().then(() => memberMemory.observe(event))
          .catch(() => log('memory_write_unavailable')));
      }
      else if (decision.kind === 'work-intent' || decision.kind === 'work') {
        record(event, 'working');
        track(Promise.resolve().then(async () => {
          if (!isLive() || now() - event.at > maxAge) return record(event, 'withheld');
          const context = decision.kind === 'work-intent' && (decision.contextHours != null || decision.contextRange)
            ? contextAt(event.at, event.messageId, { hours: decision.contextHours ?? null, range: decision.contextRange })
            : { messages: [...recent.messages, ...relatedRows.map(row => ({
                speaker: row.senderId, text: row.text.slice(0, 320), at: row.at, quote: row.quote,
              }))].sort((a, b) => a.at - b.at).slice(-12) };
          const selectedImages = workImages(decision, images);
          const request = decision.kind === 'work-intent' ? backgroundRequest(event, decision,
            { ...context, recentDeliveries: event.recentDeliveries }, selectedImages) : null;
          if (queueWork && request) {
            await queueWork(request, selectedImages);
            consumeRelated();
            return record(event, 'queued');
          }
          const job = request ? await startWork(request) : decision;
          if (!sameSource(event, job?.source) || job.kind !== 'work') return record(event, 'withheld');
          consumeRelated();
          const result = await finish(job);
          const coverage = context.coverage;
          const notice = coverage && ('上下文：' + (coverage.hours ? '近 ' + coverage.hours + ' 小时' : '指定时段')
            + (coverage.scanLimited ? '（只检查最近 2000 条记录）' : '') + '收到 ' + coverage.available + ' 条可用文字'
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
    const eligibleAnchor = row => canUseQqReplyAnchor(row?.at, now());
    const events = messages.filter(eligibleAnchor).slice(-24).map(withQuote);
    if (!events.length) {
      turnState.markRead(messages, now(), revision);
      log('window_read_only');
      return;
    }
    const candidates = events.filter(item => !item.addressedElsewhere);
    if (!candidates.length) {
      turnState.markRead(messages, now(), revision);
      return;
    }
    const tail = candidates.at(-1);
    const anchors = new Map(candidates.map(item => [item.messageId, item]));
    const isCurrent = () => isLive() && turnState.isCurrent(revision) && currentMention() === mentionAtStart;
    const context = contextAt(at, undefined, { include: (id, receivedAt) =>
      !anchors.has(id) && (turnState.isRead(id, receivedAt) || !canUseQqReplyAnchor(receivedAt, at)) }).messages
      .map(row => known.get(groupId, row.id) ? { ...row, handled: true } : row);
    ambient = true;
    budget--;
    track(Promise.resolve().then(() => planWindow(events, context, revision,
      deliveries?.recent('group', groupId, at))).then(async actions => {
      if (!Array.isArray(actions) || !isCurrent() || !turnState.markRead(messages, now(), revision)) return;
      for (const action of actions.slice(0, 2)) {
        if (!isCurrent()) break;
        const anchor = action?.mode === 'natural' ? tail : anchors.get(action?.replyToId);
        if (!['natural', 'reply', 'mention'].includes(action?.mode) ||
          !eligibleAnchor(anchor) ||
          typeof action.text !== 'string' || !action.text.trim() || action.text.length > 180 ||
          /[<\r\n]|\[CQ:|[@＠]|\bNO_REPLY\b/i.test(action.text) || !admitBotReply(anchor)) continue;
        const key = 'window:' + tail.messageId + ':' + (action.mode === 'mention' ? 'reply' : action.mode);
        if (!claim.run(groupId, key).changes) continue;
        record(tail, 'sending', key);
        try {
          if (record(tail, (await sendWindow(groupId, action, tail, anchor))?.id ? 'accepted' : 'uncertain', key) !== 'accepted') break;
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
        const event = withQuote({
          channel: 'qqbot', account, groupId, messageId: row.message_id,
          senderId: row.sender_id, mentioned: true, text, at: row.received_at,
          groupName, recentDeliveries: deliveries?.recent('group', groupId, row.received_at),
          ...(row.sender_is_bot ? { senderIsBot: true } : {}),
          ...(row.attachment_count ? { attachmentCount: Math.min(20, row.attachment_count) } : {}),
        });
        turnState.mention(event.at);
        turnState.markRead([event], now());
        if (!text || !admitBotReply(event)) { record(event, 'withheld'); continue; }
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
    const child = execFile(engine, ['exec', '-i', '-u', 'hermes', container,
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
  if (!groupId && (!always || !process.env.LUKE_QQ_GROUP_POLICY)) throw new Error('no verified QQ trial group');
  let senderId;
  if (!always) {
    const senders = inbox.prepare(`SELECT DISTINCT sender_id FROM events WHERE group_id=? AND mentioned=1 AND instr(body,?)>0`)
      .all(groupId, bindPhrase);
    senderId = senders.length === 1 ? senders[0].sender_id : null;
    if (!/^[a-z0-9_-]{1,128}$/i.test(senderId ?? '')) throw new Error('no verified QQ trial sender');
  }
  const { QQBot, ApiError } = await import(pathToFileURL(sdk));
  const appSecret = readQqAppSecret(account, keychainService);
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return this; } };
  const bot = new QQBot({ appId: account, appSecret, logger });
  const configured = process.env.LUKE_QQ_GROUP_POLICY;
  const policyConfig = configured ? JSON.parse(readFileSync(configured, 'utf8')) : undefined;
  const policy = conversationPolicy(policyConfig, { pilotGroup: groupId,
    groupMemory: id => groupMemoryAuthorized(id, process.env.LUKE_HONCHO_APPROVED_GROUPS) });
  const grantImage = source => source.account === account && source.channel === 'qqbot' &&
    (source.chatType === 'direct' ? policy.forDirect(source.senderId) : policy.forGroup(source.groupId)).imageGeneration;
  const withImagen = always && process.env.LUKE_QQ_IMAGEN === '1';
  const origin = process.env.LUKE_HONCHO_ORIGIN;
  const token = process.env.LUKE_HONCHO_TOKEN;
  const socketPath = process.env.LUKE_HONCHO_SOCKET;
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  const workerExec = ['exec', '-i', '-u', 'hermes', worker];
  const kanbanCommand = (args, input, options) => runKanbanCommand(engine, [...workerExec, 'hermes', 'kanban', ...args], input, options);
  if (always) await Promise.all([callRuntime(container, 'health', {}), kanbanCommand(['diagnostics', '--json'])]);
  const tasks = kanbanTasks({ command: kanbanCommand,
    attachFile: file => runKanbanMediaUpload(engine, [...workerExec, 'node'], file),
    exportFiles: (id, rows) => readCompletionFiles(engine, workerExec, id, rows) });
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
  const deliveries = makeDeliveryContext(ledger, account);
  const download = candidates => readQqImages(candidates, { getToken: () => bot.api.getToken(), maxBytes: qqImageBytes });
  const recordSend = async (source, value, operation) => {
    const receipt = await safeSend(operation);
    try { deliveries.remember(source, receipt, value); }
    catch { console.error('qq_delivery_context_write_failed'); }
    return receipt;
  };
  const sendMention = (event, content, seq) => sendMentionReply(bot, event, content, ApiError,
    () => console.log('qq_trial_mention_plain_fallback'), seq);
  const send = (event, content, seq) => recordSend(event, { text: content }, () => sendMention(event, content, seq));
  const sendDirect = (event, content, seq) => recordSend(event, { text: content }, () => bot.send({ target: {
    scope: 'c2c', targetId: event.senderId, msgId: event.messageId,
  }, msgType: 0, content, ...(seq ? { extra: { msg_seq: seq } } : {}) }));
  const acknowledge = ({ source, text }) => {
    return source.chatType === 'direct' ? sendDirect(source, text, 1) : recordSend(source, { text }, () => bot.send({
      target: { scope: 'group', targetId: source.groupId, msgId: source.messageId },
      msgType: 0, content: text, extra: { msg_seq: 1 },
    }));
  };
  const bindings = withImagen ? (() => {
    const directory = join(trialDir, 'artifacts');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const artifacts = imagenReceiptStore(ledger, directory);
    return { directory, artifacts, keepInput: grantImage,
      async readArtifact(key, source) {
        const row = artifacts.lookup(key);
        if (!row) return;
        if (!grantImage(source)) return { note: '当前会话未开放生图。' };
        if (row.status === 'failed') return { note: row.note };
        if (row.status === 'running') return { note: '没有确认收到生图成品，请发一条新消息后再试。' };
        return artifacts.read(key).catch(error => {
          if (error?.code === 'ENOENT') return { note: '那张成品图已经过了保留期，没法补发。' };
          throw error;
        });
      },
      onTerminal: key => artifacts.lookup(key)?.status === 'ready' ? artifacts.remove(key) : undefined,
    };
  })() : {};
  const sendArtifact = (source, artifact, seq, canSend, workKey) => {
    const target = source.chatType === 'direct'
      ? { scope: 'c2c', targetId: source.senderId, msgId: source.messageId }
      : { scope: 'group', targetId: source.groupId, msgId: source.messageId };
    return recordSend(source, { artifact: artifact.format, workKey }, () => sendWorkImage(bot, target, artifact, seq, canSend));
  };
  const deliverFile = ({ source, file, seq, canSend }) => recordSend(source, { text: '附件：' + file.name }, () =>
    sendQqFile(bot, source.chatType === 'direct'
      ? { scope: 'c2c', targetId: source.senderId, msgId: source.messageId }
      : { scope: 'group', targetId: source.groupId, msgId: source.messageId }, file, seq, canSend,
    ({ http, code }) => console.error(`qq_file_upload_rejected http=${http} code=${code}`)));
  const directWork = always && process.env.LUKE_QQ_DIRECT === '1' && process.env.LUKE_QQ_DIRECT_WORK === '1' ? makeKanbanBridge({
    db: ledger, tasks, account, direct: true, ...bindings, onError: phase => console.error('qq_kanban_direct_error phase=' + phase),
  }) : null;
  const directAnchor = directWork ? inbox.prepare('SELECT received_at FROM direct_events WHERE sender_id=? AND message_id=?') : null;
  const canDeliverDirect = source => stop.signal.aborted ? false :
    canUseQqReplyAnchor(directAnchor.get(source.senderId, source.messageId)?.received_at, Date.now()) || 'expired';
  const freshGroupMention = inbox.prepare('SELECT sender_is_bot, received_at FROM events WHERE group_id=? AND message_id=?');
  const freshEnough = at => Number.isSafeInteger(at) && Date.now() - at >= 0 && Date.now() - at < 60_000;
  const directImages = withImagen ? makeDirectImageReader(inbox) : null;
  const direct = always && process.env.LUKE_QQ_DIRECT === '1' ? makeDirectChat({
    inbox, ledger, account, start, deliveries, signal: stop.signal,
    memoryFor: sender => {
      if (!origin || !token || !policy.forDirect(sender).memory) return;
      try { return makeMemberMemory({ origin, token, socketPath, account, directSender: sender }); }
      catch { console.error('qq_direct_memory_config_invalid'); }
    },
    readImages: directImages && (event => grantImage(event) ?
      download(directImages(event.senderId, event.messageId)) : []),
    plan: (event, context, preferences, images) => callRuntime(container, 'direct', {
      event, context, preferences, images, allowWork: Boolean(directWork), imageGeneration: Boolean(directWork) && withImagen && grantImage(event),
    }),
    queueWork: directWork?.enqueue,
    retrieveWork: directWork && (source => directWork.retrieve(source, { canDeliver: canDeliverDirect, deliverFile,
      deliver: ({ source, text, artifact, receiptKey }) => artifact
        ? sendArtifact(source, artifact, 1, () => canDeliverDirect(source) === true, receiptKey) : sendDirect(source, text, 1) })),
    send: sendDirect,
    log: status => console.log('qq_direct_' + status),
  }) : null;
  function makeGroup(groupId) {
    const grants = policy.forGroup(groupId);
    const groupRules = policy.rulesForGroup(groupId);
    const groupName = policy.nameForGroup(groupId);
    const quoteFor = makeGroupQuoteReader(inbox, groupId, deliveries);
    const imagesFor = makeGroupImageReader(inbox, groupId, { verified: withImagen && grants.imageGeneration });
    let memberMemory;
    if (always && origin && token && grants.memory) {
      try { memberMemory = makeMemberMemory({ origin, token, socketPath, account, groupId }); }
      catch { console.error('qq_trial_memory_config_invalid'); }
    }
    const bridge = always ? makeKanbanBridge({ db: ledger, tasks, account, groupId, ...bindings,
      onError: phase => console.error('qq_kanban_error phase=' + phase) }) : null;
    const canDeliver = qqReceiptPolicy(inbox, { account, groupId, signal: stop.signal });
    const trial = makeTrial({
      inbox, ledger, account, groupId, groupName, deliveries, senderId, start, until, always, signal: stop.signal,
      plan: (event, context, unread, images, preferences) =>
        callRuntime(container, 'trial-plan', { events: [event], context, unread, images, preferences,
          imageGeneration: withImagen && grantImage(event), groupRules }),
      memberMemory,
      readImages: messageId => download(imagesFor(messageId)),
      startWork: decision => callRuntime(worker, 'trial-start', { decision }),
      finish: job => callRuntime(worker, 'trial-settle', { job }),
      queueWork: bridge?.enqueue,
      retrieveWork: bridge && (source => bridge.retrieve(source, { canDeliver, deliverFile,
        deliver: ({ source, text, artifact, receiptKey }) => artifact
          ? sendArtifact(source, artifact, 1, () => canDeliver(source) === true, receiptKey) : send(source, text, 1) })),
      planWindow: grants.freeReply ? (events, context, attempt, recentDeliveries) => callRuntime(container, 'trial-window',
        { events, context, attempt, groupRules, groupName, recentDeliveries }) : undefined,
      sendWindow: (to, action, tail, anchor) => recordSend(tail, { text: action.text }, () => sendAmbientReply(
        { bot, sendMention, always }, { groupId: to, action, tail, anchor })),
      send,
      log: status => console.log('qq_trial_' + status),
    });
    return { trial, bridge, canDeliver, quoteFor };
  }
  const initialGroups = always && configured ? [groupId, ...policy.groupIds].filter(Boolean) : [groupId];
  const groups = new Map([...new Set(initialGroups)].map(id => [id, makeGroup(id)]));
  const recentGroups = inbox.prepare('SELECT DISTINCT group_id FROM events WHERE mentioned=1 AND received_at > ?');
  const closeImagen = withImagen ? await (() => {
    const find = ledger.prepare(`SELECT r.key,r.source,m.images,m.valid_until FROM kanban_receipts r
      LEFT JOIN kanban_input_media m USING(key) WHERE r.card_id=? AND r.state='watching'`);
    deliveries.readLegacyArtifacts();
    return serveImagen({ directory: join(root, '..', 'imagen-ipc'), run: imagenJobs({
      ...bindings, allowed: source => !stop.signal.aborted && grantImage(source), getTask(id) {
        const row = find.get(id);
        if (!row) return;
        const source = JSON.parse(row.source);
        return { key: row.key, source, quote: groups.get(source.groupId)?.quoteFor(source.messageId),
          images: row.valid_until > Date.now() ? JSON.parse(row.images) : [] };
      },
    }) });
  })() : null;
  let nextDiscovery = 0;
  let sweep;
  let nextSweep = start;
  let nextPrune = start;
  console.log('qq_trial_ready mode=' + (always ? 'always' : 'bounded'));
  try {
    while (!stop.signal.aborted && Date.now() < until) {
      if (always && configured && Date.now() >= nextDiscovery) {
        nextDiscovery = Date.now() + 5_000;
        for (const row of recentGroups.all(Date.now() - maxAge)) {
          if (groups.size < 64 && !groups.has(row.group_id)) groups.set(row.group_id, makeGroup(row.group_id));
        }
      }
      for (const { trial } of groups.values()) trial.tick();
      direct?.tick();
      if (always && !sweep && Date.now() >= nextSweep) {
        nextSweep = Date.now() + 5_000;
        const receipts = [...groups.values()].map(({ bridge, canDeliver }) => bridge.sweep({
          canDeliver,
          canAcknowledge: source => {
            const row = freshGroupMention.get(source.groupId, source.messageId);
            return canDeliver(source) === true && row?.sender_is_bot === 0 && freshEnough(row.received_at);
          },
          acknowledge,
          deliverFile,
          deliver: async ({ source, text, artifact, seq, receiptKey }) => {
            const receipt = artifact ? await sendArtifact(source, artifact, seq, () => canDeliver(source) === true, receiptKey)
              : await send(source, text, seq);
            console.log('qq_kanban_' + (receipt?.id ? 'accepted' : 'uncertain'));
            return receipt;
          },
        }));
        if (directWork) receipts.push(directWork.sweep({
          canDeliver: canDeliverDirect,
          canAcknowledge: source => canDeliverDirect(source) === true &&
            freshEnough(directAnchor.get(source.senderId, source.messageId)?.received_at),
          acknowledge,
          deliverFile,
          deliver: ({ source, text, artifact, seq, receiptKey }) => artifact
            ? sendArtifact(source, artifact, seq, () => canDeliverDirect(source) === true, receiptKey) : sendDirect(source, text, seq),
        }));
        if (Date.now() >= nextPrune) {
          nextPrune = Date.now() + 3_600_000;
          deliveries.prune();
          if (bindings.artifacts) receipts.push(bindings.artifacts.prune(Date.now() - 86_400_000));
        }
        sweep = Promise.all(receipts).catch(() => console.error('qq_kanban_sweep_failed')).finally(() => { sweep = null; });
      }
      await delay(700, undefined, { signal: stop.signal });
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    await Promise.all([...groups.values()].map(({ trial }) => trial.drain()).concat(direct?.drain()));
    await sweep;
    await closeImagen?.();
    await bot.stop();
    inbox.close();
    ledger.close();
  }
}

if (import.meta.main) main().catch(() => {
  console.error('qq_trial_failed');
  process.exitCode = 1;
});
