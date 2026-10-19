import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const statuses = new Set(['pending', 'inflight', 'sent', 'failed', 'unknown']);
const providerMessages = new Map([
  ['image_resource_transfer_failed', /图片(?:资源)?(?:下载|转存)(?:失败|异常)|(?:image|picture)[ _-]*(?:resource[ _-]*)?(?:transfer|download|upload|transload)[ _-]*(?:fail(?:ed|ure)?|error)|failed to (?:transfer|download)(?: the)? (?:image|picture)/i],
  ['markdown_invalid', /(?:invalid|malformed)[ _-]*markdown|markdown(?:消息)?(?:内容|参数|格式|语法)(?:错误|无效)|无效的markdown/i],
  ['permission_denied', /permission[ _-]*denied|(?:no|missing|insufficient)[ _-]*permission|无(?:markdown|Markdown)?(?:模板|模版)?权限/i],
  ['content_too_long', /(?:message|content|markdown)[ _-]*(?:length[ _-]*)?(?:too[ _-]*long|exceed(?:s|ed)?[ _-]*(?:the[ _-]*)?limit)|(?:消息|内容|字数|长度)(?:长度)?(?:超限|超过限制)/i],
  ['too_many_images', /too[ _-]*many[ _-]*(?:images|pictures)|图片数量(?:超限|超过限制)/i],
]);

export function providerDiagnostic(error) {
  const source = typeof error?.bizMessage === 'string' ? error.bizMessage
    : typeof error?.message === 'string' ? error.message : null;
  if (!source) return {};
  // Persist only a fixed vocabulary and a digest, never the wrapper path or raw text.
  const text = source.replace(/https?:\/\/[^\s<>"']+/gi, '[url]');
  const providerMessage = [...providerMessages].find(([, pattern]) => pattern.test(text))?.[0]
    ?? 'unrecognized_provider_message';
  return { providerMessage, providerMessageSha256: sha256(source) };
}

function check(condition, code) { if (!condition) throw new Error(code); }
function keys(object, allowed, code = 'invalid_manifest') {
  check(object && typeof object === 'object' && !Array.isArray(object), code);
  check(Object.keys(object).every(key => allowed.includes(key)), code);
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

// Matches Python digest_json for the validated manifest's strings and integer version.
export function canonicalStringify(value) {
  if (typeof value === 'string') {
    check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'invalid_manifest');
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    check(Number.isSafeInteger(value) && !Object.is(value, -0), 'invalid_manifest');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_manifest');
  const compare = (a, b) => {
    const left = Array.from(a, c => c.codePointAt(0)), right = Array.from(b, c => c.codePointAt(0));
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return left.length - right.length;
  };
  return '{' + Object.keys(value).sort(compare).map(key => canonicalStringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
}

export function httpsUrl(value, code = 'invalid_link') {
  check(nonempty(value) && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value), code);
  let url;
  try { url = new URL(value); } catch { throw new Error(code); }
  check(url.protocol === 'https:' && !!url.hostname && !url.username && !url.password, code);
  return url;
}

export function imageDimensions(bytes) {
  let width, height;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1];
      if (marker === 255) { offset++; continue; }
      if (marker === 217 || marker === 218) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;
      }
      offset += 2 + length;
    }
  }
  check(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, 'invalid_image');
  return { width, height };
}

export async function normalizeManifest(manifest, directory) {
  check(manifest?.version !== 1, 'legacy_manifest_requires_reconciliation');
  keys(manifest, ['version', 'batchId', 'delivery', 'parts']);
  check(manifest.version === 2 && manifest.delivery === 'single_markdown'
    && typeof manifest.batchId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(manifest.batchId), 'invalid_manifest');
  check(Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length <= 1024, 'invalid_manifest');
  const parts = [];
  let bytesRead = 0;
  for (const source of manifest.parts) {
    if (source?.type === 'text') {
      keys(source, ['type', 'text']);
      check(nonempty(source.text) && source.text.length <= 4000, 'invalid_text');
      parts.push({ type: 'text', text: source.text });
    } else if (source?.type === 'heading') {
      keys(source, ['type', 'level', 'text']);
      check(source.level === 1 && nonempty(source.text) && source.text.length <= 400
        && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/u.test(source.text), 'invalid_heading');
      parts.push({ type: 'heading', level: 1, text: source.text });
    } else if (source?.type === 'link') {
      keys(source, ['type', 'label', 'url']);
      check(nonempty(source.label) && source.label.length <= 400, 'invalid_link');
      parts.push({ type: 'link', label: source.label, url: httpsUrl(source.url).href });
    } else if (source?.type === 'image') {
      keys(source, ['type', 'path']);
      check(nonempty(source.path) && !path.isAbsolute(source.path), 'invalid_image');
      const base = await fs.realpath(directory);
      const file = await fs.realpath(path.resolve(base, source.path));
      check(file.startsWith(base + path.sep), 'invalid_image');
      const handle = await fs.open(file, 'r');
      let bytes;
      try {
        const stat = await handle.stat();
        check(stat.isFile() && stat.size > 0 && stat.size <= 20 * 1024 * 1024, 'invalid_image');
        check(bytesRead + stat.size <= 64 * 1024 * 1024, 'batch_too_large');
        bytes = await handle.readFile();
        check(bytes.length === stat.size, 'image_changed_during_read');
      } finally { await handle.close(); }
      bytesRead += bytes.length;
      parts.push({ type: 'image', path: file, imageSha256: sha256(bytes), ...imageDimensions(bytes) });
    } else { throw new Error('invalid_part'); }
  }
  return { version: 2, batchId: manifest.batchId, delivery: 'single_markdown',
    manifestSha256: sha256(canonicalStringify(manifest)),
    imageSetSha256: sha256(canonicalStringify(parts.filter(p => p.type === 'image').map(p => p.imageSha256))), parts };
}

function summary(receipt, mode) {
  const message = { ...receipt.message };
  const status = mode === 'dry_run' ? 'dry_run' : message.status === 'sent' ? 'complete'
    : ['inflight', 'unknown'].includes(message.status) ? 'blocked' : message.status;
  return { ...receipt, message, status, ok: status === 'complete' };
}

export async function readReceipt(file, plan, targetSha256, imageVerification = 'strict') {
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('invalid_receipt'); }
  check(receipt?.version !== 1, 'legacy_receipt_requires_reconciliation');
  keys(receipt, ['version', 'batchId', 'delivery', 'manifestSha256', 'imageSetSha256', 'targetSha256',
    'preparedMarkdownHash', 'preparedStats', 'imageVerification', 'message', 'status', 'ok'], 'invalid_receipt');
  // Pre-switch v2 receipts were exclusively strict; never reinterpret them as diagnostics.
  const recordedPolicy = receipt.imageVerification ?? 'strict';
  check(['strict', 'diagnostic_unverified'].includes(recordedPolicy) && recordedPolicy === imageVerification,
    'receipt_delivery_mismatch');
  check(receipt.version === 2 && receipt.delivery === 'single_markdown' && receipt.batchId === plan.batchId
    && receipt.manifestSha256 === plan.manifestSha256, 'receipt_manifest_mismatch');
  check(receipt.imageSetSha256 === plan.imageSetSha256, 'receipt_image_mismatch');
  check(hashPattern.test(receipt.targetSha256) && (!targetSha256 || receipt.targetSha256 === targetSha256), 'receipt_target_mismatch');
  const message = receipt.message;
  check(message && statuses.has(message.status), 'invalid_receipt');
  keys(message, ['status', 'receiptSha256', 'errorCode', 'httpStatus', 'bizCode',
    'providerMessage', 'providerMessageSha256'], 'invalid_receipt');
  if (['inflight', 'unknown', 'sent'].includes(message.status) || message.errorCode === 'qq_rejected') {
    check(hashPattern.test(receipt.preparedMarkdownHash), 'invalid_receipt');
  }
  if (receipt.preparedMarkdownHash !== undefined) check(hashPattern.test(receipt.preparedMarkdownHash), 'invalid_receipt');
  if (receipt.preparedStats !== undefined) {
    keys(receipt.preparedStats, ['contentBytes', 'contentCharacters', 'imageCount', 'imageUrlMaxCharacters',
      'imageUrlMaxQueryCharacters', 'imageUrlsWithLiteralParentheses', 'imageUrlsWithAmpersands', 'imageUrlsReencoded',
      'imageUrlEarliestExpirySeconds'], 'invalid_receipt');
    check(Object.values(receipt.preparedStats).every(value => Number.isSafeInteger(value) && value >= 0), 'invalid_receipt');
  }
  if (message.status === 'sent') check(hashPattern.test(message.receiptSha256), 'invalid_receipt');
  if (message.receiptSha256 !== undefined) check(message.status === 'sent' && hashPattern.test(message.receiptSha256), 'invalid_receipt');
  const expectedError = message.status === 'failed' ? ['prepare_failed', 'qq_rejected']
    : message.status === 'unknown' ? ['delivery_unknown'] : [];
  check(expectedError.length ? expectedError.includes(message.errorCode) : message.errorCode === undefined, 'invalid_receipt');
  if (message.httpStatus !== undefined) check(Number.isInteger(message.httpStatus) && message.httpStatus >= 100 && message.httpStatus < 600, 'invalid_receipt');
  if (message.bizCode !== undefined) check(Number.isSafeInteger(message.bizCode), 'invalid_receipt');
  if (message.providerMessage !== undefined || message.providerMessageSha256 !== undefined) {
    check(['failed', 'unknown'].includes(message.status)
      && (providerMessages.has(message.providerMessage) || message.providerMessage === 'unrecognized_provider_message')
      && hashPattern.test(message.providerMessageSha256), 'invalid_receipt');
  }
  const result = summary(receipt);
  check(result.ok === receipt.ok && result.status === receipt.status, 'invalid_receipt');
  return result;
}

async function persist(file, receipt) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(summary(receipt), null, 2) + '\n');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function runManifest({ plan, receiptPath, transport, dryRun = false, imageVerification = 'strict' }) {
  check(plan?.version === 2 && plan.delivery === 'single_markdown', 'invalid_manifest');
  check(typeof receiptPath === 'string' && receiptPath.length > 0, 'receipt_required');
  check(['strict', 'diagnostic_unverified'].includes(imageVerification), 'invalid_delivery_policy');
  const initial = { version: 2, batchId: plan.batchId, delivery: 'single_markdown',
    imageVerification, manifestSha256: plan.manifestSha256, imageSetSha256: plan.imageSetSha256, message: { status: 'pending' } };
  if (dryRun) return summary(await readReceipt(receiptPath, plan, undefined, imageVerification) ?? initial, 'dry_run');
  check(hashPattern.test(transport?.targetSha256) && typeof transport.prepare === 'function', 'invalid_target');
  check((transport.imageVerification ?? 'strict') === imageVerification, 'invalid_delivery_policy');
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await fs.open(receiptPath + '.lock', 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('receipt_locked'); throw error; }
  // Never remove someone else's stale lock: its owner might still send to QQ.
  try {
    const receipt = await readReceipt(receiptPath, plan, transport.targetSha256, imageVerification)
      ?? { ...initial, targetSha256: transport.targetSha256 };
    const result = summary(receipt);
    if (result.ok || result.status === 'blocked') return result;
    receipt.message = { status: 'pending' };
    delete receipt.preparedMarkdownHash;
    delete receipt.preparedStats;
    await persist(receiptPath, receipt);
    let prepared;
    try {
      prepared = await transport.prepare(plan);
      check(hashPattern.test(prepared?.preparedMarkdownHash) && typeof prepared.deliver === 'function', 'invalid_preparation');
    } catch {
      receipt.message = { status: 'failed', errorCode: 'prepare_failed' };
      await persist(receiptPath, receipt);
      return summary(receipt);
    }
    receipt.preparedMarkdownHash = prepared.preparedMarkdownHash;
    if (prepared.preparedStats) receipt.preparedStats = prepared.preparedStats;
    receipt.message = { status: 'inflight' };
    await persist(receiptPath, receipt);
    let response;
    try {
      response = await prepared.deliver();
      check(nonempty(response?.id), 'missing_receipt');
    } catch (error) {
      const rejected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
        && error.status !== 408 && Number.isSafeInteger(error.bizCode);
      receipt.message = { status: rejected ? 'failed' : 'unknown', errorCode: rejected ? 'qq_rejected' : 'delivery_unknown',
        ...providerDiagnostic(error) };
      if (Number.isInteger(error?.status) && error.status >= 100 && error.status < 600) receipt.message.httpStatus = error.status;
      if (Number.isSafeInteger(error?.bizCode)) receipt.message.bizCode = error.bizCode;
      await persist(receiptPath, receipt);
      return summary(receipt);
    }
    // Failed persistence leaves inflight on disk, never a replay invitation.
    receipt.message = { status: 'sent', receiptSha256: sha256(response.id) };
    await persist(receiptPath, receipt);
    return summary(receipt);
  } finally {
    await lock.close();
    await fs.unlink(receiptPath + '.lock');
  }
}
