import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inbox } from '../aoa-async/qq-receive-only.mjs';
import { makeKanbanBridge } from './kanban.mjs';
import { makeTrial, sendMentionReply, trialInput } from './trial.mjs';
import { qqReceiptPolicy } from './qq-reply-anchor.mjs';

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
    db, ledger,
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
  assert.equal(trialInput('<@LukeBot> <@!other-person> 你是谁'), '<@!other-person> 你是谁');
});

class TestApiError extends Error {
  constructor(code, httpStatus = 403) {
    super('platform rejected the request');
    this.bizCode = code;
    this.httpStatus = httpStatus;
    this.path = '/v2/groups/' + groupId + '/messages';
  }
}

test('an explicit mention uses the QQ Markdown interaction element; a confirmed denial falls back without raw IDs', async () => {
  const calls = [];
  const event = { groupId, senderId, messageId: 'trigger' };
  const bot = { async send(body) {
    calls.push(body);
    if (calls.length === 1) throw new TestApiError(40034127);
    return { id: 'ok' };
  } };
  assert.deepEqual(await sendMentionReply(bot, event, 'here', TestApiError), { id: 'ok' });
  const target = { scope: 'group', targetId: groupId, msgId: 'trigger' };
  assert.deepEqual(calls, [
    { target, msgType: 2, markdown: { content: '<qqbot-at-user id="test-author" /> here' }, extra: { msg_seq: 1 } },
    { target, msgType: 0, content: 'here', extra: { msg_seq: 1 } },
  ]);
});

test('the mention sender never falls back on a timeout, a server error, or deduplication', async () => {
  let calls = 0;
  const event = { groupId, senderId, messageId: 'trigger' };
  for (const error of [new Error('timeout'), new TestApiError(304036, 500), new TestApiError(40054005, 400)]) {
    await assert.rejects(sendMentionReply({ async send() { calls++; throw error; } }, event, 'here', TestApiError), error);
  }
  assert.equal(calls, 3);
});

test('a group summary keeps its last sentence when sent with a native mention', async () => {
  const calls = [];
  const event = { groupId, senderId: 'a'.repeat(32), messageId: 'trigger' };
  const first = '群'.repeat(71) + '。';
  const rest = '这次没有实质性的讨论主题。';
  const prefix = '<qqbot-at-user id="' + event.senderId + '" /> ';
  const bot = { async send(body) {
    calls.push(body);
    return { id: 'accepted-' + body.extra.msg_seq };
  } };
  assert.deepEqual(await sendMentionReply(bot, event, first + rest, TestApiError), { id: 'accepted-2' });
  assert.deepEqual(calls, [
    { target: { scope: 'group', targetId: groupId, msgId: 'trigger' }, msgType: 2,
      markdown: { content: prefix + first }, extra: { msg_seq: 1 } },
    { target: { scope: 'group', targetId: groupId, msgId: 'trigger' }, msgType: 0,
      content: rest, extra: { msg_seq: 2 } },
  ]);
  assert.equal(Buffer.byteLength(calls[0].markdown.content) <= 280, true);
});

test('continuations preserve UTF-8 text and keep a compound emoji intact', async () => {
  const calls = [];
  const event = { groupId, senderId: 'a'.repeat(32), messageId: 'trigger' };
  const emoji = '\u{1f469}\u200d\u{1f4bb}';
  const first = '文'.repeat(73);
  const content = first + emoji + '续'.repeat(750) + '。';
  const bot = { async send(body) { calls.push(body); return { id: 'ok' }; } };
  await sendMentionReply(bot, event, content, TestApiError);
  const [head, ...tail] = calls;
  assert.equal(head.markdown.content.split(' /> ')[1], first);
  assert.equal(tail[0].content.startsWith(emoji), true);
  assert.equal(tail.every(part => Buffer.byteLength(part.content) <= 1800), true);
  assert.deepEqual(calls.map(call => call.extra.msg_seq), [1, 2, 3]);
  assert.equal(first + tail.map(part => part.content).join(''), content);
});

test('an unconfirmed continuation is not retried or followed by further parts', async () => {
  const calls = [];
  const event = { groupId, senderId, messageId: 'trigger' };
  const bot = { async send(body) {
    calls.push(body.extra.msg_seq);
    return calls.length === 1 ? { id: 'ok' } : {};
  } };
  assert.deepEqual(await sendMentionReply(bot, event, '长'.repeat(1400), TestApiError), {});
  assert.deepEqual(calls, [1, 2]);
});

test('a verified mention stays native in a continuation without pinging an invented ID', async t => {
  const sent = [];
  const first = '文'.repeat(75) + '。';
  const data = setup(t, {
    plan: async event => ({ kind: 'chat', source: event, text: event.text === 'unsafe'
      ? '<qqbot-at-user id="other-person" />' : first + '我不认识<@!other-person>和<@invented>。' }),
    send: (event, text) => sendMentionReply({
      async send(body) { sent.push(body); return { id: 'accepted' }; },
    }, event, text, TestApiError),
  });
  data.put('report', '<@LukeBot> 你问问 <@!Other-Person> 是谁');
  data.put('unsafe', 'unsafe');
  const trial = data.trial();
  trial.tick();
  await trial.drain();
  assert.deepEqual(data.status(), ['accepted', 'withheld']);
  assert.deepEqual(sent.map(body => body.markdown?.content ?? body.content), [
    '<qqbot-at-user id="test-author" /> ' + first,
    '我不认识<qqbot-at-user id="Other-Person" />和那位群友。',
  ]);
});

test('known recipients can be mentioned in the same bubble as the sender', async () => {
  const event = { groupId, senderId, messageId: 'trigger', text: 'ask <@person>' };
  const calls = [];
  await sendMentionReply({ async send(body) { calls.push(body); return { id: 'ok' }; } }, event,
    'Hey <@person>, who are you?', TestApiError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].markdown.content, '<qqbot-at-user id="test-author" /> Hey <qqbot-at-user id="person" />, who are you?');
});

test('a later mention replies before a separate work run settles, with no replay after restart', async t => {
  const sent = [];
  let finishWork;
  const pending = new Promise(resolve => { finishWork = resolve; });
  const data = setup(t, {
    plan: async event => event.text === 'task'
      ? { kind: 'work-intent', source: event, brief: 'a report', contextHours: null }
      : { kind: 'chat', source: event, text: 'answer' },
    startWork: async request => ({ kind: 'work', source: request.source }),
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

test('a slow intent decision does not block a later natural mention', async t => {
  let releaseRouting;
  const blocked = new Promise(resolve => { releaseRouting = resolve; });
  let sawQuick;
  const quick = new Promise(resolve => { sawQuick = resolve; });
  const sent = [];
  const data = setup(t, {
    plan: async event => {
      if (event.text === 'slow') { await blocked; return { kind: 'work', source: event }; }
      return { kind: 'chat', source: event, text: 'here' };
    },
    finish: async job => ({ source: job.source, text: 'finished' }),
    send: async event => {
      sent.push(event.messageId);
      if (event.messageId === 'quick') sawQuick();
      return { id: 'ok' };
    },
  });
  const trial = data.trial();
  data.put('slow', 'slow');
  trial.tick();
  data.put('quick', 'quick');
  trial.tick();
  await quick;
  assert.deepEqual(sent, ['quick']);
  releaseRouting();
  await trial.drain();
  assert.deepEqual(sent, ['quick', 'slow']);
});

test('the durable work adapter receives normal context without replacing quick replies', async t => {
  const ledger = new DatabaseSync(':memory:');
  t.after(() => ledger.close());
  const tasks = {
    async create({ input }) {
      assert.match(input, /previous topic/);
      return 't_12345678';
    },
    async read() { return { status: 'done', result: 'finished research' }; },
  };
  const bridge = makeKanbanBridge({ db: ledger, tasks, account: 'luke', groupId });
  const sent = [];
  const data = setup(t, {
    queueWork: bridge.enqueue,
    plan: async event => event.text === 'task'
      ? { kind: 'work-intent', source: event, brief: 'research it', contextHours: null, consumedMessageIds: ['context'] }
      : { kind: 'chat', source: event, text: 'here' },
    send: async event => { sent.push(event.messageId); return { id: 'quick-receipt' }; },
  });
  data.put('context', 'previous topic', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('job', 'task');
  data.put('ping', 'hello');
  const trial = data.trial();
  trial.tick();
  await trial.drain();
  assert.deepEqual(data.status(), ['queued', 'accepted']);
  assert.deepEqual(sent, ['ping']);
  const transport = {
    canDeliver: source => source.groupId === groupId && source.senderId === senderId,
    deliver: async ({ source }) => { sent.push(source.messageId); return { id: 'work-receipt' }; },
  };
  await bridge.sweep(transport);
  await bridge.sweep(transport);
  assert.deepEqual(sent, ['ping', 'job']);
});

test('always mode accepts more than six turns from any member of only the bound group', async t => {
  const sent = [];
  const data = setup(t, {
    always: true, until: Infinity,
    plan: async event => ({ kind: 'chat', source: event, text: 'here' }),
    send: async event => { sent.push(event.messageId); return { id: 'accepted' }; },
  });
  data.put('another-group', 'ignore', { groupOpenid: 'other' });
  const trial = data.trial();
  for (let i = 0; i < 8; i++) {
    data.advance(60_000);
    data.put('turn-' + i, 'hello', { senderId: 'member-' + i });
    trial.tick();
    await trial.drain();
  }
  assert.deepEqual(sent, Array.from({ length: 8 }, (_, i) => 'turn-' + i));
});

test('a delayed receipt requires a recent original mention from the same QQ account and group', t => {
  const data = setup(t, {});
  data.put('request', 'research');
  const source = { channel: 'qqbot', account: 'luke', groupId, senderId, messageId: 'request' };
  const check = (age, overrides) => qqReceiptPolicy(data.db, {
    account: 'luke', groupId, now: () => clock + age,
  })({ ...source, ...overrides });
  assert.equal(check(294_999), true);
  assert.equal(check(295_000), 'expired');
  assert.equal(check(0, { account: 'r2' }), 'expired');
  assert.equal(check(0, { groupId: 'other' }), 'expired');
  assert.equal(check(0, { senderId: 'other' }), 'expired');
});

test('tracing a decision uses older context only from the source group', async t => {
  let started;
  const replies = [];
  const data = setup(t, {
    start: 3_600_000,
    until: 3_700_000,
    plan: async (event, context, unread) => {
      assert.equal(unread.length, 12);
      assert.equal(unread.some(row => row.text === 'earlier discussion'), false);
      assert.equal(context.some(row => row.text === 'earlier discussion'), true);
      return { kind: 'work-intent', source: event, brief: 'trace the original decision', contextHours: 1 };
    },
    startWork: async request => { started = request; return { kind: 'work', source: request.source }; },
    finish: async job => ({ source: job.source, text: 'report' }),
    send: async (event, text) => { replies.push({ id: event.messageId, text }); return { id: 'ok' }; },
  });
  data.put('early', 'earlier discussion', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('cross-group', 'private other-group topic', { groupOpenid: 'other' });
  data.advance(3_595_001);
  for (let i = 0; i < 12; i++) data.put('recent-' + i, 'new topic ' + i, { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('credential', 'API Key: synthetic-secret', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('trace', '为什么我们说要换地方？');
  data.put('same-time-later', 'posted after the request', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  const trial = data.trial();
  trial.tick();
  await trial.drain();
  assert.ok(started);
  assert.match(started.request.input, /earlier discussion/);
  const { current, context } = JSON.parse(started.request.input.split('\n').at(-1));
  assert.equal(current, '为什么我们说要换地方？');
  assert.doesNotMatch(JSON.stringify(context), /private other-group|synthetic-secret|为什么我们说要换地方|posted after|test-author/);
  assert.equal(replies[0].id, 'trace');
  assert.match(replies[0].text, /13 .*7 /);
});

test('an empty context is evidence, not a reason to suppress work', async t => {
  let context;
  const replies = [];
  const data = setup(t, {
    plan: async event => ({ kind: 'work-intent', source: event, brief: 'summarize if possible', contextHours: 24 }),
    startWork: async request => {
      context = JSON.parse(request.request.input.split('\n').at(-1)).context;
      return { kind: 'work', source: request.source };
    },
    finish: async job => ({ source: job.source, text: 'No messages available.' }),
    send: async (_, text) => { replies.push(text); return { id: 'ok' }; },
  });
  data.put('summary', 'summarize');
  const trial = data.trial();
  trial.tick();
  await trial.drain();
  assert.deepEqual(context.messages, []);
  assert.equal(context.coverage.available, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /No messages available\.[\s\S]+24 .*0 /);
});

test('plain chat opens one same-group window, with natural and source-targeted delivery', async t => {
  const sent = [];
  const data = setup(t, {
    pollIntervalsMs: [2000, 4000],
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
    pollIntervalsMs: [2000, 4000], planWindow: () => window,
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
  assert.deepEqual(data.ledger.prepare('SELECT message_id FROM group_turn_read').all()
    .map(row => row.message_id), ['ping']);
});

test('empty polls back off to fifteen minutes, and even a silent hit resets to one minute', async t => {
  let planned = 0;
  const data = setup(t, {
    always: true, until: Infinity,
    planWindow: async () => { planned++; return []; }, sendWindow: async () => assert.fail('silence must not send'),
  });
  const state = () => data.ledger.prepare('SELECT level, due_at FROM group_turn_poll').get();
  const trial = data.trial();
  let time = clock;
  for (const [minutes, nextMinutes, level] of [[1, 2, 1], [2, 5, 2], [5, 10, 3], [10, 15, 4], [15, 15, 4]]) {
    data.advance(minutes * 60_000);
    time += minutes * 60_000;
    trial.tick();
    assert.equal(state().level, level);
    assert.equal(state().due_at, time + nextMinutes * 60_000);
  }
  assert.equal(planned, 0);
  data.advance(14 * 60_000);
  data.put('fresh', 'a topic', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.advance(60_000);
  time += 15 * 60_000;
  trial.tick();
  await trial.drain();
  assert.equal(planned, 1);
  assert.equal(state().level, 0);
  assert.equal(state().due_at, time + 60_000);
  data.advance(60_000);
  data.trial().tick();
  assert.equal(planned, 1);
  assert.equal(state().level, 1);
});

test('mentions slide the next poll, consume only their related IDs and retain readable context after restart', async t => {
  const sent = [];
  const data = setup(t, {
    always: true, until: Infinity,
    plan: async (event, _, unread) => {
      assert.deepEqual(unread.map(r => r.messageId), event.messageId === 'first' ? ['a', 'b'] : ['b']);
      return { kind: 'chat', text: 'answer', source: event, consumedMessageIds: ['a', 'nonexistent'] };
    },
    send: async event => { sent.push(event.messageId); return { id: 'ok' }; },
    planWindow: async (unread, context) => {
      assert.deepEqual(unread.map(r => r.messageId), ['b']);
      assert.ok(context.some(row => row.id === 'a' && row.text === 'topic A'));
      return [{ mode: 'reply', replyToId: 'b', text: 'topic B also matters' }];
    },
    sendWindow: async (_, action) => { sent.push(action.replyToId); return { id: 'ok' }; },
  });
  const dueAt = () => data.ledger.prepare('SELECT due_at FROM group_turn_poll').get().due_at;
  const trial = data.trial();
  data.put('a', 'topic A', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('b', 'topic B', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.put('first', 'question about A');
  trial.tick();
  await trial.drain();
  assert.deepEqual(sent, ['first']);
  assert.equal(dueAt(), clock + 60_000);
  data.advance(20_000);
  data.put('second', 'another question about A');
  trial.tick();
  await trial.drain();
  assert.equal(dueAt(), clock + 80_000);
  const resumed = data.trial();
  data.advance(40_000);
  resumed.tick();
  await resumed.drain();
  assert.deepEqual(sent, ['first', 'second']);
  data.advance(20_000);
  resumed.tick();
  await resumed.drain();
  assert.deepEqual(sent, ['first', 'second', 'b']);
});

test('a delayed poll reads stale messages but only offers live anchors to the model', async t => {
  const sent = [];
  const data = setup(t, {
    always: true, until: Infinity,
    planWindow: async (rows, context) => {
      assert.deepEqual(rows.map(row => row.messageId), ['fresh']);
      assert.ok(context.some(row => row.id === 'stale'));
      return [{ mode: 'reply', replyToId: 'stale', text: 'wrong anchor' }, { mode: 'natural', text: 'fresh topic' }];
    },
    sendWindow: async (_, action, tail) => { sent.push([action.mode, tail.messageId]); return { id: 'ok' }; },
  });
  const trial = data.trial();
  data.put('stale', 'old topic', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.advance(15 * 60_000);
  data.put('fresh', 'new topic', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  trial.tick();
  await trial.drain();
  assert.deepEqual(sent, [['natural', 'fresh']]);
  assert.deepEqual(data.ledger.prepare('SELECT message_id FROM group_turn_read ORDER BY received_at').all()
    .map(row => row.message_id), ['stale', 'fresh']);
});

test('an inference failure leaves unread messages for the next poll, including after restart', async t => {
  const revisions = [];
  const data = setup(t, {
    always: true, until: Infinity,
    planWindow: async (rows, _context, revision) => {
      assert.deepEqual(rows.map(row => row.messageId), ['subject']);
      revisions.push(revision);
      if (revisions.length === 1) throw new Error('model failed');
      return [];
    },
    sendWindow: async () => assert.fail('must not post'),
  });
  const trial = data.trial();
  data.put('subject', 'a topic', { rawEventType: 'GROUP_MESSAGE_CREATE' });
  data.advance(60_000);
  trial.tick();
  await trial.drain();
  assert.equal(data.ledger.prepare('SELECT COUNT(*) AS n FROM group_turn_read').get().n, 0);
  data.advance(60_000);
  const resumed = data.trial();
  resumed.tick();
  await resumed.drain();
  assert.equal(revisions.length, 2);
  assert.ok(revisions[1] > revisions[0]);
  assert.equal(data.ledger.prepare('SELECT COUNT(*) AS n FROM group_turn_read').get().n, 1);
});

test('an uncertain send and a mismatched source never cause a retry or wrong-target send', async t => {
  let attempted = 0;
  const data = setup(t, {
    plan: async event => ({ kind: 'chat', source: event.text === 'wrong' ? { ...event, groupId: 'other' } : event, text: 'answer' }),
    send: async () => { attempted++; throw new Error('network outcome unknown'); },
  });
  data.put('uncertain', '[Hermes] hello');
  data.put('wrong', '[Hermes] wrong');
  const trial = data.trial();
  trial.tick();
  trial.tick();
  await trial.drain();
  assert.equal(attempted, 1);
  assert.deepEqual(data.status(), ['uncertain', 'withheld']);
});
