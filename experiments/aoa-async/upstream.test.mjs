import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runOpenClaw } from './input.mjs';

const executable = process.env.AOA_OPENCLAW_BIN;
const qq = process.env.AOA_STOCK_QQ_PACKAGE;
const ding = process.env.AOA_STOCK_DING_PACKAGE;
const exec = promisify(execFile);

async function lab(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'aoa-stock-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, '.lab');
  const state = join(root, 'gateway');
  await mkdir(state, { recursive: true, mode: 0o700 });
  return { root, state, env: {
    HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8',
    OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: state, AOA_LAB_ROOT: root,
  } };
}

test('stock OpenClaw discovers the isolated bridge and both unmodified channel modules', { skip: !executable || !qq || !ding, timeout: 90_000 }, async (t) => {
  const { root, env } = await lab(t);
  const config = join(root, 'gateway.json');
  const routes = [{ channel: 'qqbot', account: 'default', to: `qqbot:group:${'A'.repeat(32)}` }];
  await writeFile(config, JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback' },
    channels: { qqbot: { enabled: false, allowFrom: ['A'.repeat(32)] }, ddingtalk: { enabled: false } },
    plugins: {
      allow: ['openclaw-qqbot', 'ddingtalk', 'luke-aoa-async'],
      load: { paths: [qq, ding, import.meta.dirname] },
      entries: { 'openclaw-qqbot': { enabled: true }, ddingtalk: { enabled: true },
        'luke-aoa-async': { enabled: true, config: { routes } } },
    },
  }), { mode: 0o600 });
  const { stdout } = await exec(executable, ['plugins', 'inspect', 'luke-aoa-async', '--runtime', '--json'], {
    env: { ...env, OPENCLAW_CONFIG_PATH: config }, timeout: 85_000, maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.plugin.id, 'luke-aoa-async');
  assert.equal(report.plugin.status, 'loaded', JSON.stringify(report.diagnostics));
  const names = JSON.stringify(report);
  assert.match(names, /reply_dispatch/);
  assert.match(names, /message_received/);
});

test('stock OpenClaw worker produces final-only text against a loopback model fixture', { skip: !executable, timeout: 240_000 }, async (t) => {
  const { root, state, env } = await lab(t);
  let requests = 0;
  let receivedProof = false;
  let receivedTools = false;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw);
    requests++;
    receivedProof ||= raw.includes('aoa-fixture-input');
    receivedTools ||= Boolean(body.tools?.length);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (delta, finish_reason) => `data: ${JSON.stringify({
      id: 'fixture-turn', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    res.end(event({ role: 'assistant', content: 'fixture final result' }, null) + event({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const config = join(root, 'worker.json');
  await writeFile(config, JSON.stringify({
    agents: { defaults: { model: { primary: 'fixture/fixture' } } },
    models: { mode: 'replace', providers: { fixture: {
      api: 'openai-completions', agentRuntime: { id: 'openclaw' },
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only',
      models: [{ id: 'fixture', name: 'Fixture' }],
    } } },
  }), { mode: 0o600 });
  const result = await runOpenClaw({
    executable, config, env, cwd: state, prompt: 'aoa-fixture-input', signal: t.signal,
  });
  assert.equal(result, 'fixture final result');
  assert.ok(requests >= 1);
  assert.equal(receivedProof, true);
  assert.equal(receivedTools, false);
});
