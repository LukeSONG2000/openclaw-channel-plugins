import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256, httpsUrl, imageDimensions } from './sender-manifest.mjs';

const digest = (bytes, algorithm) => crypto.createHash(algorithm).update(bytes).digest('hex');

export function imageUrl(value) {
  const url = httpsUrl(value, 'invalid_raw_url');
  // Only COS URLs returned by QQ; file_info/file_uuid are never interpreted.
  if (!url.hostname.endsWith('.myqcloud.com') || (url.port && url.port !== '443') || url.hash) throw new Error('invalid_raw_url');
  return url;
}

export function imageExpirySeconds(value) {
  const url = imageUrl(value), ends = [];
  for (const name of ['q-sign-time', 'q-key-time']) {
    const values = url.searchParams.getAll(name);
    if (!values.length) continue;
    if (values.length !== 1 || !/^\d+;\d+$/.test(values[0])) throw new Error('invalid_image_expiry');
    const [start, end] = values[0].split(';').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) throw new Error('invalid_image_expiry');
    ends.push(end);
  }
  if (url.searchParams.has('q-signature') && !ends.length) throw new Error('invalid_image_expiry');
  return ends.length ? Math.min(...ends) : null;
}

export function assertImageValidity(value, nowSeconds = Date.now() / 1000) {
  const expiry = imageExpirySeconds(value);
  // QQ's returned ttl can exceed the actual COS GET signature lifetime.
  if (expiry !== null && expiry - nowSeconds <= 120) throw new Error('image_expiring');
  return expiry;
}

export function uploadParts(prepared, fileSize) {
  const blockSize = Number(prepared?.block_size);
  if (typeof prepared?.upload_id !== 'string' || !prepared.upload_id || !Number.isSafeInteger(blockSize) || blockSize < 1
      || !Array.isArray(prepared.parts) || prepared.parts.length !== Math.ceil(fileSize / blockSize)) throw new Error('invalid_upload_prepare');
  const parts = prepared.parts.map(part => {
    const index = Number(part.index ?? part.part_seq);
    if (!Number.isSafeInteger(index) || index < 0 || (part.index !== undefined && part.part_seq !== undefined
        && Number(part.index) !== Number(part.part_seq))) throw new Error('invalid_upload_prepare');
    return { index, url: imageUrl(part.presigned_url).href, offset: part.offset };
  }).sort((a, b) => a.index - b.index);
  return parts.map((part, position) => {
    // Byte offsets follow returned sequence order, never a hard-coded index base.
    const offset = position * blockSize;
    if ((position && part.index !== parts[position - 1].index + 1)
        || (part.offset !== undefined && Number(part.offset) !== offset)) throw new Error('invalid_upload_prepare');
    return { index: part.index, url: part.url, offset, length: Math.min(blockSize, fileSize - offset) };
  });
}

async function readBounded(response, limit, contentType) {
  if (!response.ok || !response.body) throw new Error('image_get_failed');
  if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== contentType) {
    await response.body.cancel();
    throw new Error('image_get_invalid_type');
  }
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body.cancel(); throw new Error('image_get_too_large'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('image_get_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createImagePreparer(api, target, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 60000 } = {}) {
  return async function prepareImage(file, expectedHash) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error('invalid_image');
    const bytes = await fs.readFile(file);
    if (sha256(bytes) !== expectedHash) throw new Error('image_changed_during_read');
    imageDimensions(bytes);
    const contentType = bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : 'image/webp';
    const token = await api.getAccessToken(target.appId, target.clientSecret);
    const prefix = '/v2/users/' + target.id;
    const prepared = await api.apiRequest(token, 'POST', prefix + '/upload_prepare', {
      file_type: 1, file_name: path.basename(file), file_size: bytes.length,
      md5: digest(bytes, 'md5'), sha1: digest(bytes, 'sha1'), md5_10m: digest(bytes.subarray(0, 10002432), 'md5'),
    });
    for (const part of uploadParts(prepared, bytes.length)) {
      const chunk = bytes.subarray(part.offset, part.offset + part.length);
      const response = await fetchImpl(part.url, { method: 'PUT', body: chunk,
        headers: { 'Content-Type': contentType, 'Content-Disposition': 'inline' },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error('image_put_failed');
      await response.body?.cancel();
      await api.apiRequest(token, 'POST', prefix + '/upload_part_finish', {
        upload_id: prepared.upload_id, part_index: part.index, block_size: chunk.length, md5: digest(chunk, 'md5'),
      });
    }
    const result = await api.apiRequest(token, 'POST', prefix + '/files', {
      upload_id: prepared.upload_id, file_type: 1, file_name: path.basename(file), srv_send_msg: false,
    });
    if (!(Number(result?.ttl) > 0)) throw new Error('invalid_image_ttl');
    const rawUrl = imageUrl(result.raw_url).href;
    assertImageValidity(rawUrl);
    const response = await fetchImpl(rawUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const downloaded = await readBounded(response, bytes.length, contentType);
    if (sha256(downloaded) !== expectedHash) throw new Error('image_get_mismatch');
    assertImageValidity(rawUrl);
    return rawUrl;
  };
}
