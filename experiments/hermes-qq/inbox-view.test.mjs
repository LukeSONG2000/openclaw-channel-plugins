import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { groupHistoryMs, makeGroupImageReader, makeGroupQuoteReader, readGroupContext } from './inbox-view.mjs';

test('range reads never cross the retention horizon, request anchor or future', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 10_000;
  const receiver = inbox(db, { mode: 'all-groups', now: () => now });
  const record = (messageId, content) => receiver.record({
    kind: 'group', groupOpenid: 'test', senderId: 'speaker', rawEventType: 'GROUP_MESSAGE_CREATE', messageId, content,
  });
  record('first', 'first at the retention horizon');
  now += groupHistoryMs;
  record('prior', 'before the anchor, at the same time');
  record('anchor', 'the request');
  record('after', 'received after the anchor');
  const read = range => readGroupContext(db, { groupId: 'test', through: now, beforeMessageId: 'anchor', range });
  const { messages, coverage } = read({ start: 0, end: now + 6000 });
  assert.deepEqual(messages.map(row => row.text), ['first at the retention horizon', 'before the anchor, at the same time']);
  assert.deepEqual(coverage.selected, { start: 10_000, end: now });
  assert.deepEqual(coverage.requested, { start: 0, end: now + 6000 });
  const future = read({ start: now + 1, end: now + 2 });
  assert.deepEqual(future.messages, []);
  assert.equal(future.coverage.selected, null);
  assert.throws(() => readGroupContext(db, {
    groupId: 'test', through: now, range: { start: 0, end: now },
  }), /invalid QQ context selection/);
});

test('quotes are scoped to a group, preserve receive order and do not require the original event', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 10_000;
  const receiver = inbox(db, { mode: 'all-groups', now: () => now });
  const put = (messageId, changes, quote) => receiver.record({
    kind: 'group', groupOpenid: 'test', senderId: 'speaker', rawEventType: 'GROUP_MESSAGE_CREATE',
    messageId, ...changes,
  }, quote);
  put('other-source', { groupOpenid: 'other', msgIdx: 'same-index', content: 'Never disclose this' });
  put('local-source', { msgIdx: 'same-index', content: 'Our source text' });
  put('cited', { refMsgIdx: 'same-index' });
  put('outside', { refMsgIdx: 'other-source' });
  put('embedded', { refMsgIdx: 'not-in-inbox' }, {
    refKey: 'not-in-inbox', source: 'msg_elements', rawContent: 'Pushed with the reply',
    attachments: [{ contentType: 'image/png', url: 'https://example.test/private' }],
  });
  put('wrong-push', { refMsgIdx: 'missing' }, { refKey: 'wrong', source: 'msg_elements', rawContent: 'Wrong quote' });
  put('future-quote', { refMsgIdx: 'late-idx' });
  put('late-source', { msgIdx: 'late-idx', content: 'Received after its quote' });
  put('image-only-ref', { refMsgIdx: 'only-image' }, {
    refKey: 'only-image', source: 'msg_elements', attachments: [{ contentType: 'image/png' }],
  });
  const quote = makeGroupQuoteReader(db, 'test');
  assert.deepEqual(quote('cited'), { availability: 'received', text: 'Our source text' });
  assert.deepEqual(quote('embedded'), { availability: 'received', text: 'Pushed with the reply', attachmentCount: 1 });
  for (const id of ['outside', 'wrong-push', 'future-quote']) assert.deepEqual(quote(id), { availability: 'unavailable' });
  assert.deepEqual(quote('image-only-ref'), { availability: 'received', attachmentCount: 1 });
  assert.equal(quote('other-source'), undefined);
  assert.equal(quote('local-source'), undefined);
  now += 86_400_001;
  receiver.prune();
  assert.equal(db.prepare('SELECT count(*) AS n FROM event_quotes').get().n, 0);
});

test('direct and quoted image sources use the verified group and expire with their events', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 12_000;
  const receiver = inbox(db, { mode: 'bound-group', challenge: 'bind-test', now: () => now });
  const binding = { kind: 'group', groupOpenid: 'test', senderId: 'speaker',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: 'bind-test', messageId: 'handshake' };
  receiver.record(binding);
  const all = inbox(db, { mode: 'all-groups', now: () => now });
  const url = name => 'https://gchat.qpic.cn/' + name;
  const attachments = name => [{ content_type: 'image/png', url: url(name) }];
  const add = (id, options, quote) => all.record({
    ...binding, rawEventType: 'GROUP_MESSAGE_CREATE', messageId: id, ...options,
  }, quote);
  add('separate', { groupOpenid: 'other', msgIdx: 'other-idx', attachments: attachments('outside') });
  add('original', { msgIdx: 'image-idx', attachments: attachments('original') });
  add('reply', { refMsgIdx: 'image-idx', attachments: attachments('reply') });
  add('cross-group', { refMsgIdx: 'other-idx' });
  add('pushed', { refMsgIdx: 'push-only' }, { refKey: 'push-only', source: 'msg_elements', attachments: attachments('pushed') });
  assert.equal(db.prepare("SELECT count(*) AS n FROM event_images WHERE group_id='other'").get().n, 0);
  const read = makeGroupImageReader(db, 'test');
  assert.deepEqual(read('reply'), [{ origin: 'current', locator: url('reply') }, { origin: 'quote', locator: url('original') }]);
  assert.deepEqual(read('cross-group'), []);
  assert.deepEqual(read('pushed'), [{ origin: 'quote', locator: url('pushed') }]);
  now += 86_400_001;
  all.prune();
  assert.equal(db.prepare('SELECT count(*) AS n FROM event_images').get().n, 0);
});
