import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin, { createHandler, parseArgs, resolveScope, validateImages } from './index.mjs';
import { registerImagenTool } from './agent-tool.mjs';
import { boundedContext, buildBriefRequest, readVisualBrief } from './visual-brief.mjs';
import { inferImagenMode, recognizeImagenIntent } from './intent.mjs';
import { createJobPool } from './jobs.mjs';
import { proxyConfig } from './proxy-config.mjs';
import { rankImageProxyRoutes, selectImageProxyRoute } from './proxy-route.mjs';

const user = 'qqbot:c2c:' + 'A'.repeat(32);
const group = 'qqbot:group:' + 'B'.repeat(32);
const other = 'qqbot:group:' + 'C'.repeat(32);
const call = (address, args) => ({ channelId: 'qqbot', from: address, to: address, args });
const noPlan = async () => undefined;
function toolHarness(handler) {
  const hooks = {};
  let factory;
  let n = 0;
  registerImagenTool({ on: (name, hook) => { hooks[name] = hook; }, registerTool: create => { factory = create; } }, handler);
  return (ctx, options = {}) => {
    const runId = 'run-' + ++n;
    const sessionKey = ctx.SessionKey ?? 'session';
    const tool = factory({ sessionKey, messageChannel: ctx.Provider, requesterSenderId: ctx.SenderId });
    const dispatch = hooks.reply_dispatch({ runId, sessionKey, ctx, ...options }, {});
    const invoke = async (params, override = {}) => {
      const toolCallId = 'call-' + ++n;
      const block = hooks.before_tool_call({ runId, toolCallId, toolName: tool.name, ...override }, { sessionKey });
      return block ?? (await tool.execute(toolCallId, params)).content[0].text;
    };
    const final = (payload, overrides = {}) => hooks.reply_payload_sending({
      kind: 'final', channel: ctx.Provider, runId, sessionKey, payload, ...overrides,
    });
    return { dispatch, invoke, final };
  };
}

test('private and allowed groups use trusted addresses; unauthorized requests never render', async () => {
  const calls = [];
  let time = 0;
  const run = createHandler({ allowedGroups: [group], now: () => time += 11_000, plan: noPlan,
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
  const options = { allowedGroups: [group], now: () => time += 11_000, plan: noPlan,
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
    model: 'gpt-image-2.6-sunburst', prompt: 'jump: {yes}', quality: 'high', complexity: 'high',
    n: 1, output_format: 'gif', size: '512x512', frame_count: 3, frame_duration_ms: 200,
  });
  assert.equal(parseArgs('paint').model, 'gpt-image-2.6-sunburst');
  assert.equal(parseArgs('paint').quality, 'medium');
  assert.equal(parseArgs('low paint').complexity, 'low');
  assert.equal(parseArgs('low paint').model, 'gpt-image-2.6-flare');
  assert.equal(parseArgs('paint').output_format, 'png');
  assert.equal(parseArgs('png gif paint'), null);
  assert.equal(parseArgs('help'), null);
  assert.equal(parseArgs('做一个香菇用合肥车技开超跑的动态图').output_format, 'gif');
  assert.equal(parseArgs('png 做一张有动图质感的图').output_format, 'png');
  assert.equal(parseArgs('做静态海报，不要动图').output_format, 'png');
});

test('natural requests distinguish drawing, editing and references from discussion', () => {
  for (const [ask, hasImages] of [
    ['帮我做个飞船穿过云海的动态表情', false],
    ['根据你对这个群的了解生成一张图片', false],
    ['请画一只小狗', false],
    ['把背景换成雪山', true],
    ['参考这张的配色重新做一张海报', true],
    ['让这张图动起来', true],
    ['把这两只猫放大一百倍', true],
  ]) assert.equal(recognizeImagenIntent(ask, hasImages)?.kind, 'generate', ask);
  for (const message of [
    '这个动图有点好笑', '怎么生成 GIF？', '不要生成图片', '有没有动图教程',
    '做一个图片识别工具', '这是什么图片', '找一张巴黎的照片', '分析一下这张图片',
  ]) assert.equal(recognizeImagenIntent(message, true), undefined, message);
  assert.equal(recognizeImagenIntent('把这张图换个背景', false)?.kind, 'needs-image');
  assert.equal(recognizeImagenIntent('做一个飞船的视频', false)?.kind, 'video');
  assert.equal(recognizeImagenIntent('我要的是动态图', false)?.kind, 'format-correction');
  assert.equal(recognizeImagenIntent('主角是蓝色圆形，不是机器人，重新画', false)?.kind, 'redraw');
  assert.equal(recognizeImagenIntent('重新画一下，背景留白', false)?.kind, 'redraw');
  assert.equal(recognizeImagenIntent('现在重新画', false)?.kind, 'redraw');
  assert.equal(recognizeImagenIntent('不要现在重新画', false), undefined);
  assert.equal(recognizeImagenIntent('不用重新画', false), undefined);
  assert.equal(recognizeImagenIntent('怎么重新画？', false), undefined);
  assert.equal(inferImagenMode('将图中的日语替换成翻译后的中文', true), 'edit');
  assert.equal(inferImagenMode('参考这张的配色换成人物海报', true), 'ref');
});

test('DingTalk native tool preserves caption and same-turn media', async () => {
  const to = 'ddingtalk:chat:cidRoom==';
  const ctx = { Provider: 'ddingtalk', OriginatingChannel: 'ddingtalk', From: 'ddingtalk:sender',
    To: to, OriginatingTo: to, AccountId: 'account-a', SenderId: 'sender',
    ImagenInput: { args: '画一张红色方块', images: [], expectedImages: 0 } };
  const bind = toolHarness(createHandler({ allowAllDingTalkGroups: true, plan: noPlan,
    render: async () => '/fake/test.png' }));
  const turn = bind(ctx);
  assert.equal(turn.dispatch, undefined);
  assert.match(ctx.BodyForAgent, /显式指定/);
  assert.match(await turn.invoke({ prompt: '画一张红色方块' }), /已生成/);
  assert.equal(turn.final({ text: '<dingtalk_final>画好了。</dingtalk_final>' }).payload.text,
    '<dingtalk_final>画好了。</dingtalk_final>');
});

test('a format correction can reuse only the same sender and conversation text prompt', async () => {
  const used = [];
  let time = 12_000;
  const run = createHandler({ allowedGroups: [group, other], now: () => time, plan: noPlan,
    render: async (body) => { used.push(body); return '/fake/media'; },
  });
  const request = { ...call(group, '画一张开超跑的插画'), senderId: 'sender', accountId: 'default' };
  await run(request);
  const correction = { ...request, args: undefined, intent: { kind: 'format-correction' } };
  time += 11_000;
  for (const ctx of [{ ...correction, senderId: 'someone-else' }, { ...correction, accountId: 'other' },
    { ...correction, from: other, to: other }]) {
    assert.match((await run(ctx)).text, /想画的内容/);
  }
  assert.equal((await run(correction)).mediaUrl, '/fake/media');
  assert.equal(used[1].output_format, 'gif');
  assert.equal(used[1].prompt, used[0].prompt);
  assert.match((await run(correction)).text, /想画的内容/);
});

test('the tool edits quoted GIF source pixels on demand with current attachments taking precedence', async () => {
  let loads = 0;
  const rendered = [];
  const bind = toolHarness(createHandler({ allowedGroups: [group],
    plan: async () => 'A small looping motion while keeping the source unchanged.',
    verify: async paths => paths,
    render: async (body, _key, files) => { rendered.push({ body, files }); return '/fake/result.gif'; },
  }));
  const ctx = { Provider: 'qqbot', OriginatingChannel: 'qqbot', From: group, To: group, OriginatingTo: group, SenderId: 'tester' };
  const original = '/current/quoted.png';
  const quoted = { naturalText: '改成gif', images: [], expectedImages: 0, quotedImageCount: 1,
    loadQuotedImages: async () => { loads++; return [original]; } };
  const first = bind({ ...ctx, ImagenInput: quoted });
  assert.equal(loads, 0);
  const animate = { prompt: '让原图动起来', mode: 'edit', format: 'gif' };
  await first.invoke(animate);
  assert.equal(loads, 1);
  assert.deepEqual(rendered[0].files, [original]);
  assert.equal(rendered[0].body.output_format, 'gif');
  assert.match(rendered[0].body.prompt, /Image 1 is the original to edit/);
  await bind({ ...ctx, ImagenInput: { ...quoted, expectedImages: 1, images: ['/current/attached.png'] } }).invoke(animate);
  assert.equal(loads, 1);
  assert.deepEqual(rendered[1].files, ['/current/attached.png']);
  assert.match(await bind({ ...ctx, ImagenInput: { ...quoted, loadQuotedImages: async () => [] } }).invoke(animate),
    /没能下载到引用里的原图/);
  assert.equal(rendered.length, 2);
});

test('natural candidates require a semantic decision and use the returned brief', async () => {
  const output = [];
  let time = 0;
  let decision = { intent: 'ignore', format: 'png', brief: '' };
  const run = createHandler({ now: () => time += 11_000,
    plan: async ({ decideIntent }) => { assert.equal(decideIntent, true); return decision; },
    render: async (body) => { output.push(body); return '/fake/media.gif'; },
  });
  const ctx = { ...call(user, '做一张飞船穿过云海的动态图'), intent: { kind: 'generate' } };
  assert.equal(await run(ctx), undefined);
  assert.equal(output.length, 0);
  decision = { intent: 'text', format: 'gif', brief: 'A spaceship moves smoothly through cloud layers.' };
  assert.equal((await run(ctx)).mediaUrl, '/fake/media.gif');
  assert.equal(output[0].output_format, 'gif');
  assert.match(output[0].prompt, /moves smoothly/);
});

test('slash and natural-language turns use the same on-demand conversation scope', async () => {
  const planned = [];
  let loads = 0;
  const bind = toolHarness(createHandler({ allowedGroups: [group],
    plan: async input => { planned.push(input); return 'A mural of the two stories discussed today.'; },
    render: async () => '/fake/today.png',
  }));
  const ctx = {
    Provider: 'qqbot', OriginatingChannel: 'qqbot', From: group, To: group, OriginatingTo: group, SenderId: 'tester',
    ReplyToBody: '累了一天想放松，喝苹果汁，联系私下用 noecho@example.org',
    ConversationContextLoader: async range => {
      assert.equal(range, 'today');
      loads++;
      return { messages: Array.from({ length: 12 }, (_, i) => ({ at: '08:00', text: 'group story ' + i })), count: 54 };
    },
  };
  const input = { expectedImages: 0, images: [], recentChat: ['unrelated short-context'] };
  const slashCtx = { ...ctx, ImagenInput: { ...input, args: '看看群里今天的对话，生成一张图' } };
  const slash = bind(slashCtx);
  const natural = bind({ ...ctx, ImagenInput: { ...input, naturalText: '看看群里今天的对话，生成一张图片' } });
  assert.equal(slash.dispatch, undefined);
  assert.equal(natural.dispatch, undefined);
  assert.match(slashCtx.CommandBody, /^请使用 Imagen/);
  assert.equal(loads, 0);
  for (const t of [slash, natural]) {
    const args = { prompt: '把今天的话题画成一幅插画', contextRange: 'today' };
    assert.match(await t.invoke(args), /已生成/);
    assert.match(await t.invoke(args), /已生成/);
    assert.equal(t.final({ text: '画好了。' }, { kind: 'block' }), undefined);
    assert.equal(t.final({ text: '画好了。' }).payload.mediaUrl, '/fake/today.png');
    assert.equal(t.final({ text: '画好了。' }), undefined);
  }
  assert.equal(loads, 2);
  assert.equal(planned.length, 2);
  assert.deepEqual(planned[0].contextCoverage, { available: 54, sampled: 12, partial: undefined });
  assert.equal(planned[0].context.length, 12);
  assert.match(planned[0].quotedText, /苹果汁/);
  assert.doesNotMatch(planned[0].quotedText, /noecho/);
  assert.match(await bind({ ...ctx, ConversationContextLoader: undefined, ImagenInput: input })
    .invoke({ prompt: '画一下今天的群聊', contextRange: 'today' }), /不能把最近几条/);
  assert.equal(planned.length, 2);
});

test('explicit QQ quote edits use the quoted pixels and cannot silently become text-to-image', async () => {
  let loaded = 0;
  let time = 0;
  const inputs = [];
  const render = [];
  const run = createHandler({ allowedGroups: [group], now: () => time += 11_000,
    verify: async (paths) => paths,
    plan: async (request) => { inputs.push(request); return 'Preserve the pale left cat and gray tabby on the right.'; },
    render: async (body, _key, files) => { render.push({ body, files }); return '/fake/cats.png'; },
  });
  const request = { ...call(group, '把这两只猫放大一百倍'), expectedImages: 0, quotedImageCount: 1,
    loadQuotedImages: async () => { loaded++; return ['/current/original.png']; },
  };
  assert.match((await run({ ...request, from: other, to: other })).text, /未开放/);
  assert.equal(loaded, 0);
  assert.equal((await run(request)).mediaUrl, '/fake/cats.png');
  assert.equal(loaded, 1);
  assert.equal(inputs[0].mode, 'edit');
  assert.deepEqual(render[0].files, ['/current/original.png']);
  assert.match(render[0].body.prompt, /do not replace them with lookalikes/i);
  assert.match(render[0].body.prompt, /pale left cat and gray tabby/);
  assert.match((await run({ ...request, loadQuotedImages: async () => [] })).text, /没能下载到引用里的原图/);
  assert.match((await run(call(group, '毛色不对，猫品种都变了'))).text, /上传或引用原图/);
  assert.equal(render.length, 1);
});

test('QQ recent images are used only for referenced requests; a correction stays on the original', async () => {
  let time = 0;
  const renders = [];
  const run = createHandler({ allowedGroups: [group, other], now: () => time += 11_000,
    plan: async () => 'Make only the requested change.', verify: async (paths) => paths,
    render: async (body, _key, images) => { renders.push({ body, images }); return '/fake/result.png'; },
  });
  const context = { ...call(group, '画一张蓝色飞船的图'), senderId: 'sender', recentImages: ['/same-chat/recent.png'] };
  await run(context);
  assert.deepEqual(renders[0].images, []);
  await run({ ...context, args: '把刚才那张图放大一倍' });
  assert.deepEqual(renders[1].images, ['/same-chat/recent.png']);
  const correction = { ...context, args: '毛色不对', recentImages: ['/same-chat/unrelated.png'] };
  assert.match((await run({ ...correction, senderId: 'different' })).text, /上传或引用原图/);
  assert.match((await run({ ...correction, from: other, to: other })).text, /上传或引用原图/);
  await run(correction);
  assert.deepEqual(renders[2].images, renders[1].images);
  assert.match(renders[2].body.prompt, /把刚才那张图放大一倍/);
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
  assert.equal(calls[1].body.model, 'gpt-image-2.6-sunburst');
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
  assert.deepEqual(planned[0].context, []);
  assert.equal(rendered[0].complexity, 'high');
  await run({ ...call(group, '根据你对这个群的了解生成一张图片'), recentChat });
  assert.deepEqual(planned[1].context, ['周末聊星空，邮箱']);
  assert.doesNotMatch(rendered[1].prompt, /邮箱|private|\/reset/);
  assert.match(rendered[1].prompt, /An illustrated discussion/);
  assert.equal(rendered[1].complexity, 'high');
  assert.match((await run(call(group, '根据这个群画图'))).text, /没有足够/);
  assert.equal(rendered.length, 2);
  await run({ ...call(user, 'studio paint'), recentChat });
  assert.deepEqual(planned[2].context, []);
  assert.equal(rendered[2].quality, 'high');
  assert.equal(rendered[2].model, 'gpt-image-2.6-sunburst');
});

test('VLM receives actual image bytes, no tools and no retention flag, then returns only a brief', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const request = await buildBriefRequest({ prompt: 'borrow the palette', mode: 'ref',
    format: 'png', context: [], images: ['/current/image.png'] }, async () => png);
  assert.equal(request.store, false);
  assert.equal(request.reasoning.effort, 'high');
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

test('subject replacement is not locked to the original identity, and a failed plan cannot render', async () => {
  let time = 0;
  const outputs = [];
  let brief;
  const run = createHandler({ allowedGroups: [group], now: () => time += 11_000,
    plan: async () => brief, verify: async (files) => files,
    render: async (body) => { outputs.push(body); return '/fake/replacement.png'; },
  });
  const input = { ...call(group, '把这个改成小青蛙'), expectedImages: 1, images: ['/current/original.png'] };
  assert.match((await run(input)).text, /没有继续生成/);
  assert.equal(outputs.length, 0);
  brief = 'Replace the person with a little green frog. Keep the office and desk unchanged.';
  assert.equal((await run(input)).mediaUrl, '/fake/replacement.png');
  assert.match(outputs[0].prompt, /change that subject to the specified target/);
  assert.match(outputs[0].prompt, /Keep the office and desk unchanged/);
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

test('native tool execution is rejected for suppressed, unbound and wrong-run turns', async () => {
  let calls = 0;
  const run = async () => { calls++; return { text: 'ok' }; };
  run.allowed = () => true;
  const bind = toolHarness(run);
  const ctx = { Provider: 'qqbot', OriginatingChannel: 'qqbot', From: group, To: group, OriginatingTo: group, SenderId: 'a',
    ImagenInput: { naturalText: '做个插画', images: [], expectedImages: 0 } };
  const args = { prompt: '画插画' };
  for (const options of [{ sendPolicy: 'deny' }, { suppressUserDelivery: true }, { isTailDispatch: true }]) {
    assert.equal((await bind(ctx, options).invoke(args)).block, true);
  }
  assert.equal((await bind({ ...ctx, OriginatingTo: other }).invoke(args)).block, true);
  assert.equal((await bind(ctx).invoke(args, { runId: 'wrong-run' })).block, true);
  assert.equal(calls, 0);
  assert.equal(await bind(ctx).invoke(args), 'ok');
  assert.equal(calls, 1);
});

test('four jobs render concurrently; queued work starts FIFO and key rotation is preserved', async () => {
  const started = [];
  const finish = [];
  const run = createHandler({ plan: noPlan, jobs: createJobPool({ concurrency: 4, queueLimit: 2 }),
    render: (body, key) => new Promise(resolve => { started.push([body.prompt, key]); finish.push(resolve); }),
  });
  const running = Array.from({ length: 6 }, (_, index) => run(call(user, 'image ' + index)));
  assert.match((await run(call(user, 'over capacity'))).text, /繁忙/);
  assert.deepEqual(started, [['image 0', 0], ['image 1', 1], ['image 2', 0], ['image 3', 1]]);
  finish[1]('/fake/image.png');
  finish[2]('/fake/image.png');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.slice(4), [['image 4', 0], ['image 5', 1]]);
  for (const resolve of finish) resolve('/fake/image.png');
  for (const result of await Promise.all(running)) assert.equal(result.mediaUrl, '/fake/image.png');
});

test('registers one native skill tool and no standalone slash responder', () => {
  const tools = [];
  const hooks = [];
  plugin.register({ registerTool: (_factory, options) => tools.push(options.name), on: event => hooks.push(event) });
  assert.deepEqual(tools, ['luke_imagen']);
  assert.deepEqual(hooks, ['reply_dispatch', 'before_tool_call', 'reply_payload_sending']);
});

test('gateway startup loads Imagen before the first reply dispatch', async () => {
  const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.skills, ['./skills']);
  const skill = await readFile(new URL('./skills/imagen/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /description:.*动图.*精修/);
});

test('proxy listeners isolate subscriptions and only route the OpenAI API', () => {
  const cfg = proxyConfig(['https://example.org/sub1', 'https://example.org/sub2']);
  assert.equal(cfg['allow-lan'], false);
  assert.deepEqual(cfg.rules, [
    'AND,((IN-NAME,image-1),(DOMAIN,api.openai.com)),OPENAI-IMAGE-1',
    'AND,((IN-NAME,image-2),(DOMAIN,api.openai.com)),OPENAI-IMAGE-2',
    'MATCH,REJECT',
  ]);
  for (const [i, listener] of cfg.listeners.entries()) {
    const [main, preferred, alternate] = cfg['proxy-groups'].slice(i * 3, i * 3 + 3);
    assert.deepEqual(listener, { name: `image-${i + 1}`, type: 'mixed', listen: '127.0.0.1', port: 17979 + i });
    assert.deepEqual(main.proxies, [preferred.name, alternate.name, 'REJECT']);
    assert.deepEqual(preferred.use, [listener.name]);
    assert.deepEqual(alternate.use, [listener.name]);
    assert.deepEqual(preferred.proxies, ['REJECT']);
    assert.equal(alternate['exclude-filter'], preferred.filter);
    assert.match('日本2-Ver.8', new RegExp(preferred.filter));
    assert.doesNotMatch('日本20-Ver.8', new RegExp(preferred.filter));
  }
  for (const provider of Object.values(cfg['proxy-providers'])) {
    assert.equal(provider.proxy, 'DIRECT');
    assert.equal(provider['health-check']['expected-status'], 401);
    assert.equal(provider.filter, '日本');
    assert.equal(provider['exclude-filter'], '下载专用');
  }
});

const subscription = (Download, Expire = 200) => ({
  proxies: [{}], subscriptionInfo: { Total: 100, Download, Upload: 10, Expire },
});

test('proxy ranking subtracts upload and download, skips expired and exhausted subscriptions', () => {
  const rank = (a, b) => rankImageProxyRoutes({ 'image-1': a, 'image-2': b }, 100_000)
    .map(({ provider, remaining }) => [provider, remaining]);
  assert.deepEqual(rank(subscription(50), subscription(10)), [['image-2', 80], ['image-1', 40]]);
  assert.deepEqual(rank(subscription(90), subscription(10)), [['image-2', 80]]);
  assert.deepEqual(rank(subscription(50, 100), subscription(10)), [['image-2', 80]]);
  assert.deepEqual(rank({ proxies: [{}] }, subscription(10)), [['image-2', 80], ['image-1', -1]]);
  assert.deepEqual(rank(subscription(100), subscription(0, 99)), []);
  assert.deepEqual(rank({ proxies: [] }, subscription(10)), [['image-2', 80]]);
});

test('unreachable high-quota proxy falls back; health refresh never probes an exhausted route', async () => {
  const calls = [];
  let result = await selectImageProxyRoute({
    providers: { 'image-1': subscription(50), 'image-2': subscription(10) }, now: 100_000,
    probe: async ({ provider }) => (calls.push(provider), provider === 'image-1'),
    refresh: async () => assert.fail('unnecessary refresh'),
  });
  assert.equal(result.provider, 'image-1');
  assert.deepEqual(calls, ['image-2', 'image-1']);

  calls.length = 0;
  let refreshed = false;
  result = await selectImageProxyRoute({
    providers: { 'image-1': subscription(90), 'image-2': subscription(10) }, now: 100_000,
    probe: async ({ provider }) => (calls.push(provider), refreshed),
    refresh: async ({ provider }) => { calls.push(`refresh:${provider}`); refreshed = true; },
  });
  assert.equal(result.provider, 'image-2');
  assert.deepEqual(calls, ['image-2', 'refresh:image-2', 'image-2']);
});
