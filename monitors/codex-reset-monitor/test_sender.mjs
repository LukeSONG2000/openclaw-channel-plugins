import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalStringify, normalizeManifest, readReceipt, runManifest, sha256, imageDimensions, providerDiagnostic } from './sender-manifest.mjs';
import { administrator, createTransport, markdownLink } from './sender-transport.mjs';
import { createImagePreparer, uploadParts, imageUrl, imageExpirySeconds, assertImageValidity } from './sender-images.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const host = 'qqbot-file-upload-1251316161.cos.accelerate.myqcloud.com';
const target = { id: 'fake-admin-only', appId: 'fake-app', clientSecret: 'fake-secret', targetSha256: sha256('fake-admin-only') };
const timezone = { type: 'link', label: 'UTC+08:00', url: 'https://time.ms/zh-cn/utc+8/' };
const manifest = { version: 2, batchId: 'fixture-20261019', delivery: 'single_markdown', parts: [
  { type: 'text', text: 'private text must not be persisted' },
  { type: 'image', path: 'card.png' },
  { type: 'link', label: '\u4fe1\u606f\u6765\u6e90', url: 'https://willreset.com/zh/' },
  timezone,
] };

async function fixture(t, input = manifest) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-sender-v2-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'card.png'), PNG);
  return { directory, plan: await normalizeManifest(input, directory), receiptPath: path.join(directory, 'receipt.json') };
}

function fakeTransport({ prepareError, deliverError, beforeDeliver, response = { id: 'fake-message-id' } } = {}) {
  const prepared = [], delivered = [];
  return { targetSha256: target.targetSha256, prepared, delivered,
    async prepare(plan) {
      prepared.push(plan.batchId);
      if (prepareError) throw new Error('fake-secret fake-admin-only');
      return { preparedMarkdownHash: sha256('fake-body'), async deliver() {
        await beforeDeliver?.();
        delivered.push(plan.batchId);
        if (deliverError) throw deliverError;
        return response;
      } };
    },
  };
}

function apiFixture({ error } = {}) {
  const calls = [];
  return { calls, api: {
    async getAccessToken() { calls.push({ kind: 'token' }); return 'fake-token'; },
    async apiRequest(token, method, route, body) {
      calls.push({ kind: 'message', token, method, route, body });
      if (error) throw error;
      return { id: 'fake-message-id' };
    },
    async sendProactiveC2CMessage() { throw new Error('text_fallback_forbidden'); },
    async sendC2CMediaMessage() { throw new Error('media_fallback_forbidden'); },
    async uploadC2CMedia() { throw new Error('ordinary_upload_forbidden'); },
  } };
}

test('canonical raw manifest matches Python UTF-8 sorted JSON, independent of local image resolution', async t => {
  const f = await fixture(t);
  const shuffled = { parts: manifest.parts, delivery: manifest.delivery, batchId: manifest.batchId, version: 2 };
  const unicode = { '\u{10000}': '\u4e2d\u6587\n\t"', '\ue000': 'x', '10': null, '2': [true, 2] };
  const headingManifest = { ...manifest, parts: [{ type: 'heading', level: 1, text: 'H1\u4e2d\u6587' }] };
  for (const value of [manifest, shuffled, unicode, headingManifest]) {
    const python = spawnSync('python3', ['-c',
      'import sys,json,hashlib; x=json.load(sys.stdin); print(hashlib.sha256(json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest())'],
    { input: JSON.stringify(value), encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    assert.equal(sha256(canonicalStringify(value)), python.stdout.trim());
  }
  assert.equal(f.plan.manifestSha256, sha256(canonicalStringify(manifest)));
  assert.equal((await normalizeManifest(shuffled, f.directory)).manifestSha256, f.plan.manifestSha256);
  assert.equal(f.plan.imageSetSha256, sha256(canonicalStringify([sha256(PNG)])));
  assert.deepEqual(imageDimensions(PNG), { width: 1, height: 1 });
  assert.throws(() => canonicalStringify('\ud800'), /invalid_manifest/);
});

test('one message is durable inflight before sending; complete replay prepares and sends nothing', async t => {
  const f = await fixture(t);
  const transport = fakeTransport({ async beforeDeliver() {
    const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
    assert.equal(receipt.message.status, 'inflight');
    assert.equal(receipt.status, 'blocked');
    assert.equal(receipt.ok, false);
    assert.match(receipt.preparedMarkdownHash, /^[a-f0-9]{64}$/);
    assert.equal(receipt.parts, undefined);
  } });
  const result = await runManifest({ ...f, transport });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.message, { status: 'sent', receiptSha256: sha256('fake-message-id') });
  assert.equal(transport.delivered.length, 1);
  const again = fakeTransport();
  assert.equal((await runManifest({ ...f, transport: again })).ok, true);
  assert.deepEqual(again.prepared, []);
  const raw = await fs.readFile(f.receiptPath, 'utf8');
  for (const secret of ['fake-secret', 'fake-admin-only', 'fake-message-id', 'private text', 'willreset', 'card.png', PNG.toString('base64')]) {
    assert.equal(raw.includes(secret), false);
  }
  assert.equal((await fs.stat(f.receiptPath)).mode & 0o777, 0o600);
});

test('four distinct images, all text and source links compose one Markdown request with one backend timezone', async t => {
  const f = await fixture(t);
  const parts = [{ type: 'text', text: 'Current forecast' }];
  for (let i = 0; i < 4; i++) {
    const filename = 'image-' + i + '.png';
    await fs.writeFile(path.join(f.directory, filename), Buffer.concat([PNG, Buffer.from(String(i))]));
    if (i === 1) parts.push({ type: 'text', text: '\n\nHistory example (not today)\nTibo announcements' });
    parts.push({ type: 'image', path: filename }, { type: 'link', label: 'Source ' + i, url: 'https://x.com/example/status/' + i });
  }
  parts.push(timezone);
  const plan = await normalizeManifest({ ...manifest, parts }, f.directory);
  const { api, calls } = apiFixture();
  const images = [];
  const transport = createTransport(api, target, { async prepareImage(file, hash) {
    assert.equal(calls.length, 0);
    images.push({ file, hash });
    return 'https://' + host + '/' + hash + '.png?signature=private';
  } });
  const result = await runManifest({ ...f, plan, transport });
  assert.equal(result.ok, true);
  assert.equal(images.length, 4);
  const messages = calls.filter(c => c.kind === 'message');
  assert.equal(messages.length, 1);
  const request = messages[0];
  assert.equal(request.route, '/v2/users/fake-admin-only/messages');
  assert.equal(request.method, 'POST');
  assert.equal(request.body.msg_type, 2);
  assert.equal(request.body.markdown.force_verify_image_resource, true);
  const content = request.body.markdown.content;
  assert.equal((content.match(/!\[image #1px #1px\]/g) ?? []).length, 4);
  assert.equal((content.match(/https:\/\/x.com\/example\/status\//g) ?? []).length, 4);
  assert.equal((content.match(/https:\/\/time.ms\/zh-cn\/utc\+8\//g) ?? []).length, 1);
  assert.ok(content.includes('\n\nHistory example \\(not today\\)\nTibo announcements\n\n'));
  assert.ok(content.endsWith('[UTC+08:00](https://time.ms/zh-cn/utc+8/)'));
  assert.equal(result.preparedMarkdownHash, sha256(canonicalStringify(request.body)));
  assert.equal((await fs.readFile(f.receiptPath, 'utf8')).includes('signature='), false);
});

test('sender never adds a timezone footer when backend did not provide one', async t => {
  const f = await fixture(t, { ...manifest, parts: [{ type: 'text', text: 'only this' }] });
  const { api, calls } = apiFixture();
  await runManifest({ ...f, transport: createTransport(api, target) });
  assert.equal(calls.find(c => c.kind === 'message').body.markdown.content, 'only this');
});

test('H1 layout composes one strict body with source before first image and zero, one or multiple announcements', async t => {
  for (const count of [0, 1, 3]) {
    const parts = [
      { type: 'heading', level: 1, text: '\u0043odex\u4f1a\u91cd\u7f6e\u5417\uff1f' },
      { type: 'text', text: 'optional stage' },
      { type: 'link', label: '\u4fe1\u606f\u6765\u6e90', url: 'https://willreset.com/zh/' },
      { type: 'image', path: 'card.png' },
    ];
    if (count) parts.push({ type: 'heading', level: 1, text: 'Tibo\u5ba3\u5e03\u4e86\u4ec0\u4e48' });
    for (let i = 0; i < count; i++) parts.push(
      { type: 'image', path: 'card.png' },
      { type: 'link', label: '\u67e5\u770b\u{1D54F}', url: 'https://x.com/example/status/' + i },
    );
    const input = { ...manifest, parts };
    const f = await fixture(t, input);
    assert.equal(f.plan.manifestSha256, sha256(canonicalStringify(input)));
    const { api, calls } = apiFixture();
    const result = await runManifest({ ...f, transport: createTransport(api, target, {
      prepareImage: async () => 'https://' + host + '/image.png',
    }) });
    const messages = calls.filter(call => call.kind === 'message');
    assert.equal(messages.length, 1);
    assert.equal(result.ok, true);
    const body = messages[0].body;
    assert.equal(body.msg_type, 2);
    assert.equal(body.markdown.force_verify_image_resource, true);
    assert.equal(result.imageVerification, 'strict');
    const content = body.markdown.content;
    assert.ok(content.startsWith('# Codex\u4f1a\u91cd\u7f6e\u5417\uff1f\n\noptional stage\n\n'));
    assert.equal(content.startsWith('\\# '), false);
    const source = '[\u4fe1\u606f\u6765\u6e90](https://willreset.com/zh/)';
    const image = '![image #1px #1px](https://' + host + '/image.png)';
    assert.ok(content.includes(source + '\n\n' + image));
    assert.equal((content.match(/^# /gm) ?? []).length, count ? 2 : 1);
    assert.equal(content.includes('\n\n# Tibo\u5ba3\u5e03\u4e86\u4ec0\u4e48\n\n'), count > 0);
    assert.equal((content.match(/\[\u67e5\u770b\u{1D54F}\]/gu) ?? []).length, count);
    assert.equal((content.match(/!\[image /g) ?? []).length, count + 1);
    assert.equal(content.includes('\u5386\u53f2\u6392\u7248\u793a\u4f8b'), false);
    assert.equal(content.includes('time.ms'), false);
    assert.equal(content.includes('UTC+'), false);
  }
});

test('heading text is escaped but generated prefix is not; legacy text escaping is unchanged', async t => {
  const text = '# _x_ *b* [link](https://example.com) `code` \\ ! <tag> {a}|';
  const escaped = '\\# \\_x\\_ \\*b\\* \\[link\\]\\(https://example.com\\) \\`code\\` \\\\ \\! \\<tag\\> \\{a\\}\\|';
  const input = { ...manifest, parts: [
    { type: 'heading', level: 1, text: '  ' + text + '  ' },
    { type: 'text', text },
  ] };
  const f = await fixture(t, input);
  assert.equal(f.plan.parts[0].text, input.parts[0].text);
  assert.equal(f.plan.manifestSha256, sha256(canonicalStringify(input)));
  const { api, calls } = apiFixture();
  assert.equal((await runManifest({ ...f, transport: createTransport(api, target) })).ok, true);
  assert.equal(calls.find(call => call.kind === 'message').body.markdown.content,
    '# ' + escaped + '\n\n' + escaped);
});

test('heading schema rejects newlines, controls, invalid levels, empty or long text and extra keys', async t => {
  const f = await fixture(t);
  const heading = { type: 'heading', level: 1, text: 'Safe' };
  const invalid = [
    ...[undefined, null, 0, 2, -1, 1.5, '1', true].map(level => ({ ...heading, level })),
    ...[undefined, null, '', '  ', 12, 'x'.repeat(401), 'a\nb', 'a\rb', 'a\r\nb',
      'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\0b', 'a\tb', 'a\x7fb'].map(text => ({ ...heading, text })),
  ];
  for (const part of invalid) {
    await assert.rejects(normalizeManifest({ ...manifest, parts: [part] }, f.directory), /invalid_heading/);
  }
  for (const extra of [{ url: 'https://example.com' }, { path: 'card.png' }, { raw: true }]) {
    await assert.rejects(normalizeManifest({ ...manifest, parts: [{ ...heading, ...extra }] }, f.directory), /invalid_manifest/);
  }
  for (const text of ['x', 'x'.repeat(400)]) {
    const plan = await normalizeManifest({ ...manifest, parts: [{ ...heading, text }] }, f.directory);
    assert.deepEqual(plan.parts, [{ ...heading, text }]);
  }
  const manifestPath = path.join(f.directory, 'invalid-heading.json');
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, parts: [{ ...heading, level: 2 }] }));
  const command = spawnSync(process.execPath, ['send-openclaw-qq.mjs', '--manifest', manifestPath,
    '--receipt', f.receiptPath, '--root', '/not-a-config', '--dry-run'], { encoding: 'utf8' });
  assert.equal(command.status, 4);
  assert.equal(JSON.parse(command.stdout).errorCode, 'invalid_heading');
  await assert.rejects(fs.access(f.receiptPath));
});

test('legacy text layout and completed receipt remain frozen without heading or source reordering', async t => {
  const input = { ...manifest, parts: [
    { type: 'text', text: '# old title' },
    manifest.parts[1], manifest.parts[2],
    { type: 'text', text: '\n\nHistory example (not today)\nTibo announcements' }, timezone,
  ] };
  const original = canonicalStringify(input);
  const f = await fixture(t, input);
  const { api, calls } = apiFixture();
  const transport = createTransport(api, target, { prepareImage: async () => 'https://' + host + '/image.png' });
  assert.equal((await runManifest({ ...f, transport })).ok, true);
  const content = calls.find(call => call.kind === 'message').body.markdown.content;
  assert.ok(content.startsWith('\\# old title\n\n![image '));
  assert.ok(content.indexOf('![image ') < content.indexOf('[\u4fe1\u606f\u6765\u6e90]'));
  assert.ok(content.endsWith('[UTC+08:00](https://time.ms/zh-cn/utc+8/)'));
  const receipt = await fs.readFile(f.receiptPath, 'utf8');
  const retry = fakeTransport();
  assert.equal((await runManifest({ ...f, transport: retry })).ok, true);
  assert.deepEqual(retry.prepared, []);
  assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receipt);
  assert.equal(canonicalStringify(input), original);
  assert.equal(f.plan.manifestSha256, sha256(original));
});

test('late image preparation failure sends zero messages; retry prepares complete message', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'second.png'), Buffer.concat([PNG, Buffer.from('different')]));
  const plan = await normalizeManifest({ ...manifest, parts: [
    manifest.parts[0], manifest.parts[1], { type: 'image', path: 'second.png' }, timezone,
  ] }, f.directory);
  const { api, calls } = apiFixture();
  let count = 0;
  const broken = createTransport(api, target, { async prepareImage() {
    if (++count === 2) throw new Error('private signed_url secret');
    return 'https://' + host + '/one.png';
  } });
  const result = await runManifest({ ...f, plan, transport: broken });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.message, { status: 'failed', errorCode: 'prepare_failed' });
  assert.equal(calls.length, 0);
  const retry = createTransport(api, target, { async prepareImage(file, hash) { return 'https://' + host + '/' + hash; } });
  assert.equal((await runManifest({ ...f, plan, transport: retry })).ok, true);
  assert.equal(calls.filter(c => c.kind === 'message').length, 1);
});

test('missing provider, invalid raw URL and payload ceiling fail closed with no fallback', async t => {
  for (const options of [{}, { prepareImage: async () => 'https://127.0.0.1/a' },
    { prepareImage: async () => 'https://' + host + '/image.png', maxMarkdownBytes: 1 }]) {
    const f = await fixture(t);
    const { api, calls } = apiFixture();
    const result = await runManifest({ ...f, transport: createTransport(api, target, options) });
    assert.equal(result.message.status, 'failed');
    assert.equal(calls.length, 0);
  }
});

test('explicit QQ JSON rejection is failed, without any plain-text/media fallback', async t => {
  const f = await fixture(t);
  const error = Object.assign(new Error('secret raw_url'), { status: 403, bizCode: 304003 });
  const { api, calls } = apiFixture({ error });
  const transport = createTransport(api, target, { prepareImage: async () => 'https://' + host + '/image.png' });
  const result = await runManifest({ ...f, transport });
  assert.equal(result.status, 'failed');
  assert.equal(result.message.errorCode, 'qq_rejected');
  assert.equal(result.message.httpStatus, 403);
  assert.equal(result.message.bizCode, 304003);
  assert.equal(calls.filter(c => c.kind === 'message').length, 1);
  assert.equal(JSON.stringify(result).includes('raw_url'), false);
});

test('timeouts, 5xx, ambiguous 4xx and missing acknowledgments are unknown and never automatically replayed', async t => {
  const failures = [new Error('timeout'), Object.assign(new Error('gateway'), { status: 503 }),
    Object.assign(new Error('timeout'), { status: 408, bizCode: 1 }),
    Object.assign(new Error('HTML gateway'), { status: 403 }), null];
  for (const deliverError of failures) {
    const f = await fixture(t);
    const transport = fakeTransport({ deliverError, response: {} });
    const result = await runManifest({ ...f, transport });
    assert.equal(result.status, 'blocked');
    assert.equal(result.message.status, 'unknown');
    const before = await fs.readFile(f.receiptPath, 'utf8');
    const retry = fakeTransport();
    assert.equal((await runManifest({ ...f, transport: retry })).status, 'blocked');
    assert.deepEqual(retry.prepared, []);
    assert.equal(await fs.readFile(f.receiptPath, 'utf8'), before);
  }
});

test('crashed inflight and changed payload/target/image are blocked before preparation', async t => {
  const f = await fixture(t);
  await runManifest({ ...f, transport: fakeTransport() });
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  receipt.message = { status: 'inflight' }; receipt.status = 'blocked'; receipt.ok = false;
  await fs.writeFile(f.receiptPath, JSON.stringify(receipt));
  const transport = fakeTransport();
  assert.equal((await runManifest({ ...f, transport })).status, 'blocked');
  assert.deepEqual(transport.prepared, []);
  const changed = await normalizeManifest({ ...manifest, parts: [{ type: 'text', text: 'changed' }] }, f.directory);
  await assert.rejects(runManifest({ ...f, plan: changed, transport }), /receipt_manifest_mismatch/);
  await assert.rejects(runManifest({ ...f, transport: { ...transport, targetSha256: sha256('other') } }), /receipt_target_mismatch/);
  await fs.writeFile(path.join(f.directory, 'card.png'), Buffer.concat([PNG, Buffer.from('changed')]));
  const changedImage = await normalizeManifest(manifest, f.directory);
  assert.equal(changedImage.manifestSha256, f.plan.manifestSha256);
  await assert.rejects(runManifest({ ...f, plan: changedImage, transport }), /receipt_image_mismatch/);
});

test('v1 completed/partial/unknown receipts stay byte-for-byte intact, no conversion or continuation', async t => {
  for (const status of ['complete', 'partial', 'blocked']) {
    const f = await fixture(t);
    const raw = JSON.stringify({ version: 1, batchId: f.plan.batchId, status, parts: [{ status: 'sent' }, { status: 'unknown' }] });
    await fs.writeFile(f.receiptPath, raw);
    const transport = fakeTransport();
    await assert.rejects(runManifest({ ...f, transport }), /legacy_receipt_requires_reconciliation/);
    await assert.rejects(runManifest({ ...f, dryRun: true }), /legacy_receipt_requires_reconciliation/);
    assert.equal(await fs.readFile(f.receiptPath, 'utf8'), raw);
    assert.deepEqual(transport.prepared, []);
  }
  await assert.rejects(normalizeManifest({ version: 1, batchId: 'old', parts: manifest.parts }, '/unused'), /legacy_manifest/);
});

test('dry run is credential/network/provider-free and read-only, including absent parents', async t => {
  const f = await fixture(t);
  const receiptPath = path.join(f.directory, 'absent', 'receipt.json');
  const transport = { get targetSha256() { throw new Error('transport_touched'); } };
  assert.equal((await runManifest({ plan: f.plan, receiptPath, dryRun: true, transport })).status, 'dry_run');
  await assert.rejects(fs.access(path.dirname(receiptPath)));
  await runManifest({ ...f, transport: fakeTransport() });
  const before = await fs.readFile(f.receiptPath, 'utf8');
  const result = await runManifest({ ...f, dryRun: true, transport });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'dry_run');
  assert.equal(await fs.readFile(f.receiptPath, 'utf8'), before);
});

test('stale and concurrent receipt locks prevent all preparation and sends', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.receiptPath + '.lock', 'preserve owner');
  const transport = fakeTransport();
  await assert.rejects(runManifest({ ...f, transport }), /receipt_locked/);
  assert.equal(await fs.readFile(f.receiptPath + '.lock', 'utf8'), 'preserve owner');
  assert.deepEqual(transport.prepared, []);
});

test('validation is strict for image attrs, routes, links, fake images and malformed receipts', async t => {
  const f = await fixture(t);
  for (const extra of [{ width: 1 }, { height: 1 }, { sha256: sha256(PNG) }]) {
    await assert.rejects(normalizeManifest({ ...manifest, parts: [{ ...manifest.parts[1], ...extra }] }, f.directory), /invalid_manifest/);
  }
  await assert.rejects(normalizeManifest({ ...manifest, target: 'group' }, f.directory), /invalid_manifest/);
  for (const url of ['', 'http://example.com/', 'https://u:p@example.com/', 'javascript:alert(1)', 'https://example.com/\nsecret']) {
    await assert.rejects(normalizeManifest({ ...manifest, parts: [{ type: 'link', label: 'Source', url }] }, f.directory), /invalid_link/);
  }
  await assert.rejects(normalizeManifest({ ...manifest, parts: [{ type: 'image', path: '../outside.png' }] }, f.directory));
  await fs.writeFile(path.join(f.directory, 'card.png'), 'not an image');
  await assert.rejects(normalizeManifest(manifest, f.directory), /invalid_image/);
  await fs.writeFile(f.receiptPath, 'invalid json');
  await assert.rejects(readReceipt(f.receiptPath, f.plan), /invalid_receipt/);
});

test('changed image between normalization and preparation blocks sends', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'card.png'), Buffer.concat([PNG, Buffer.from('changed')]));
  const { api, calls } = apiFixture();
  let prepared = 0;
  const result = await runManifest({ ...f, transport: createTransport(api, target, { async prepareImage() { prepared++; } }) });
  assert.equal(result.message.errorCode, 'prepare_failed');
  assert.equal(prepared, 0);
  assert.equal(calls.length, 0);
});

test('upload sequence mapping supports returned 0/1 bases, reversed order and part_seq without guessing offsets', () => {
  for (const base of [0, 1, 10]) {
    const parts = [1, 0].map(i => ({ index: base + i, presigned_url: 'https://' + host + '/put-' + i }));
    const result = uploadParts({ upload_id: 'upload', block_size: '4', parts }, 7);
    assert.deepEqual(result.map(p => [p.index, p.offset, p.length]), [[base, 0, 4], [base + 1, 4, 3]]);
  }
  assert.equal(uploadParts({ upload_id: 'u', block_size: 8, parts: [{ part_seq: 0, presigned_url: 'https://' + host + '/p' }] }, 7)[0].index, 0);
  for (const parts of [
    [{ index: 1, presigned_url: 'https://' + host + '/p' }, { index: 1, presigned_url: 'https://' + host + '/q' }],
    [{ index: 0, offset: 1, presigned_url: 'https://' + host + '/p' }, { index: 1, presigned_url: 'https://' + host + '/q' }],
  ]) assert.throws(() => uploadParts({ upload_id: 'u', block_size: 4, parts }, 7), /invalid_upload_prepare/);
  for (const url of ['http://' + host + '/a', 'https://127.0.0.1/a', 'https://u:p@' + host + '/a', 'https://' + host + ':444/a', 'https://' + host + '/a#x']) {
    assert.throws(() => imageUrl(url), /invalid_raw_url/);
  }
});

function uploadFixture({ base = 1, complete, getBytes = PNG, failPut = false, failFinish = false, contentType = 'image/png' } = {}) {
  const calls = [], network = [];
  const block = Math.ceil(PNG.length / 2);
  const api = {
    async getAccessToken() { return 'fake-token'; },
    async apiRequest(token, method, route, body) {
      calls.push({ method, route, body });
      if (route.endsWith('/upload_prepare')) return { upload_id: 'u', block_size: block, parts:
        [1, 0].map(i => ({ index: base + i, presigned_url: 'https://' + host + '/put-' + i + '?secret=signature' })) };
      if (route.endsWith('/upload_part_finish')) {
        if (failFinish) throw new Error('finish failed');
        return {};
      }
      if (route.endsWith('/files')) return complete ?? { raw_url: 'https://' + host + '/raw?secret=signature', ttl: 86400, file_info: 'opaque' };
      throw new Error('messages_forbidden');
    },
  };
  const fetchImpl = async (url, options) => {
    network.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (options.method === 'PUT') return new Response('', { status: failPut ? 403 : 200 });
    assert.equal(options.method, 'GET');
    return new Response(getBytes, { status: 200, headers: contentType ? { 'content-type': contentType } : {} });
  };
  return { api, calls, network, fetchImpl };
}

test('image provider uploads all returned sequence values, explicitly merges without sending, verifies raw_url GET hash', async t => {
  const f = await fixture(t);
  for (const base of [0, 1]) {
    const u = uploadFixture({ base });
    const prepare = createImagePreparer(u.api, target, { fetchImpl: u.fetchImpl });
    assert.equal(await prepare(path.join(f.directory, 'card.png'), sha256(PNG)), 'https://' + host + '/raw?secret=signature');
    assert.deepEqual(u.calls.filter(c => c.route.endsWith('/upload_part_finish')).map(c => c.body.part_index), [base, base + 1]);
    const putBytes = u.network.filter(c => c.options.method === 'PUT').map(c => c.options.body);
    assert.deepEqual(Buffer.concat(putBytes), PNG);
    for (const put of u.network.filter(c => c.options.method === 'PUT')) {
      assert.deepEqual(put.options.headers, { 'Content-Type': 'image/png', 'Content-Disposition': 'inline' });
    }
    assert.deepEqual(u.calls.find(c => c.route.endsWith('/files')).body,
      { upload_id: 'u', file_type: 1, file_name: 'card.png', srv_send_msg: false });
    assert.equal(u.calls.some(c => c.route.endsWith('/messages')), false);
    const get = u.network.find(c => c.options.method === 'GET');
    assert.equal(get.options.headers, undefined);
  }
});

test('missing raw_url, ttl=0, failed PUT/finish or mismatched GET cannot produce a sendable image', async t => {
  const f = await fixture(t);
  for (const options of [
    { complete: { file_uuid: 'never-guess', file_info: 'opaque', ttl: 86400 } },
    { complete: { raw_url: 'https://' + host + '/raw', ttl: 0 } },
    { getBytes: Buffer.from('not PNG') }, { failPut: true }, { failFinish: true },
  ]) {
    const u = uploadFixture(options);
    await assert.rejects(createImagePreparer(u.api, target, { fetchImpl: u.fetchImpl })(path.join(f.directory, 'card.png'), sha256(PNG)));
    assert.equal(u.calls.some(c => c.route.endsWith('/messages')), false);
  }
});

test('image MIME must match verified bytes; octet-stream is not a Markdown-ready image', async t => {
  const f = await fixture(t);
  for (const contentType of ['application/octet-stream', 'text/html', 'image/jpeg', null]) {
    const u = uploadFixture({ contentType });
    await assert.rejects(createImagePreparer(u.api, target, { fetchImpl: u.fetchImpl })(
      path.join(f.directory, 'card.png'), sha256(PNG)), /image_get_invalid_type/);
    assert.equal(u.calls.some(c => c.route.endsWith('/messages')), false);
  }
});

test('COS signature expiry wins over ttl and requires more than the full 120 second send window', async t => {
  const now = Math.floor(Date.now() / 1000);
  const signed = end => 'https://' + host + '/raw?q-signature=private&q-sign-time=' + (now - 1) + '%3B' + end
    + '&q-key-time=' + (now - 1) + '%3B' + (now + 3600);
  assert.equal(imageExpirySeconds(signed(now + 121)), now + 121);
  assert.equal(assertImageValidity(signed(now + 121), now), now + 121);
  for (const end of [now - 1, now, now + 120]) assert.throws(() => assertImageValidity(signed(end), now), /image_expiring/);
  for (const query of ['q-signature=private', 'q-sign-time=bad', 'q-sign-time=1;2&q-sign-time=1;3']) {
    assert.throws(() => imageExpirySeconds('https://' + host + '/raw?' + query), /invalid_image_expiry/);
  }
  const f = await fixture(t);
  const expired = uploadFixture({ complete: { raw_url: signed(now - 1), ttl: 86400 } });
  await assert.rejects(createImagePreparer(expired.api, target, { fetchImpl: expired.fetchImpl })(
    path.join(f.directory, 'card.png'), sha256(PNG)), /image_expiring/);
  assert.equal(expired.network.some(c => c.options.method === 'GET'), false);
  const valid = uploadFixture({ complete: { raw_url: signed(now + 3600), ttl: 86400 } });
  assert.equal(await createImagePreparer(valid.api, target, { fetchImpl: valid.fetchImpl })(
    path.join(f.directory, 'card.png'), sha256(PNG)), signed(now + 3600));
});

test('receipt saves only earliest signature expiry and strict single-message Markdown remains unchanged', async t => {
  const f = await fixture(t), end = Math.floor(Date.now() / 1000) + 3600;
  const raw = 'https://' + host + '/raw?q-signature=private&q-sign-time=1%3B' + end;
  const { api, calls } = apiFixture();
  const transport = createTransport(api, target, { prepareImage: async () => raw });
  const result = await runManifest({ ...f, transport });
  assert.equal(result.preparedStats.imageUrlEarliestExpirySeconds, end);
  assert.equal((await readReceipt(f.receiptPath, f.plan, target.targetSha256)).status, 'complete');
  const receipt = await fs.readFile(f.receiptPath, 'utf8');
  for (const sensitive of ['q-signature', 'private', raw]) assert.equal(receipt.includes(sensitive), false);
  const messages = calls.filter(c => c.kind === 'message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body.markdown.force_verify_image_resource, true);
  assert.equal(messages[0].body.markdown.content.includes(raw), true);
});

test('delivery rechecks expiry without a POST or replay if the send window has elapsed', async t => {
  const f = await fixture(t), end = Math.floor(Date.now() / 1000) + 3600;
  const raw = 'https://' + host + '/raw?q-signature=private&q-sign-time=1%3B' + end;
  const { api, calls } = apiFixture();
  const prepared = await createTransport(api, target, { prepareImage: async () => raw }).prepare(f.plan);
  t.mock.method(Date, 'now', () => (end - 120) * 1000);
  assert.throws(() => prepared.deliver(), /image_expiring/);
  assert.equal(calls.some(c => c.kind === 'message'), false);
  assert.throws(() => prepared.deliver(), /delivery_already_attempted/);
});

test('prepared delivery closure only allows one invocation', async t => {
  const f = await fixture(t, { ...manifest, parts: [manifest.parts[0]] });
  const { api, calls } = apiFixture();
  const prepared = await createTransport(api, target).prepare(f.plan);
  await prepared.deliver();
  assert.throws(() => prepared.deliver(), /delivery_already_attempted/);
  assert.equal(calls.filter(c => c.kind === 'message').length, 1);
});

test('administrator remains first configured C2C, never a group or fallback administrator', () => {
  const config = { channels: { qqbot: { appId: 'app', clientSecret: 'secret', customRuntime: { admins: ['first', 'second'], adminGroup: 'group' } } } };
  assert.equal(administrator(config).id, 'first');
  config.channels.qqbot.customRuntime.admins = ['qqbot:group:invalid', 'second'];
  assert.throws(() => administrator(config), /administrator_unavailable/);
  config.channels.qqbot.customRuntime.admins = [];
  assert.throws(() => administrator(config), /administrator_unavailable/);
  assert.match(markdownLink('a]b', 'https://example.com/a(b)'), /a\\\]b/);
});

test('CLI dry run ignores unavailable root; legacy receipt blocks before config loading; v2 text sends once under mock SDK', async t => {
  const f = await fixture(t, { ...manifest, parts: [manifest.parts[0], timezone] });
  const manifestFile = path.join(f.directory, 'manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, parts: [manifest.parts[0], timezone] }));
  const script = new URL('./send-openclaw-qq.mjs', import.meta.url).pathname;
  const args = [script, '--manifest', manifestFile, '--receipt', f.receiptPath, '--root', '/does-not-exist'];
  const dry = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(JSON.parse(dry.stdout).status, 'dry_run');
  await assert.rejects(fs.access(f.receiptPath));
  const legacy = '{"version":1,"status":"partial","parts":[{"status":"sent"}]}';
  await fs.writeFile(f.receiptPath, legacy);
  const blocked = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(JSON.parse(blocked.stdout).errorCode, 'legacy_receipt_requires_reconciliation');
  assert.equal(await fs.readFile(f.receiptPath, 'utf8'), legacy);
  await fs.unlink(f.receiptPath);
  const plugin = path.join(f.directory, 'extensions/openclaw-qqbot');
  await fs.mkdir(path.join(plugin, 'dist/src'), { recursive: true });
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(path.join(f.directory, 'openclaw.json'), JSON.stringify({ channels: { qqbot: {
    appId: 'fake-app', clientSecret: 'fake-secret', customRuntime: { admins: ['fake-first', 'fake-second'] },
  } } }));
  const audit = path.join(f.directory, 'audit.jsonl');
  await fs.writeFile(path.join(plugin, 'dist/src/api.js'), [
    "import fs from 'node:fs/promises';",
    "console.log('fake-secret signed_url raw_url');",
    'export function setApiLogger() {}',
    "export async function getAccessToken() { return 'mock-token'; }",
    "export async function apiRequest(token,method,route,body) {",
    "console.log('fake-secret fake-first');",
    'await fs.appendFile(' + JSON.stringify(audit) + ', JSON.stringify({route,body}) + "\\n");',
    "return {id:'fake-message-id'}; }",
  ].join('\n'));
  const actual = [script, '--manifest', manifestFile, '--receipt', f.receiptPath, '--root', f.directory];
  const run = spawnSync(process.execPath, actual, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.includes('fake-secret'), false);
  assert.equal(run.stdout.includes('raw_url'), false);
  const replay = spawnSync(process.execPath, actual, { encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stdout);
  const rows = (await fs.readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, '/v2/users/fake-first/messages');
  assert.equal(rows[0].body.markdown.force_verify_image_resource, true);
});

test('disk failure after send preserves inflight and blocks replay', async t => {
  const f = await fixture(t);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === f.receiptPath) {
      const pending = JSON.parse(await fs.readFile(source, 'utf8'));
      if (pending.message.status === 'sent') throw new Error('mock disk failure');
    }
    return rename(source, destination);
  };
  const first = fakeTransport();
  try { await assert.rejects(runManifest({ ...f, transport: first }), /mock disk failure/); }
  finally { fs.rename = rename; }
  assert.equal(first.delivered.length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.receiptPath, 'utf8')).message.status, 'inflight');
  const retry = fakeTransport();
  assert.equal((await runManifest({ ...f, transport: retry })).status, 'blocked');
  assert.deepEqual(retry.prepared, []);
});

test('concurrent invocations cannot prepare or send a second message', async t => {
  const f = await fixture(t);
  let release, started;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const first = fakeTransport({ async beforeDeliver() { started(); await barrier; } });
  const pending = runManifest({ ...f, transport: first });
  await ready;
  const second = fakeTransport();
  try {
    await assert.rejects(runManifest({ ...f, transport: second }), /receipt_locked/);
    assert.deepEqual(second.prepared, []);
  } finally { release(); }
  assert.equal((await pending).ok, true);
  assert.equal(first.delivered.length, 1);
});

test('provider diagnostics retain only whitelisted meaning and a digest, never raw message, URL, target or token', async t => {
  const raw = 'image resource transfer failed: https://' + host + '/secret.png?token=private-signed-url';
  const error = Object.assign(new Error('API Error [/v2/users/private-openid/messages]: ' + raw), {
    status: 400, bizCode: 40034141, bizMessage: raw,
  });
  const f = await fixture(t);
  const result = await runManifest({ ...f, transport: fakeTransport({ deliverError: error }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.message.errorCode, 'qq_rejected');
  assert.equal(result.message.bizCode, 40034141);
  assert.equal(result.message.providerMessage, 'image_resource_transfer_failed');
  assert.equal(result.message.providerMessageSha256, sha256(raw));
  assert.equal(result.message.receiptSha256, undefined);
  assert.equal((await readReceipt(f.receiptPath, f.plan, target.targetSha256)).message.providerMessage,
    'image_resource_transfer_failed');
  const receipt = await fs.readFile(f.receiptPath, 'utf8');
  for (const secret of ['https://', 'private-openid', 'private-signed-url', 'secret.png', host, raw]) {
    assert.equal(receipt.includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  for (const [bizMessage, expected] of [
    ['图片转存失败', 'image_resource_transfer_failed'],
    ['invalid markdown', 'markdown_invalid'], ['permission denied', 'permission_denied'],
    ['content too long', 'content_too_long'], ['too many images', 'too_many_images'],
    ['unexpected raw_url https://example.com/token=private', 'unrecognized_provider_message'],
  ]) assert.equal(providerDiagnostic({ bizMessage }).providerMessage, expected);
  assert.deepEqual(providerDiagnostic({}), {});
  // A code alone is not proof of a specific provider message.
  assert.deepEqual(providerDiagnostic({ bizCode: 40034141 }), {});
});

test('explicit diagnostic mode changes only verification flag and binds its receipt before image preparation', async t => {
  const f = await fixture(t);
  const rawUrl = 'https://' + host + '/card.png?q-signature=private&q-url-param-list=x%2Fy&literal=a+b'
    + '&q-sign-time=1%3B' + (Math.floor(Date.now() / 1000) + 3600);
  const payloads = [];
  for (const forceVerifyImageResource of [true, false]) {
    const imageVerification = forceVerifyImageResource ? 'strict' : 'diagnostic_unverified';
    const receiptPath = path.join(f.directory, imageVerification + '.json');
    const { api, calls } = apiFixture();
    const transport = createTransport(api, target, { forceVerifyImageResource, async prepareImage() {
      const saved = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      assert.equal(saved.imageVerification, imageVerification);
      assert.equal(saved.message.status, 'pending');
      return rawUrl;
    } });
    const result = await runManifest({ ...f, receiptPath, transport, imageVerification });
    assert.equal(result.ok, true);
    assert.equal(result.imageVerification, imageVerification);
    assert.equal(result.preparedStats.imageCount, 1);
    assert.equal(result.preparedStats.imageUrlsWithAmpersands, 1);
    assert.equal(result.preparedStats.imageUrlsReencoded, 0);
    const sends = calls.filter(c => c.kind === 'message');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.markdown.force_verify_image_resource, forceVerifyImageResource);
    assert.ok(sends[0].body.markdown.content.includes('](' + rawUrl + ')'));
    assert.equal(sends[0].body.markdown.content.includes('&amp;'), false);
    payloads.push(sends[0].body);
    const before = await fs.readFile(receiptPath, 'utf8');
    await assert.rejects(runManifest({ ...f, receiptPath, transport: fakeTransport(), imageVerification:
      forceVerifyImageResource ? 'diagnostic_unverified' : 'strict' }), /invalid_delivery_policy|receipt_delivery_mismatch/);
    await assert.rejects(readReceipt(receiptPath, f.plan, undefined,
      forceVerifyImageResource ? 'diagnostic_unverified' : 'strict'), /receipt_delivery_mismatch/);
    assert.equal(await fs.readFile(receiptPath, 'utf8'), before);
  }
  assert.equal(payloads[0].markdown.content, payloads[1].markdown.content);
  assert.notEqual(sha256(canonicalStringify(payloads[0])), sha256(canonicalStringify(payloads[1])));
});

test('diagnostic mode still requires successful image GET and matching SHA before any messages call', async t => {
  const f = await fixture(t);
  const u = uploadFixture({ getBytes: Buffer.from('invalid downloaded PNG') });
  const { api, calls } = apiFixture();
  const transport = createTransport(api, target, { forceVerifyImageResource: false,
    prepareImage: createImagePreparer(u.api, target, { fetchImpl: u.fetchImpl }) });
  const result = await runManifest({ ...f, transport, imageVerification: 'diagnostic_unverified' });
  assert.equal(result.message.errorCode, 'prepare_failed');
  assert.equal(result.imageVerification, 'diagnostic_unverified');
  assert.equal(calls.length, 0);
  assert.equal(u.network.filter(c => c.options.method === 'GET').length, 1);
});

test('diagnostic closure never retries or changes mode after rejection or unknown outcome', async t => {
  for (const deliverError of [Object.assign(new Error('provider refused'), { status: 400, bizCode: 40034141 }),
    new Error('connection closed')]) {
    const f = await fixture(t);
    const { api, calls } = apiFixture({ error: deliverError });
    const transport = createTransport(api, target, { forceVerifyImageResource: false,
      prepareImage: async () => 'https://' + host + '/card.png' });
    const result = await runManifest({ ...f, transport, imageVerification: 'diagnostic_unverified' });
    assert.equal(result.ok, false);
    assert.equal(calls.filter(c => c.kind === 'message').length, 1);
    assert.equal(calls.find(c => c.kind === 'message').body.markdown.force_verify_image_resource, false);
    if (result.message.status === 'unknown') {
      const retry = { ...fakeTransport(), imageVerification: 'diagnostic_unverified' };
      assert.equal((await runManifest({ ...f, transport: retry, imageVerification: 'diagnostic_unverified' })).status, 'blocked');
      assert.deepEqual(retry.prepared, []);
    }
  }
});

test('CLI diagnostic flag is dry-run safe, receipt-bound, and forbidden for positional alerts', async t => {
  const f = await fixture(t);
  const input = path.join(f.directory, 'batch.json');
  await fs.writeFile(input, JSON.stringify(manifest));
  const script = new URL('./send-openclaw-qq.mjs', import.meta.url).pathname;
  const args = [script, '--manifest', input, '--receipt', f.receiptPath, '--root', '/not-a-config', '--dry-run'];
  const diagnostic = spawnSync(process.execPath, [...args, '--diagnostic-unverified-images'], { encoding: 'utf8' });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  assert.equal(JSON.parse(diagnostic.stdout).imageVerification, 'diagnostic_unverified');
  await assert.rejects(fs.access(f.receiptPath));
  await runManifest({ ...f, transport: fakeTransport() });
  const mismatch = spawnSync(process.execPath, [...args, '--diagnostic-unverified-images'], { encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.equal(JSON.parse(mismatch.stdout).errorCode, 'receipt_delivery_mismatch');
  const alert = spawnSync(process.execPath, [script, '--dry-run', '--diagnostic-unverified-images', 'test alert'], { encoding: 'utf8' });
  assert.notEqual(alert.status, 0);
  assert.equal(JSON.parse(alert.stdout).errorCode, 'invalid_delivery_policy');
});
