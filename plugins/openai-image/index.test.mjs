import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin, { createDispatchHook, createHandler, parseArgs, resolveScope, validateImages } from './index.mjs';
import { boundedContext, buildBriefRequest, readVisualBrief } from './visual-brief.mjs';
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

test('edit and reference paths require all current attachments and have distinct defaults', async () => {
  let time = 0;
  const calls = [];
  const run = createHandler({
    now: () => time += 11_000,
    verify: async (paths, root) => {
      assert.match(root, /\/media\/qqbot\/downloads$/);
      return paths;
    },
    plan: async ({ mode }) => `Brief for ${mode}`,
    render: async (body, _key, files) => {
      calls.push({ body, files });
      return '/fake/image.png';
    },
  });
  const images = ['/current/photo.png'];
  const attach = (args, expectedImages = 1) => ({ ...call(user, args), images, expectedImages });
  assert.match((await run(call(user, 'edit /private/file.png'))).text, /上传/);
  assert.match((await run(attach('ref paint', 2))).text, /未下载齐/);
  assert.match((await run(attach('text paint'))).text, /不接收附件/);
  assert.equal(calls.length, 0);
  await run(attach('edit replace only the sky'));
  await run(attach('portrait with the same color palette'));
  await run(attach('ref gif use this as inspiration'));
  assert.equal(calls[0].body.model, 'gpt-image-2.6-sunburst');
  assert.equal(calls[0].body.quality, 'high');
  assert.match(calls[0].body.prompt, /Image 1 is the original.*\n\nreplace only the sky/);
  assert.match(calls[0].body.prompt, /Brief for edit/);
  assert.equal(calls[1].body.model, 'gpt-image-2.6-flare');
  assert.match(calls[1].body.prompt, /^Create a new image; use the supplied images as visual references/);
  assert.match(calls[1].body.prompt, /Brief for ref/);
  assert.equal(calls[2].body.output_format, 'gif');
  assert.deepEqual(calls.map((x) => x.files), [images, images, images]);
});

test('group context is opt-in and is not copied into the rendering request', async () => {
  let time = 0;
  const planned = [];
  const rendered = [];
  const run = createHandler({ allowedGroups: [group], now: () => time += 11_000,
    plan: async (request) => { planned.push(request); return 'An illustrated discussion under a night sky.'; },
    render: async (body) => { rendered.push(body); return '/fake/render.png'; },
  });
  const recentChat = ['周末聊星空，邮箱 luke@example.org', 'https://example.org/private', '/reset', '这张卡的密码是 secret'];
  await run({ ...call(group, '画棵树'), recentChat });
  assert.equal(planned.length, 0);
  assert.equal(rendered[0].complexity, 'low');
  await run({ ...call(group, '根据你对这个群的了解生成一张图片'), recentChat });
  assert.deepEqual(planned[0].context, ['周末聊星空，邮箱']);
  assert.doesNotMatch(rendered[1].prompt, /邮箱|private|\/reset/);
  assert.match(rendered[1].prompt, /An illustrated discussion/);
  assert.equal(rendered[1].complexity, undefined);
  assert.match((await run(call(group, '根据这个群画图'))).text, /没有足够/);
  assert.equal(rendered.length, 2);
  await run({ ...call(user, 'studio paint'), recentChat });
  assert.deepEqual(planned[1].context, []);
  assert.equal(rendered[2].quality, 'high');
  assert.equal(rendered[2].model, 'gpt-image-2.6-sunburst');
});

test('VLM receives actual image bytes, no tools and no retention flag, then returns only a brief', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const request = await buildBriefRequest({ prompt: 'borrow the palette', mode: 'ref',
    format: 'png', context: [], images: ['/current/image.png'] }, async () => png);
  assert.equal(request.store, false);
  assert.equal(request.tools, undefined);
  assert.match(request.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(request), /\/current\/image/);
  const response = { status: 'completed', output: [
    { type: 'reasoning', content: [{ type: 'output_text', text: 'reasoning must not be included' }] },
    { type: 'message', content: [{ type: 'output_text', text: '{"brief":"Muted blue and green."}' }] },
  ] };
  assert.equal(readVisualBrief(response), 'Muted blue and green.');
  assert.equal(readVisualBrief({ ...response, status: 'incomplete' }), undefined);
  assert.deepEqual(boundedContext(['<@some-id> 12345678 星球大战']), ['星球大战']);
});

test('attachment validation uses real paths and image bytes', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'imagen-'));
  const otherRoot = await mkdtemp(join(tmpdir(), 'imagen-outside-'));
  try {
    const png = join(root, 'image.png');
    const outside = join(otherRoot, 'image.png');
    const invalid = join(root, 'not-image.png');
    const link = join(root, 'link.png');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(png, bytes);
    await writeFile(outside, bytes);
    await writeFile(invalid, 'not PNG');
    await symlink(outside, link);
    assert.deepEqual(await validateImages([png], root), [png]);
    for (const path of [outside, invalid, link, 'relative.png']) {
      await assert.rejects(validateImages([path], root), /invalid_input/);
    }
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(otherRoot, { recursive: true, force: true })]);
  }
});

test('reply hook skips synthetic input and never renders for suppressed or mismatched routes', async () => {
  const replies = [];
  const calls = [];
  const hook = createDispatchHook(async (input) => {
    calls.push(input);
    return { text: '请附图' };
  });
  const dispatch = {
    dispatcher: {
      sendFinalReply: (reply) => Boolean(replies.push(reply)),
      getQueuedCounts: () => ({ final: replies.length }),
    },
    recordProcessed: () => {},
    markIdle: () => {},
  };
  const to = 'ddingtalk:chat:cidNewGroup==';
  const ctx = {
    Provider: 'ddingtalk', OriginatingChannel: 'ddingtalk', OriginatingTo: to,
    From: 'ddingtalk:sender_01', To: to, ImagenInput: { args: 'edit paint', images: [], expectedImages: 0 },
  };
  assert.equal(await hook({ ctx: { ...ctx, ImagenInput: undefined } }, dispatch), undefined);
  for (const event of [
    { ctx, sendPolicy: 'deny' }, { ctx, suppressUserDelivery: true }, { ctx, isTailDispatch: true },
    { ctx: { ...ctx, OriginatingTo: user } },
  ]) assert.equal((await hook(event, dispatch)).queuedFinal, false);
  assert.equal(calls.length, 0);
  assert.equal((await hook({ ctx }, dispatch)).queuedFinal, true);
  assert.deepEqual(replies, [{ text: '<dingtalk_final>请附图</dingtalk_final>' }]);
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
  const hooks = [];
  plugin.register({ registerCommand: (command) => commands.push(command), on: (event) => hooks.push(event) });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'imagen');
  assert.deepEqual(commands[0].channels, ['qqbot', 'ddingtalk']);
  assert.deepEqual(hooks, ['reply_dispatch']);
  assert.match(commands[0].handler().text, /edit/);
});

test('gateway startup loads Imagen before the first reply dispatch', async () => {
  const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation?.onStartup, true);
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
