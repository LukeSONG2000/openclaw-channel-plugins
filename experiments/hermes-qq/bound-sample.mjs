import { DatabaseSync } from 'node:sqlite';
import { readGroupWindow } from './inbox-view.mjs';

export function boundSample(db, account, now = Date.now()) {
  const binding = db.prepare('SELECT group_id FROM group_binding WHERE singleton = 1').get();
  if (!binding?.group_id) throw new Error('no verified test group');
  const groupId = binding.group_id;
  const latest = db.prepare('SELECT MAX(received_at) AS at FROM events WHERE group_id = ?').get(groupId)?.at;
  if (!Number.isSafeInteger(latest) || latest > now || now - latest > 86_400_000) return { events: [] };
  const events = readGroupWindow(db, { account, groupId, after: latest - 120_000, through: latest });
  return { events: events.filter(row => !row.mentioned).slice(-8) };
}

if (import.meta.main) {
  const [file, account] = process.argv.slice(2);
  if (!file || !account) throw new Error('usage: bound-sample.mjs <inbox.sqlite> <test-account>');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const sample = boundSample(db, account);
    if (!sample.events.length) throw new Error('no recent ordinary messages in the verified test group');
    process.stdout.write(JSON.stringify(sample));
  } finally { db.close(); }
}
