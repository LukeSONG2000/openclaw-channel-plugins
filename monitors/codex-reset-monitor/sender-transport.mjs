import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, canonicalStringify } from './sender-manifest.mjs';
import { createImagePreparer, imageUrl } from './sender-images.mjs';

export function administrator(config) {
  const channel = config?.channels?.qqbot;
  const account = channel?.accounts?.default ?? channel;
  const admins = channel?.customRuntime?.admins;
  // Pin the original first private administrator, without recipient fallback.
  const admin = Array.isArray(admins) ? admins.find(id => typeof id === 'string' && id.trim()) : null;
  if (channel?.enabled === false || account?.enabled === false || !account?.appId || !account?.clientSecret || !admin) {
    throw new Error('administrator_unavailable');
  }
  if (admin.startsWith('qqbot:') && !admin.startsWith('qqbot:c2c:')) throw new Error('administrator_unavailable');
  const id = admin.replace(/^qqbot:c2c:/, '');
  if (!id || /[\s/]/.test(id)) throw new Error('administrator_unavailable');
  return { id, appId: account.appId, clientSecret: account.clientSecret,
    targetSha256: sha256(JSON.stringify(['c2c', account.appId, id])) };
}

function markdownText(text) { return text.replace(/[\\`*_[\]{}()<>!#|]/g, '\\$&'); }
function markdownUrl(url) { return url.replace(/[()<>\\]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()); }
export function markdownLink(label, url) {
  return '[' + markdownText(label).replace(/[\r\n]+/g, ' ') + '](' + markdownUrl(url) + ')';
}

export function createTransport(api, target, {
  prepareImage, maxMarkdownBytes = 64 * 1024, forceVerifyImageResource = true,
} = {}) {
  if (typeof forceVerifyImageResource !== 'boolean') throw new Error('invalid_delivery_policy');
  let token;
  const accessToken = async () => token ??= await api.getAccessToken(target.appId, target.clientSecret);
  return {
    targetSha256: target.targetSha256,
    imageVerification: forceVerifyImageResource ? 'strict' : 'diagnostic_unverified',
    async prepare(plan) {
      const blocks = [], images = new Map(), urls = [];
      for (const part of plan.parts) {
        if (part.type === 'image') {
          if (typeof prepareImage !== 'function') throw new Error('image_provider_unavailable');
          if (sha256(await fs.readFile(part.path)) !== part.imageSha256) throw new Error('image_changed_during_read');
          if (!images.has(part.imageSha256)) images.set(part.imageSha256, imageUrl(await prepareImage(part.path, part.imageSha256)).href);
          if (sha256(await fs.readFile(part.path)) !== part.imageSha256) throw new Error('image_changed_during_read');
          const url = images.get(part.imageSha256);
          urls.push(url);
          blocks.push('![image #' + part.width + 'px #' + part.height + 'px](' + markdownUrl(url) + ')');
        } else if (part.type === 'link') {
          blocks.push(markdownLink(part.label, part.url));
        } else if (part.type === 'text') {
          blocks.push(markdownText(part.text.trim()));
        } else { throw new Error('invalid_part'); }
      }
      // All content, including the single timezone footer, belongs to backend parts.
      const content = blocks.join('\n\n');
      if (!Number.isSafeInteger(maxMarkdownBytes) || maxMarkdownBytes < 1 || Buffer.byteLength(content) > maxMarkdownBytes) {
        throw new Error('markdown_too_large');
      }
      const body = { msg_type: 2, markdown: { content, force_verify_image_resource: forceVerifyImageResource } };
      const preparedStats = {
        contentBytes: Buffer.byteLength(content), contentCharacters: Array.from(content).length, imageCount: urls.length,
        imageUrlMaxCharacters: Math.max(0, ...urls.map(url => url.length)),
        imageUrlMaxQueryCharacters: Math.max(0, ...urls.map(url => new URL(url).search.length)),
        imageUrlsWithLiteralParentheses: urls.filter(url => /[()]/.test(url)).length,
        imageUrlsWithAmpersands: urls.filter(url => url.includes('&')).length,
        imageUrlsReencoded: urls.filter(url => markdownUrl(url) !== url).length,
      };
      const credential = await accessToken();
      let used = false;
      return { preparedMarkdownHash: sha256(canonicalStringify(body)), preparedStats, deliver: () => {
        if (used) throw new Error('delivery_already_attempted');
        used = true;
        return api.apiRequest(credential, 'POST', '/v2/users/' + target.id + '/messages', body);
      } };
    },
    async prepareText(text) {
      if (typeof api.sendProactiveC2CMessage !== 'function') throw new Error('plugin_api_unavailable');
      const credential = await accessToken();
      return () => api.sendProactiveC2CMessage(credential, target.id, text);
    },
  };
}

export async function loadTransport(root = path.join(os.homedir(), '.openclaw'), options = {}) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'openclaw.json'), 'utf8'));
  const target = administrator(config);
  let modulePath;
  for (const candidate of ['extensions/openclaw-qqbot', 'extensions/node_modules/@tencent-connect/openclaw-qqbot']) {
    const file = path.join(root, candidate, 'dist/src/api.js');
    try { await fs.access(file); modulePath = file; break; } catch {}
  }
  if (!modulePath) throw new Error('plugin_api_unavailable');
  const api = await import(pathToFileURL(modulePath).href);
  for (const name of ['getAccessToken', 'apiRequest', 'setApiLogger']) {
    if (typeof api[name] !== 'function') throw new Error('plugin_api_unavailable');
  }
  api.setApiLogger({ info() {}, error() {}, warn() {}, debug() {} });
  return createTransport(api, target, { ...options, prepareImage: options.prepareImage ?? createImagePreparer(api, target) });
}
