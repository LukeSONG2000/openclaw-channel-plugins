const publicHosts = new Set(['gchat.qpic.cn']);
const tokenHosts = new Set(['multimedia.nt.qq.com.cn', 'multimedia.nt.qq.com']);
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const maxImageBytes = 2 * 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

function cdnUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return;
  let url;
  try { url = new URL(value.startsWith('//') ? 'https:' + value : value); } catch { return; }
  if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    !url.hash && (publicHosts.has(url.hostname) || tokenHosts.has(url.hostname))) return url;
}

export function qqImageLocators(attachments) {
  if (!Array.isArray(attachments)) return [];
  const result = [];
  for (const item of attachments.slice(0, 20)) {
    const mime = item?.contentType ?? item?.content_type;
    const url = cdnUrl(item?.url);
    if (imageTypes.has(mime) && url && !result.includes(url.href)) result.push(url.href);
    if (result.length === 4) break;
  }
  return result;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function readQqImages(candidates, { getToken, fetchImage = fetch, signal = AbortSignal.timeout(4000),
  maxBytes = maxImageBytes } = {}) {
  let token;
  const requests = candidates.slice(0, 2).map(async ({ origin, locator }) => {
    const url = cdnUrl(locator);
    if (!url || !['current', 'quote'].includes(origin) || signal.aborted) return;
    try {
      const headers = { accept: 'image/*' };
      if (tokenHosts.has(url.hostname)) {
        token ??= abortable(getToken(), signal);
        const accessToken = await token;
        if (!accessToken) return;
        headers.authorization = 'QQBot ' + accessToken;
      }
      const response = await fetchImage(url, { headers, redirect: 'error', signal });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        return;
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) return;
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, total);
      const mime = imageType(bytes);
      if (mime) return { origin, dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64') };
    } catch { /* An unavailable image must not prevent the text reply. */ }
  });
  return (await Promise.all(requests)).filter(Boolean);
}
