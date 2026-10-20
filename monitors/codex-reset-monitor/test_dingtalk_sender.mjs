import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeManifest, sha256 } from './sender-manifest.mjs';
import { privateTarget, renderDingtalkMarkdown, qqUploadOnlyHost, createDingtalkTransport,
  runDingtalkManifest, contract, main, loadPrivateTestTransport, botAcceptance, sendCapabilities,
  privateTestPins } from './send-dingtalk.mjs';
import { groupTarget, groupPins, groupContract, planProjection, matchGroupHistory,
  loadGroupTransport, runGroupManifest, groupDwsText } from './dingtalk-group-transport.mjs';

const target = { mode: 'bot_private', botName: 'R2-D2', robotCode: 'fixture-bot',
  userId: 'fixture-user', corpId: 'fixture-org', accountUserId: 'fixture-account',
  robotCodeSource: 'channels.ddingtalk.clientId' };
const url = 'https://fixture.cos.myqcloud.com/image.png';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dingtalk-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // Real PNG fixture, not a provider object identifier.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(directory, 'forecast.png'), png);
  const manifest = { version: 2, batchId: 'fixture-regular', delivery: 'single_markdown', parts: [
    { type: 'heading', level: 1, text: 'Codex regular phase' },
    { type: 'link', label: '信息来源', url: 'https://willreset.com/zh/' },
    { type: 'image', path: 'forecast.png' },
    { type: 'heading', level: 1, text: 'Tibo' },
    { type: 'text', text: 'banked phase remains distinct' },
    { type: 'image', path: 'forecast.png' },
    { type: 'link', label: '查看𝕏', url: 'https://x.com/thsottiaux/status/2111566005684289735' },
  ] };
  return { directory, png, manifest, plan: await normalizeManifest(manifest, directory), receiptPath: path.join(directory, 'dingtalk-receipt.json') };
}
function setup(plan, options = {}) {
  const calls = [];
  const send = options.cli ?? (async args => { calls.push(args); return { success: true, processQueryKey: 'fixture-provider-key' }; });
  const transport = createDingtalkTransport(target, { capabilities: { profile: false },
    imageHost: { kind: 'qq_upload_only', prepareImage: async () => url }, ...options,
    cli: async args => {
      if (args.slice(0, 3).join(' ') === 'contact user get-self') return { success: true, result: [{
        orgEmployeeModel: { corpId: target.corpId, userId: target.accountUserId } }] };
      return send(args);
    } });
  return { calls, transport, loadTransport: async () => transport };
}

test('contract never permits personal fallback, group sends or automatic retries', () => {
  assert.equal(contract.identity, 'R2-D2'); assert.equal(contract.scope, 'private');
  assert.equal(contract.automaticRetry, false); assert.equal(contract.acceptanceIsDelivery, false);
});
test('target binds channel, bot, recipient, organization and account', () => {
  const original = privateTarget(target).targetSha256;
  for (const key of ['robotCode', 'userId', 'corpId', 'accountUserId']) {
    assert.notEqual(privateTarget({ ...target, [key]: 'other' }).targetSha256, original);
  }
  assert.equal(privateTarget({ ...target, profile: 'fixture-org:fixture-account' }).targetSha256, original);
});
test('reject group, multiple recipients, guessed robot source and wrong profile', () => {
  for (const patch of [{ mode: 'group' }, { group: 'fixture-group' }, { userId: 'a,b' },
    { robotCodeSource: 'guessed' }, { profile: 'other' }, { botName: 'Other' }]) {
    assert.throws(() => privateTarget({ ...target, ...patch }));
  }
});
test('H1 remains raw; exact order, links, phases, no appended footer', async t => {
  const { plan } = await fixture(t);
  const value = await renderDingtalkMarkdown(plan, async () => url);
  assert.ok(value.markdown.startsWith('# Codex regular phase\n\n'));
  assert.ok(!value.markdown.includes('\\# '));
  assert.ok(value.markdown.indexOf('[信息来源]') < value.markdown.indexOf('![image]'));
  assert.ok(value.markdown.includes('\n\n# Tibo\n\n'));
  assert.ok(value.markdown.includes('banked phase'));
  assert.equal(value.imageCount, 2);
  assert.ok(value.markdown.endsWith('[查看𝕏](https://x.com/thsottiaux/status/2111566005684289735)'));
  assert.ok(!value.markdown.includes('UTC'));
});
test('render deduplicates hosting, not inline image positions', async t => {
  const { plan } = await fixture(t); let uploads = 0;
  const result = await renderDingtalkMarkdown(plan, async () => { uploads++; return url; });
  assert.equal(uploads, 1); assert.equal(result.imageCount, 2);
});
test('dry-run performs no transport load, network, receipt read or write', async t => {
  const { plan, receiptPath, directory } = await fixture(t);
  await fs.writeFile(receiptPath, 'not-json');
  const before = await fs.readdir(directory);
  const result = await runDingtalkManifest({ plan, receiptPath, dryRun: true,
    loadTransport: () => { throw Error('secret_read_forbidden'); } });
  assert.equal(result.status, 'dry_run'); assert.equal(result.ok, false);
  assert.equal(await fs.readFile(receiptPath, 'utf8'), 'not-json');
  assert.deepEqual(await fs.readdir(directory), before);
});
test('QQ host must be explicitly opted in', () => {
  assert.throws(() => qqUploadOnlyHost({}, {}), /qq_host_opt_in_required/);
});
test('QQ upload-only uses PNG MIME, anonymous GET, hash equality and zero messages', async t => {
  const { plan, png } = await fixture(t); const requests = [], fetches = [];
  const api = {
    getAccessToken: async () => 'fixture-token-not-real',
    apiRequest: async (token, method, endpoint, body) => {
      requests.push({ method, endpoint, body });
      if (endpoint.endsWith('/upload_prepare')) return { upload_id: 'fixture-upload',
        block_size: png.length, parts: [{ index: 0, presigned_url: url }] };
      if (endpoint.endsWith('/files')) return { ttl: 3600, raw_url: url };
      return {};
    },
  };
  const host = qqUploadOnlyHost(api, { id: 'fixture-qq-user', appId: 'fixture-qq-app', clientSecret: 'fixture-only' }, {
    explicitlyEnabled: true, fetchImpl: async (address, options) => {
      fetches.push({ address, options });
      return options.method === 'GET'
        ? new Response(png, { headers: { 'content-type': 'image/png' } }) : new Response('');
    },
  });
  assert.equal(await host.prepareImage(plan.parts[2].path, plan.parts[2].imageSha256), url);
  assert.equal(requests.filter(r => r.endpoint.endsWith('/messages')).length, 0);
  assert.equal(requests.find(r => r.endpoint.endsWith('/files')).body.srv_send_msg, false);
  assert.equal(fetches[0].options.headers['Content-Type'], 'image/png');
  assert.equal(fetches[1].options.method, 'GET'); assert.equal(fetches[1].options.headers, undefined);
});
test('missing host blocks without sending or fallback', async t => {
  const { plan } = await fixture(t); let calls = 0;
  await assert.rejects(createDingtalkTransport(target, { cli: () => calls++ }).prepare(plan), /image_host_required/);
  assert.equal(calls, 0);
});
test('host failure, expired URL, changed PNG and too-large content all block', async t => {
  const { plan } = await fixture(t);
  await assert.rejects(renderDingtalkMarkdown(plan, async () => { throw Error('host_down'); }), /host_down/);
  await assert.rejects(renderDingtalkMarkdown(plan, async () => url + '?q-sign-time=1;2'), /image_expiring/);
  await assert.rejects(renderDingtalkMarkdown(plan, async () => url, { maxMarkdownBytes: 1 }), /markdown_too_large/);
  await fs.appendFile(plan.parts[2].path, 'changed');
  await assert.rejects(renderDingtalkMarkdown(plan, async () => url), /image_changed_during_read/);
});
test('one bot CLI call, one recipient, no UUID, no group, real newlines', async t => {
  const { plan } = await fixture(t); const { calls, transport } = setup(plan);
  const prepared = await transport.prepare(plan); await prepared.dispatch();
  assert.equal(calls.length, 1); const args = calls[0];
  assert.deepEqual(args.slice(0, 3), ['chat', 'message', 'send-by-bot']);
  assert.equal(args[args.indexOf('--users') + 1], target.userId);
  assert.ok(!args.includes('--uuid')); assert.ok(!args.includes('--group'));
  assert.ok(args[args.indexOf('--text') + 1].includes('\n\n# Tibo'));
  await assert.rejects(prepared.dispatch(), /dispatch_already_attempted/);
});
test('acceptance is UNKNOWN, persisted provider key is not delivery evidence', async t => {
  const { plan, receiptPath } = await fixture(t); const setupValue = setup(plan);
  const result = await runDingtalkManifest({ plan, receiptPath, ...setupValue });
  assert.equal(result.status, 'unknown'); assert.equal(result.ok, false); assert.equal(result.accepted, true);
  assert.equal(result.processQueryKey, 'fixture-provider-key');
  assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(url));
});
test('unknown and accepted receipts never resend', async t => {
  const { plan, receiptPath } = await fixture(t); const value = setup(plan);
  await runDingtalkManifest({ plan, receiptPath, ...value });
  await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(value.calls.length, 1);
});
test('CLI exit/JSON success without real processQueryKey cannot complete', async t => {
  const { plan, receiptPath } = await fixture(t);
  const value = setup(plan, { cli: async () => ({ success: true, openTaskId: 'fixture-personal-task' }) });
  const result = await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(result.status, 'unknown'); assert.equal(result.accepted, false); assert.equal(result.ok, false);
});
test('timeout and explicit rejection never auto-retry without provider UUID', async t => {
  const { plan, receiptPath } = await fixture(t); let calls = 0;
  const value = setup(plan, { cli: async () => { calls++; throw Error('timeout with sensitive diagnostics'); } });
  await runDingtalkManifest({ plan, receiptPath, ...value });
  const result = await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(calls, 1); assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});
test('known preparation failure remains failed without automatic replay', async t => {
  const { plan, receiptPath } = await fixture(t); let uploads = 0;
  const value = setup(plan, { imageHost: { kind: 'qq_upload_only', prepareImage: async () => { uploads++; throw Error('down'); } } });
  assert.equal((await runDingtalkManifest({ plan, receiptPath, ...value })).status, 'failed');
  await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(uploads, 1); assert.equal(value.calls.length, 0);
});
test('verified readback must bind exact bot target, key, content and provider evidence', async t => {
  const { plan, receiptPath } = await fixture(t);
  const value = setup(plan, { verify: async r => ({ kind: 'bot_readback', targetSha256: r.targetSha256,
    processQueryKey: r.processQueryKey, markdownSha256: r.preparedMarkdownHash,
    openMessageId: 'fixture-message', responseSha256: sha256('fixture-raw-readback'), secret: 'must-not-persist' }) });
  const result = await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(result.status, 'complete'); assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes('must-not-persist'));
});
test('wrong target readback is UNKNOWN, not delivery', async t => {
  const { plan, receiptPath } = await fixture(t);
  const value = setup(plan, { verify: async () => ({ kind: 'bot_readback', targetSha256: sha256('other') }) });
  assert.equal((await runDingtalkManifest({ plan, receiptPath, ...value })).status, 'unknown');
});
test('verifier failure preserves provider key for later reconciliation', async t => {
  const { plan, receiptPath } = await fixture(t); const value = setup(plan, { verify: async () => { throw Error('unavailable'); } });
  const result = await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(result.status, 'unknown'); assert.equal(result.processQueryKey, 'fixture-provider-key');
});
test('cross-channel receipt, target mismatch and lock cannot dispatch', async t => {
  const { plan, receiptPath } = await fixture(t); const value = setup(plan);
  await fs.writeFile(receiptPath, JSON.stringify({ version: 2, channel: 'qq' }));
  await assert.rejects(runDingtalkManifest({ plan, receiptPath, ...value }), /invalid_receipt/);
  await fs.unlink(receiptPath); await runDingtalkManifest({ plan, receiptPath, ...value });
  const other = createDingtalkTransport({ ...target, userId: 'other' });
  await assert.rejects(runDingtalkManifest({ plan, receiptPath, loadTransport: async () => other }), /receipt_target_mismatch/);
  await fs.writeFile(receiptPath + '.lock', '');
  await assert.rejects(runDingtalkManifest({ plan, receiptPath, ...value }), /receipt_locked/);
  assert.equal(value.calls.length, 1);
});
test('null or corrupt receipt cannot be treated as a fresh delivery', async t => {
  const { plan, receiptPath } = await fixture(t); const value = setup(plan);
  for (const content of ['null', 'false', '{}', 'not-json']) {
    await fs.writeFile(receiptPath, content);
    await assert.rejects(runDingtalkManifest({ plan, receiptPath, ...value }), /invalid_receipt/);
  }
  assert.equal(value.calls.length, 0);
});
test('inflight recovery cannot resend, and success cannot be forged by an ok boolean', async t => {
  const { plan, receiptPath } = await fixture(t); const value = setup(plan);
  const original = await runDingtalkManifest({ plan, receiptPath, ...value });
  for (const status of ['inflight', 'preparing']) {
    await fs.writeFile(receiptPath, JSON.stringify({ ...original, status }));
    assert.equal((await runDingtalkManifest({ plan, receiptPath, ...value })).status, status);
  }
  await fs.writeFile(receiptPath, JSON.stringify({ ...original, ok: true }));
  await assert.rejects(runDingtalkManifest({ plan, receiptPath, ...value }), /invalid_receipt/);
  await fs.writeFile(receiptPath, JSON.stringify({ ...original, status: 'complete', ok: true }));
  await assert.rejects(runDingtalkManifest({ plan, receiptPath, ...value }), /invalid_receipt/);
  assert.equal(value.calls.length, 1);
});
test('CLI default cannot send and dry-run requires no runtime credentials', async t => {
  const { directory, manifest } = await fixture(t);
  const file = path.join(directory, 'batch.json'); await fs.writeFile(file, JSON.stringify(manifest));
  const sender = new URL('./send-dingtalk.mjs', import.meta.url).pathname;
  const output = JSON.parse(execFileSync(process.execPath, [sender, '--manifest', file, '--dry-run'], {
    env: { HOME: '/nonexistent', PATH: '/nonexistent' }, encoding: 'utf8',
  }));
  assert.equal(output.status, 'dry_run');
  assert.throws(() => execFileSync(process.execPath, [sender, '--manifest', file], { stdio: 'pipe' }));
});

test('real group CLI resolves its circular import and reaches config validation', async t => {
  const { directory, manifest, receiptPath } = await fixture(t);
  const file = path.join(directory, 'batch.json'), config = path.join(directory, 'group.json');
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(config, JSON.stringify({ version: 0 }), { mode: 0o600 });
  const sender = new URL('./send-dingtalk.mjs', import.meta.url).pathname;
  let failure;
  try {
    execFileSync(process.execPath, [sender, '--manifest', file, '--send-group',
      '--config', config, '--receipt', receiptPath], {
      env: { HOME: '/nonexistent', PATH: '/nonexistent' }, encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.status, 4, 'must not exit 13 from an unresolved top-level await');
  assert.equal(JSON.parse(failure.stdout).errorCode, 'invalid_group_config');
  await assert.rejects(fs.access(receiptPath));
});

const oldHelp = '--robot-code string\n--users string\n--title string\n--text string\n--format string';
async function loaderFixture(t, { modern = false, readback = true } = {}) {
  const value = await fixture(t), calls = [], helps = [];
  const { directory } = value;
  const root = path.join(directory, 'runtime'), modulePath = path.join(root, 'extensions/openclaw-qqbot/dist/src');
  await fs.mkdir(modulePath, { recursive: true }); await fs.writeFile(path.join(modulePath, 'api.js'), '');
  const runtime = { channels: { ddingtalk: { enabled: true, clientId: target.robotCode, adminUserId: target.userId },
    qqbot: { appId: 'fixture-qq', clientSecret: 'fixture-secret-not-real', customRuntime: { admins: ['fixture-qq-user'] } } } };
  await fs.writeFile(path.join(root, 'openclaw.json'), JSON.stringify(runtime));
  const configFile = path.join(directory, 'private-config.json');
  await fs.writeFile(configFile, JSON.stringify({ version: 1, openclawRoot: root, imageHosting: 'qq_upload_only' }), { mode: 0o600 });
  // The fixture account must match the only recipient, as on the deployment host.
  const fixedTarget = { ...target, accountUserId: target.userId };
  const botId = 'fixture-bot-openid-not-real';
  const pins = { targetSha256: privateTarget(fixedTarget).targetSha256, botOpenDingTalkIdSha256: sha256(botId) };
  let imports = 0;
  const dependencies = { pins,
    help: async args => {
      helps.push(args);
      if (args.join(' ') === 'chat message send-by-bot') return oldHelp + (modern ? '\n--profile string' : '');
      if (args.join(' ') === 'chat message list-direct') {
        if (!readback) throw Error('command unavailable');
        return '--open-dingtalk-id string\n--time string\n--limit int';
      }
      return 'available';
    },
    cli: async args => {
      calls.push(args);
      const leaf = args.slice(0, 3).join(' ');
      if (leaf === 'contact user get-self') return { success: true, result: [{ orgEmployeeModel: {
        orgUserName: '宋雨扬', userId: fixedTarget.accountUserId, corpId: target.corpId } }] };
      if (args.slice(0, 2).join(' ') === 'profile list') return { success: true, profiles: [{
        isCurrent: true, status: 'active', profile: `${target.corpId}:${fixedTarget.accountUserId}`,
        corpId: target.corpId, userId: fixedTarget.accountUserId }] };
      if (leaf === 'chat bot find') return { success: true, result: { hasMore: false,
        bots: [{ name: 'R2-D2', botOpenDingTalkId: botId }] } };
      if (leaf === 'chat message list-direct') return { success: true, result: { hasMore: false, messages: [] } };
      if (leaf === 'chat message send-by-bot') return { processQueryKey: 'fixture-provider-key' };
      throw Error('unexpected command');
    },
    importModule: async () => {
      imports++;
      return { setApiLogger() {}, getAccessToken: async () => { throw Error('real upload forbidden in test'); }, apiRequest() {} };
    },
  };
  return { ...value, root, configFile, runtime, calls, helps, dependencies, imports: () => imports };
}

test('old CLI capability pin omits --profile; modern CLI requires explicit profile evidence', async t => {
  for (const modern of [false, true]) {
    const value = await loaderFixture(t, { modern });
    const transport = await loadPrivateTestTransport(value.configFile, value.dependencies);
    assert.equal(transport.identityEvidence.cliSupportsProfile, modern);
    assert.equal(value.calls.some(args => args[0] === 'profile'), modern);
    // Supply a fake host so dispatch assertions exercise the real CLI argument builder without uploads.
    const routed = createDingtalkTransport({ ...target, accountUserId: target.userId,
      ...(modern ? { profile: `${target.corpId}:${target.userId}` } : {}) }, {
      capabilities: sendCapabilities(oldHelp + (modern ? '\n--profile string' : '')),
      imageHost: { kind: 'qq_upload_only', prepareImage: async () => url }, cli: value.dependencies.cli,
    });
    await (await routed.prepare(value.plan)).dispatch();
    assert.equal(value.calls.at(-1).includes('--profile'), modern);
  }
});
test('profile on an unpinned old CLI fails before any dispatch', async t => {
  const { plan } = await fixture(t); let calls = 0;
  const transport = createDingtalkTransport({ ...target, profile: `${target.corpId}:${target.accountUserId}` }, {
    capabilities: { profile: false }, imageHost: { kind: 'qq_upload_only', prepareImage: async () => url }, cli: async () => calls++,
  });
  await assert.rejects((await transport.prepare(plan)).dispatch(), /dws_profile_unsupported/);
  assert.equal(calls, 0);
});
test('private config derives only the pinned live bot/admin, without trusting config IDs', async t => {
  const value = await loaderFixture(t);
  const transport = await loadPrivateTestTransport(value.configFile, value.dependencies);
  assert.equal(transport.targetSha256, value.dependencies.pins.targetSha256);
  assert.equal(value.imports(), 1);
  assert.ok(!JSON.stringify(transport.identityEvidence).includes('fixture-secret'));
  await assert.rejects(loadPrivateTestTransport(value.configFile, { ...value.dependencies, pins: privateTestPins }), /private_test_target_mismatch/);
  for (const patch of [{ userId: 'other' }, { group: 'fixture-group' }, { imageHosting: 'implicit' }]) {
    await fs.writeFile(value.configFile, JSON.stringify({ version: 1, openclawRoot: value.root, imageHosting: 'qq_upload_only', ...patch }));
    await assert.rejects(loadPrivateTestTransport(value.configFile, value.dependencies), /invalid_private_test_config/);
  }
});
test('readback missing is not a send blocker; readback availability is recorded', async t => {
  for (const readback of [true, false]) {
    const value = await loaderFixture(t, { readback });
    const transport = await loadPrivateTestTransport(value.configFile, value.dependencies);
    assert.equal(transport.identityEvidence.readbackAvailable, readback);
  }
});
test('group-readable config and changed runtime admin cannot load a sender', async t => {
  const value = await loaderFixture(t);
  await fs.chmod(value.configFile, 0o644);
  await assert.rejects(loadPrivateTestTransport(value.configFile, value.dependencies), /private_config_required/);
  await fs.chmod(value.configFile, 0o600);
  value.runtime.channels.ddingtalk.adminUserId = 'different';
  await fs.writeFile(path.join(value.root, 'openclaw.json'), JSON.stringify(value.runtime));
  await assert.rejects(loadPrivateTestTransport(value.configFile, value.dependencies), /account_unverified/);
  assert.equal(value.imports(), 0);
});
test('receipt cannot overwrite live runtime credentials', async t => {
  const value = await loaderFixture(t); const transport = await loadPrivateTestTransport(value.configFile, value.dependencies);
  const receiptPath = path.join(value.root, 'openclaw.json'); const before = await fs.readFile(receiptPath);
  await assert.rejects(runDingtalkManifest({ plan: value.plan, receiptPath, loadTransport: async () => transport }), /receipt_overlaps_input/);
  assert.deepEqual(await fs.readFile(receiptPath), before);
});
test('receipt extraction does not assume success/result envelope or promote acceptance to delivery', () => {
  for (const response of [{ processQueryKey: 'fixture-key' }, { success: true, result: { processQueryKey: 'fixture-key' } },
    { data: { processQueryKey: 'fixture-key' } }]) {
    assert.equal(botAcceptance(response).accepted, true);
    assert.equal(botAcceptance(response).processQueryKey, 'fixture-key');
  }
  for (const response of [{ success: true }, { success: false, processQueryKey: 'fixture-key' },
    { result: { processQueryKey: 'first' }, data: { processQueryKey: 'second' } }]) {
    assert.equal(botAcceptance(response).accepted, false);
  }
});
test('explicit private-test CLI runs one mocked bot call and returns accepted/unknown, never exit-zero delivery', async t => {
  const value = await fixture(t), outputs = [], route = setup(value.plan);
  const configFile = path.join(value.directory, 'private.json'); await fs.writeFile(configFile, '{}');
  const manifestFile = path.join(value.directory, 'batch.json'); await fs.writeFile(manifestFile, JSON.stringify(value.manifest));
  const argv = ['--manifest', manifestFile, '--send-private-test', '--config', configFile, '--receipt', value.receiptPath];
  const dependencies = { loadPrivateTransport: async () => route.transport, output: x => outputs.push(x) };
  assert.equal(await main(argv, dependencies), 5);
  assert.equal(outputs.at(-1).status, 'unknown'); assert.equal(outputs.at(-1).accepted, true);
  assert.equal(await main(argv, dependencies), 5); assert.equal(route.calls.length, 1);
});
test('CLI requires exclusive mode plus config and receipt; dry-run ignores supplied secret paths', async t => {
  const { directory, manifest, receiptPath } = await fixture(t), outputs = [];
  const file = path.join(directory, 'batch.json'); await fs.writeFile(file, JSON.stringify(manifest));
  let loads = 0;
  const dependencies = { loadPrivateTransport: async () => { loads++; throw Error('must not load'); }, output: x => outputs.push(x) };
  for (const args of [[], ['--send-private-test'], ['--send-private-test', '--config', '/missing'],
    ['--send-private-test', '--receipt', receiptPath], ['--send-private-test', '--dry-run']]) {
    assert.equal(await main(['--manifest', file, ...args], dependencies), 4);
  }
  assert.equal(await main(['--manifest', file, '--dry-run', '--config', '/missing', '--receipt', '/missing/receipt'], dependencies), 0);
  assert.equal(loads, 0);
});
test('one bounded readback failure keeps acceptance and never retries the send', async t => {
  const { plan, receiptPath } = await fixture(t); let queries = 0;
  const value = setup(plan, { readback: async () => { queries++; throw Error('readback unavailable'); } });
  const receipt = await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(queries, 1); assert.equal(receipt.accepted, true); assert.equal(receipt.status, 'unknown');
  assert.deepEqual(receipt.readback, { status: 'unavailable' }); assert.equal(receipt.clientAcceptanceRequired, true);
  await runDingtalkManifest({ plan, receiptPath, ...value });
  assert.equal(value.calls.length, 1); assert.equal(queries, 1);
});

test('QA P1: omitted profile cannot hide a changed current account or organization on old CLI', async t => {
  const { plan } = await fixture(t);
  for (const changed of [{ accountUserId: 'other-account' }, { corpId: 'other-org' }]) {
    let sends = 0;
    const transport = createDingtalkTransport({ ...target, ...changed }, {
      capabilities: { profile: false }, imageHost: { kind: 'qq_upload_only', prepareImage: async () => url },
      cli: async args => {
        if (args.slice(0, 3).join(' ') === 'contact user get-self') return { success: true, result: [{
          orgEmployeeModel: { corpId: target.corpId, userId: target.accountUserId } }] };
        sends++; return { processQueryKey: 'must-not-send' };
      },
    });
    await assert.rejects((await transport.prepare(plan)).dispatch(), /current_identity_mismatch/);
    assert.equal(sends, 0);
  }
});
test('QA P1: modern CLI deterministically pins omitted profile after live current-profile verification', async t => {
  const { plan } = await fixture(t), calls = [];
  const transport = createDingtalkTransport(target, {
    help: async () => oldHelp + '\n--profile string',
    imageHost: { kind: 'qq_upload_only', prepareImage: async () => url },
    cli: async args => {
      calls.push(args);
      if (args[0] === 'contact') return { success: true, result: [{ orgEmployeeModel: {
        corpId: target.corpId, userId: target.accountUserId } }] };
      if (args[0] === 'profile') return { success: true, profiles: [{ isCurrent: true, status: 'active',
        corpId: target.corpId, userId: target.accountUserId, profile: `${target.corpId}:${target.accountUserId}` }] };
      return { processQueryKey: 'fixture-provider-key' };
    },
  });
  const result = await (await transport.prepare(plan)).dispatch();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1).slice(-2), ['--profile', `${target.corpId}:${target.accountUserId}`]);
  assert.equal(result.executionIdentityEvidence.explicitProfile, true);
});
test('QA P1: current-profile disagreement and identity query failure both prevent sends', async t => {
  const { plan } = await fixture(t);
  for (const failure of ['profile-mismatch', 'identity-query']) {
    let sends = 0;
    const transport = createDingtalkTransport(target, {
      capabilities: { profile: true }, imageHost: { kind: 'qq_upload_only', prepareImage: async () => url },
      cli: async args => {
        if (args[0] === 'contact') {
          if (failure === 'identity-query') throw Error('identity unavailable');
          return { success: true, result: [{ orgEmployeeModel: { corpId: target.corpId, userId: target.accountUserId } }] };
        }
        if (args[0] === 'profile') return { success: true, profiles: [{ isCurrent: true, status: 'active', profile: 'other:account' }] };
        sends++; return { processQueryKey: 'must-not-send' };
      },
    });
    await assert.rejects((await transport.prepare(plan)).dispatch()); assert.equal(sends, 0);
  }
});
test('QA P1: account drift after upload preparation is detected directly before sending', async t => {
  const value = await loaderFixture(t); const baseCli = value.dependencies.cli;
  let selves = 0, sends = 0;
  const cli = async args => {
    if (args.slice(0, 3).join(' ') === 'contact user get-self' && ++selves > 1) return { success: true, result: [{
      orgEmployeeModel: { corpId: target.corpId, userId: 'switched-account' } }] };
    if (args.slice(0, 3).join(' ') === 'chat message send-by-bot') sends++;
    return baseCli(args);
  };
  await loadPrivateTestTransport(value.configFile, { ...value.dependencies, cli });
  const routed = createDingtalkTransport({ ...target, accountUserId: target.userId }, {
    capabilities: { profile: false }, cli, imageHost: { kind: 'qq_upload_only', prepareImage: async () => url },
  });
  const result = await runDingtalkManifest({ plan: value.plan, receiptPath: value.receiptPath, loadTransport: async () => routed });
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'current_identity_mismatch');
  assert.equal(sends, 0);
});

const groupBotId = 'fixture-group-bot-openid', groupAccountId = 'fixture-group-account-openid';
const groupRoute = { mode: 'bot_group', botName: 'R2-D2', robotCode: 'fixture-bot',
  corpId: 'fixture-org', accountUserId: 'fixture-account', groupId: 'cidFixture==',
  robotCodeSource: 'channels.ddingtalk.clientId' };
const groupNow = Date.parse('2026-10-19T12:00:00+08:00');
async function groupFixture(t, { modern = false, images = true } = {}) {
  const value = await fixture(t), calls = [];
  const root = path.join(value.directory, 'runtime'); await fs.mkdir(root);
  const runtime = { channels: { ddingtalk: { enabled: true, clientId: groupRoute.robotCode, adminUserId: groupRoute.accountUserId } } };
  await fs.writeFile(path.join(root, 'openclaw.json'), JSON.stringify(runtime));
  const configFile = path.join(value.directory, 'group.json');
  const config = { version: 1, openclawRoot: root, imageHosting: 'qq_upload_only', groupId: groupRoute.groupId };
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  if (!images) {
    value.manifest.parts = [{ type: 'heading', level: 1, text: 'Health' }, { type: 'text', text: 'Source unavailable' }];
    value.plan = await normalizeManifest(value.manifest, value.directory);
  }
  let history = { success: true, result: { messages: [], hasMore: false } }, sends = 0, uploads = 0;
  const pins = { targetSha256: groupTarget(groupRoute).targetSha256,
    botOpenDingTalkIdSha256: sha256(groupBotId), accountOpenDingTalkIdSha256: sha256(groupAccountId) };
  const help = async args => {
    const leaf = args.join(' ');
    if (leaf === 'chat message send-by-bot') return '--group string\n--robot-code string\n--title string\n--text string'
      + (modern ? '\n--profile string' : '');
    if (leaf === 'chat search') return '--query string\n--limit int';
    if (leaf === 'chat group bots') return '--group string';
    if (leaf === 'chat group members list') return '--id string';
    if (leaf === 'chat message list') return '--group string\n--time string\n--limit int\n--forward bool';
    throw Error('unexpected help');
  };
  const cli = async args => {
    calls.push(args);
    const leaf = args.slice(0, 3).join(' ');
    if (leaf === 'contact user get-self') return { success: true, result: [{ orgEmployeeModel: {
      corpId: groupRoute.corpId, userId: groupRoute.accountUserId, orgUserName: '\u5b8b\u96e8\u626c' } }] };
    if (args[0] === 'profile') return { success: true, profiles: [{ isCurrent: true, status: 'active',
      corpId: groupRoute.corpId, userId: groupRoute.accountUserId, profile: `${groupRoute.corpId}:${groupRoute.accountUserId}` }] };
    if (args[1] === 'search') return { success: true, result: { hasMore: false, groups: [{
      title: '\u0041\u0049\u7ec4\u5185\u901a\u77e5', openConversationId: groupRoute.groupId }] } };
    if (leaf === 'chat group bots') return { success: true, result: { bots: [{ name: 'R2-D2',
      robotCode: groupRoute.robotCode, botOpenDingTalkId: groupBotId, status: 1, isCreator: true, manageable: true }] } };
    if (leaf === 'chat group members') return { success: true, result: { hasMore: false, list: [{ openDingtalkId: groupAccountId }] } };
    if (leaf === 'chat message list') return history;
    if (leaf === 'chat message send-by-bot') { sends++; return { success: true, result: { processQueryKey: 'fixture-group-key' } }; }
    throw Error('unexpected cli');
  };
  const dependencies = { cli, help, pins, imageHost: { kind: 'qq_upload_only',
    prepareImage: async () => { uploads++; return url; } } };
  return { ...value, root, config, configFile, runtime, pins, dependencies, calls,
    sends: () => sends, uploads: () => uploads, setHistory: value => { history = value; } };
}
function groupMessage(plan, patch = {}) {
  const text = plan.parts.filter(p => p.type !== 'image').map(p => p.type === 'link' ? p.label : p.text).join(' \n ');
  return { content: text + '\n' + plan.parts.filter(p => p.type === 'image').map(() => '![image](@fixtureMediaId)').join('\n'),
    createTime: '2026-10-19 12:00:00', openConversationId: groupRoute.groupId,
    openMessageId: 'fixture-group-message', sendType: 'robot', sender: 'R2-D2', senderOpenDingTalkId: groupBotId, ...patch };
}
const historyResponse = (...messages) => ({ success: true, result: { hasMore: false, messages } });
async function groupRun(value, overrides = {}) {
  return runGroupManifest({ plan: value.plan, receiptPath: value.receiptPath,
    loadTransport: () => loadGroupTransport(value.configFile, value.dependencies), now: () => groupNow, ...overrides });
}

test('group-only identity, namespace, contract and actual observed target pin', () => {
  assert.notEqual(groupTarget(groupRoute).targetSha256, privateTarget(target).targetSha256);
  for (const k of ['corpId', 'accountUserId', 'robotCode', 'groupId']) {
    assert.notEqual(groupTarget({ ...groupRoute, [k]: 'other' }).targetSha256, groupTarget(groupRoute).targetSha256);
  }
  assert.throws(() => groupTarget({ ...groupRoute, userId: 'other' }), /invalid_target/);
  assert.equal(groupContract.acceptanceIsDelivery, false);
  assert.equal(groupContract.readbackKind, 'server_history_projection');
  assert.equal(groupPins.targetSha256, groupTarget({ ...groupRoute,
    corpId: 'dingcd17e98b5e38e99e35c2f4657eb6378f', accountUserId: '51135122',
    robotCode: 'dingjt9lppnwihirkjpi', groupId: 'cidyHM8LHTEyQHtHoNc12qsUQ==' }).targetSha256);
});
test('group dispatch is one titled multi-image bot call, no personal or QQ message fallback', async t => {
  for (const modern of [false, true]) {
    const value = await groupFixture(t, { modern });
    const receipt = await groupRun(value);
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.ok, false);
    assert.equal(receipt.accepted, true); assert.equal(receipt.deliveryVerified, false);
    assert.equal(receipt.readbackObserved, false); assert.equal(value.sends(), 1); assert.equal(value.uploads(), 1);
    const send = value.calls.find(a => a[2] === 'send-by-bot');
    assert.equal(send[send.indexOf('--group') + 1], groupRoute.groupId);
    assert.equal(send[send.indexOf('--title') + 1], value.plan.parts[0].text);
    assert.equal((send[send.indexOf('--text') + 1].match(/!\[image\]/g) ?? []).length, 2);
    assert.equal(send.includes('--users'), false); assert.equal(send.includes('--profile'), modern);
    assert.equal(value.calls.at(-1).includes('--forward=true'), true);
  }
});
test('accepted is durable before readback; same receipt is read-only and can observe later', async t => {
  const value = await groupFixture(t); let queries = 0;
  const transport = await loadGroupTransport(value.configFile, value.dependencies);
  const read = transport.readback;
  transport.readback = async receipt => {
    queries++;
    const disk = JSON.parse(await fs.readFile(value.receiptPath));
    assert.equal(disk.accepted, true); assert.equal(disk.processQueryKey, 'fixture-group-key');
    assert.equal(disk.status, 'accepted');
    return read(receipt);
  };
  const options = { loadTransport: async () => transport };
  assert.equal((await groupRun(value, options)).status, 'accepted');
  value.setHistory(historyResponse(groupMessage(value.plan)));
  const receipt = await groupRun(value, options);
  assert.equal(receipt.status, 'readback_confirmed'); assert.equal(receipt.ok, true);
  assert.equal(receipt.readbackObserved, true); assert.equal(receipt.deliveryVerified, false);
  assert.equal(receipt.readback.evidence.providerKeyCorrelated, false);
  assert.equal(receipt.readback.evidence.verifiesImageBytes, false);
  assert.equal(receipt.readback.evidence.verifiesLinkDestinations, false);
  assert.equal(value.sends(), 1); assert.equal(queries, 2);
  assert.deepEqual(await groupRun(value, options), receipt); assert.equal(queries, 2);
});
test('real group history fields: wrong destination/bot/type/time/content/images never complete', async t => {
  const value = await groupFixture(t), receipt = await groupRun(value);
  const valid = groupMessage(value.plan);
  const variants = [{ openConversationId: 'wrong' }, { senderOpenDingTalkId: 'wrong' }, { sendType: 'user' },
    { createTime: '2026-10-19 11:58:00' }, { createTime: '2026-10-19 12:03:00' },
    { createTime: 'not-time' }, { openMessageId: '' }, { content: 'different' },
    { content: valid.content.replace('![image](@fixtureMediaId)', '') },
    { content: valid.content + '\n![image](@anotherId)' }];
  for (const patch of variants) {
    const result = matchGroupHistory(historyResponse({ ...valid, ...patch }), groupRoute, groupBotId, receipt);
    assert.equal(result.status, 'not_found'); assert.equal(result.evidence, undefined);
  }
  const ambiguous = matchGroupHistory(historyResponse(valid, { ...valid, openMessageId: 'second' }), groupRoute, groupBotId, receipt);
  assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.evidence, undefined);
  const partial = matchGroupHistory({ success: true, result: { messages: [valid], hasMore: true } }, groupRoute, groupBotId, receipt);
  assert.equal(partial.status, 'incomplete'); assert.equal(partial.evidence, undefined);
  for (const response of [{ success: false }, { success: true, result: { messages: [] } }]) {
    assert.throws(() => matchGroupHistory(response, groupRoute, groupBotId, receipt), /group_readback_unavailable/);
  }
});
test('group no-image health manifest needs no QQ credentials, imports or image API', async t => {
  const value = await groupFixture(t, { images: false });
  delete value.dependencies.imageHost;
  value.dependencies.importModule = () => { throw Error('must-not-import-qq'); };
  value.setHistory(historyResponse(groupMessage(value.plan)));
  const result = await groupRun(value);
  assert.equal(result.status, 'readback_confirmed'); assert.equal(value.sends(), 1); assert.equal(value.uploads(), 0);
});
test('group readback failures preserve accepted and process key; timeout never retries send', async t => {
  for (const kind of ['readback', 'send']) {
    const value = await groupFixture(t); const base = value.dependencies.cli; let sendCalls = 0;
    value.dependencies.cli = async args => {
      if (args[2] === 'send-by-bot') { sendCalls++; if (kind === 'send') throw Error('secret-timeout'); }
      if (args[2] === 'list' && kind === 'readback') throw Error('secret-readback');
      return base(args);
    };
    const first = await groupRun(value); const second = await groupRun(value);
    assert.equal(sendCalls, 1); assert.equal(second.status, kind === 'send' ? 'unknown' : 'accepted');
    assert.equal(second.accepted, kind !== 'send');
    if (kind === 'readback') assert.equal(second.processQueryKey, 'fixture-group-key');
    assert.ok(!JSON.stringify(first).includes('secret'));
  }
});
test('QA: only a proven prepare-only failure can retry preparation, never an attempted dispatch', async t => {
  const value = await groupFixture(t); let uploads = 0;
  value.dependencies.imageHost.prepareImage = async () => { if (++uploads === 1) throw Error('temporary'); return url; };
  const first = await groupRun(value);
  assert.equal(first.status, 'failed'); assert.equal(first.errorCode, 'prepare_failed');
  assert.equal(Object.hasOwn(first, 'dispatchStartedAt'), false); assert.equal(value.sends(), 0);
  assert.equal((await groupRun(value)).status, 'accepted'); assert.equal(value.sends(), 1); assert.equal(uploads, 2);
  await groupRun(value); assert.equal(value.sends(), 1); assert.equal(uploads, 2);
  for (const patch of [{ dispatchStartedAt: new Date(groupNow).toISOString() }, { processQueryKey: 'key' },
    { dispatchFinishedAt: new Date(groupNow).toISOString() }, { preparedMarkdownHash: sha256('prepared') }]) {
    await fs.writeFile(value.receiptPath, JSON.stringify({ ...first, ...patch }));
    assert.equal((await groupRun(value)).status, 'failed');
  }
  assert.equal(value.sends(), 1); assert.equal(uploads, 2);
});
test('group route rejects duplicate search, absent/changed bot, nonmember and switched account', async t => {
  for (const failure of ['account', 'group', 'bot', 'membership']) {
    const value = await groupFixture(t), base = value.dependencies.cli;
    value.dependencies.cli = async args => {
      const response = await base(args);
      if (failure === 'account' && args[0] === 'contact') response.result[0].orgEmployeeModel.userId = 'wrong';
      if (failure === 'group' && args[1] === 'search') response.result.groups.push(response.result.groups[0]);
      if (failure === 'bot' && args[2] === 'bots') response.result.bots[0].botOpenDingTalkId = 'different-bot';
      if (failure === 'membership' && args[2] === 'members') response.result.list = [];
      return response;
    };
    await assert.rejects(groupRun(value)); assert.equal(value.sends(), 0); assert.equal(value.uploads(), 0);
  }
});
test('group pins reject any other group and config cannot carry personal recipients', async t => {
  const value = await groupFixture(t);
  await assert.rejects(loadGroupTransport(value.configFile, { ...value.dependencies, pins: groupPins }), /group_target_mismatch/);
  for (const patch of [{ groupId: 'another-group' }, { userId: 'someone' }, { profile: 'other' }]) {
    await fs.writeFile(value.configFile, JSON.stringify({ ...value.config, ...patch }));
    await assert.rejects(loadGroupTransport(value.configFile, value.dependencies));
  }
  assert.equal(value.sends(), 0);
});
test('group identity drift between image prep and dispatch fails closed', async t => {
  const value = await groupFixture(t), base = value.dependencies.cli;
  value.dependencies.cli = async args => {
    const response = await base(args);
    if (args[0] === 'contact' && value.uploads() > 0) response.result[0].orgEmployeeModel.corpId = 'switched';
    return response;
  };
  const receipt = await groupRun(value);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.errorCode, 'current_identity_mismatch');
  assert.equal(value.sends(), 0);
});
test('private/QQ/corrupt/group target mismatched receipts cannot be dispatched or upgraded', async t => {
  const value = await groupFixture(t);
  const good = await groupRun(value);
  for (const previous of [null, {}, { ...good, scope: 'private' }, { ...good, channel: 'qq' },
    { ...good, targetSha256: sha256('other') }, { ...good, ok: true },
    { ...good, status: 'readback_confirmed', ok: true, readbackObserved: true }]) {
    await fs.writeFile(value.receiptPath, JSON.stringify(previous));
    await assert.rejects(groupRun(value));
  }
  for (const status of ['preparing', 'inflight', 'unknown', 'failed']) {
    const previous = { ...good, status, accepted: false }; delete previous.processQueryKey;
    await fs.writeFile(value.receiptPath, JSON.stringify(previous));
    assert.equal((await groupRun(value)).status, status);
  }
  assert.equal(value.sends(), 1);
});
test('group receipt lock and runtime overwrite guards protect dispatch', async t => {
  const value = await groupFixture(t);
  await fs.writeFile(value.receiptPath + '.lock', '');
  await assert.rejects(groupRun(value), /receipt_locked/);
  await assert.rejects(groupRun(value, { receiptPath: path.join(value.root, 'openclaw.json') }), /receipt_overlaps_input/);
  assert.equal(value.sends(), 0);
});
test('group CLI mode is explicit/exclusive and does not load private routing', async t => {
  const value = await groupFixture(t), outputs = [];
  const manifestFile = path.join(value.directory, 'batch.json'); await fs.writeFile(manifestFile, JSON.stringify(value.manifest));
  const dependencies = { loadGroupTransport: () => loadGroupTransport(value.configFile, value.dependencies),
    loadPrivateTransport: () => { throw Error('private-forbidden'); }, output: x => outputs.push(x) };
  const args = ['--manifest', manifestFile, '--config', value.configFile, '--receipt', value.receiptPath];
  assert.equal(await main([...args, '--send-group'], dependencies), 0);
  assert.equal(outputs.at(-1).status, 'accepted'); assert.equal(outputs.at(-1).ok, false);
  const createTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .format(new Date(outputs.at(-1).dispatchStartedAt));
  value.setHistory(historyResponse(groupMessage(value.plan, { createTime })));
  assert.equal(await main([...args, '--send-group'], dependencies), 0);
  assert.equal(outputs.at(-1).status, 'readback_confirmed'); assert.equal(outputs.at(-1).deliveryVerified, false);
  for (const extra of [[], ['--send-group', '--send-private-test'], ['--send-group', '--dry-run']]) {
    assert.equal(await main([...args, ...extra], dependencies), 4);
  }
  assert.equal(value.sends(), 1);
});
test('production group CLI wrapper forbids private/raw credential overrides without executing DWS', async () => {
  for (const args of [['chat', 'message', 'send-by-bot', '--users', 'someone'],
    ['chat', 'group', 'members', 'add-bot'], ['chat', 'message', 'send-by-bot', '--mock'],
    ['chat', 'message', 'send-by-bot', '--client-secret=secret']]) {
    await assert.rejects(groupDwsText(args), /invalid_dws_command/);
  }
});
