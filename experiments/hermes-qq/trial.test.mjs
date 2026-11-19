import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { makeTrial, trialInput } from './trial.mjs';

const groupId = 'test-group';
const senderId = 'test-author';
const clock = 5_000;

function setup(t, handlers) {
  const db = new DatabaseSync(':memory:');
  const ledger = new DatabaseSync(':memory:');
  t.after(() => { db.close(); ledger.close(); });
  const intake = inbox(db, { mode: 'all-groups', now: () => clock });
  const parameters = {
    inbox: db, ledger, account: 'luke', groupId, senderId, start: clock - 1, until: clock + 10_000,
    now: () => clock, ...handlers,
  };
  return {
    trial: () => makeTrial(parameters),
    put: (messageId, content, changes = {}) => intake.record({
      kind: 'group', groupOpenid: groupId, senderId, rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      messageId, content, ...changes,
    }),
    status: () => ledger.prepare('SELECT state FROM trial_receipts ORDER BY rowid').all().map(row => row.state),
  };
}

test('trial input strips transport mentions without activating unmarked chat', () => {
  assert.equal(trialInput('<@!TOKEN> [Hermes] hi'), 'hi');
  assert.equal(trialInput('@Luke [Hermes] hi'), 'hi');
  assert.equal(trialInput('quote [Hermes] hi'), '');
});

test('a later mention replies before a separate work run settles, with no replay after restart', async t => {
  const sent = [];
  let finishWork;
  const pending = new Promise(resolve => { finishWork = resolve; });
  const data = setup(t, {
    plan: async event => ({ kind: event.text === 'task' ? 'work' : 'chat', source: event, text: 'answer' }),
    finish: async job => { await pending; return { source: job.source, text: 'report' }; },
    send: async event => { sent.push(event.messageId); return { id: 'ok' }; },
  });
  data.put('job', '[Hermes] task');
  data.put('unmarked', 'not a trial');
  data.put('other-group', '[Hermes] hi', { groupOpenid: 'other' });
  data.put('other-author', '[Hermes] hi', { senderId: 'other' });
  data.put('not-mentioned', '[Hermes] hi', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  const trial = data.trial();
  await trial.tick();
  assert.deepEqual(sent, []);
  data.put('ping', '[Hermes] hi');
  await trial.tick();
  assert.deepEqual(sent, ['ping']);
  finishWork();
  await trial.drain();
  assert.deepEqual(sent, ['ping', 'job']);
  assert.deepEqual(data.status(), ['accepted', 'accepted']);
  await data.trial().tick();
  assert.deepEqual(sent, ['ping', 'job']);
});

test('an uncertain send and a mismatched source never cause a retry or wrong-target send', async t => {
  let attempted = 0;
  const data = setup(t, {
    plan: async event => ({ kind: 'chat', source: event.text === 'wrong' ? { ...event, groupId: 'other' } : event, text: 'answer' }),
    send: async () => { attempted++; throw new Error('network outcome unknown'); },
  });
  data.put('uncertain', '[Hermes] hello');
  data.put('wrong', '[Hermes] wrong');
  await data.trial().tick();
  await data.trial().tick();
  assert.equal(attempted, 1);
  assert.deepEqual(data.status(), ['uncertain', 'withheld']);
});
