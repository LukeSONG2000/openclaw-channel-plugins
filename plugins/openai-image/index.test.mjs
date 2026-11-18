import assert from 'node:assert/strict';
import test from 'node:test';
import plugin, { createHandler, parseArgs, resolveScope } from './index.mjs';
import { proxyConfig } from './proxy-config.mjs';

const user = 'qqbot:c2c:' + 'A'.repeat(32);
const group = 'qqbot:group:' + 'B'.repeat(32);
const other = 'qqbot:group:' + 'C'.repeat(32);
const call = (address, args) => ({ channelId: 'qqbot', from: address, to: address, args });

test('private and allowed groups use trusted addresses; unauthorized requests never render', async () => {
  const calls = [];
  let time = 0;
  const run = createHandler({ allowedGroups: [group], now: () => time += 11_000,
    render: async (body, key) => { calls.push([body, key]); return '/fake/test.png'; } });
  const disallowed = [call(other, 'paint'), { ...call(other, 'paint'), args: `${group} paint` },
    { ...call(other, 'paint'), to: user }, { ...call(user, 'paint'), channelId: 'webchat' },
    { ...call(user, 'paint'), from: '' }];
  for (const context of disallowed) assert.match((await run(context)).text, /未开放/);
  assert.equal(calls.length, 0);
  assert.equal((await run(call(user, 'paint'))).mediaUrl, '/fake/test.png');
  assert.equal((await run(call(group.toLowerCase(), 'paint'))).mediaUrl, '/fake/test.png');
  assert.deepEqual(calls.map(([, key]) => key), [0, 1]);
});

test('DingTalk direct and group routes are distinct, exact and fail closed', () => {
  const channel = 'ddingtalk';
  const from = 'ddingtalk:sender_01';
  assert.deepEqual(resolveScope({ channel, from, to: 'ddingtalk:user:sender_01' }), { group: false });
  assert.equal(resolveScope({ channel, from, to: 'ddingtalk:user:another_sender' }), null);
  assert.deepEqual(resolveScope({ channel, from, to: 'ddingtalk:chat:cidQq+2==' }),
    { group: true, address: 'ddingtalk:chat:cidQq+2==' });
  assert.equal(resolveScope({ channel, from: 'ddingtalk:sender:forged', to: 'ddingtalk:user:sender:forged' }), null);
});

test('DingTalk-wide opt-in accepts arbitrary admitted groups without opening QQ or untrusted routes', async () => {
  const dd = { channel: 'ddingtalk', from: 'ddingtalk:sender_01', to: 'ddingtalk:chat:cidNewGroup==', args: 'paint' };
  let calls = 0;
  let time = 0;
  const options = { allowedGroups: [group], now: () => time += 11_000,
    render: async () => { calls++; return '/fake/test.png'; } };
  assert.match((await createHandler(options)(dd)).text, /未开放/);
  const run = createHandler({ ...options, allowAllDingTalkGroups: true });
  assert.match((await run(call(other, 'paint'))).text, /未开放/);
  assert.match((await run({ ...dd, channel: 'webchat' })).text, /未开放/);
  assert.match((await run({ ...dd, to: 'ddingtalk:chat:unknown' })).text, /未开放/);
  assert.equal(calls, 0);
  assert.equal((await run(dd)).mediaUrl, '/fake/test.png');
  assert.equal((await run({ ...dd, to: 'ddingtalk:chat:cidAnotherGroup==' })).mediaUrl, '/fake/test.png');
  assert.equal((await run(call(group, 'paint'))).mediaUrl, '/fake/test.png');
  assert.equal(calls, 3);
});

test('arguments stay data, not flags or shell instructions', () => {
  assert.deepEqual(parseArgs('gif high sunburst jump: {yes}'), {
    model: 'gpt-image-2.6-sunburst', prompt: 'jump: {yes}', quality: 'high', complexity: 'low',
    n: 1, output_format: 'gif', size: '512x512', frame_count: 3, frame_duration_ms: 200,
  });
  assert.equal(parseArgs('paint').model, 'gpt-image-2.6-flare');
  assert.equal(parseArgs('paint').output_format, 'png');
  assert.equal(parseArgs('png gif paint'), null);
  assert.equal(parseArgs('help'), null);
});

test('blocked and in-flight requests cannot start a second paid job', async () => {
  let finish;
  const run = createHandler({ render: () => new Promise((resolve) => { finish = resolve; }) });
  const running = run(call(user, 'first image'));
  assert.match((await run(call(user, 'second image'))).text, /繁忙/);
  finish('/fake/image.png');
  assert.equal((await running).mediaUrl, '/fake/image.png');
});

test('registers one explicit command, not a general-purpose exec tool', () => {
  const commands = [];
  plugin.register({ registerCommand: (command) => commands.push(command) });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'imagen');
  assert.deepEqual(commands[0].channels, ['qqbot', 'ddingtalk']);
});

test('proxy refresh and health checks pin both Japan 2 candidates to the OpenAI host', () => {
  const cfg = proxyConfig(['https://example.org/sub1', 'https://example.org/sub2']);
  assert.equal(cfg['allow-lan'], false);
  assert.deepEqual(cfg.rules, ['DOMAIN,api.openai.com,OPENAI-IMAGE', 'MATCH,REJECT']);
  const [main, preferred, alternate] = cfg['proxy-groups'];
  assert.deepEqual(main.proxies, ['JAPAN-2', 'JAPAN-ALTERNATE', 'REJECT']);
  assert.deepEqual(preferred.use, ['image-1', 'image-2']);
  assert.deepEqual(preferred.proxies, ['REJECT']);
  assert.equal(alternate['exclude-filter'], preferred.filter);
  assert.match('日本2-Ver.8', new RegExp(preferred.filter));
  assert.doesNotMatch('日本20-Ver.8', new RegExp(preferred.filter));
  for (const provider of Object.values(cfg['proxy-providers'])) {
    assert.equal(provider.proxy, 'DIRECT');
    assert.equal(provider['health-check']['expected-status'], 401);
    assert.equal(provider.filter, '日本');
    assert.equal(provider['exclude-filter'], '下载专用');
  }
});
