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
