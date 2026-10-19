import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './sender-manifest.mjs';

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

export function markdownLink(label, url) {
  const escaped = label.replace(/[\\`*_[\]{}()<>!#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return `[${escaped}](${url.replace(/[()<>\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)})`;
}

export function createTransport(api, target) {
  let token;
  const accessToken = async () => token ??= await api.getAccessToken(target.appId, target.clientSecret);
  return {
    targetSha256: target.targetSha256,
    async prepare(part) {
      const credential = await accessToken();
      if (part.type === 'image') {
        const uploaded = await api.uploadC2CMedia(credential, target.id, 1, undefined, part.bytes.toString('base64'), false);
        if (typeof uploaded?.file_info !== 'string' || !uploaded.file_info) throw new Error('upload_invalid_response');
        return () => api.sendC2CMediaMessage(credential, target.id, uploaded.file_info);
      }
      if (part.type === 'link') {
        return () => api.apiRequest(credential, 'POST', `/v2/users/${target.id}/messages`, {
          msg_type: 2, markdown: { content: markdownLink(part.label, part.url) },
        });
      }
      return () => api.sendProactiveC2CMessage(credential, target.id, part.text);
    },
  };
}

export async function loadTransport(root = path.join(os.homedir(), '.openclaw')) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'openclaw.json'), 'utf8'));
  const target = administrator(config);
  let modulePath;
  for (const candidate of ['extensions/openclaw-qqbot', 'extensions/node_modules/@tencent-connect/openclaw-qqbot']) {
    const file = path.join(root, candidate, 'dist/src/api.js');
    try { await fs.access(file); modulePath = file; break; } catch {}
  }
  if (!modulePath) throw new Error('plugin_api_unavailable');
  const api = await import(pathToFileURL(modulePath).href);
  for (const name of ['getAccessToken', 'uploadC2CMedia', 'sendC2CMediaMessage', 'sendProactiveC2CMessage', 'apiRequest', 'setApiLogger']) {
    if (typeof api[name] !== 'function') throw new Error('plugin_api_unavailable');
  }
  api.setApiLogger({ info() {}, error() {}, warn() {}, debug() {} });
  api.initApiConfig?.({ markdownSupport: false });
  return createTransport(api, target);
}
