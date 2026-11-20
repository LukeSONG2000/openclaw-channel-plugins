export const groupHistoryMs = 24 * 3_600_000;
const hour = 3_600_000;
const bucketCount = 12;
const perBucket = 6;
const timestamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function selectRows(db, { groupId, after, through, beforeMessageId = null, ordinaryOnly = false, limit }) {
  return db.prepare(`
    SELECT message_id, sender_id, mentioned, received_at, body FROM events
    WHERE group_id = ? AND received_at > ? AND received_at <= ?
      AND (? IS NULL OR rowid < (SELECT rowid FROM events WHERE group_id = ? AND message_id = ?))
      AND (? = 0 OR (mentioned = 0 AND length(trim(body)) > 0))
    ORDER BY received_at DESC, rowid DESC LIMIT ?
  `).all(groupId, after, through, beforeMessageId, groupId, beforeMessageId, ordinaryOnly ? 1 : 0, limit).reverse();
}

export function readGroupWindow(db, { account, groupId, after, through, beforeMessageId, ordinaryOnly, limit = 24 }) {
  if (typeof account !== 'string' || !account || typeof groupId !== 'string' || !groupId
    || !Number.isSafeInteger(after) || !Number.isSafeInteger(through) || through <= after
    || !Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw new Error('invalid QQ window selection');
  }
  return selectRows(db, { groupId, after, through, beforeMessageId, ordinaryOnly, limit }).map(row => ({
    channel: 'qqbot', account, groupId, messageId: row.message_id,
    senderId: row.sender_id, mentioned: row.mentioned === 1, text: row.body, at: row.received_at,
  }));
}

function excerpt(body) {
  const text = body
    .replace(/<[^>]+>|https?:\/\/[^\s<>]+|\bsk-[\w-]{10,}|\b[0-9a-f]{32,}\b/giu, ' ')
    .replace(/\s+/gu, ' ').trim();
  if (!text || text.startsWith('/') ||
    /\u5bc6\u7801|\u5bc6\u94a5|\u9a8c\u8bc1\u7801|access[_ -]?token|api[_ -]?key|app[_ -]?secret|\bBearer\s+\S+/iu.test(text)) return '';
  const chars = [...text].slice(0, 140);
  while (JSON.stringify(chars.join('')).length > 180) chars.length -= 12;
  return chars.join('');
}

export function readGroupContext(db, { groupId, through, beforeMessageId, hours = null, include }) {
  if (typeof groupId !== 'string' || !groupId || !Number.isSafeInteger(through) ||
    (hours !== null && (!beforeMessageId || !Number.isInteger(hours) || hours < 1 || hours > 24))) {
    throw new Error('invalid QQ context selection');
  }
  const start = through - (hours ?? 24) * hour;
  const rows = selectRows(db, {
    groupId, after: start - 1, through, beforeMessageId, limit: hours === null && !include ? 8 : 2000,
  }).filter(row => !include || include(row.message_id, row.received_at));
  if (hours === null) {
    return { messages: rows.slice(-8).map(row => ({
      id: row.message_id, at: row.received_at, speaker: row.sender_id.slice(0, 60), text: row.body.slice(0, 320),
    })) };
  }
  const buckets = Array.from({ length: bucketCount }, () => []);
  let available = 0;
  for (const row of rows) {
    const text = excerpt(row.body);
    if (!text) continue;
    const bucket = Math.min(bucketCount - 1, Math.floor((row.received_at - start) * bucketCount / (hours * hour)));
    buckets[bucket].push({ row, text });
    available++;
  }
  const speakers = new Map();
  const messages = buckets.flatMap(bucket => bucket.length <= perBucket ? bucket
    : Array.from({ length: perBucket }, (_, i) => bucket[Math.floor(i * (bucket.length - 1) / (perBucket - 1))]))
    .map(({ row, text }) => {
      if (!speakers.has(row.sender_id)) speakers.set(row.sender_id, 'member-' + (speakers.size + 1));
      return { at: timestamp.format(row.received_at), speaker: speakers.get(row.sender_id), text };
    });
  return {
    messages,
    coverage: { hours, available, sampled: messages.length, timeZone: 'UTC+08:00', receivedTextOnly: true },
  };
}
