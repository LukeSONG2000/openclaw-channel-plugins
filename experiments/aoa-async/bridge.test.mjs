import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBridge } from './index.mjs';
import { collectAttachments, makePrompt, runOpenClaw } from './input.mjs';
import { identifyTask, routeKey } from './routing.mjs';
import { openStore } from './store.mjs';
import { workOnce } from './worker.mjs';

const group = `qqbot:group:${'A'.repeat(32)}`;
const other = `qqbot:group:${'B'.repeat(32)}`;
const direct = `qqbot:c2c:${'C'.repeat(32)}`;
const ding = 'ddingtalk:chat:cidFixture==';

function message({ to = group, channel = 'qqbot', account = 'sandbox', id = 'm1', body = '总结一下24h内群里的聊天内容', extra = {} } = {}) {
  const isGroup = to.includes(':group:') || to.includes(':chat:');
  return { sendPolicy: 'allow', ctx: {
    Provider: channel, OriginatingChannel: channel, AccountId: account, To: to, OriginatingTo: to,
    ChatType: isGroup ? 'group' : 'direct', RawBody: body, MessageSid: id, SenderId: isGroup ? 'group-member' : to.split(':').at(-1), ...extra,
  } };
}

function dispatcher() {
  const finals = [];
  return {
    finals, dispatcher: { sendFinalReply: (p) => (finals.push(p.text), true), getQueuedCounts: () => ({ final: finals.length }) },
    recordProcessed: () => {}, markIdle: () => {},
  };
}

async function fixture(t, sender = async ({ channel }) => ({ channel, messageId: 'fixture-receipt' })) {
  const parent = await mkdtemp(join(tmpdir(), 'aoa-async-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, '.lab');
  const mediaRoot = join(root, 'gateway', 'media');
  await mkdir(mediaRoot, { recursive: true });
  const store = openStore(root);
  t.after(() => store.close());
  const clock = { value: 2_000_000_000_000 };
  const now = () => clock.value;
  const config = { channels: { qqbot: {}, ddingtalk: {} }, tools: { profile: 'fixture' } };
  const routes = [
    { channel: 'qqbot', account: 'sandbox', to: group },
    { channel: 'qqbot', account: 'sandbox', to: other },
    { channel: 'qqbot', account: 'sandbox', to: direct },
    { channel: 'ddingtalk', account: 'sandbox', to: ding },
  ];
  const sent = [];
  const current = () => ({ cfg: config, routes });
  const bridge = createBridge({ store, mediaRoot, now, current, send: async (p) => {
    assert.equal(p.assertCurrent(), true);
    sent.push(p);
    return sender(p);
  } });
  function observe(text, to = group, channel = 'qqbot', id = 'history-1', time = now()) {
    bridge.observe({ messageId: id, senderId: 'person-1', content: text, timestamp: time }, { channelId: channel, accountId: 'sandbox', conversationId: to });
  }
  return { parent, root, mediaRoot, store, clock, now, config, routes, sent, current, bridge, observe };
}

test('recognizes both narrow tasks and leaves regular chat and commands alone', () => {
  assert.equal(identifyTask('总结一下24h内群里的聊天内容', true), 'history');
  assert.equal(identifyTask('帮我整理这份材料', false, true), 'document');
  for (const x of ['群里怎么这么热闹', '别总结这个群24小时的讨论', '可以聊天吗', '/summary', '总结这件事']) {
    assert.equal(identifyTask(x, true, false), undefined);
  }
});

test('real SQLite: same-group input, duplicate admission, foreground bypass and one delayed receipt', async (t) => {
  const f = await fixture(t);
  f.observe('计划把原型拆成两步');
  f.observe('另一群不能被读到', other);
  f.observe('过期记录不能冒充今天', group, 'qqbot', 'old', f.now() - 86_400_001);
  const ack = dispatcher();
  assert.equal((await f.bridge.reply(message(), ack)).handled, true);
  assert.equal(ack.finals.length, 1);
  const duplicate = dispatcher();
  assert.equal((await f.bridge.reply(message(), duplicate)).handled, true);
  assert.deepEqual(duplicate.finals, []);
  let finish;
  const running = workOnce({ store: f.store, now: f.now, work: async (_, input) => {
    const prompt = await makePrompt('history', input);
    assert.match(prompt, /拆成两步/);
    assert.doesNotMatch(prompt, /另一群|过期记录/);
    return new Promise((resolve) => { finish = resolve; });
  } });
  await new Promise(setImmediate);
  f.clock.value += 180_000;
  assert.equal(await f.bridge.reply(message({ id: 'chat', body: '今天晚饭吃什么' }), dispatcher()), undefined);
  assert.equal(f.store.status()[0].state, 'running');
  await f.bridge.tick();
  assert.equal(f.sent.length, 0);
  finish('测试结果');
  await running;
  await f.bridge.tick();
  await f.bridge.tick();
  assert.deepEqual(f.sent.map(({ to, replyToId, text }) => [to, replyToId, text]), [[group, 'm1', '测试结果']]);
  assert.equal(f.store.status()[0].state, 'sent');
});

test('native DingTalk shape and QQ direct attachment are covered offline', async (t) => {
  const f = await fixture(t);
  const text = join(f.mediaRoot, 'first.csv');
  await writeFile(text, 'column,value\nphase,ready\n');
  for (const [channel, to] of [['qqbot', direct], ['ddingtalk', ding]]) {
    const ack = dispatcher();
    const event = message({ channel, to, id: 'file', body: '帮我整理这份附件', extra: { MediaPaths: [text], MediaTypes: ['text/csv'] } });
    assert.equal((await f.bridge.reply(event, ack)).handled, true);
    assert.match(ack.finals[0], /已接单/);
    await workOnce({ store: f.store, now: f.now, work: async (job, input) => {
      assert.equal(job.kind, 'document');
      assert.match(await makePrompt(job.kind, input, { mediaRoot: f.mediaRoot }), /phase,ready/);
      return '已整理';
    } });
    await f.bridge.tick();
  }
  assert.deepEqual(f.sent.map((p) => p.to), [direct, ding]);
});

test('attachments fail closed on no file, symlinks outside the lab, and replacements', async (t) => {
  const f = await fixture(t);
  const outside = join(f.parent, 'private.txt');
  await writeFile(outside, 'secret');
  const link = join(f.mediaRoot, 'unsafe.txt');
  await symlink(outside, link);
  const ack = dispatcher();
  await f.bridge.reply(message({ body: '整理附件', extra: { MediaPath: link } }), ack);
  assert.match(ack.finals[0], /没有拿到/);
  const local = join(f.mediaRoot, 'safe.txt');
  await writeFile(local, 'original');
  const files = collectAttachments({ MediaPaths: [local] }, f.mediaRoot);
  await writeFile(local, 'not the original');
  await assert.rejects(makePrompt('document', { files }, { mediaRoot: f.mediaRoot }), /file_changed/);
  assert.equal(f.store.status().length, 0);
});

test('does not claim suppressed, unauthorized, command or mismatched routes', async (t) => {
  const f = await fixture(t);
  f.observe('many notes');
  for (const event of [
    { ...message(), sendPolicy: 'deny' },
    { ...message(), suppressUserDelivery: true },
    { ...message(), isTailDispatch: true },
    { ...message(), originatingAccountId: 'another' },
    message({ account: 'another' }),
    message({ extra: { CommandSource: 'text' } }),
    message({ extra: { OriginatingTo: other } }),
  ]) assert.equal(await f.bridge.reply(event, dispatcher()), undefined);
  assert.equal(f.store.status().length, 0);
});

test('config revocation blocks pending work and withholds completed output', async (t) => {
  const f = await fixture(t);
  f.observe('notes');
  await f.bridge.reply(message({ id: 'before' }), dispatcher());
  await workOnce({ store: f.store, now: f.now, work: async () => 'already finished' });
  await f.bridge.reply(message({ id: 'after' }), dispatcher());
  f.routes.splice(0, 1);
  await f.bridge.tick();
  assert.deepEqual(f.store.status().map(({ state }) => state), ['revoked', 'revoked']);
  assert.equal(f.sent.length, 0);
  assert.equal(await workOnce({ store: f.store, now: f.now, work: assert.fail }), false);
});

test('restart preserves a pending task but never replays orphaned execution or sending', async (t) => {
  const f = await fixture(t);
  f.observe('notes');
  await f.bridge.reply(message({ id: 'send' }), dispatcher());
  await workOnce({ store: f.store, now: f.now, work: async () => 'ready' });
  assert.ok(f.store.claimDelivery(f.now()));
  await f.bridge.reply(message({ id: 'run' }), dispatcher());
  assert.ok(f.store.claimWork(f.now()));
  await f.bridge.reply(message({ id: 'pending' }), dispatcher());
  f.clock.value += 721_000;
  const restored = openStore(f.root);
  t.after(() => restored.close());
  restored.grant(routeKey({ channel: 'qqbot', account: 'sandbox', to: group }), 'test-only-change', f.now() + 5000);
  assert.equal(restored.claimWork(f.now()), undefined);
  assert.equal(restored.claimDelivery(f.now()), undefined);
  assert.deepEqual(restored.status().map(({ state }) => state).sort(), ['revoked', 'uncertain', 'uncertain']);
});

test('send errors or a missing receipt are not treated as permission to retry', async (t) => {
  let attempts = 0;
  const f = await fixture(t, async () => {
    if (++attempts === 1) throw new Error('possible send');
    return { channel: 'qqbot', messageId: '' };
  });
  f.observe('notes');
  for (const id of ['one', 'two']) {
    await f.bridge.reply(message({ id }), dispatcher());
    await workOnce({ store: f.store, now: f.now, work: async () => 'result' });
    await f.bridge.tick();
  }
  await f.bridge.tick();
  assert.equal(attempts, 2);
  assert.deepEqual(f.store.status().map(({ state }) => state), ['uncertain', 'uncertain']);
});

test('the child model process receives only stdin, and publishes only a final result', async (t) => {
  const f = await fixture(t);
  const executable = join(f.root, 'fake-agent');
  await writeFile(executable, `#!${process.execPath}\n` + [
    'let text = "";',
    'process.stdin.setEncoding("utf8").on("data", x => text+=x).on("end", () => {',
    'if (process.argv.some(x => x.includes("private fixture")) || !text.includes("private fixture") || process.env.QQ_APP_SECRET) process.exit(5);',
    'console.log(JSON.stringify({ok:true,status:"ok",final:"最终结果<@123>",commentary:"should not publish"}));',
    '});',
  ].join('\n'), { mode: 0o700 });
  assert.equal(await runOpenClaw({ executable, config: '/unused', env: {}, cwd: f.root, prompt: 'private fixture' }), '最终结果');
});
