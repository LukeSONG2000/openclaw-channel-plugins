import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { contains, makePrompt, runOpenClaw } from './input.mjs';
import { openStore, testRoot } from './store.mjs';

export async function workOnce({ store, work, now = Date.now, log = () => {} }) {
  const job = store.claimWork(now());
  if (!job) return false;
  log('started', { id: job.id, kind: job.kind });
  let result;
  let reason;
  try {
    result = await work(job, JSON.parse(job.input));
  } catch (error) {
    reason = error?.message === 'file_changed' || error?.message === 'pdf_not_readable' ? 'input_unavailable' : 'task_failed';
    result = reason === 'input_unavailable' ? '后台没能读取原附件，请重新发送可读文件。' : '这项后台任务没能完成，未自动重试。';
  }
  const recorded = store.complete(job.id, result, reason, now());
  log('finished', { id: job.id, state: recorded ? 'ready' : 'late', ...(reason ? { reason } : {}) });
  return true;
}

async function main() {
  const root = testRoot(process.env.AOA_LAB_ROOT);
  if (process.argv[2] === '--status') {
    const store = openStore(root);
    try { process.stdout.write(JSON.stringify(store.status(), null, 2) + '\n'); }
    finally { store.close(); }
    return;
  }
  const executable = process.env.AOA_OPENCLAW_BIN;
  if (!executable || !isAbsolute(executable)) throw new Error('configure absolute AOA_OPENCLAW_BIN');
  const config = await realpath(join(root, 'worker.json'));
  if (!contains(root, config)) throw new Error('worker config outside lab');
  const settings = JSON.parse(await readFile(config, 'utf8'));
  const providers = Object.values(settings.models?.providers ?? {});
  if (Object.hasOwn(settings, 'channels') || settings.$include || settings.env || settings.agents?.list ||
      !providers.length || providers.some((provider) => provider?.agentRuntime?.id !== 'openclaw')) {
    throw new Error('worker needs the embedded OpenClaw runtime and no channels');
  }
  const home = join(root, 'worker-home');
  const tasks = join(root, 'work');
  await Promise.all([home, tasks].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const env = {
    HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: join(home, '.openclaw'),
    LANG: 'C.UTF-8', PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  for (const name of (process.env.AOA_WORKER_ENV ?? '').split(',').filter(Boolean)) {
    if (!/^(?:OPENAI|ZAI|ANTHROPIC|GEMINI|AZURE_OPENAI|DEEPSEEK)_API_KEY$/.test(name)) throw new Error('unexpected worker environment key');
    if (process.env[name]) env[name] = process.env[name];
  }
  const pdfToText = process.env.AOA_PDFTOTEXT;
  if (pdfToText && !isAbsolute(pdfToText)) throw new Error('configure absolute AOA_PDFTOTEXT');
  const store = openStore(root);
  const log = (event, detail) => console.log(JSON.stringify({ event, ...detail }));
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      try {
        await workOnce({
          store, log, async work(job, input) {
            const cwd = join(tasks, job.id);
            await mkdir(cwd, { mode: 0o700 });
            const prompt = await makePrompt(job.kind, input, { mediaRoot: join(root, 'gateway', 'media'), pdfToText, cwd });
            return runOpenClaw({ executable, config, env, cwd, prompt });
          },
        });
      } catch { log('worker_cycle_error'); }
      await delay(500, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('[aoa-async] worker configuration or startup error; check README');
    process.exitCode = 1;
  });
}
