import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.openclaw');
const PROXY = 'http://127.0.0.1:17979';
const CLI = join(ROOT, 'bin', 'openai-image-cli');
const USAGE = '/imagen [png|gif] [low|high] [flare|sunburst] <描述>';

export function resolveScope({ channel, channelId, from, to }) {
  const kind = channelId ?? channel;
  if (typeof from !== 'string' || typeof to !== 'string' || from.length > 256 || to.length > 256) return null;
  if (kind === 'qqbot') {
    if (from.toLowerCase() !== to.toLowerCase()) return null;
    if (/^qqbot:c2c:[a-f0-9]{32}$/i.test(to)) return { group: false };
    if (/^qqbot:group:[a-f0-9]{32}$/i.test(to)) return { group: true, address: to.toLowerCase() };
  }
  if (kind === 'ddingtalk') {
    if (!/^ddingtalk:[\w.+@=-]+$/.test(from)) return null;
    if (to === from.replace(/^ddingtalk:/, 'ddingtalk:user:')) return { group: false };
    if (/^ddingtalk:chat:cid[\w+/]+={0,2}$/.test(to)) return { group: true, address: to };
  }
  return null;
}

export function parseArgs(input = '') {
  const format = ['png', 'gif'];
  const quality = ['low', 'high'];
  const variant = ['flare', 'sunburst'];
  const choices = [format, quality, variant];
  const selected = [false, false, false];
  const options = ['png', 'low', 'flare'];
  let prompt = input.trim();
  for (let i = 0; i < choices.length; i++) {
    const [token] = prompt.split(/\s/u, 1);
    const found = choices.findIndex((set) => set.includes(token?.toLowerCase()));
    if (found < 0) break;
    if (selected[found]) return null;
    selected[found] = true;
    options[found] = token.toLowerCase();
    prompt = prompt.slice(token.length).trimStart();
  }
  if (!prompt || prompt.length > 1800 || prompt === 'help' || prompt === '?') return null;
  const [output_format, imageQuality, model] = options;
  return {
    model: `gpt-image-2.6-${model}`, prompt, quality: imageQuality,
    complexity: 'low',
    n: 1, output_format, size: output_format === 'gif' ? '512x512' : '1024x1024',
    ...(output_format === 'gif' ? { frame_count: 3, frame_duration_ms: 200 } : {}),
  };
}

async function loadKeys() {
  const file = join(ROOT, 'openai-image-private', 'accounts.json');
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('credentials_permissions');
  const keys = JSON.parse(await readFile(file, 'utf8')).keys;
  if (!Array.isArray(keys) || keys.length !== 2 || new Set(keys).size !== 2 ||
      keys.some((key) => typeof key !== 'string' || !/^sk-[\w-]+$/.test(key))) throw new Error('credentials_invalid');
  return keys;
}

function run(file, args, { input, env, timeout }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const failure = new Error(error.killed ? 'timeout' : 'provider');
      if (!error.killed) {
        for (const stream of [stderr, stdout]) {
          try {
            const parsed = JSON.parse(stream);
            failure.quota = (parsed.error?.code ?? parsed.code) === 'insufficient_quota';
            if (failure.quota) break;
          } catch { /* Never surface raw CLI output. */ }
        }
      }
      reject(failure);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function apiEnv(key) {
  return {
    PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8',
    OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://api.openai.com/v1',
    HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, ALL_PROXY: PROXY,
    OPENAI_NO_AUTO_UPDATE: '1',
  };
}

async function checkKey(key, model) {
  try {
    const output = await run('/usr/bin/curl', ['-q', '--silent', '--fail', '--max-time', '8',
      '--proto', '=https', '--proxy', PROXY, '--noproxy', '', '--config', '-'], {
      env: apiEnv(key), timeout: 10_000,
      input: `url = "https://api.openai.com/v1/models/${model}"\nheader = "Authorization: Bearer ${key}"\n`,
    });
    return JSON.parse(output).id === model;
  } catch { return false; }
}

async function generate(body, startAt) {
  const keys = await loadKeys();
  for (const key of [keys[startAt], keys[1 - startAt]]) {
    if (!await checkKey(key, body.model)) continue;
    let output;
    try {
      output = await run(CLI, ['images', 'generate', '--format', 'json', '--format-error', 'json'], {
        env: apiEnv(key), timeout: 180_000, input: JSON.stringify(body),
      });
    } catch (error) {
      // A request with an uncertain outcome must not generate or charge again.
      if (error.quota) continue;
      throw error;
    }
    const encoded = JSON.parse(output).data?.[0]?.b64_json;
    const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    const gif = body.output_format === 'gif';
    const valid = gif ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!valid || bytes.length > 20 * 1024 * 1024) throw new Error('invalid_media');
    const dir = join(ROOT, 'media', 'outbound', 'openai-image');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.${body.output_format}`);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return file;
  }
  throw new Error('no_provider');
}

export function createHandler({ allowedGroups = [], render = generate, now = Date.now } = {}) {
  const groups = new Set(allowedGroups.map((value) => value.startsWith('qqbot:') ? value.toLowerCase() : value));
  let active = false;
  let nextKey = 0;
  let lastStart = -Infinity;
  return async (context) => {
    const scope = resolveScope(context);
    if (!scope || (scope.group && !groups.has(scope.address))) return { text: '生图仅在私聊和指定群开放。' };
    const body = parseArgs(context.args);
    if (!body) return { text: `用法：${USAGE}\n默认 PNG、低画质、Flare；GIF 默认 3 帧。` };
    if (active || now() - lastStart < 10_000) return { text: '生图繁忙，请稍后再试。' };
    active = true;
    lastStart = now();
    const startAt = nextKey;
    nextKey = 1 - nextKey;
    try { return { mediaUrl: await render(body, startAt) }; }
    catch { return { text: '生图暂时失败，请稍后再试。' }; }
    finally { active = false; }
  };
}

export default {
  id: 'luke-openai-image',
  register(api) {
    api.registerCommand({
      name: 'imagen', description: '生成图片或 GIF（仅私聊和指定群）',
      channels: ['qqbot', 'ddingtalk'], acceptsArgs: true, requireAuth: false,
      handler: createHandler({ allowedGroups: api.pluginConfig?.allowedGroups ?? [] }),
    });
  },
};
