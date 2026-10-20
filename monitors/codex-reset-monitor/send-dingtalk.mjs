#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { normalizeManifest, canonicalStringify, sha256 } from './sender-manifest.mjs';
import { imageUrl, assertImageValidity, createImagePreparer } from './sender-images.mjs';

// v1.0.37 bot send has no UUID flag or bot-status query. Never retry a dispatch.
export const contract = Object.freeze({
  channel: 'dingtalk', delivery: 'single_markdown', identity: 'R2-D2', scope: 'private',
  imageHosting: 'explicit_qq_upload_only', automaticRetry: false,
  acceptanceIsDelivery: false, cliEntry: 'explicit_private_test_only',
});
// Only digests are checked in. Raw account/bot identifiers and credentials stay local.
export const privateTestPins = Object.freeze({
  targetSha256: 'fedf8eacf5d2655dec8155385d6d914209f6e4ca88d1a50f122bc0a5361a321b',
  botOpenDingTalkIdSha256: '3a731b5625ab01fad417041ca93ce421e33ab89b4d62080c40f967cf698de7c8',
});
const check = (condition, code) => { if (!condition) throw new Error(code); };
const hashPattern = /^[a-f0-9]{64}$/;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:@=-]+$/.test(value);
const escape = text => text.replace(/[\\`*_[\]{}()<>!#|]/g, '\\$&');
const destination = url => url.replace(/[()<>\\]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function privateTarget(target) {
  check(target && Object.keys(target).every(k => ['mode', 'botName', 'robotCode', 'userId',
    'corpId', 'accountUserId', 'profile', 'robotCodeSource'].includes(k)), 'invalid_target');
  check(target.mode === 'bot_private' && target.botName === 'R2-D2'
    && ['robotCode', 'userId', 'corpId', 'accountUserId'].every(k => identifier(target[k]))
    && target.robotCodeSource === 'channels.ddingtalk.clientId', 'invalid_target');
  check(target.profile === undefined || target.profile === `${target.corpId}:${target.accountUserId}`, 'invalid_profile');
  return { ...target, targetSha256: sha256(canonicalStringify(['dingtalk', target.mode,
    target.corpId, target.accountUserId, target.robotCode, target.userId])) };
}

export async function renderDingtalkMarkdown(plan, prepareImage, { dryRun = false, maxMarkdownBytes = 20000 } = {}) {
  check(plan?.version === 2 && plan.delivery === 'single_markdown', 'invalid_manifest');
  check(plan.parts[0]?.type === 'heading', 'heading_required');
  const blocks = [], images = new Map();
  for (const part of plan.parts) {
    if (part.type === 'heading') blocks.push('# ' + escape(part.text.trim()));
    else if (part.type === 'text') blocks.push(escape(part.text.trim()));
    else if (part.type === 'link') blocks.push('[' + escape(part.label).replace(/[\r\n]+/g, ' ')
      + '](' + destination(part.url) + ')');
    else if (part.type === 'image') {
      let url;
      if (dryRun) url = `https://dry-run.invalid/${part.imageSha256}.png`;
      else {
        check(typeof prepareImage === 'function', 'image_host_required');
        const bytes = await fs.readFile(part.path);
        check(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png_required');
        check(sha256(bytes) === part.imageSha256, 'image_changed_during_read');
        if (!images.has(part.imageSha256)) {
          url = imageUrl(await prepareImage(part.path, part.imageSha256)).href;
          assertImageValidity(url);
          images.set(part.imageSha256, url);
        }
        check(sha256(await fs.readFile(part.path)) === part.imageSha256, 'image_changed_during_read');
        url = images.get(part.imageSha256);
      }
      blocks.push('![image](' + destination(url) + ')');
    } else throw new Error('invalid_part');
  }
  const markdown = blocks.join('\n\n');
  check(Number.isSafeInteger(maxMarkdownBytes) && maxMarkdownBytes > 0
    && Buffer.byteLength(markdown) <= maxMarkdownBytes, 'markdown_too_large');
  return { title: plan.parts[0].text, markdown, markdownSha256: sha256(markdown),
    imageCount: plan.parts.filter(p => p.type === 'image').length, imageUrls: [...images.values()] };
}

export function qqUploadOnlyHost(api, qqTarget, { explicitlyEnabled = false, ...options } = {}) {
  check(explicitlyEnabled === true, 'qq_host_opt_in_required');
  // Only the upload methods are exposed; never import the QQ delivery transport.
  const guarded = {
    getAccessToken: (...args) => api.getAccessToken(...args),
    apiRequest(token, method, endpoint, body) {
      const prefix = '/v2/users/' + qqTarget.id + '/';
      check(method === 'POST' && ['upload_prepare', 'upload_part_finish', 'files']
        .some(leaf => endpoint === prefix + leaf), 'qq_messages_forbidden');
      check(!endpoint.endsWith('/files') || body?.srv_send_msg === false, 'qq_messages_forbidden');
      return api.apiRequest(token, method, endpoint, body);
    },
  };
  return { kind: 'qq_upload_only', prepareImage: createImagePreparer(guarded, qqTarget, options) };
}

const execFileAsync = promisify(execFile);
async function dwsText(args) {
  check(['chat message send-by-bot', 'chat message list-direct', 'contact user get-self',
    'chat bot find', 'profile list'].some(command => args.slice(0, command.split(' ').length).join(' ') === command)
    && !args.includes('--group') && !args.includes('--uuid') && !args.includes('--mock'), 'invalid_dws_command');
  // No shell interpolation, raw diagnostics, or retries: they can leak signed URLs.
  try {
    const { stdout } = await execFileAsync('dws', [...args, '--format', 'json'], {
      timeout: 60000, maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch { throw new Error('dws_result_unknown'); }
}
export async function dwsJson(args) { return JSON.parse(await dwsText(args)); }

// Preserve the provider field without assuming a particular CLI success envelope.
// A processQueryKey is acceptance only, never terminal delivery success.
export function botAcceptance(response) {
  const keys = new Set(), paths = []; let rejected = false;
  function visit(value, at = '$', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (value.success === false || value.ok === false || value.error
      || (value.errorCode != null && ![0, '0', ''].includes(value.errorCode))) rejected = true;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'processQueryKey' && typeof child === 'string' && child.trim()) {
        keys.add(child); paths.push(at + '.processQueryKey');
      } else if (/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) visit(child, at + '.' + key, depth + 1);
    }
  }
  visit(response);
  const accepted = !rejected && keys.size === 1;
  return { accepted, ...(accepted ? { processQueryKey: [...keys][0], providerKeyPaths: paths } : {}),
    responseSha256: sha256(canonicalStringify(response)) };
}

export function sendCapabilities(help) {
  for (const flag of ['robot-code', 'users', 'title', 'text']) {
    check(new RegExp('--' + flag + '\\s').test(help), 'dws_bot_send_unavailable');
  }
  return { profile: /--profile\s/.test(help), helpSha256: sha256(help) };
}

export async function assertCurrentIdentity(target, capabilities, cli) {
  const response = await cli(['contact', 'user', 'get-self']);
  const employee = response?.result?.[0]?.orgEmployeeModel;
  check(response?.success === true && response.result.length === 1
    && employee?.corpId === target.corpId && String(employee?.userId) === target.accountUserId,
  'current_identity_mismatch');
  const expectedProfile = `${target.corpId}:${target.accountUserId}`;
  const evidence = { currentProfileSha256: sha256(expectedProfile),
    identityResponseSha256: sha256(canonicalStringify(response)), explicitProfile: capabilities.profile };
  if (capabilities.profile) {
    const profiles = await cli(['profile', 'list']);
    const current = profiles?.profiles?.filter(p => p.isCurrent === true);
    check(profiles?.success === true && current?.length === 1 && current[0].status === 'active'
      && current[0].profile === expectedProfile && current[0].corpId === target.corpId
      && String(current[0].userId) === target.accountUserId, 'current_profile_mismatch');
    evidence.profileResponseSha256 = sha256(canonicalStringify(profiles));
  }
  return evidence;
}

export async function loadPrivateTestTransport(configFile, {
  cli = dwsJson, help = args => dwsText([...args, '--help']), importModule = url => import(url), pins = privateTestPins,
} = {}) {
  const stat = await fs.stat(configFile);
  check(stat.isFile() && !(stat.mode & 0o077)
    && (process.getuid === undefined || stat.uid === process.getuid()), 'private_config_required');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  check(config && Object.keys(config).every(k => ['version', 'openclawRoot', 'imageHosting'].includes(k))
    && config.version === 1 && path.isAbsolute(config.openclawRoot ?? '')
    && config.imageHosting === 'qq_upload_only', 'invalid_private_test_config');
  const root = await fs.realpath(config.openclawRoot);
  const runtime = JSON.parse(await fs.readFile(path.join(root, 'openclaw.json'), 'utf8'));
  const dd = runtime.channels?.ddingtalk;
  check(dd?.enabled === true, 'dingtalk_disabled');
  const capabilities = sendCapabilities(await help(['chat', 'message', 'send-by-bot']));
  const self = await cli(['contact', 'user', 'get-self']);
  check(self.success === true && self.result?.length === 1, 'account_unverified');
  const employee = self.result[0].orgEmployeeModel;
  check(employee?.orgUserName === '宋雨扬' && String(employee.userId) === String(dd.adminUserId), 'account_unverified');
  const target = { mode: 'bot_private', botName: 'R2-D2', robotCode: dd.clientId,
    userId: String(dd.adminUserId), corpId: employee.corpId, accountUserId: String(employee.userId),
    robotCodeSource: 'channels.ddingtalk.clientId' };
  check(privateTarget(target).targetSha256 === pins.targetSha256, 'private_test_target_mismatch');
  if (capabilities.profile) {
    await help(['profile', 'list']);
    const profiles = await cli(['profile', 'list']);
    const current = profiles.profiles?.filter(p => p.isCurrent === true);
    check(profiles.success === true && current?.length === 1 && current[0].status === 'active'
      && current[0].corpId === target.corpId && String(current[0].userId) === target.accountUserId
      && current[0].profile === `${target.corpId}:${target.accountUserId}`, 'profile_unverified');
    target.profile = current[0].profile;
  }
  await help(['chat', 'bot', 'find']);
  const bots = await cli(['chat', 'bot', 'find', '--query', 'R2-D2', '--limit', '20']);
  check(bots.success === true && bots.result?.hasMore === false && bots.result.bots?.length === 1,
    'bot_unverified');
  const bot = bots.result.bots[0];
  check(bot.name === 'R2-D2' && typeof bot.botOpenDingTalkId === 'string'
    && sha256(bot.botOpenDingTalkId) === pins.botOpenDingTalkIdSha256, 'bot_unverified');
  let canReadback = false;
  try {
    const readHelp = await help(['chat', 'message', 'list-direct']);
    canReadback = ['open-dingtalk-id', 'time', 'limit'].every(flag => new RegExp('--' + flag + '\\s').test(readHelp));
  } catch { /* Absence of readback must not prevent the one authorized private test. */ }
  const qq = runtime.channels?.qqbot, account = qq?.accounts?.default ?? qq;
  const admin = qq?.customRuntime?.admins?.find(id => typeof id === 'string' && id.trim());
  check(qq?.enabled !== false && account?.enabled !== false && account?.appId && account?.clientSecret
    && admin && (!admin.startsWith('qqbot:') || admin.startsWith('qqbot:c2c:')), 'qq_host_unavailable');
  const id = admin.replace(/^qqbot:c2c:/, '');
  check(id && !/[\s/]/.test(id), 'qq_host_unavailable');
  let apiPath;
  for (const candidate of ['extensions/openclaw-qqbot', 'extensions/node_modules/@tencent-connect/openclaw-qqbot']) {
    const file = path.join(root, candidate, 'dist/src/api.js');
    try { await fs.access(file); apiPath = file; break; } catch {}
  }
  check(apiPath, 'qq_host_unavailable');
  const api = await importModule(pathToFileURL(apiPath).href);
  check(['getAccessToken', 'apiRequest', 'setApiLogger'].every(k => typeof api[k] === 'function'), 'qq_host_unavailable');
  api.setApiLogger({ info() {}, error() {}, warn() {}, debug() {} });
  const imageHost = qqUploadOnlyHost(api, { id, appId: account.appId, clientSecret: account.clientSecret }, { explicitlyEnabled: true });
  const readback = canReadback ? async () => {
    const since = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .format(new Date(Date.now() - 120000));
    const response = await cli(['chat', 'message', 'list-direct', '--open-dingtalk-id', bot.botOpenDingTalkId,
      '--time', since, '--forward', 'false', '--limit', '20', ...(target.profile ? ['--profile', target.profile] : [])]);
    // The observed history response was empty. Do not guess unseen message fields.
    check(response.success === true && Array.isArray(response.result?.messages), 'readback_unavailable');
    return { status: 'queried', messageCount: response.result.messages.length,
      responseSha256: sha256(canonicalStringify(response)) };
  } : undefined;
  const transport = createDingtalkTransport(target, { imageHost, cli, readback, capabilities });
  transport.identityEvidence = { targetSha256: pins.targetSha256, botOpenDingTalkIdSha256: pins.botOpenDingTalkIdSha256,
    robotCodeSource: target.robotCodeSource, cliHelpSha256: capabilities.helpSha256,
    cliSupportsProfile: capabilities.profile, readbackAvailable: canReadback };
  transport.protectedPaths = [await fs.realpath(configFile), path.join(root, 'openclaw.json'), apiPath];
  return transport;
}

export function createDingtalkTransport(targetInput, { imageHost, cli = dwsJson, verify, readback,
  capabilities, help = args => dwsText([...args, '--help']) } = {}) {
  // A target digest alone never authorizes execution in the CLI's current account.
  // Dispatch checks live identity again after image preparation.
  const target = privateTarget(targetInput);
  return {
    targetSha256: target.targetSha256,
    async prepare(plan) {
      check(imageHost?.kind === 'qq_upload_only' && typeof imageHost.prepareImage === 'function', 'image_host_required');
      const prepared = await renderDingtalkMarkdown(plan, imageHost.prepareImage);
      let used = false;
      return { ...prepared, async dispatch() {
        check(!used, 'dispatch_already_attempted'); used = true;
        for (const url of prepared.imageUrls) assertImageValidity(url);
        const actualCapabilities = capabilities ?? sendCapabilities(await help(['chat', 'message', 'send-by-bot']));
        check(!target.profile || actualCapabilities.profile === true, 'dws_profile_unsupported');
        // Recheck after image preparation, directly before the only possible send.
        const executionIdentityEvidence = await assertCurrentIdentity(target, actualCapabilities, cli);
        const args = ['chat', 'message', 'send-by-bot', '--robot-code', target.robotCode,
          '--users', target.userId, '--title', prepared.title, '--text', prepared.markdown];
        if (actualCapabilities.profile) args.push('--profile', `${target.corpId}:${target.accountUserId}`);
        const response = await cli(args);
        return { ...botAcceptance(response), executionIdentityEvidence };
      }, verify: typeof verify === 'function' ? verify : undefined,
      readback: typeof readback === 'function' ? readback : undefined };
    },
  };
}

export async function persist(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

function verifiedEvidence(evidence, receipt) {
  return evidence?.kind === 'bot_readback' && evidence.targetSha256 === receipt.targetSha256
    && evidence.processQueryKey === receipt.processQueryKey
    && evidence.markdownSha256 === receipt.preparedMarkdownHash
    && typeof evidence.openMessageId === 'string' && evidence.openMessageId.length > 0
    && hashPattern.test(evidence.responseSha256);
}

export async function runDingtalkManifest({ plan, receiptPath, loadTransport, dryRun = false }) {
  if (dryRun) {
    const prepared = await renderDingtalkMarkdown(plan, null, { dryRun: true });
    return { version: 2, channel: 'dingtalk', batchId: plan.batchId, ok: false, status: 'dry_run',
      markdown: prepared.markdown, imageCount: prepared.imageCount, imageHosting: contract.imageHosting };
  }
  check(typeof receiptPath === 'string' && !!receiptPath, 'receipt_required');
  check(!plan.parts.some(p => p.path === path.resolve(receiptPath)), 'receipt_overlaps_image');
  const transport = await loadTransport();
  check(hashPattern.test(transport?.targetSha256), 'invalid_target');
  const actualReceipt = await fs.realpath(receiptPath).catch(error => {
    if (error.code === 'ENOENT') return path.resolve(receiptPath); throw error;
  });
  check(!(transport.protectedPaths ?? []).includes(actualReceipt), 'receipt_overlaps_input');
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await fs.open(receiptPath + '.lock', 'wx', 0o600); }
  catch { throw new Error('receipt_locked'); }
  try {
    let previous, exists = false;
    try { previous = JSON.parse(await fs.readFile(receiptPath, 'utf8')); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_receipt'); }
    if (exists) {
      check(previous && previous.version === 2 && previous.channel === 'dingtalk'
        && previous.delivery === 'single_markdown', 'invalid_receipt');
      check(previous.targetSha256 === transport.targetSha256, 'receipt_target_mismatch');
      check(previous.batchId === plan.batchId && previous.manifestSha256 === plan.manifestSha256
        && previous.imageSetSha256 === plan.imageSetSha256, 'receipt_manifest_mismatch');
      check(['preparing', 'failed', 'inflight', 'unknown', 'complete'].includes(previous.status), 'invalid_receipt');
      check(previous.ok === (previous.status === 'complete'), 'invalid_receipt');
      check(previous.status !== 'complete' || verifiedEvidence(previous.evidence, previous), 'invalid_receipt');
      return previous; // Bot CLI exposes no provider idempotency parameter, even for known failure.
    }
    const receipt = { version: 2, channel: 'dingtalk', delivery: 'single_markdown', batchId: plan.batchId,
      manifestSha256: plan.manifestSha256, imageSetSha256: plan.imageSetSha256,
      targetSha256: transport.targetSha256, imageHosting: contract.imageHosting,
      ...(transport.identityEvidence ? { identityEvidence: transport.identityEvidence } : {}),
      status: 'preparing', ok: false };
    await persist(receiptPath, receipt);
    let prepared;
    try { prepared = await transport.prepare(plan); }
    catch { receipt.status = 'failed'; receipt.errorCode = 'prepare_failed'; await persist(receiptPath, receipt); return receipt; }
    receipt.preparedMarkdownHash = prepared.markdownSha256;
    receipt.status = 'inflight';
    await persist(receiptPath, receipt);
    try {
      const response = await prepared.dispatch();
      receipt.status = 'unknown';
      receipt.accepted = response.accepted;
      receipt.responseSha256 = response.responseSha256;
      if (response.processQueryKey) receipt.processQueryKey = response.processQueryKey;
      if (response.providerKeyPaths) receipt.providerKeyPaths = response.providerKeyPaths;
      if (response.executionIdentityEvidence) receipt.executionIdentityEvidence = response.executionIdentityEvidence;
      receipt.clientAcceptanceRequired = true;
      // Persist acceptance before readback, so a verifier failure cannot erase the provider key.
      await persist(receiptPath, receipt);
      if (response.accepted && prepared.readback) {
        try { receipt.readback = await prepared.readback(); }
        catch { receipt.readback = { status: 'unavailable' }; }
      }
      if (response.accepted && prepared.verify) {
        const evidence = await prepared.verify({ ...receipt });
        if (verifiedEvidence(evidence, receipt)) {
          receipt.evidence = Object.fromEntries(['kind', 'targetSha256', 'processQueryKey',
            'markdownSha256', 'openMessageId', 'responseSha256'].map(k => [k, evidence[k]]));
          receipt.status = 'complete'; receipt.ok = true;
        }
      }
    } catch (error) {
      receipt.status = 'unknown';
      if (['current_identity_mismatch', 'current_profile_mismatch', 'dws_profile_unsupported'].includes(error.message)) {
        receipt.status = 'failed'; receipt.accepted = false; receipt.errorCode = error.message;
      }
    }
    await persist(receiptPath, receipt);
    return receipt;
  } finally { await lock.close(); await fs.unlink(receiptPath + '.lock'); }
}

export async function main(argv = process.argv.slice(2), { loadPrivateTransport = loadPrivateTestTransport,
  loadGroupTransport,
  output = value => process.stdout.write(JSON.stringify(value) + '\n') } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      manifest: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
      'send-private-test': { type: 'boolean', default: false }, config: { type: 'string' }, receipt: { type: 'string' },
      'send-group': { type: 'boolean', default: false },
    } });
    check([values['dry-run'], values['send-private-test'], values['send-group']].filter(Boolean).length === 1,
      'explicit_mode_required');
    check(values['dry-run'] || (values.config && values.receipt), 'private_config_and_receipt_required');
    check(values.manifest, 'manifest_required');
    const file = path.resolve(values.manifest);
    const plan = await normalizeManifest(JSON.parse(await fs.readFile(file, 'utf8')), path.dirname(file));
    const receiptPath = values.receipt ? path.resolve(values.receipt) : undefined;
    if (!values['dry-run']) {
      const protectedPaths = [file, values.config, ...plan.parts.filter(p => p.type === 'image').map(p => p.path)];
      const resolvedReceipt = await fs.realpath(receiptPath).catch(error => {
        if (error.code === 'ENOENT') return receiptPath; throw error;
      });
      check(!(await Promise.all(protectedPaths.map(p => fs.realpath(p)))).includes(resolvedReceipt), 'receipt_overlaps_input');
    }
    if (values['send-group']) {
      const group = await import('./dingtalk-group-transport.mjs');
      const result = await group.runGroupManifest({ plan, receiptPath,
        loadTransport: () => (loadGroupTransport ?? group.loadGroupTransport)(path.resolve(values.config)) });
      output(result);
      return ['accepted', 'readback_confirmed'].includes(result.status) ? 0 : result.status === 'unknown' ? 5 : 4;
    }
    const result = await runDingtalkManifest({ plan, receiptPath, dryRun: values['dry-run'],
      loadTransport: () => loadPrivateTransport(path.resolve(values.config)) });
    output(result);
    return result.status === 'dry_run' || result.ok ? 0 : result.status === 'unknown' ? 5 : 4;
  } catch (error) {
    const publicCodes = new Set(['explicit_mode_required', 'private_config_and_receipt_required', 'manifest_required',
      'private_config_required', 'invalid_private_test_config', 'private_test_target_mismatch', 'account_unverified',
      'profile_unverified', 'bot_unverified', 'dingtalk_disabled', 'dws_bot_send_unavailable', 'dws_profile_unsupported',
      'qq_host_unavailable', 'receipt_overlaps_input', 'receipt_overlaps_image', 'receipt_locked',
      'current_identity_mismatch', 'current_profile_mismatch',
      'invalid_receipt', 'receipt_target_mismatch', 'receipt_manifest_mismatch']);
    for (const code of ['invalid_group_config', 'group_target_mismatch', 'group_unverified',
      'group_bot_unverified', 'group_membership_unverified', 'group_readback_unavailable']) publicCodes.add(code);
    output({ channel: 'dingtalk', ok: false, status: 'blocked',
      errorCode: publicCodes.has(error.message) ? error.message : 'preflight_blocked' });
    return 4;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
  // Group transport imports this module; finish evaluation before loading it.
  main().then(code => { process.exitCode = code; });
}
