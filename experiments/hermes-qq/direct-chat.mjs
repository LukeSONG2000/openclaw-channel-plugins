import { qqRouteFailureNotice } from './pilot.mjs';
import { qqFilePendingNotice } from './qq-attachments.mjs';

const maxAge = 180_000;

export function groupMemoryAuthorized(groupId, approvals = '') {
  return typeof groupId === 'string' && /^[a-z0-9_-]{1,256}$/i.test(groupId) &&
    approvals.split(',').map(v => v.trim()).includes(groupId);
}

export function makeDirectChat({ inbox, ledger, account, start, signal, plan, send, queueWork, retrieveWork, memoryFor, readImages,
  deliveries, now = Date.now, log = () => {} }) {
  ledger.exec(`CREATE TABLE IF NOT EXISTS direct_receipts (
    account TEXT NOT NULL, sender_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (account, sender_id, message_id)
  )`);
  const claim = ledger.prepare('INSERT OR IGNORE INTO direct_receipts VALUES (?, ?, ?, ?)');
  const prune = ledger.prepare('DELETE FROM direct_receipts WHERE at < ?');
  const batch = inbox.prepare(`SELECT rowid, * FROM direct_events WHERE received_at >= ? AND received_at <= ?
    AND rowid > ? ORDER BY rowid LIMIT 32`);
  const history = inbox.prepare(`SELECT body FROM direct_events WHERE sender_id = ? AND rowid < ?
    AND received_at >= ? AND received_at <= ? ORDER BY rowid DESC LIMIT 6`);
  const pending = new Map();
  let rowid = 0;
  let prunedAt = 0;
  async function reply(row, event) {
    const memory = memoryFor?.(event.senderId);
    let preferences = [];
    try { if (memory) preferences = await memory.recall(event); } catch { log('memory_read_unavailable'); }
    const context = history.all(event.senderId, row.rowid, row.received_at - 86_400_000, row.received_at)
      .reverse().map(item => item.body.slice(0, 320));
    if (!event.text.trim()) return;
    let images = [];
    try { if (readImages) images = await readImages(event); } catch { log('media_read_failed'); }
    let result;
    try { result = await plan(event, context, preferences, images); }
    catch {
      log('failed');
      if (!signal?.aborted && now() - row.received_at <= maxAge) {
        try { log((await send(event, qqRouteFailureNotice))?.id ? 'route_notice_sent' : 'route_notice_uncertain'); }
        catch { log('route_notice_uncertain'); }
      }
      return;
    }
    const matches = result?.source?.chatType === 'direct' &&
      ['channel', 'account', 'senderId', 'messageId'].every(k => result.source[k] === event[k]);
    if (result?.kind === 'retrieve') {
      if (retrieveWork && matches && !signal?.aborted) {
        const status = await retrieveWork(event);
        if (!signal?.aborted && now() - row.received_at <= maxAge) {
          if (status === 'not_found') await send(event, '我没找到你还没收到的成品，可能还在做，也可能已经发过了。');
          if (status === 'retained') await send(event, qqFilePendingNotice);
        }
      }
      return;
    }
    if (result?.kind === 'work-request') {
      if (queueWork && !signal?.aborted && matches) {
        await queueWork(result, images);
        log('queued');
      }
      return;
    }
    const text = typeof result === 'string' ? result.trim() : '';
    if (!text || /<[^>]+>|\[CQ:|\bNO_REPLY\b/i.test(text) || signal?.aborted || now() - row.received_at > maxAge) return;
    const receipt = await send(event, text.slice(0, 500));
    if (receipt?.id) {
      log('accepted');
      try { await memory?.observe(event); } catch { log('memory_write_unavailable'); }
    }
  }
  return {
    tick() {
      const at = now();
      if (signal?.aborted) return;
      if (at - prunedAt > 60_000) { prune.run(at - 86_400_000); prunedAt = at; }
      for (const row of batch.all(Math.max(start, at - maxAge), at, rowid)) {
        if (pending.size >= 3 || pending.has(row.sender_id)) break;
        rowid = row.rowid;
        if (!claim.run(account, row.sender_id, row.message_id, at).changes) continue;
        const event = { channel: 'qqbot', chatType: 'direct', account, senderId: row.sender_id,
          messageId: row.message_id, text: row.body, attachmentCount: row.has_media,
          recentDeliveries: deliveries?.recent('direct', row.sender_id, row.received_at) };
        pending.set(event.senderId, reply(row, event).catch(() => log('failed'))
          .finally(() => pending.delete(event.senderId)));
      }
    },
    async drain() { while (pending.size) await Promise.all(pending.values()); },
  };
}
