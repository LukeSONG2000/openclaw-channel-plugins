import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { confirmCrossGroupMember, qqMemberIdentity } from './member-identity.mjs';

test('the same QQ account and sender map to one person, with different group memory partitions', () => {
  const event = { account: 'testbot', senderId: 'same-id', groupId: 'previous', displayName: 'Alice' };
  const original = qqMemberIdentity(event);
  const renamed = qqMemberIdentity({ ...event, groupId: 'new', displayName: 'Bob' });
  assert.equal(renamed.peerId, original.peerId);
  assert.notEqual(renamed.workspaceId, original.workspaceId);
  assert.notEqual(qqMemberIdentity({ ...event, senderId: 'different' }).peerId, original.peerId);
  assert.notEqual(qqMemberIdentity({ ...event, account: 'r2' }).peerId, original.peerId);
});

test('confirmation requires one new mention and an earlier same-ID mention in the bound group', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = 10;
  const receiver = inbox(db, { mode: 'bound-group', challenge: 'fixture', now: () => clock });
  const base = { kind: 'group', senderId: 'same-id', rawEventType: 'GROUP_AT_MESSAGE_CREATE' };
  receiver.record({ ...base, groupOpenid: 'old', content: 'fixture', messageId: 'bind' });
  const intake = inbox(db, { mode: 'all-groups', now: () => clock });
  const add = (id, opts = {}) => {
    clock++;
    return intake.record({ ...base, groupOpenid: 'new', content: '<@bot> hello', messageId: id, ...opts });
  };
  const confirm = () => confirmCrossGroupMember(db, { account: 'testbot', message: 'hello', since: 10, now: clock });
  add('no-at', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  assert.throws(confirm, /exactly one/);
  add('spoof', { senderId: 'different' });
  assert.throws(confirm, /no earlier mention/);
  db.prepare('DELETE FROM events WHERE message_id = ?').run('spoof');
  add('confirmed', { rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: true }] });
  const proof = confirm();
  assert.equal(proof.peerId, qqMemberIdentity({ account: 'testbot', senderId: 'same-id', groupId: 'old' }).peerId);
  assert.deepEqual(proof.observed.map(x => x.at), [10, 13]);
  assert.equal(new Set(proof.observed.map(x => x.workspaceId)).size, 2);
  assert.doesNotMatch(JSON.stringify(proof), /same-id|hello|admin/);
  add('ambiguous');
  assert.throws(confirm, /exactly one/);
});
