import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { canonicalStringify, sha256 } from './sender-manifest.mjs';
import { assertImageValidity } from './sender-images.mjs';
import { renderDingtalkMarkdown, qqUploadOnlyHost, assertCurrentIdentity, botAcceptance, persist } from './send-dingtalk.mjs';

export const groupContract = Object.freeze({ scope: 'group', automaticRetry: false,
  acceptanceIsDelivery: false, readbackKind: 'server_history_projection',
  verifiesImageBytes: false, verifiesLinkDestinations: false, providerKeyCorrelated: false });
// Derived from read-only DWS search/get-self/group bots/members on 2026-10-19.
export const groupPins = Object.freeze({
  targetSha256: '83586e66a30c9dc2cba735eb540c5fe84c82cd436e827a3019e854ed49984b17',
  botOpenDingTalkIdSha256: 'a6be67e76ff4754fc08df0a8f6a5d02481954c32211b2e3b23957107dbbe77dd',
  accountOpenDingTalkIdSha256: 'b47d3b62053fd3c0b8d74a620f317c9f43c3587fc53b930708a06932d7744d6c',
});
const check = (condition, code) => { if (!condition) throw Error(code); };
const hashPattern = /^[a-f0-9]{64}$/;
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const execAsync = promisify(execFile);
export async function groupDwsText(args) {
  const commands = ['contact user get-self', 'profile list', 'chat search', 'chat group bots',
    'chat group members list', 'chat message list', 'chat message send-by-bot'];
  check(commands.some(c => args.slice(0, c.split(' ').length).join(' ') === c)
    && !args.some(x => /^--(?:users?|open-dingtalk-ids?|uuid|mock|client-id|client-secret)(?:=|$)/.test(x)),
  'invalid_dws_command');
  try { return (await execAsync('dws', [...args, '--format', 'json'], { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw Error('dws_result_unknown'); }
}
const groupDwsJson = async args => JSON.parse(await groupDwsText(args));
const localTime = milliseconds => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23' }).format(new Date(milliseconds));
const normalizeText = value => value.replace(/\s+/gu, ' ').trim();

export function groupTarget(target) {
  check(target && Object.keys(target).every(k => ['mode', 'botName', 'robotCode', 'corpId',
    'accountUserId', 'groupId', 'robotCodeSource'].includes(k)), 'invalid_target');
  check(target.mode === 'bot_group' && target.botName === 'R2-D2'
    && ['robotCode', 'corpId', 'accountUserId', 'groupId'].every(k => nonempty(target[k])
      && /^[A-Za-z0-9_.:@=+/-]+$/.test(target[k]))
    && target.robotCodeSource === 'channels.ddingtalk.clientId', 'invalid_target');
  return { ...target, targetSha256: sha256(canonicalStringify(['dingtalk', target.mode,
    target.corpId, target.accountUserId, target.robotCode, target.groupId])) };
}

export function planProjection(plan) {
  return { textSha256: sha256(normalizeText(plan.parts.filter(p => p.type !== 'image')
    .map(p => p.type === 'link' ? p.label : p.text).join(' '))),
  imageCount: plan.parts.filter(p => p.type === 'image').length };
}

// DWS flattens Markdown and appends media-ID images. No link target or image-byte proof is available.
export function matchGroupHistory(response, target, botId, receipt) {
  check(response?.success === true && Array.isArray(response.result?.messages)
    && typeof response.result.hasMore === 'boolean', 'group_readback_unavailable');
  const start = Date.parse(receipt.dispatchStartedAt) - 5000;
  const end = Date.parse(receipt.dispatchFinishedAt) + 120000;
  check(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'invalid_receipt');
  const matches = [];
  for (const message of response.result.messages) {
    if (message.openConversationId !== target.groupId || message.senderOpenDingTalkId !== botId
      || message.sendType !== 'robot' || !nonempty(message.openMessageId) || typeof message.content !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(message.createTime ?? '')) continue;
    const at = Date.parse(message.createTime.replace(' ', 'T') + '+08:00');
    if (!(at >= start && at <= end)) continue;
    let images = 0;
    const text = message.content.replace(/!\[image\]\((@[A-Za-z0-9_=-]+|https:\/\/[^\s()]+)\)/g, (raw, reference) => {
      if (!reference.startsWith('@')) {
        try {
          const url = new URL(reference);
          if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return raw;
        } catch { return raw; }
      }
      images++; return '';
    });
    const projection = { textSha256: sha256(normalizeText(text)), imageCount: images };
    const rawExact = sha256(message.content) === receipt.preparedMarkdownHash;
    const projected = projection.textSha256 === receipt.projection.textSha256
      && projection.imageCount === receipt.projection.imageCount;
    if (rawExact || projected) matches.push({ openMessageId: message.openMessageId, createTime: message.createTime,
      observedContentSha256: sha256(message.content) });
  }
  const readback = { status: matches.length > 1 ? 'ambiguous' : response.result.hasMore ? 'incomplete'
    : matches.length === 1 ? 'matched' : 'not_found', kind: groupContract.readbackKind,
  messageCount: response.result.messages.length, matchCount: matches.length,
  responseSha256: sha256(canonicalStringify(response)) };
  if (readback.status === 'matched') readback.evidence = { ...matches[0], kind: groupContract.readbackKind,
    targetSha256: receipt.targetSha256, botOpenDingTalkIdSha256: sha256(botId),
    markdownSha256: receipt.preparedMarkdownHash, projectionSha256: sha256(canonicalStringify(receipt.projection)),
    responseSha256: readback.responseSha256, providerKeyCorrelated: false,
    verifiesImageBytes: false, verifiesLinkDestinations: false };
  return readback;
}

export async function loadGroupTransport(configFile, { cli = groupDwsJson,
  help = args => groupDwsText([...args, '--help']), pins = groupPins,
  importModule = url => import(url), imageHost: suppliedImageHost } = {}) {
  const stat = await fs.stat(configFile);
  check(stat.isFile() && !(stat.mode & 0o077) && (process.getuid === undefined || stat.uid === process.getuid()),
    'private_config_required');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  check(config?.version === 1 && Object.keys(config).every(k => ['version', 'openclawRoot', 'imageHosting', 'groupId'].includes(k))
    && path.isAbsolute(config.openclawRoot ?? '') && config.imageHosting === 'qq_upload_only'
    && nonempty(config.groupId), 'invalid_group_config');
  const root = await fs.realpath(config.openclawRoot);
  const runtimeFile = path.join(root, 'openclaw.json');
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const dd = runtime.channels?.ddingtalk;
  check(dd?.enabled === true, 'dingtalk_disabled');
  const sendHelp = await help(['chat', 'message', 'send-by-bot']);
  check(['group', 'robot-code', 'title', 'text'].every(f => new RegExp('--' + f + '\\s').test(sendHelp)),
    'dws_bot_send_unavailable');
  const capabilities = { profile: /--profile\s/.test(sendHelp) };
  const self = await cli(['contact', 'user', 'get-self']);
  const employee = self?.result?.[0]?.orgEmployeeModel;
  check(self?.success === true && self.result.length === 1 && employee?.orgUserName === '\u5b8b\u96e8\u626c'
    && String(employee.userId) === String(dd.adminUserId), 'account_unverified');
  const target = groupTarget({ mode: 'bot_group', botName: 'R2-D2', robotCode: dd.clientId,
    corpId: employee.corpId, accountUserId: String(employee.userId), groupId: config.groupId,
    robotCodeSource: 'channels.ddingtalk.clientId' });
  check(target.targetSha256 === pins.targetSha256, 'group_target_mismatch');
  const profileArgs = capabilities.profile ? ['--profile', `${target.corpId}:${target.accountUserId}`] : [];
  for (const [command, flags] of [[['chat', 'search'], ['query', 'limit']],
    [['chat', 'group', 'bots'], ['group']], [['chat', 'group', 'members', 'list'], ['id']],
    [['chat', 'message', 'list'], ['group', 'time', 'limit', 'forward']]]) {
    const text = await help(command);
    check(flags.every(f => new RegExp('--' + f + '\\s').test(text)), 'group_readback_unavailable');
  }
  async function preflight() {
    const identity = await assertCurrentIdentity(target, capabilities, cli);
    const groups = await cli(['chat', 'search', '--query', '\u0041\u0049\u7ec4\u5185\u901a\u77e5', '--limit', '30', ...profileArgs]);
    check(groups?.success === true && groups.result?.hasMore === false && groups.result.groups?.length === 1
      && groups.result.groups[0].title === '\u0041\u0049\u7ec4\u5185\u901a\u77e5'
      && groups.result.groups[0].openConversationId === target.groupId, 'group_unverified');
    const bots = await cli(['chat', 'group', 'bots', '--group', target.groupId, ...profileArgs]);
    const candidates = bots?.result?.bots?.filter(b => b.name === target.botName || b.robotCode === target.robotCode);
    check(bots?.success === true && candidates?.length === 1, 'group_bot_unverified');
    const bot = candidates[0];
    check(bot.name === target.botName && bot.robotCode === target.robotCode && bot.status === 1
      && bot.isCreator === true && bot.manageable === true && nonempty(bot.botOpenDingTalkId)
      && sha256(bot.botOpenDingTalkId) === pins.botOpenDingTalkIdSha256, 'group_bot_unverified');
    const members = await cli(['chat', 'group', 'members', 'list', '--id', target.groupId, ...profileArgs]);
    check(members?.success === true && members.result?.hasMore === false && Array.isArray(members.result.list)
      && members.result.list.filter(m => typeof m.openDingtalkId === 'string'
        && sha256(m.openDingtalkId) === pins.accountOpenDingTalkIdSha256).length === 1, 'group_membership_unverified');
    return { botId: bot.botOpenDingTalkId, identity, groupResponseSha256: sha256(canonicalStringify(groups)),
      botsResponseSha256: sha256(canonicalStringify(bots)), membersResponseSha256: sha256(canonicalStringify(members)) };
  }
  const evidence = await preflight();
  let imageHost = suppliedImageHost;
  async function prepareImage(file, hash) {
    if (!imageHost) {
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
      imageHost = qqUploadOnlyHost(api, { id, appId: account.appId, clientSecret: account.clientSecret }, { explicitlyEnabled: true });
    }
    check(imageHost.kind === 'qq_upload_only', 'image_host_required');
    return imageHost.prepareImage(file, hash);
  }
  const transport = {
    targetSha256: target.targetSha256,
    protectedPaths: [await fs.realpath(configFile), await fs.realpath(runtimeFile)],
    identityEvidence: { targetSha256: target.targetSha256, botOpenDingTalkIdSha256: sha256(evidence.botId),
      cliSupportsProfile: capabilities.profile, cliHelpSha256: sha256(sendHelp),
      groupResponseSha256: evidence.groupResponseSha256, botsResponseSha256: evidence.botsResponseSha256,
      membersResponseSha256: evidence.membersResponseSha256 },
    async prepare(plan) {
      const prepared = await renderDingtalkMarkdown(plan, prepareImage);
      let attempted = false;
      return { ...prepared, async dispatch() {
        check(!attempted, 'dispatch_already_attempted'); attempted = true;
        for (const url of prepared.imageUrls) assertImageValidity(url);
        await preflight();
        // 1.0.37 cannot pin a profile, so check get-self immediately before dispatch as well.
        const identity = await assertCurrentIdentity(target, capabilities, cli);
        const response = await cli(['chat', 'message', 'send-by-bot', '--group', target.groupId,
          '--robot-code', target.robotCode, '--title', prepared.title, '--text', prepared.markdown, ...profileArgs]);
        return { ...botAcceptance(response), executionIdentityEvidence: identity };
      } };
    },
    async readback(receipt) {
      await preflight();
      const response = await cli(['chat', 'message', 'list', '--group', target.groupId,
        '--time', localTime(Date.parse(receipt.dispatchStartedAt) - 5000), '--forward=true', '--limit', '30', ...profileArgs]);
      return matchGroupHistory(response, target, evidence.botId, receipt);
    },
  };
  return transport;
}

function validReadback(receipt, transport) {
  const e = receipt.readback?.evidence;
  return receipt.readback?.status === 'matched' && e?.kind === groupContract.readbackKind
    && e.targetSha256 === receipt.targetSha256 && e.botOpenDingTalkIdSha256 === transport.identityEvidence.botOpenDingTalkIdSha256
    && e.markdownSha256 === receipt.preparedMarkdownHash && e.projectionSha256 === sha256(canonicalStringify(receipt.projection))
    && nonempty(e.openMessageId) && hashPattern.test(e.responseSha256) && hashPattern.test(e.observedContentSha256)
    && e.providerKeyCorrelated === false && e.verifiesImageBytes === false && e.verifiesLinkDestinations === false;
}

export async function runGroupManifest({ plan, receiptPath, loadTransport, now = () => Date.now() }) {
  check(nonempty(receiptPath), 'receipt_required');
  const transport = await loadTransport();
  check(hashPattern.test(transport?.targetSha256), 'invalid_target');
  const actual = await fs.realpath(receiptPath).catch(e => { if (e.code === 'ENOENT') return path.resolve(receiptPath); throw e; });
  check(!(transport.protectedPaths ?? []).includes(actual) && !plan.parts.some(p => p.path === actual), 'receipt_overlaps_input');
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await fs.open(receiptPath + '.lock', 'wx', 0o600); } catch { throw Error('receipt_locked'); }
  try {
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); check(receipt, 'invalid_receipt'); }
    catch (e) { if (e.code !== 'ENOENT') throw Error('invalid_receipt'); }
    if (receipt) {
      check(receipt.version === 2 && receipt.channel === 'dingtalk' && receipt.scope === 'group'
        && receipt.delivery === 'single_markdown' && receipt.deliveryVerified === false, 'invalid_receipt');
      check(receipt.targetSha256 === transport.targetSha256, 'receipt_target_mismatch');
      check(receipt.batchId === plan.batchId && receipt.manifestSha256 === plan.manifestSha256
        && receipt.imageSetSha256 === plan.imageSetSha256, 'receipt_manifest_mismatch');
      check(['preparing', 'inflight', 'unknown', 'failed', 'accepted', 'readback_confirmed'].includes(receipt.status)
        && receipt.ok === (receipt.status === 'readback_confirmed')
        && receipt.readbackObserved === receipt.ok, 'invalid_receipt');
      check(!(receipt.status === 'accepted' || (receipt.status === 'readback_confirmed' && receipt.accepted === true))
        || (receipt.accepted === true && nonempty(receipt.processQueryKey) && hashPattern.test(receipt.responseSha256)
          && hashPattern.test(receipt.preparedMarkdownHash)), 'invalid_receipt');
      if (receipt.status === 'readback_confirmed' && receipt.accepted !== true) {
        check(receipt.accepted === false && receipt.acceptanceUnconfirmed === true
          && ['unknown', 'inflight'].includes(receipt.recoveredFromStatus)
          && hashPattern.test(receipt.preparedMarkdownHash)
          && Number.isFinite(Date.parse(receipt.dispatchStartedAt))
          && Number.isFinite(Date.parse(receipt.dispatchFinishedAt)), 'invalid_receipt');
      }
      check(canonicalStringify(receipt.projection) === canonicalStringify(planProjection(plan)), 'invalid_receipt');
      if (receipt.ok) { check(validReadback(receipt, transport), 'invalid_receipt'); return receipt; }
      // Old private/unknown receipts are never migrated. Group retries are read-only.
      const safePrepareRetry = receipt.status === 'failed' && receipt.errorCode === 'prepare_failed'
        && receipt.accepted === false && !Object.hasOwn(receipt, 'dispatchStartedAt')
        && !Object.hasOwn(receipt, 'dispatchFinishedAt') && !Object.hasOwn(receipt, 'processQueryKey')
        && !Object.hasOwn(receipt, 'preparedMarkdownHash');
      if (safePrepareRetry) receipt = undefined;
      else if ((receipt.accepted !== true || !nonempty(receipt.processQueryKey))
        && !(['unknown', 'inflight'].includes(receipt.status)
          && hashPattern.test(receipt.preparedMarkdownHash)
          && Number.isFinite(Date.parse(receipt.dispatchStartedAt))
          && Number.isFinite(Date.parse(receipt.dispatchFinishedAt)))) return receipt;
    }
    if (!receipt) {
      receipt = { version: 2, channel: 'dingtalk', scope: 'group', delivery: 'single_markdown', batchId: plan.batchId,
        manifestSha256: plan.manifestSha256, imageSetSha256: plan.imageSetSha256, targetSha256: transport.targetSha256,
        identityEvidence: transport.identityEvidence, imageHosting: 'explicit_qq_upload_only', projection: planProjection(plan),
        status: 'preparing', ok: false, accepted: false, deliveryVerified: false, readbackObserved: false };
      await persist(receiptPath, receipt);
      let prepared;
      try { prepared = await transport.prepare(plan); }
      catch { receipt.status = 'failed'; receipt.errorCode = 'prepare_failed'; await persist(receiptPath, receipt); return receipt; }
      receipt.preparedMarkdownHash = prepared.markdownSha256;
      receipt.dispatchStartedAt = new Date(now()).toISOString();
      receipt.status = 'inflight';
      await persist(receiptPath, receipt);
      try {
        const response = await prepared.dispatch();
        receipt.accepted = response.accepted;
        receipt.responseSha256 = response.responseSha256;
        if (response.processQueryKey) receipt.processQueryKey = response.processQueryKey;
        if (response.providerKeyPaths) receipt.providerKeyPaths = response.providerKeyPaths;
        if (response.executionIdentityEvidence) receipt.executionIdentityEvidence = response.executionIdentityEvidence;
        receipt.status = response.accepted ? 'accepted' : 'unknown';
      } catch (error) {
        receipt.status = 'unknown';
        const known = ['current_identity_mismatch', 'current_profile_mismatch', 'group_unverified',
          'group_bot_unverified', 'group_membership_unverified'];
        if (known.includes(error.message)) { receipt.status = 'failed'; receipt.errorCode = error.message; }
      }
      receipt.dispatchFinishedAt = new Date(now()).toISOString();
      // Acceptance is durable before any history query, which can fail independently.
      await persist(receiptPath, receipt);
    }
    const recoverable = ['unknown', 'inflight'].includes(receipt.status)
      && hashPattern.test(receipt.preparedMarkdownHash)
      && Number.isFinite(Date.parse(receipt.dispatchStartedAt))
      && Number.isFinite(Date.parse(receipt.dispatchFinishedAt));
    if (receipt.accepted || recoverable) {
      try {
        receipt.readback = await transport.readback(receipt);
        if (validReadback(receipt, transport)) {
          if (!receipt.accepted) {
            // History proves a matching message, not a missing provider acceptance key.
            receipt.acceptanceUnconfirmed = true;
            receipt.recoveredFromStatus = receipt.status;
          }
          receipt.status = 'readback_confirmed'; receipt.ok = true; receipt.readbackObserved = true;
        }
      } catch { receipt.readback = { status: 'unavailable', kind: groupContract.readbackKind }; }
      await persist(receiptPath, receipt);
    }
    return receipt;
  } finally { await lock.close(); await fs.unlink(receiptPath + '.lock'); }
}
