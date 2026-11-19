export function readGroupWindow(db, { account, groupId, after, through }) {
  if (typeof account !== 'string' || !account || typeof groupId !== 'string' || !groupId
    || !Number.isSafeInteger(after) || !Number.isSafeInteger(through) || through <= after) {
    throw new Error('invalid QQ window selection');
  }
  return db.prepare(`
    SELECT message_id, sender_id, mentioned, body FROM events
    WHERE group_id = ? AND received_at > ? AND received_at <= ?
    ORDER BY received_at DESC, rowid DESC LIMIT 24
  `).all(groupId, after, through).reverse().map(row => ({
    channel: 'qqbot', account, groupId, messageId: row.message_id,
    senderId: row.sender_id, mentioned: row.mentioned === 1, text: row.body,
  }));
}
