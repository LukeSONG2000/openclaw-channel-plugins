export const groupHistoryMs = 24 * 3_600_000;
const hour = 3_600_000;
const bucketCount = 12;
const perBucket = 6;
const extendedScanLimit = 2000;
const timestamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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

function excerpt(body, maxChars = 140, jsonLimit = 180) {
  const text = body
    .replace(/<[^>]+>|https?:\/\/[^\s<>]+|\bsk-[\w-]{10,}|\b[0-9a-f]{32,}\b/giu, ' ')
    .replace(/\s+/gu, ' ').trim();
  if (!text || text.startsWith('/') ||
    /\u5bc6\u7801|\u5bc6\u94a5|\u9a8c\u8bc1\u7801|access[_ -]?token|api[_ -]?key|app[_ -]?secret|\bBearer\s+\S+/iu.test(text)) return '';
  const chars = [...text].slice(0, maxChars);
  while (JSON.stringify(chars.join('')).length > jsonLimit) chars.length -= 12;
  return chars.join('');
}

function prepareQuoteLookup(db) {
  return db.prepare(`
    SELECT q.quoted_text AS pushed_text, q.quoted_attachments AS pushed_attachments,
           source.message_id AS source_id, source.body AS source_text, source.attachment_count AS source_attachments
    FROM events AS current
    JOIN event_quotes AS q USING (group_id, message_id)
    LEFT JOIN events AS source ON source.rowid = coalesce((
      SELECT candidate.rowid FROM events AS candidate
      WHERE candidate.group_id = current.group_id AND candidate.message_id = q.quoted_index
        AND (candidate.received_at, candidate.rowid) < (current.received_at, current.rowid)
    ), (
      SELECT candidate.rowid FROM event_quotes AS ref
      JOIN events AS candidate USING (group_id, message_id)
      WHERE candidate.group_id = current.group_id
        AND ref.group_id = current.group_id AND ref.message_index = q.quoted_index
        AND (candidate.received_at, candidate.rowid) < (current.received_at, current.rowid)
      ORDER BY candidate.received_at DESC, candidate.rowid DESC
      LIMIT 1
    ))
    WHERE current.group_id = ? AND current.message_id = ? AND q.quoted_index IS NOT NULL
  `);
}

export function makeGroupQuoteReader(db, groupId) {
  const select = prepareQuoteLookup(db);
  return messageId => {
    const row = select.get(groupId, messageId);
    if (!row) return;
    const text = excerpt(row.source_text || row.pushed_text || '', 600, 800);
    const attachmentCount = Math.min(20, Math.max(row.pushed_attachments, row.source_attachments ?? 0));
    return {
      availability: text || attachmentCount ? 'received' : 'unavailable',
      ...(text ? { text } : {}),
      ...(attachmentCount ? { attachmentCount } : {}),
    };
  };
}

export function makeGroupImageReader(db, groupId) {
  const quote = prepareQuoteLookup(db);
  const select = db.prepare(`
    SELECT locator FROM event_images JOIN group_binding USING (group_id)
    WHERE group_id = ? AND message_id = ? AND origin = ? ORDER BY position
  `);
  const list = (id, origin) => select.all(groupId, id, origin).map(row => row.locator);
  return messageId => {
    const current = list(messageId, 'current');
    let quoted = list(messageId, 'quote');
    if (!quoted.length) {
      const source = quote.get(groupId, messageId)?.source_id;
      if (source) quoted = list(source, 'current');
    }
    const unique = new Set();
    const images = [];
    for (let i = 0; i < Math.max(current.length, quoted.length) && images.length < 2; i++) {
      for (const [origin, locator] of [['current', current[i]], ['quote', quoted[i]]]) {
        if (!locator || unique.has(locator) || images.length >= 2) continue;
        unique.add(locator);
        images.push({ origin, locator });
      }
    }
    return images;
  };
}

export function readGroupContext(db, { groupId, through, beforeMessageId, hours = null, range, include, quoteFor }) {
  const extended = hours !== null || range !== undefined;
  if (typeof groupId !== 'string' || !groupId || !Number.isSafeInteger(through) ||
    (extended && (typeof beforeMessageId !== 'string' || !beforeMessageId)) ||
    (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 24)) ||
    (range !== undefined && (hours !== null || !Number.isSafeInteger(range?.start) ||
      !Number.isSafeInteger(range.end) || range.start > range.end))) {
    throw new Error('invalid QQ context selection');
  }
  const requested = range ?? { start: through - (hours ?? 24) * hour, end: through };
  const start = Math.max(through - groupHistoryMs, requested.start);
  const end = Math.min(through, requested.end);
  const rows = start > end ? [] : selectRows(db, {
    groupId, after: start - 1, through: end, beforeMessageId,
    limit: extended ? extendedScanLimit + 1 : include ? extendedScanLimit : 8,
  });
  if (!extended) {
    return { messages: rows.filter(row => !include || include(row.message_id, row.received_at)).slice(-8).map(row => ({
      id: row.message_id, at: row.received_at, speaker: row.sender_id.slice(0, 60), text: row.body.slice(0, 320),
      quote: quoteFor?.(row.message_id),
    })) };
  }
  const buckets = Array.from({ length: bucketCount }, () => []);
  let available = 0;
  const scanLimited = rows.length > extendedScanLimit;
  const scanned = rows.slice(-extendedScanLimit);
  for (const row of scanned) {
    const text = excerpt(row.body);
    if (!text) continue;
    const bucket = Math.floor((row.received_at - start) * bucketCount / (end - start + 1));
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
    coverage: {
      ...(hours !== null ? { hours } : {}), requested,
      selected: start <= end ? { start, end } : null,
      ...(scanned.length ? { observed: { first: scanned[0].received_at, last: scanned.at(-1).received_at } } : {}),
      scanLimited, available, sampled: messages.length, timeZone: 'UTC+08:00', receivedTextOnly: true,
    },
  };
}
