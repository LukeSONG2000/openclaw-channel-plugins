import { createHash } from 'node:crypto';

function key(kind, ...parts) {
  if (!parts.every(v => typeof v === 'string' && /^[a-z0-9_-]{1,256}$/iu.test(v))) {
    throw new Error('invalid QQ identity field');
  }
  return 'qq-' + kind + '-' + createHash('sha256')
    .update(JSON.stringify(['luke-qq-identity-v1', kind, ...parts])).digest('hex').slice(0, 40);
}

export function qqMemberIdentity({ account, senderId, groupId }) {
  return {
    peerId: key('member', account, senderId),
    workspaceId: key('group', account, groupId),
  };
}

export function confirmCrossGroupMember(db, { account, message, now = Date.now(), since }) {
  if (typeof message !== 'string' || !message.trim() || !Number.isSafeInteger(since) ||
    !Number.isSafeInteger(now) || since > now || now - since > 3_600_000) {
    throw new Error('invalid QQ identity verification window');
  }
  const bound = db.prepare('SELECT group_id FROM group_binding WHERE singleton = 1').get()?.group_id;
  if (!bound) throw new Error('no previously verified QQ group');
  const candidates = db.prepare(`SELECT group_id, sender_id, body, received_at FROM events
    WHERE group_id != ? AND mentioned = 1 AND received_at >= ? AND received_at <= ?
    ORDER BY received_at DESC, rowid DESC`).all(bound, since, now)
    .filter(row => row.body.replace(/<@!?[^>]+>/g, '').trim() === message.trim());
  if (candidates.length !== 1) throw new Error('QQ identity requires exactly one matching recent mention');
  const event = candidates[0];
  const old = db.prepare(`SELECT received_at FROM events WHERE group_id = ? AND sender_id = ?
    AND mentioned = 1 AND received_at < ? ORDER BY received_at DESC, rowid DESC LIMIT 1`)
    .get(bound, event.sender_id, event.received_at);
  if (!old) throw new Error('no earlier mention under the same QQ sender in the verified group');

  const current = qqMemberIdentity({ account, senderId: event.sender_id, groupId: event.group_id });
  const previous = qqMemberIdentity({ account, senderId: event.sender_id, groupId: bound });
  return { peerId: current.peerId, observed: [
    { workspaceId: previous.workspaceId, at: old.received_at },
    { workspaceId: current.workspaceId, at: event.received_at },
  ] };
}
