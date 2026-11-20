import { randomUUID } from 'node:crypto';
import { hermesPilot, hermesRuns } from './pilot.mjs';

const runs = hermesRuns({
  origin: 'http://127.0.0.1:8642', token: process.env.API_SERVER_KEY, timeoutMs: 145_000, pollMs: 750,
});
const lane = process.env.HERMES_QQ_LANE ?? 'chat';

async function assertTools() {
  const response = await fetch('http://127.0.0.1:8642/v1/toolsets', {
    headers: { authorization: 'Bearer ' + process.env.API_SERVER_KEY },
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('unable to verify the shadow tool policy');
  const { data } = await response.json();
  if (!Array.isArray(data) || !data.length || data.some(row => typeof row.enabled !== 'boolean')) {
    throw new Error('invalid Hermes tool inventory');
  }
  const enabled = data.filter(row => row.enabled).map(row => row.name).sort();
  const expected = lane === 'work' ? ['luke-imagen', 'luke-readonly', 'todo'] : ['luke-readonly'];
  if (lane === 'chat' && process.env.HERMES_QQ_WEB === '1') expected.push('web');
  if (enabled.length !== expected.length || enabled.some((name, index) => name !== expected[index])) {
    throw new Error('unexpected tools in Hermes profile');
  }
  const readonly = data.find(row => row.name === 'luke-readonly');
  if (JSON.stringify(readonly?.tools?.sort()) !== JSON.stringify(['luke_reference_search', 'luke_skill_read'])) {
    throw new Error('unexpected read-only tool registration');
  }
  return enabled;
}

async function readSample(maxBytes) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('sample exceeds its size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main(mode) {
  if (!['chat', 'work'].includes(lane)) throw new Error('invalid Hermes lane');
  const enabledTools = await assertTools();
  if (mode === 'health') {
    console.log(JSON.stringify({ status: 'ready', lane }));
    return;
  }
  if (mode === 'probe') {
    const id = randomUUID();
    const sessionId = 'pilot-probe-' + id;
    const runId = await runs.start({ sessionId, requestKey: id, input: 'Reply briefly with: ready' });
    if (!await runs.wait(runId, sessionId)) throw new Error('missing model output');
    const { runtime, usage } = await runs.status(runId);
    const { provider, model } = runtime ?? {};
    const valid = value => typeof value === 'string' && /^[a-z0-9./_-]{1,100}$/i.test(value);
    console.log(JSON.stringify({
      status: 'completed', lane, enabledTools, provider: valid(provider) ? provider : null,
      model: valid(model) ? model : null, totalTokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : null,
    }));
    return;
  }
  const modes = lane === 'work' ? ['trial-start', 'trial-settle'] : ['window', 'mention', 'trial-plan', 'trial-window', 'direct'];
  if (!modes.includes(mode)) throw new Error('invalid shadow mode for Hermes lane');
  const sample = await readSample(['trial-plan', 'direct'].includes(mode) ? 6_000_000 : 48_000);
  const pilot = hermesPilot({ fast: runs });
  const groupRules = typeof sample.groupRules === 'string' && sample.groupRules.length <= 1800 ? sample.groupRules : '';
  if (mode === 'direct') {
    console.log(JSON.stringify(await pilot.direct(sample.event, sample.context, sample.preferences,
      sample.allowWork === true, sample.imageGeneration === true, sample.images)));
    return;
  }
  if (mode === 'trial-start') {
    console.log(JSON.stringify(await pilot.startWork(sample.decision)));
    return;
  }
  if (mode === 'trial-settle') {
    console.log(JSON.stringify(await pilot.settle(sample.job)));
    return;
  }
  if (!Array.isArray(sample?.events) || sample.events.length > 24) throw new Error('invalid shadow sample');
  if (mode === 'window' || mode === 'trial-window') {
    const actions = await pilot.window(sample.events, Array.isArray(sample.context) ? sample.context : [],
      Number.isSafeInteger(sample.attempt) && sample.attempt >= 0 ? sample.attempt : 0, groupRules);
    console.log(JSON.stringify(mode === 'trial-window' ? actions
      : { status: 'completed', count: actions.length, modes: actions.map(x => x.mode) }));
    return;
  }
  if (sample.events.length !== 1) throw new Error('expected one source event');
  const decision = await pilot.planMention(sample.events[0], Array.isArray(sample.context) ? sample.context : [],
    Array.isArray(sample.unread) ? sample.unread.slice(-12) : [], mode === 'trial-plan' ? sample.images : [],
    mode === 'trial-plan' ? sample.preferences : [], mode === 'trial-plan' && sample.imageGeneration === true, groupRules);
  console.log(JSON.stringify(mode === 'trial-plan' ? decision
    : { status: 'completed', route: decision.kind === 'work-intent' ? 'work' : decision.kind }));
}

main(process.argv[2]).catch(error => {
  console.error(error instanceof SyntaxError ? 'shadow_invalid_json' : 'shadow_failed');
  process.exitCode = 1;
});
