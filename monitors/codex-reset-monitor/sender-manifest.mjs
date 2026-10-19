import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const statuses = new Set(['pending', 'inflight', 'sent', 'failed', 'unknown']);
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function check(condition, code) { if (!condition) throw new Error(code); }
function keys(object, allowed) {
  check(object && typeof object === 'object' && !Array.isArray(object), 'invalid_manifest');
  check(Object.keys(object).every(key => allowed.includes(key)), 'invalid_manifest');
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

export async function normalizeManifest(manifest, directory) {
  keys(manifest, ['version', 'batchId', 'parts']);
  check(manifest.version === 1 && typeof manifest.batchId === 'string' && idPattern.test(manifest.batchId), 'invalid_manifest');
  check(Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length <= 1024, 'invalid_manifest');
  const parts = [];
  let bytesRead = 0;
  for (const [partIndex, source] of manifest.parts.entries()) {
    let part;
    if (source?.type === 'text') {
      keys(source, ['type', 'text']);
      check(nonempty(source.text) && source.text.length <= 4000, 'invalid_text');
      part = { type: 'text', text: source.text };
    } else if (source?.type === 'link') {
      keys(source, ['type', 'label', 'url']);
      check(nonempty(source.label) && source.label.length <= 400, 'invalid_link');
      check(nonempty(source.url) && source.url.length <= 3000 && !/[\s\x00-\x1f\x7f]/.test(source.url), 'invalid_link');
      let url;
      try { url = new URL(source.url); } catch { throw new Error('invalid_link'); }
      check(url.protocol === 'https:' && !!url.hostname && !url.username && !url.password, 'invalid_link');
      part = { type: 'link', label: source.label, url: url.href };
    } else if (source?.type === 'image') {
      keys(source, ['type', 'path']);
      check(nonempty(source.path), 'invalid_image');
      const file = path.resolve(directory, source.path);
      const handle = await fs.open(file, 'r');
      let bytes;
      try {
        const stat = await handle.stat();
        check(stat.isFile() && stat.size > 0 && stat.size <= 20 * 1024 * 1024, 'invalid_image');
        check(bytesRead + stat.size <= 64 * 1024 * 1024, 'batch_too_large');
        bytes = await handle.readFile();
        check(bytes.length === stat.size, 'image_changed_during_read');
      } finally { await handle.close(); }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      check(png || jpeg || webp, 'invalid_image');
      bytesRead += bytes.length;
      part = { type: 'image', imageSha256: sha256(bytes), bytes };
    } else { throw new Error('invalid_part'); }
    parts.push({ ...part, partIndex });
  }
  const manifestSha256 = sha256(JSON.stringify({ version: 1, batchId: manifest.batchId,
    parts: parts.map(({ bytes, partIndex, ...part }) => part) }));
  return { version: 1, batchId: manifest.batchId, manifestSha256, parts };
}

function summary(receipt, mode) {
  const next = receipt.parts.findIndex(part => part.status !== 'sent');
  const nextIndex = next === -1 ? receipt.parts.length : next;
  const blocked = receipt.parts.some(part => ['inflight', 'unknown'].includes(part.status));
  const complete = nextIndex === receipt.parts.length;
  const status = mode === 'dry_run' ? 'dry_run' : complete ? 'complete' : blocked ? 'blocked' : 'partial';
  return { version: 1, ok: status === 'complete', batchId: receipt.batchId, status, nextIndex,
    total: receipt.parts.length, parts: receipt.parts.map(part => ({ ...part })) };
}

export async function readReceipt(file, plan, targetSha256) {
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('invalid_receipt'); }
  check(receipt?.version === 1 && receipt.batchId === plan.batchId && receipt.manifestSha256 === plan.manifestSha256, 'receipt_manifest_mismatch');
  check(hashPattern.test(receipt.targetSha256) && (!targetSha256 || receipt.targetSha256 === targetSha256), 'receipt_target_mismatch');
  check(Array.isArray(receipt.parts) && receipt.parts.length === plan.parts.length, 'invalid_receipt');
  let seenPending = false;
  const safeParts = receipt.parts.map((part, index) => {
    check(part?.partIndex === index && statuses.has(part.status), 'invalid_receipt');
    check(!(part.status === 'sent' && seenPending), 'invalid_receipt');
    if (part.status !== 'sent') seenPending = true;
    if (part.status === 'sent') check(hashPattern.test(part.receiptSha256), 'invalid_receipt');
    const safe = { partIndex: index, status: part.status };
    if (hashPattern.test(part.receiptSha256)) safe.receiptSha256 = part.receiptSha256;
    if (['prepare_failed', 'qq_rejected', 'delivery_unknown'].includes(part.errorCode)) safe.errorCode = part.errorCode;
    if (Number.isInteger(part.httpStatus) && part.httpStatus >= 100 && part.httpStatus < 600) safe.httpStatus = part.httpStatus;
    if (Number.isSafeInteger(part.bizCode)) safe.bizCode = part.bizCode;
    return safe;
  });
  return { version: 1, batchId: plan.batchId, manifestSha256: plan.manifestSha256,
    targetSha256: receipt.targetSha256, parts: safeParts };
}

async function persist(file, receipt) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ ...receipt, ...summary(receipt) }, null, 2)}\n`);
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

export async function runManifest({ plan, receiptPath, transport, dryRun = false }) {
  check(typeof receiptPath === 'string' && receiptPath.length > 0, 'receipt_required');
  if (dryRun) {
    const existing = await readReceipt(receiptPath, plan);
    return summary(existing ?? { batchId: plan.batchId,
      parts: plan.parts.map(({ partIndex }) => ({ partIndex, status: 'pending' })) }, 'dry_run');
  }
  check(hashPattern.test(transport?.targetSha256), 'invalid_target');
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await fs.open(`${receiptPath}.lock`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('receipt_locked'); throw error; }
  // Never auto-remove a stale lock: its owner might still send to QQ.
  try {
    const receipt = await readReceipt(receiptPath, plan, transport.targetSha256) ?? {
      version: 1, batchId: plan.batchId, manifestSha256: plan.manifestSha256,
      targetSha256: transport.targetSha256,
      parts: plan.parts.map(({ partIndex }) => ({ partIndex, status: 'pending' })),
    };
    const result = summary(receipt);
    if (result.ok || result.status === 'blocked') return result;
    await persist(receiptPath, receipt);
    for (let index = result.nextIndex; index < plan.parts.length; index++) {
      let deliver;
      try { deliver = await transport.prepare(plan.parts[index]); }
      catch {
        receipt.parts[index] = { partIndex: index, status: 'failed', errorCode: 'prepare_failed' };
        await persist(receiptPath, receipt);
        return summary(receipt);
      }
      receipt.parts[index] = { partIndex: index, status: 'inflight' };
      await persist(receiptPath, receipt);
      let response;
      try {
        response = await deliver();
        if (!response?.id || typeof response.id !== 'string') throw new Error('missing_receipt');
      } catch (error) {
        const rejected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 408;
        const failure = { partIndex: index, status: rejected ? 'failed' : 'unknown',
          errorCode: rejected ? 'qq_rejected' : 'delivery_unknown' };
        if (Number.isInteger(error?.status) && error.status >= 100 && error.status < 600) failure.httpStatus = error.status;
        if (Number.isSafeInteger(error?.bizCode)) failure.bizCode = error.bizCode;
        receipt.parts[index] = failure;
        await persist(receiptPath, receipt);
        return summary(receipt);
      }
      // A disk failure here leaves inflight on disk; it must not invite replay.
      receipt.parts[index] = { partIndex: index, status: 'sent', receiptSha256: sha256(response.id) };
      await persist(receiptPath, receipt);
    }
    return summary(receipt);
  } finally {
    await lock.close();
    await fs.unlink(`${receiptPath}.lock`);
  }
}
