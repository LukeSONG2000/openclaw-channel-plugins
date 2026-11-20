import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { backgroundRequest, hermesPilot, hermesRuns } from './pilot.mjs';
import { kanbanTasks, makeKanbanBridge } from './kanban.mjs';

const event = (id = 'task', groupId = 'group-one') => ({
  channel: 'qqbot', account: 'test-bot', groupId, senderId: 'speaker-one',
  messageId: id, mentioned: true, text: 'make a report',
});
const decision = source => backgroundRequest(source, { brief: 'Prepare the report.' }, { messages: [] });
const state = db => db.prepare('SELECT state FROM kanban_receipts').get().state;
const card = db => db.prepare('SELECT card_id AS id, tenant, key FROM kanban_receipts').get();

function withLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-qq-kanban-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return () => new DatabaseSync(join(dir, 'receipts.sqlite'));
}

test('the original source survives ambiguous admission and restart without duplicate task or delivery', async t => {
  const source = event();
  const open = withLedger(t);
  const known = new Map();
  let creates = 0;
  const tasks = {
    async create({ key }) {
      creates++;
      known.set(key, 't_12345678');
      if (creates === 1) throw new Error('response lost after card creation');
      return known.get(key);
    },
    async read() { return { status: 'done', result: 'Final answer' }; },
  };
  const results = [];
  let enabled = false;
  const transport = { canDeliver: () => enabled, deliver: r => { results.push(r); return { id: 'receipt' }; } };
  const bridgeFor = (db, groupId = source.groupId) => makeKanbanBridge({ db, tasks, account: source.account, groupId });
  let db = open();
  const bridge = bridgeFor(db);
  const queued = bridge.enqueue(decision(source));
  assert.equal(queued.inserted, true);
  assert.equal(bridge.enqueue(decision(source)).inserted, false);
  assert.throws(() => bridge.enqueue(decision(event('task', 'elsewhere'))), /outside QQ binding/);
  await bridge.sweep(transport);
  assert.equal(state(db), 'pending');
  db.close();
  db = open();
  try {
    const recovered = bridgeFor(db);
    await bridgeFor(db, 'elsewhere').sweep(transport);
    assert.equal(creates, 1);
    await recovered.sweep(transport);
    assert.equal(known.size, 1);
    assert.equal(state(db), 'watching');
    assert.equal(db.prepare('SELECT input FROM kanban_receipts').get().input, null);
    await recovered.sweep(transport);
    assert.deepEqual(results, []);
    enabled = true;
    await Promise.all([recovered.sweep(transport), bridgeFor(db).sweep(transport)]);
    await recovered.sweep(transport);
    assert.deepEqual(results, [{ source: decision(source).source, text: 'Final answer', receiptKey: queued.key }]);
    assert.equal(state(db), 'accepted');
  } finally { db.close(); }
});

test('uncertain delivery, lost receipts and non-final output are not posted again', async t => {
  const open = withLedger(t);
  for (const outcome of ['uncertain', 'sending', 'withheld']) {
    const source = event(outcome);
    const tasks = {
      async create() { return 't_12345678'; },
      async read() { return { status: 'done', result: outcome === 'withheld' ? 'NO_REPLY' : 'Complete' }; },
    };
    let sent = 0;
    const transport = { canDeliver: () => true, deliver: () => { sent++; throw new Error('connection lost'); } };
    const acrossRestart = async action => {
      const db = open();
      try { await action(makeKanbanBridge({ db, tasks, account: source.account, groupId: source.groupId }), db); }
      finally { db.close(); }
    };
    const key = decision(source).request.requestKey;
    await acrossRestart(async (bridge, db) => {
      bridge.enqueue(decision(source));
      await bridge.sweep(transport);
      if (outcome === 'sending') db.prepare("UPDATE kanban_receipts SET state = 'sending' WHERE key = ?").run(key);
      else await bridge.sweep(transport);
    });
    await acrossRestart(async (bridge, db) => {
      await bridge.sweep(transport);
      assert.equal(db.prepare('SELECT state FROM kanban_receipts WHERE key = ?').get(key).state, outcome);
      assert.equal(sent, outcome === 'uncertain' ? 1 : 0);
    });
  }
});

test('a card from a different tenant is never treated as the original task', async () => {
  const tasks = kanbanTasks({ command: async () => ({ task: {
    id: 't_12345678', tenant: 'elsewhere', title: 'QQ background work ' + 'a'.repeat(16), assignee: 'default',
    status: 'done', result: 'Wrong group', workspace_kind: 'scratch', completion_contract: 'local-only',
  } }) });
  await assert.rejects(tasks.read({ id: 't_12345678', tenant: 'group', key: 'a'.repeat(64) }), /identity mismatch/);
});

test('a completed artifact replaces model text and is delivered once to the bound source', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const source = event();
    const artifact = { bytes: Buffer.from('fixture'), format: 'gif' };
    const queue = makeKanbanBridge({ db, account: source.account, groupId: source.groupId,
      tasks: { create: async () => 't_12345678', read: async () => ({ status: 'done', result: 'unneeded status' }) },
      readArtifact: async () => artifact });
    const { key } = queue.enqueue(decision(source));
    const sent = [];
    for (let i = 0; i < 3; i++) await queue.sweep({
      canDeliver: () => true, deliver: async item => { sent.push(item); return { id: 'qq-receipt' }; },
    });
    assert.deepEqual(sent, [{ source: decision(source).source, receiptKey: key, text: '', artifact }]);
  } finally { db.close(); }
});

test('native image attachments survive a restart without opening an incomplete card or uploading twice', async t => {
  const open = withLedger(t);
  const source = event('media-task');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2sAAAAASUVORK5CYII=', 'base64');
  const images = ['current', 'quote'].map(origin => ({ origin, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }));
  const nativeAttachments = [];
  const events = [{ kind: 'blocked', payload: { reason: 'initial_status' } }];
  let status = 'blocked';
  let uploads = 0;
  let creates = 0;
  let native;
  let unblocks = 0;
  const tasks = kanbanTasks({
    async command(args, body) {
      const [op, title] = args;
      if (op === 'create') {
        creates++;
        assert.equal(args[args.indexOf('--initial-status') + 1], 'blocked');
        assert.match(body, /vision_analyze/);
        assert.doesNotMatch(body, /base64/);
        native ??= { id: 't_12345678', title, tenant: args[args.indexOf('--tenant') + 1], assignee: 'default',
          workspace_kind: 'scratch', completion_contract: 'local-only' };
        return native;
      }
      if (op === 'show') return { task: { ...native, status }, events, runs: [] };
      if (op === 'attachments') return [...nativeAttachments];
      assert.equal(op, 'unblock');
      assert.equal(nativeAttachments.length, 2);
      unblocks++;
      status = 'ready';
      events.push({ kind: 'unblocked' });
      throw new Error('lost response after card release');
    },
    async attachFile(file) {
      uploads++;
      assert.equal(status, 'blocked');
      assert.deepEqual(file.bytes, bytes);
      nativeAttachments.push({ filename: file.name, content_type: file.type, size: file.bytes.length, uploaded_by: 'luke-qq-media' });
      if (uploads === 1) throw new Error('lost response after first attachment');
    },
  });
  const transport = { canDeliver: () => false, deliver: () => assert.fail('no QQ send') };
  const use = async fn => {
    const db = open();
    try { await fn(makeKanbanBridge({ db, tasks, account: source.account, groupId: source.groupId }), db); }
    finally { db.close(); }
  };
  await use(async (bridge, db) => {
    bridge.enqueue(decision(source), images);
    await bridge.sweep(transport);
    assert.equal(status, 'blocked');
    assert.equal(state(db), 'pending');
  });
  await use(async (bridge, db) => {
    await bridge.sweep(transport);
    assert.equal(status, 'ready');
    assert.equal(state(db), 'pending');
  });
  await use(async (bridge, db) => {
    await bridge.sweep(transport);
    assert.equal(state(db), 'watching');
    assert.equal(db.prepare('SELECT count(*) AS n FROM kanban_input_media').get().n, 0);
  });
  assert.equal(creates, 3);
  assert.equal(uploads, 2);
  assert.equal(unblocks, 1);
});

test('a stale input is discarded instead of silently launching a text-only card', async t => {
  const db = withLedger(t)();
  t.after(() => db.close());
  const source = event('stale');
  let at = 100;
  const bridge = makeKanbanBridge({ db, tasks: { create: () => assert.fail('must not create') },
    account: source.account, groupId: source.groupId, now: () => at });
  bridge.enqueue(decision(source), [{ origin: 'quote', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]);
  at += 86_400_001;
  await bridge.sweep({ canDeliver: () => false, deliver: () => assert.fail('must not post') });
  assert.equal(state(db), 'withheld');
  assert.equal(db.prepare('SELECT count(*) AS n FROM kanban_input_media').get().n, 0);
});

test('an expired QQ anchor retains the result in Kanban without retrying or posting it', async t => {
  const db = withLedger(t)();
  t.after(() => db.close());
  let reads = 0;
  const tasks = {
    async create() { return 't_12345678'; },
    async read() { reads++; return { status: 'done', result: 'completed in Kanban' }; },
  };
  const source = event();
  const bridge = makeKanbanBridge({ db, tasks, account: source.account, groupId: source.groupId });
  bridge.enqueue(decision(source));
  const transport = { canDeliver: () => 'expired', deliver: () => assert.fail('must not post') };
  await bridge.sweep(transport);
  await bridge.sweep(transport);
  await bridge.sweep(transport);
  assert.equal(state(db), 'retained');
  assert.equal(reads, 1);
});

test('real Hermes: a native worker finishes while the QQ bridge is closed; quick chat remains separate', {
  skip: !process.env.HERMES_QQ_FIXTURE_ORIGIN, timeout: 90_000,
}, async t => {
  const fast = hermesRuns({ origin: process.env.HERMES_QQ_FIXTURE_ORIGIN, token: 'hermes-qq-fixture-only' });
  const pilot = hermesPilot({ fast });
  const source = event('durable-' + Date.now());
  const intent = await pilot.planMention(source);
  assert.equal(intent.kind, 'work-intent');
  const tasks = kanbanTasks();
  const open = withLedger(t);
  const bridgeFor = db => makeKanbanBridge({ db, tasks, account: source.account, groupId: source.groupId });
  const results = [];
  const transport = { canDeliver: () => true, deliver: r => { results.push(r); return { id: 'fixture-only' }; } };
  let db = open();
  let handle;
  try {
    bridgeFor(db).enqueue(backgroundRequest(source, intent, { messages: [] }));
    await bridgeFor(db).sweep(transport);
    handle = card(db);
    assert.match(handle.id, /^t_/);
    assert.equal(await tasks.create({ ...handle, input: 'duplicate input' }), handle.id);
  } finally { db.close(); }
  execFileSync('hermes', ['kanban', 'dispatch', '--max', '1', '--json'], { stdio: 'pipe', timeout: 15_000 });
  const quick = await pilot.mention({ ...source, messageId: source.messageId + '-ping', text: 'are you there?' });
  assert.equal(quick.text, "I'm here.");
  let latest = await tasks.read(handle);
  assert.notEqual(latest.status, 'done');
  for (let attempt = 0; attempt < 15 && latest.status !== 'done'; attempt++) {
    await delay(650);
    latest = await tasks.read(handle);
  }
  assert.equal(latest.status, 'done', latest.last_failure_error ?? '');
  db = open();
  try {
    const restarted = bridgeFor(db);
    await restarted.sweep(transport);
    await restarted.sweep(transport);
    assert.deepEqual(results, [{
      source: decision(source).source, text: 'The durable report is ready.', receiptKey: handle.key,
    }]);
    assert.equal(state(db), 'accepted');
  } finally { db.close(); }
});
