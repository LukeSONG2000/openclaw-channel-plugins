import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { boundSample } from './bound-sample.mjs';
import { readGroupWindow } from './inbox-view.mjs';
import { hermesPilot, hermesRuns } from './pilot.mjs';

const event = (messageId, text, overrides = {}) => ({
  channel: 'qqbot', account: 'test-bot', groupId: 'group-one', senderId: 'speaker-one',
  messageId, text, mentioned: false, ...overrides,
});

test('the bridge namespaces groups and jobs without implementing a task runner', async () => {
  const requests = [];
  const fast = {
    async start(request) { requests.push(request); return 'fast'; },
    async wait() { return '{"route":"work","text":"a report"}'; },
  };
  const work = {
    async start(request) { requests.push(request); return 'job'; },
    async wait() { return 'done'; },
  };
  const pilot = hermesPilot({ fast, work });
  const job = await pilot.mention(event('same-id', 'report', { mentioned: true }));
  const other = await pilot.mention(event('same-id', 'report', { mentioned: true, groupId: 'group-two' }));
  assert.notEqual(requests[0].sessionId, requests[1].sessionId);
  assert.notEqual(requests[1].sessionId, requests[3].sessionId);
  assert.notEqual(job.sessionId, other.sessionId);
  assert.equal((await pilot.settle(job)).source.groupId, 'group-one');
  await assert.rejects(pilot.settle({ ...job, source: { ...job.source, groupId: 'group-two' } }), /source mismatch/);
  await assert.rejects(pilot.window([event('a', 'a'), event('b', 'b', { groupId: 'group-two' })]), /one group/);
  assert.equal(requests.length, 4);
  const sameGroup = await pilot.mention(event('new-id', 'report', { mentioned: true }));
  assert.notEqual(requests[0].sessionId, requests[4].sessionId);
  assert.notEqual(sameGroup.sessionId, job.sessionId);
});

test('the API client only accepts the local gateway', () => {
  for (const origin of ['https://outside.example', 'http://localhost:8642', 'http://127.0.0.1/x']) {
    assert.throws(() => hermesRuns({ origin, token: 'fixture' }), /invalid local Hermes endpoint/);
  }
});

test('a request can cross independent runner processes only with its original work session', async () => {
  const calls = [];
  const classifier = hermesPilot({ fast: {
    async start() { calls.push('chat'); return 'route'; },
    async wait() { return '{"route":"work","text":"organize this discussion"}'; },
  } });
  const worker = hermesPilot({ fast: {
    async start(request) { calls.push(request.sessionId); return 'job'; },
    async wait() { return 'organized'; },
  } });
  const source = event('task', '整理一下群内的话题', { mentioned: true });
  const request = JSON.parse(JSON.stringify(await classifier.planMention(source)));
  assert.deepEqual(calls, ['chat']);
  await assert.rejects(worker.startWork({ ...request, source: { ...request.source, groupId: 'elsewhere' } }), /mismatch/);
  await assert.rejects(worker.startWork({ ...request, request: { ...request.request, requestKey: 'other' } }), /mismatch/);
  const job = await worker.startWork(request);
  const result = await worker.settle(job);
  assert.deepEqual(calls, ['chat', job.sessionId]);
  assert.equal(result.source.messageId, source.messageId);
  assert.equal(result.text, 'organized');
});

test('a failed or malformed inference is not reported as a deliberate silent decision', async () => {
  const input = [event('ordinary', 'A')];
  const withAnswer = wait => hermesPilot({ fast: { start: async () => 'fast', wait } });
  await assert.rejects(withAnswer(async () => { throw new Error('provider failed'); }).window(input), /provider failed/);
  await assert.rejects(withAnswer(async () => '{"unrelated":1}').window(input), /invalid Hermes window decision/);
  assert.deepEqual(await withAnswer(async () => '{"natural":null,"reply":null}').window(input), []);
});

function recordedWindow(rows) {
  const db = new DatabaseSync(':memory:');
  try {
    const receiver = inbox(db, { mode: 'all-groups', now: () => 42 });
    for (const row of rows) receiver.record({
      rawEventType: row.mentioned ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
      kind: 'group', groupOpenid: row.groupId, senderId: row.senderId,
      messageId: row.messageId, content: row.text,
    });
    return readGroupWindow(db, { account: 'test-bot', groupId: 'group-one', after: 41, through: 42 });
  } finally { db.close(); }
}

test('read-only input reuses the QQ receipt schema but scopes the selected group', () => {
  const plain = event('ordinary', 'A');
  const mention = event('mention', '@Luke', { mentioned: true, senderId: 'speaker-two' });
  const other = event('different', 'not in this group', { groupId: 'group-two' });
  assert.deepEqual(recordedWindow([plain, other, mention]), [plain, mention]);
});

test('live samples require a previously verified group and omit old or mentioned inputs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 1;
    const receiver = inbox(db, { challenge: 'AOA-TEST1234', now: () => now });
    assert.throws(() => boundSample(db, 'test-bot', now), /verified test group/);
    const put = (messageId, content, rawEventType) => receiver.record({
      kind: 'group', groupOpenid: 'group-one', senderId: 'speaker-one',
      messageId, content, rawEventType,
    });
    put('bind', 'AOA-TEST1234', 'GROUP_AT_MESSAGE_CREATE');
    put('old', 'old', 'GROUP_MESSAGE_CREATE');
    now = 120_002;
    put('new', 'new', 'GROUP_MESSAGE_CREATE');
    put('direct', '@bot', 'GROUP_AT_MESSAGE_CREATE');
    assert.deepEqual(boundSample(db, 'test-bot', now).events.map(e => e.messageId), ['new']);
    assert.deepEqual(boundSample(db, 'test-bot', now + 86_400_001), { events: [] });
  } finally { db.close(); }
});

test('real Hermes: a QQ window chooses two replies and another @ completes before the job', {
  skip: !process.env.HERMES_QQ_FIXTURE_ORIGIN, timeout: 90_000,
}, async () => {
  const api = hermesRuns({ origin: process.env.HERMES_QQ_FIXTURE_ORIGIN, token: 'hermes-qq-fixture-only' });
  const pilot = hermesPilot({ fast: api });
  const unique = Date.now().toString();
  const input = topic => event(unique + '-' + topic, topic);
  const actions = await pilot.window(recordedWindow(['A1', 'A2', 'B1', 'B2', 'A3', 'C1', 'C2', 'A4', 'A5'].map(input)));
  assert.deepEqual(actions, [
    { mode: 'natural', text: 'A is worth a look.' },
    { mode: 'reply', replyToId: unique + '-B1', text: 'B is at seven.' },
  ]);
  const task = event(unique + '-ask', 'make a report', { mentioned: true });
  const job = await pilot.mention(task);
  assert.equal(job.kind, 'work');
  const quick = await pilot.mention(event(unique + '-ping', 'are you there?', { mentioned: true }));
  assert.equal(quick.kind, 'chat');
  assert.equal(quick.text, "I'm here.");
  assert.notEqual((await api.status(job.runId)).status, 'completed');
  const result = await pilot.settle(job);
  assert.equal(result.source.messageId, task.messageId);
  assert.equal(result.text, 'The background report is ready.');
  const duplicate = await pilot.mention(task);
  assert.equal(duplicate.runId, job.runId);
  assert.equal((await pilot.settle(duplicate)).receiptKey, result.receiptKey);
});
