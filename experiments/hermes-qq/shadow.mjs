import { randomUUID } from 'node:crypto';
import { hermesPilot, hermesRuns } from './pilot.mjs';

const runs = hermesRuns({
  origin: 'http://127.0.0.1:8642', token: process.env.API_SERVER_KEY, timeoutMs: 90_000, pollMs: 750,
});

async function assertNoTools() {
  const response = await fetch('http://127.0.0.1:8642/v1/toolsets', {
    headers: { authorization: 'Bearer ' + process.env.API_SERVER_KEY },
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('unable to verify the shadow tool policy');
  const { data } = await response.json();
  if (!Array.isArray(data) || !data.length || data.some(row => row.enabled !== false)) {
    throw new Error('shadow execution requires a tool-free API profile');
  }
}

async function readSample() {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 48_000) throw new Error('sample exceeds its size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main(mode) {
  if (mode === 'probe') {
    const id = randomUUID();
    const sessionId = 'pilot-probe-' + id;
    const runId = await runs.start({ sessionId, requestKey: id, input: 'Reply briefly with: ready' });
    if (!await runs.wait(runId, sessionId)) throw new Error('missing model output');
    const { runtime, usage } = await runs.status(runId);
    const { provider, model } = runtime ?? {};
    const valid = value => typeof value === 'string' && /^[a-z0-9./_-]{1,100}$/i.test(value);
    console.log(JSON.stringify({
      status: 'completed', provider: valid(provider) ? provider : null,
      model: valid(model) ? model : null, totalTokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : null,
    }));
    return;
  }
  if (!['window', 'mention', 'trial-mention', 'trial-settle'].includes(mode)) throw new Error('invalid shadow mode');
  const sample = await readSample();
  await assertNoTools();
  const pilot = hermesPilot({ fast: runs });
  if (mode === 'trial-settle') {
    console.log(JSON.stringify(await pilot.settle(sample.job)));
    return;
  }
  if (!Array.isArray(sample?.events) || sample.events.length > 24) throw new Error('invalid shadow sample');
  if (mode === 'window') {
    const actions = await pilot.window(sample.events);
    console.log(JSON.stringify({ status: 'completed', count: actions.length, modes: actions.map(x => x.mode) }));
    return;
  }
  if (sample.events.length !== 1) throw new Error('expected one source event');
  const started = await pilot.mention(sample.events[0], Array.isArray(sample.context) ? sample.context : []);
  if (mode === 'trial-mention') {
    console.log(JSON.stringify(started));
    return;
  }
  if (started.kind === 'chat') {
    console.log(JSON.stringify({ status: 'completed', route: 'chat' }));
  } else {
    const result = await pilot.settle(started);
    console.log(JSON.stringify({ status: 'completed', route: 'work', sourceMatched: result.source.messageId === sample.events[0].messageId }));
  }
}

main(process.argv[2]).catch(error => {
  console.error(error instanceof SyntaxError ? 'shadow_invalid_json' : 'shadow_failed');
  process.exitCode = 1;
});
