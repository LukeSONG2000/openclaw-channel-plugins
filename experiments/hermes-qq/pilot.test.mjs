import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { boundSample } from './bound-sample.mjs';
import { readGroupWindow } from './inbox-view.mjs';
import { backgroundRequest, hermesPilot, hermesRuns } from './pilot.mjs';

test('any mention can use native image blocks and no CDN locator enters the request', async () => {
  const picture = 'data:image/png;base64,iVBORw0KGgo=';
  const event = { channel: 'qqbot', account: 'fixture', groupId: 'synthetic', messageId: 'quote',
    senderId: 'speaker', mentioned: true, text: 'What is shown?', quote: { availability: 'received', attachmentCount: 1 } };
  const pilot = hermesPilot({ fast: {
    async start({ input }) {
      assert.equal(input[0].role, 'user');
      assert.match(input[0].content[0].text, /"visibleImages":1/);
      assert.deepEqual(input[0].content.slice(1), [
        { type: 'text', text: 'Image from the cited message:' },
        { type: 'image_url', image_url: { url: picture } },
      ]);
      return 'run_image';
    },
    async wait() { return '{"route":"chat","text":"A cup."}'; },
  } });
  assert.equal((await pilot.planMention(event, [], [], [{ origin: 'quote', dataUrl: picture }])).text, 'A cup.');
  await assert.rejects(pilot.planMention(event, [], [], [{ origin: 'quote', dataUrl: 'https://cdn.example.test/url' }]),
    /invalid image for Hermes/);
});
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
  const intent = await classifier.planMention(source);
  assert.equal(intent.contextHours, null);
  const request = JSON.parse(JSON.stringify(backgroundRequest(source, intent, { messages: [] })));
  assert.deepEqual(calls, ['chat']);
  await assert.rejects(worker.startWork({ ...request, source: { ...request.source, groupId: 'elsewhere' } }), /mismatch/);
  await assert.rejects(worker.startWork({ ...request, request: { ...request.request, requestKey: 'other' } }), /mismatch/);
  const job = await worker.startWork(request);
  const result = await worker.settle(job);
  assert.deepEqual(calls, ['chat', job.sessionId]);
  assert.equal(result.source.messageId, source.messageId);
  assert.equal(result.text, 'organized');
});

test('any work intent can ask the host for bounded context, not a different group', async () => {
  const source = event('trace', '找一下我们今天为什么决定换场地', { mentioned: true });
  const withAnswer = answer => hermesPilot({ fast: { start: async () => 'route', wait: async () => answer } });
  const extended = '{"route":"work","text":"trace the venue decision","contextHours":24}';
  assert.equal((await withAnswer(extended).planMention(source)).contextHours, 24);
  await assert.rejects(withAnswer(extended).mention(source), /requires the conversation adapter/);
  for (const answer of ['{"route":"work","text":"trace","contextHours":25}',
    '{"route":"work","text":"trace","contextHours":6,"groupId":"other"}',
    '{"route":"chat","text":"hello","contextHours":6}']) {
    await assert.rejects(withAnswer(answer).planMention(source), /invalid mention route/);
  }
});

test('calendar requests use the event clock and validate offset-aware intervals', async () => {
  const source = event('calendar', 'Summarize the conversation since local midnight', {
    mentioned: true, at: Date.parse('2026-11-20T15:30:00+08:00'),
  });
  const from = '2026-11-20T00:00:00+08:00', to = '2026-11-20T07:30:00Z';
  const plan = fields => hermesPilot({ fast: {
    async start({ input }) {
      const { current } = JSON.parse(input.split('\n').at(-1));
      assert.equal(Date.parse(current.receivedAt), source.at);
      assert.equal(current.localDate, '2026-11-20');
      return 'route';
    },
    async wait() { return JSON.stringify({ route: 'work', text: 'Summarize the period', ...fields }); },
  } }).planMention(source);
  const intent = await plan({ contextRange: { from, to } });
  assert.deepEqual(intent.contextRange, { start: Date.parse(from), end: Date.parse(to) });
  assert.deepEqual((await plan({ contextRange: { from, to: 'message' } })).contextRange, intent.contextRange);
  for (const fields of [
    { contextRange: { from: '2026-11-20T00:00:00', to } },
    { contextRange: { from: '2026-02-30T00:00:00Z', to } },
    { contextRange: { from: to, to: from } },
    { contextRange: { from, to, groupId: 'elsewhere' } },
    { contextRange: { from, to }, contextHours: 4 },
  ]) await assert.rejects(plan(fields), /invalid mention route/);
});

test('mention decisions can consume only local unread anchors from the supplied window', async () => {
  const source = event('ask', 'Tell me more', { mentioned: true });
  const pilot = hermesPilot({ fast: {
    async start({ input }) {
      const payload = JSON.parse(input.split('\n').at(-1));
      assert.deepEqual(payload.unread.map(row => row.text), ['topic A', 'topic B']);
      return 'route';
    },
    async wait() { return '{"route":"chat","text":"answer","related":["m1","m1","remote","m3"]}'; },
  } });
  const decision = await pilot.planMention(source, [], [
    event('a', 'topic A'), event('b', 'topic B'), event('secret', 'elsewhere', { groupId: 'elsewhere' }),
  ]);
  assert.deepEqual(decision.consumedMessageIds, ['a']);
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
  assert.deepEqual(recordedWindow([plain, other, mention]), [{ ...plain, at: 42 }, { ...mention, at: 42 }]);
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
