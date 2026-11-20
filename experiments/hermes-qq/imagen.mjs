import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler, generate } from '../../plugins/openai-image/index.mjs';
import { imageInputs } from './pilot.mjs';

const taskId = /^t_[a-f0-9]{8,32}$/;
const maxImageBytes = 20 * 1024 * 1024;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

function imageFormat(bytes) {
  if (bytes.length > maxImageBytes) return;
  if (bytes.subarray(0, 8).equals(png)) return 'png';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
}

export function imagenReceiptStore(db, directory) {
  db.exec(`CREATE TABLE IF NOT EXISTS imagen_receipts (
    key TEXT PRIMARY KEY, status TEXT NOT NULL, format TEXT, note TEXT
  )`);
  const lookup = db.prepare('SELECT * FROM imagen_receipts WHERE key=?');
  const claim = db.prepare("INSERT OR IGNORE INTO imagen_receipts VALUES (?, 'running', NULL, NULL)");
  const finish = db.prepare("UPDATE imagen_receipts SET status=?, format=?, note=? WHERE key=? AND status='running'");
  const path = key => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid artifact key');
    return join(directory, key);
  };
  return {
    lookup: key => lookup.get(key),
    claim: key => claim.run(key).changes === 1,
    fail: (key, note) => finish.run('failed', null, note, key),
    async save(key, bytes) {
      const format = imageFormat(bytes);
      if (!format) throw new Error('invalid output');
      const file = path(key);
      await writeFile(file + '.new', bytes, { flag: 'wx', mode: 0o600 });
      await rename(file + '.new', file);
      finish.run('ready', format, null, key);
    },
    async read(key) {
      const entry = lookup.get(key);
      if (entry?.status !== 'ready') return;
      const bytes = await readFile(path(key));
      if (imageFormat(bytes) !== entry.format) throw new Error('invalid stored output');
      return { bytes, format: entry.format };
    },
    async remove(key) { await rm(path(key), { force: true }); },
    async prune(before) {
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}(?:\.new)?$/.test(name)) continue;
        const file = join(directory, name);
        const age = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (age && age.mtimeMs < before) await rm(file, { force: true });
      }
    },
  };
}

const failed = '没有收到生图成品。请发一条新消息后再试。';

export function imagenJobs({ getTask, allowed, artifacts, directory,
  renderer = createHandler({ authorizeGroup: () => true, inputRoot: context => context.inputRoot,
    render: (body, start, images, options) => generate(body, start, images, { ...options, outputDirectory: directory }),
    logger: { warn: message => console.error(message) } }) }) {
  const active = new Map();
  async function execute(task, args, useImages) {
    const { key, source } = task;
    let root;
    try {
      root = await mkdtemp(join(directory, 'input-'));
      const images = [];
      for (const { dataUrl } of useImages ? imageInputs(task.images) : []) {
        const [, format, encoded] = /^data:image\/(png|jpeg|webp|gif);base64,(.*)$/.exec(dataUrl);
        const file = join(root, images.length + '.' + format);
        await writeFile(file, Buffer.from(encoded, 'base64'), { mode: 0o600 });
        images.push(file);
      }
      const address = source.chatType === 'direct' ? 'qqbot:c2c:' + source.senderId : 'qqbot:group:' + source.groupId;
      const result = await renderer({ channel: 'qqbot', accountId: source.account, from: address, to: address,
        senderId: source.senderId, args, images, expectedImages: images.length, inputRoot: root });
      if (!result?.mediaUrl) {
        const message = result?.text ?? failed;
        artifacts.fail(key, message);
        return { status: 'failed', message };
      }
      try {
        if ((await stat(result.mediaUrl)).size > maxImageBytes) throw new Error('output too large');
        await artifacts.save(key, await readFile(result.mediaUrl));
      } finally { await rm(result.mediaUrl, { force: true }); }
      return { status: 'ready' };
    } catch {
      artifacts.fail(key, failed);
      return { status: 'failed', message: failed };
    } finally { if (root) await rm(root, { recursive: true, force: true }); }
  }
  return async ({ id, args, useImages }) => {
    if (!taskId.test(id ?? '') || typeof args !== 'string' || !args.trim() || args.length > 1800 ||
        typeof useImages !== 'boolean') return { status: 'denied' };
    let task = getTask(id);
    // Native dispatch can start between card creation and the bridge storing its receipt.
    for (let attempt = 0; !task && attempt < 10; attempt++) {
      await delay(200);
      task = getTask(id);
    }
    if (!task || !allowed(task.source)) return { status: 'denied' };
    if (useImages && !task.images.length) return { status: 'needs_input', message: '未收到任务原图，请引用或重新附图。' };
    const { key } = task;
    if (active.has(key)) return active.get(key);
    if (!artifacts.claim(key)) {
      const row = artifacts.lookup(key);
      return row.status === 'ready' ? { status: 'ready' } : { status: 'failed', message: row.note ?? failed };
    }
    const pending = execute(task, args, useImages).finally(() => active.delete(key));
    active.set(key, pending);
    return pending;
  };
}

export async function serveImagen({ directory, run }) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const path = join(directory, 'render.sock');
  await rm(path, { force: true });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/render') { res.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 8192) throw new Error('body too large');
      }
      const result = await run(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o666);
  return async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(path, { force: true });
  };
}
