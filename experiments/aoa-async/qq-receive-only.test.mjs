import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from './qq-receive-only.mjs';

const challenge = 'AOA-TEST1234';
const sample = (overrides = {}) => ({
  kind: 'group', groupOpenid: 'test-group', senderId: 'tester', messageId: 'plain',
  rawEventType: 'GROUP_MESSAGE_CREATE', content: '2', ...overrides,
});

test('the receive-only inbox binds exactly one group with an actual mention and never changes it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const receiver = inbox(db, { challenge });
    assert.equal(receiver.record(sample({ content: challenge })), false);
    assert.equal(receiver.record(sample({
      kind: 'c2c', rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: challenge,
    })), false);
    assert.equal(receiver.record(sample({
      senderIsBot: true, rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: challenge,
    })), false);
    assert.equal(receiver.record(sample({
      messageId: 'bind', mentions: [{ is_you: true }], content: '@Luke ' + challenge,
    })), true);
    assert.equal(receiver.record(sample({ attachments: [{ url: 'should-not-be-stored' }] })), true);
    assert.equal(receiver.record(sample()), false);
    const afterRestart = inbox(db, { challenge });
    assert.equal(afterRestart.record(sample({
      messageId: 'other-group', groupOpenid: 'other', rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: challenge,
    })), false);
    assert.deepEqual(db.prepare('SELECT mentioned, attachment_count FROM events ORDER BY rowid').all()
      .map(row => [row.mentioned, row.attachment_count]), [[1, 0], [0, 1]]);
  } finally { db.close(); }
});

test('the rolling inbox expires content without forgetting the bound group', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let time = 100;
    const receiver = inbox(db, { challenge, now: () => time });
    receiver.record(sample({ messageId: 'bind', rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: challenge }));
    time += 86_400_001;
    receiver.prune();
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
    assert.equal(receiver.record(sample()), true);
  } finally { db.close(); }
});

test('all-groups needs no handshake and keeps the same platform ID separate across groups', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const receiver = inbox(db, { mode: 'all-groups' });
    assert.equal(receiver.record(sample()), true);
    assert.equal(receiver.record(sample({ groupOpenid: 'second-group' })), true);
    assert.equal(receiver.record(sample({ kind: 'c2c', messageId: 'dm' })), false);
    assert.equal(receiver.record(sample({ senderIsBot: true, messageId: 'bot' })), true);
    assert.equal(receiver.record(sample({ rawEventType: 'GROUP_ADD_ROBOT', messageId: 'lifecycle' })), false);
    assert.equal(receiver.record(sample()), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 3);
    assert.equal(db.prepare('SELECT count(*) AS n FROM group_binding').get().n, 0);
  } finally { db.close(); }
});

test('structured mention targets win over event type and bots remain identifiable', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const receiver = inbox(db, { mode: 'all-groups' });
    const rawEventType = 'GROUP_AT_MESSAGE_CREATE';
    receiver.record(sample({ messageId: 'other', rawEventType, mentions: [{ is_you: false }] }));
    receiver.record(sample({ messageId: 'self', rawEventType, senderIsBot: true,
      mentions: [{ is_you: false }, { is_you: true }] }));
    assert.deepEqual(db.prepare('SELECT mentioned, sender_is_bot, addressed_elsewhere FROM events ORDER BY rowid')
      .all().map(row => Object.values(row)), [[0, 0, 1], [1, 1, 0]]);
  } finally { db.close(); }
});

test('migration preserves earlier messages and assigns them to their original bound group', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE group_binding (singleton INTEGER PRIMARY KEY, group_id TEXT NOT NULL);
      INSERT INTO group_binding VALUES (1, 'original-group');
      CREATE TABLE events (message_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, received_at INTEGER NOT NULL,
        event_type TEXT NOT NULL, mentioned INTEGER NOT NULL, body TEXT NOT NULL, attachment_count INTEGER NOT NULL);
      CREATE INDEX events_received_at ON events(received_at);
      INSERT INTO events VALUES ('existing', 'tester', 100, 'GROUP_MESSAGE_CREATE', 0, 'previous', 0);
    `);
    const receiver = inbox(db, { mode: 'all-groups', now: () => 101 });
    assert.equal(db.prepare('SELECT group_id FROM events WHERE body = ?').get('previous').group_id, 'original-group');
    assert.equal(receiver.record(sample()), true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
  } finally { db.close(); }
});
