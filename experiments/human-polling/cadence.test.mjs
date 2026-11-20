import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { makeHumanPolling } from './cadence.mjs';

test('cadence does not read before its deadline and invalidates an earlier poll on a mention', t => {
  const ledger = new DatabaseSync(':memory:');
  t.after(() => ledger.close());
  const group = makeHumanPolling({ ledger, account: 'test', groupId: 'one', start: 0 });
  assert.equal(group.poll(59_999, () => assert.fail('must not inspect unread early')), undefined);
  const snapshot = group.poll(60_000, () => ['unread']);
  assert.deepEqual(snapshot.messages, ['unread']);
  group.mention(71_000);
  assert.equal(group.isCurrent(snapshot.revision), false);
  assert.equal(group.poll(130_999, () => assert.fail('must use the new anchor')), undefined);
  assert.deepEqual(group.poll(131_000, () => []).messages, []);
});

test('cadence state is independent by scope and survives recreation', t => {
  const ledger = new DatabaseSync(':memory:');
  t.after(() => ledger.close());
  const make = (account, start = 0) => makeHumanPolling({ ledger, account, groupId: 'same', start });
  const first = make('one');
  const other = make('two');
  const empty = first.poll(60_000, () => []);
  const restored = make('one', 70_000);
  assert.equal(restored.startedAt, 0);
  assert.equal(restored.isCurrent(empty.revision), true);
  assert.equal(restored.poll(70_000, () => assert.fail('backoff lost')), undefined);
  assert.ok(other.poll(70_000, () => ['available']));
});
