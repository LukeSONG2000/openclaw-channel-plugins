import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { groupMemoryAuthorized, makeDirectChat } from './direct-chat.mjs';
import { qqDirectIdentity, qqMemberIdentity } from './member-identity.mjs';
import { makeMemberMemory } from './member-memory.mjs';

test('group memory requires an exact operator approval; private and group identity partitions differ', async () => {
  assert.equal(groupMemoryAuthorized('one'), false);
  assert.equal(groupMemoryAuthorized('one', 'another,*'), false);
  assert.equal(groupMemoryAuthorized('one', 'one,another'), true);
  const direct = { chatType: 'direct', channel: 'qqbot', account: 'luke', senderId: 'alice' };
  const ids = qqDirectIdentity(direct);
  assert.notEqual(ids.workspaceId, qqDirectIdentity({ ...direct, senderId: 'bob' }).workspaceId);
  assert.notEqual(ids.workspaceId, qqMemberIdentity({ ...direct, groupId: 'one' }).workspaceId);
  const memory = makeMemberMemory({ origin: 'http://127.0.0.1', token: 'fixture', account: 'luke',
    directSender: 'alice', fetchImpl: async url => {
      assert.ok(url.pathname.includes(ids.workspaceId));
      return Response.json({ items: [
        { observed_id: ids.peerId, observer_id: 'luke', content: 'private preference' },
      ] });
    } });
  assert.deepEqual(await memory.recall(direct), ['private preference']);
  await assert.rejects(memory.recall({ ...direct, senderId: 'bob' }), /outside/);
  await assert.rejects(memory.recall({ ...direct, groupId: 'one' }), /outside/);
});

test('native private events reply without @ or memory availability, without crossing users or replaying', async () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new DatabaseSync(':memory:');
  try {
    let now = 100;
    const input = inbox(db, { mode: 'all-groups', enableDirect: true, now: () => now });
    const put = (senderId, messageId, content, options) => input.record({
      kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId, messageId, content, ...options,
    });
    assert.equal(put('alice', 'fake', 'not a QQ private event', { rawEventType: 'DIRECT_MESSAGE_CREATE' }), false);
    assert.equal(put('alice', 'previous', 'Alice private history'), true);
    assert.equal(put('bob', 'previous', 'Bob private history'), true);
    now++;
    assert.equal(put('alice', 'current', 'Hello'), true);
    assert.equal(put('alice', 'current', 'Hello'), false);
    assert.equal(put('bob', 'current', 'Hello'), true);
    const replies = [];
    const writes = [];
    const make = () => makeDirectChat({ inbox: db, ledger, account: 'luke', start: now, now: () => now,
      memoryFor: () => ({
        async recall() { throw new Error('Honcho unavailable'); },
        async observe(event) { writes.push(event.senderId); },
      }),
      async plan(event, context, preferences) {
        assert.deepEqual(context, [event.senderId === 'alice' ? 'Alice private history' : 'Bob private history']);
        assert.deepEqual(preferences, []);
        return 'Hello back';
      },
      async send(event, text) { replies.push(event.senderId); assert.equal(text, 'Hello back'); return { id: 'ok' }; },
    });
    const first = make();
    first.tick();
    await first.drain();
    const restarted = make();
    restarted.tick();
    await restarted.drain();
    assert.deepEqual(replies.sort(), ['alice', 'bob']);
    assert.deepEqual(writes.sort(), replies);
  } finally { ledger.close(); db.close(); }
});
