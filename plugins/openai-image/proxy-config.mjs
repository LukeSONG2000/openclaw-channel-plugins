import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const URL = 'https://api.openai.com/v1/models';
const FILTER = '日本[ _#-]*0?2([^0-9]|$)';

export function proxyConfig(subscriptions) {
  if (!Array.isArray(subscriptions) || subscriptions.length !== 2 || new Set(subscriptions).size !== 2 ||
      subscriptions.some((url) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    throw new Error('Expected two distinct HTTPS subscriptions');
  }
  const providers = Object.fromEntries(subscriptions.map((url, index) => [`image-${index + 1}`, {
    type: 'http', url, path: `./image-${index + 1}.yaml`, interval: 1800, filter: '日本',
    'exclude-filter': '下载专用', proxy: 'DIRECT',
    header: { 'User-Agent': ['Clash'] },
    'health-check': { enable: true, url: URL, interval: 180, timeout: 5000, lazy: false, 'expected-status': 401 },
    override: { 'additional-prefix': `[${index + 1}] ` },
  }]));
  const health = { type: 'fallback', url: URL, interval: 180, lazy: false, 'expected-status': 401 };
  return {
    'mixed-port': 17979, 'allow-lan': false, 'bind-address': '127.0.0.1',
    mode: 'rule', 'log-level': 'silent',
    'external-controller-unix': 'control.sock',
    'proxy-providers': providers,
    'proxy-groups': [
      { ...health, name: 'OPENAI-IMAGE', proxies: ['JAPAN-2', 'JAPAN-ALTERNATE', 'REJECT'] },
      { ...health, name: 'JAPAN-2', proxies: ['REJECT'], use: Object.keys(providers), filter: FILTER },
      { ...health, name: 'JAPAN-ALTERNATE', proxies: ['REJECT'], use: Object.keys(providers), 'exclude-filter': FILTER },
    ],
    rules: ['DOMAIN,api.openai.com,OPENAI-IMAGE', 'MATCH,REJECT'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const payload = JSON.parse(await readFile(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(proxyConfig(payload.subscriptions), null, 2) + '\n');
}
