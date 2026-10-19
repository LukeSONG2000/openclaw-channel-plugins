import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeManifest, readReceipt, runManifest, sha256 } from './sender-manifest.mjs';
import { administrator, createTransport, markdownLink } from './sender-transport.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const target = { id: 'fake-admin-only', appId: 'fake-app', clientSecret: 'fake-secret', targetSha256: sha256('fake-admin-only') };
const manifest = { version: 1, batchId: 'fixture-20261019', parts: [
  { type: 'text', text: 'private text must not be persisted' },
  { type: 'image', path: 'card.png' },
  { type: 'link', label: '信息来源', url: 'https://willreset.com/zh/' },
] };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-sender-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'card.png'), PNG);
  return { directory, plan: await normalizeManifest(manifest, directory), receiptPath: path.join(directory, 'receipt.json') };
}

function fakeTransport({ prepareError, deliverError, beforeDeliver } = {}) {
  const delivered = [], prepared = [];
  return { targetSha256: target.targetSha256, delivered, prepared,
    async prepare(part) {
      prepared.push(part.partIndex);
      if (prepareError?.(part.partIndex)) throw new Error('fake-secret fake-admin-only');
      return async () => {
        await beforeDeliver?.(part.partIndex);
        delivered.push(part.partIndex);
        const error = deliverError?.(part.partIndex);
        if (error) throw error;
        return { id: `fake-message-${part.partIndex}` };
      };
    },
  };
}

test('success is atomically saved before next part; completed replay sends nothing', async t => {
  const f = await fixture(t);
  const transport = fakeTransport({ async beforeDeliver(index) {
    const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
    assert.equal(receipt.parts[index].status, 'inflight');
    assert.ok(receipt.parts.slice(0, index).every(p => p.status === 'sent'));
    assert.equal(receipt.ok, false);
  } });
  const result = await runManifest({ ...f, transport });
  assert.equal(result.ok, true);
  assert.equal(result.nextIndex, 3);
  assert.deepEqual(transport.delivered, [0, 1, 2]);
  const again = fakeTransport();
  assert.equal((await runManifest({ ...f, transport: again })).ok, true);
  assert.deepEqual(again.prepared, []);
  const raw = await fs.readFile(f.receiptPath, 'utf8');
  for (const secret of ['fake-secret', 'fake-admin-only', 'fake-message-', 'private text', 'willreset', 'card.png', PNG.toString('base64')]) {
    assert.equal(raw.includes(secret), false);
  }
  assert.equal((await fs.stat(f.receiptPath)).mode & 0o777, 0o600);
});

test('upload failure leaves partial receipt; retry skips every successful part', async t => {
  const f = await fixture(t);
  const first = fakeTransport({ prepareError: index => index === 1 });
  const result = await runManifest({ ...f, transport: first });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'partial');
  assert.equal(result.nextIndex, 1);
  assert.deepEqual(first.delivered, [0]);
  assert.deepEqual(result.parts.map(p => p.status), ['sent', 'failed', 'pending']);
  const second = fakeTransport();
  assert.equal((await runManifest({ ...f, transport: second })).ok, true);
  assert.deepEqual(second.delivered, [1, 2]);
});

test('explicit Markdown rejection is a failure, not unsupported plain-text fallback', async t => {
  const f = await fixture(t);
  const transport = fakeTransport({ deliverError: index => index === 2
    ? Object.assign(new Error('fake-secret credential admin'), { status: 403, bizCode: 304003 }) : null });
  const result = await runManifest({ ...f, transport });
  assert.equal(result.status, 'partial');
  assert.equal(result.nextIndex, 2);
  assert.equal(result.parts[2].errorCode, 'qq_rejected');
  assert.equal(result.parts[2].httpStatus, 403);
  assert.equal(result.parts[2].bizCode, 304003);
  assert.equal(JSON.stringify(result).includes('credential'), false);
  const retry = fakeTransport();
  await runManifest({ ...f, transport: retry });
  assert.deepEqual(retry.delivered, [2]);
});

test('timeout, server errors, or lost acknowledgment block automatic replay', async t => {
  for (const error of [new Error('fake-secret timeout'), Object.assign(new Error('gateway'), { status: 503 }),
    Object.assign(new Error('timeout'), { status: 408 })]) {
    const f = await fixture(t);
    const transport = fakeTransport({ deliverError: index => index === 1 ? error : null });
    const result = await runManifest({ ...f, transport });
    assert.equal(result.status, 'blocked');
    assert.equal(result.parts[1].status, 'unknown');
    const retry = fakeTransport();
    assert.equal((await runManifest({ ...f, transport: retry })).status, 'blocked');
    assert.deepEqual(retry.prepared, []);
  }
});

test('inflight after process crash and changed payload/target fail closed', async t => {
  const f = await fixture(t);
  await runManifest({ ...f, transport: fakeTransport({ prepareError: index => index === 1 }) });
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  receipt.parts[1] = { partIndex: 1, status: 'inflight' };
  await fs.writeFile(f.receiptPath, JSON.stringify(receipt));
  const transport = fakeTransport();
  assert.equal((await runManifest({ ...f, transport })).status, 'blocked');
  assert.deepEqual(transport.prepared, []);
  const changed = await normalizeManifest({ ...manifest, parts: [{ type: 'text', text: 'changed' }] }, f.directory);
  await assert.rejects(runManifest({ ...f, plan: changed, transport }), /receipt_manifest_mismatch/);
  await assert.rejects(runManifest({ ...f, transport: { ...transport, targetSha256: sha256('different-admin') } }), /receipt_target_mismatch/);
  await fs.writeFile(path.join(f.directory, 'card.png'), Buffer.concat([PNG, Buffer.from('changed')]));
  const changedImage = await normalizeManifest(manifest, f.directory);
  await assert.rejects(runManifest({ ...f, plan: changedImage, transport }), /receipt_manifest_mismatch/);
});

test('dry-run is credential-free and read-only, including missing parent directories', async t => {
  const f = await fixture(t);
  const receiptPath = path.join(f.directory, 'not-created', 'receipt.json');
  const result = await runManifest({ plan: f.plan, receiptPath, dryRun: true });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.ok, false);
  await assert.rejects(fs.access(path.dirname(receiptPath)));
  const manifestPath = path.join(f.directory, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const run = spawnSync(process.execPath, [new URL('./send-openclaw-qq.mjs', import.meta.url).pathname,
    '--manifest', manifestPath, '--receipt', receiptPath, '--root', '/does-not-exist', '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'dry_run');
  await assert.rejects(fs.access(path.dirname(receiptPath)));
});

test('concurrent and stale locks prevent sends', async t => {
  const f = await fixture(t);
  await fs.writeFile(`${f.receiptPath}.lock`, '');
  const transport = fakeTransport();
  await assert.rejects(runManifest({ ...f, transport }), /receipt_locked/);
  assert.deepEqual(transport.prepared, []);
});

test('CLI nonzero on partial failure, resumes by receipt, and legacy alerts never change target', async t => {
  const f = await fixture(t);
  const plugin = path.join(f.directory, 'extensions/openclaw-qqbot');
  await fs.mkdir(path.join(plugin, 'dist/src'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(path.join(f.directory, 'openclaw.json'), JSON.stringify({ channels: { qqbot: {
    appId: 'fixture-app', clientSecret: 'fixture-secret',
    customRuntime: { admins: ['fixture-first', 'fixture-second'], adminGroup: 'fixture-group' },
  } } }));
  const auditPath = path.join(f.directory, 'audit.jsonl');
  await fs.writeFile(path.join(plugin, 'dist/src/api.js'), `
    import fs from 'node:fs/promises';
    const record = async (kind, target) => {
      console.log('unsafe dependency log fixture-secret fixture-first');
      await fs.appendFile(${JSON.stringify(auditPath)}, JSON.stringify({kind,target}) + '\\n');
    };
    export function setApiLogger() {}
    export function initApiConfig() {}
    export async function getAccessToken() { return 'fixture-token'; }
    export async function uploadC2CMedia(token, target) {
      await record('upload', target);
      if (process.env.SENDER_FIXTURE_FAIL === 'image') throw new Error('fixture-secret');
      return {file_info:'fixture-file-info'};
    }
    export async function sendC2CMediaMessage(token, target) {
      await record('image', target); return {id:'fixture-image-id'};
    }
    export async function sendProactiveC2CMessage(token, target) {
      await record('text', target);
      if (process.env.SENDER_FIXTURE_FAIL === 'text') throw new Error('fixture-secret');
      return {id:'fixture-text-id'};
    }
    export async function apiRequest(token, method, target) {
      await record('link', target); return {id:'fixture-link-id'};
    }
  `);
  const manifestPath = path.join(f.directory, 'batch.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const script = new URL('./send-openclaw-qq.mjs', import.meta.url).pathname;
  const args = [script, '--root', f.directory, '--manifest', manifestPath, '--receipt', f.receiptPath];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, SENDER_FIXTURE_FAIL: 'image' } });
  assert.equal(first.status, 4);
  assert.equal(JSON.parse(first.stdout).nextIndex, 1);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout.includes('fixture-secret'), false);
  const resumed = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, SENDER_FIXTURE_FAIL: '' } });
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout).ok, true);
  let audit = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(row => row.kind), ['text', 'upload', 'upload', 'image', 'link']);
  assert.ok(audit.every(row => row.target === 'fixture-first' || row.target === '/v2/users/fixture-first/messages'));
  const legacy = spawnSync(process.execPath, [script, '--root', f.directory, 'legacy alert'], {
    encoding: 'utf8', env: { ...process.env, SENDER_FIXTURE_FAIL: 'text' },
  });
  assert.notEqual(legacy.status, 0);
  assert.equal(legacy.stdout.includes('fixture-secret'), false);
  audit = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 6);
  assert.deepEqual(audit.at(-1), { kind: 'text', target: 'fixture-first' });
});

test('validation rejects unsafe links, extra routing fields, malformed receipts and fake images', async t => {
  const f = await fixture(t);
  const fullFeed = await normalizeManifest({ version: 1, batchId: 'all-112-events',
    parts: Array.from({ length: 112 }, () => [manifest.parts[1], manifest.parts[2]]).flat() }, f.directory);
  assert.equal(fullFeed.parts.length, 224);
  for (const url of ['', 'http://willreset.com/', 'https://user:secret@willreset.com/', 'javascript:alert(1)', 'https://willreset.com/\nsecret']) {
    await assert.rejects(normalizeManifest({ ...manifest, parts: [{ type: 'link', label: 'Source', url }] }, f.directory), /invalid_link/);
  }
  await assert.rejects(normalizeManifest({ ...manifest, target: 'group' }, f.directory), /invalid_manifest/);
  await fs.writeFile(path.join(f.directory, 'card.png'), 'not an image');
  await assert.rejects(normalizeManifest(manifest, f.directory), /invalid_image/);
  await fs.writeFile(f.receiptPath, 'invalid json');
  await assert.rejects(readReceipt(f.receiptPath, f.plan), /invalid_receipt/);
});

test('administrator is always first configured C2C, never a second user or a group', () => {
  const config = { channels: { qqbot: { appId: 'app', clientSecret: 'secret', customRuntime: {
    admins: ['first', 'second'], adminGroup: 'qqbot:group:not-allowed',
  } } } };
  assert.equal(administrator(config).id, 'first');
  config.channels.qqbot.customRuntime.admins = [];
  assert.throws(() => administrator(config), /administrator_unavailable/);
  config.channels.qqbot.customRuntime.admins = ['qqbot:group:not-allowed'];
  assert.throws(() => administrator(config), /administrator_unavailable/);
});

test('transport uses upload/file_info media API and explicit native Markdown for source blue link', async () => {
  const calls = [];
  const api = {
    async getAccessToken() { calls.push(['token']); return 'fake-token'; },
    async uploadC2CMedia(...args) { calls.push(['upload', ...args]); return { file_info: 'fake-file-info' }; },
    async sendC2CMediaMessage(...args) { calls.push(['image', ...args]); return { id: 'fake-image-id' }; },
    async sendProactiveC2CMessage(...args) { calls.push(['text', ...args]); return { id: 'fake-text-id' }; },
    async apiRequest(...args) { calls.push(['markdown', ...args]); return { id: 'fake-link-id' }; },
  };
  const transport = createTransport(api, target);
  await (await transport.prepare({ type: 'image', bytes: PNG }))();
  await (await transport.prepare(manifest.parts[2]))();
  assert.deepEqual(calls[1], ['upload', 'fake-token', target.id, 1, undefined, PNG.toString('base64'), false]);
  assert.deepEqual(calls[2], ['image', 'fake-token', target.id, 'fake-file-info']);
  assert.deepEqual(calls[3], ['markdown', 'fake-token', 'POST', `/v2/users/${target.id}/messages`,
    { msg_type: 2, markdown: { content: '[信息来源](https://willreset.com/zh/)' } }]);
  assert.equal(calls.filter(c => c[0] === 'token').length, 1);
  assert.equal(JSON.stringify(calls).includes('<qqimg>'), false);
  assert.match(markdownLink('a]b', 'https://example.com/a(b)'), /a\\\]b/);
});

test('actual existing QQ plugin API under mocked fetch produces files upload and msg_type 7/2', async t => {
  const apiFile = new URL('../../plugins/qqbot/dist/src/api.js', import.meta.url);
  try { await fs.access(apiFile); } catch { t.skip('local plugin build unavailable'); return; }
  const api = await import(apiFile.href);
  api.setApiLogger({ info() {}, warn() {}, error() {}, debug() {} });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let rejectMarkdown = false;
  globalThis.fetch = async (url, options) => {
    // This mock never delegates to fetch: no DNS or external HTTP is performed.
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (rejectMarkdown && body.msg_type === 2) {
      return new Response(JSON.stringify({ code: 304003, message: 'mock no Markdown permission' }),
        { status: 403, headers: { 'content-type': 'application/json' } });
    }
    const payload = String(url).endsWith('/files')
      ? { file_info: 'mock-real-api-file', file_uuid: 'mock-uuid', ttl: 0 }
      : { id: 'mock-real-api-message', timestamp: '2026-10-19T00:00:00Z' };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const transport = createTransport({ ...api, getAccessToken: async () => 'mock-only-token' }, target);
    await (await transport.prepare({ type: 'image', bytes: PNG }))();
    await (await transport.prepare(manifest.parts[2]))();
    assert.equal(calls.length, 3);
    assert.equal(new URL(calls[0].url).pathname, `/v2/users/${target.id}/files`);
    assert.deepEqual(calls[0].body, { file_type: 1, srv_send_msg: false, file_data: PNG.toString('base64') });
    assert.equal(calls[1].body.msg_type, 7);
    assert.deepEqual(calls[1].body.media, { file_info: 'mock-real-api-file' });
    assert.equal(calls[2].body.msg_type, 2);
    assert.deepEqual(calls[2].body.markdown, { content: '[信息来源](https://willreset.com/zh/)' });
    assert.equal(calls.some(c => new URL(c.url).pathname.includes('/groups/')), false);
    rejectMarkdown = true;
    const f = await fixture(t);
    const linkPlan = await normalizeManifest({ ...manifest, parts: [manifest.parts[2]] }, f.directory);
    const rejected = await runManifest({ plan: linkPlan, receiptPath: f.receiptPath, transport });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.parts[0].status, 'failed');
    assert.equal(rejected.parts[0].httpStatus, 403);
    assert.equal(rejected.parts[0].bizCode, 304003);
    assert.equal(calls.length, 4);
    assert.equal(calls.some(c => c.body.msg_type === 0), false);
  } finally { globalThis.fetch = originalFetch; }
});
