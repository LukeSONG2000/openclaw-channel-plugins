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
