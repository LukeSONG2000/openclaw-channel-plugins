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
  let time = clock;
  const intake = inbox(db, { mode: 'all-groups', now: () => time });
  const parameters = {
    inbox: db, ledger, account: 'luke', groupId, senderId, start: clock - 1, until: clock + 10_000,
    now: () => time, ...handlers,
  };
  return {
    trial: () => makeTrial(parameters),
    advance: ms => { time += ms; },
    put: (messageId, content, changes = {}) => intake.record({
      kind: 'group', groupOpenid: groupId, senderId, rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      messageId, content, ...changes,
    }),
    status: () => ledger.prepare('SELECT state FROM trial_receipts ORDER BY rowid').all().map(row => row.state),
  };
}

test('trial input preserves natural chat and strips only transport mentions and the optional old prefix', () => {
  assert.equal(trialInput('<@!TOKEN> [Hermes] hi'), 'hi');
  assert.equal(trialInput('@Luke [Hermes] hi'), 'hi');
  assert.equal(trialInput('quote [Hermes] hi'), 'quote [Hermes] hi');
  assert.equal(trialInput('@Luke hello'), 'hello');
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
  data.put('job', 'task');
  data.put('other-group', '[Hermes] hi', { groupOpenid: 'other' });
  data.put('other-author', '[Hermes] hi', { senderId: 'other' });
  data.put('not-mentioned', '[Hermes] hi', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  const trial = data.trial();
  await trial.tick();
  assert.deepEqual(sent, []);
  data.put('ping', 'hi');
  await trial.tick();
  assert.deepEqual(sent, ['ping']);
  finishWork();
  await trial.drain();
  assert.deepEqual(sent, ['ping', 'job']);
  assert.deepEqual(data.status(), ['accepted', 'accepted']);
  await data.trial().tick();
  assert.deepEqual(sent, ['ping', 'job']);
});

test('plain chat opens one same-group window, with natural and source-targeted delivery', async t => {
  const sent = [];
  const data = setup(t, {
    windowMs: 2000,
    planWindow: async rows => {
      assert.deepEqual(rows.map(e => e.messageId), ['other-plain', 'tester-plain']);
      return [{ mode: 'natural', text: 'a' }, { mode: 'reply', replyToId: 'other-plain', text: 'b' }];
    },
    sendWindow: async (to, action) => { sent.push({ to, ...action }); return { id: 'ok' }; },
  });
  const trial = data.trial();
  data.put('other-plain', 'B', { senderId: 'other', rawEventType: 'GROUP_MESSAGE_CREATE' });
  await trial.tick();
  data.put('tester-plain', 'A', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('cross', 'C', { groupOpenid: 'other', rawEventType: 'GROUP_MESSAGE_CREATE' });
  await trial.tick();
  assert.deepEqual(sent, []);
  data.advance(2000);
  await trial.tick();
  await trial.drain();
  assert.deepEqual(sent, [
    { to: groupId, mode: 'natural', text: 'a' },
    { to: groupId, mode: 'reply', replyToId: 'other-plain', text: 'b' },
  ]);
  await trial.tick();
  assert.equal(sent.length, 2);
});

test('a later mention bypasses a pending window and cancels its proposed reply', async t => {
  let finishWindow;
  const window = new Promise(resolve => { finishWindow = resolve; });
  const sent = [];
  const data = setup(t, {
    windowMs: 2000, planWindow: () => window,
    sendWindow: async () => { sent.push('window'); return { id: 'ok' }; },
    plan: async event => ({ kind: 'chat', source: event, text: 'answer' }),
    send: async () => { sent.push('mention'); return { id: 'ok' }; },
  });
  const trial = data.trial();
  data.put('plain', 'A', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.advance(2000);
  await trial.tick();
  data.advance(1);
  data.put('ping', 'hi');
  await trial.tick();
  assert.deepEqual(sent, ['mention']);
  finishWindow([{ mode: 'natural', text: 'late' }]);
  await trial.drain();
  assert.deepEqual(sent, ['mention']);
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
