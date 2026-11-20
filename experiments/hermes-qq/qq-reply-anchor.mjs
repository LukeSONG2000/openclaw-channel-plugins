const passiveWindowMs = 295_000;

export function canUseQqReplyAnchor(receivedAt, now) {
  const age = now - receivedAt;
  return Number.isSafeInteger(receivedAt) && age >= 0 && age < passiveWindowMs;
}

export function qqReceiptPolicy(inbox, { account, groupId, signal, now = Date.now }) {
  const lookup = inbox.prepare('SELECT sender_id, received_at FROM events WHERE group_id=? AND message_id=? AND mentioned=1');
  return source => {
    if (signal?.aborted) return false;
    if (source.channel !== 'qqbot' || source.account !== account || source.groupId !== groupId) return 'expired';
    const row = lookup.get(groupId, source.messageId);
    return row?.sender_id === source.senderId && canUseQqReplyAnchor(row?.received_at, now()) ? true : 'expired';
  };
}
