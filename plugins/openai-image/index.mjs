import { execFile } from 'node:child_process';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { inferImagenFormat, inferImagenMode, isImagenEditCorrection, isImagenRedraw, requiresImagenSource, wantsRecentImagenSource } from './intent.mjs';
import { boundedContext, buildBriefRequest, imageMime, PLANNER_EFFORT, PLANNER_MODEL, readVisualBrief, wantsConversationContext } from './visual-brief.mjs';
import { createJobPool } from './jobs.mjs';
import { registerImagenTool } from './agent-tool.mjs';
import { OPENAI_PROBE, selectImageProxyRoute } from './proxy-route.mjs';

const ROOT = join(homedir(), '.openclaw');
const PROXY_SOCKET = join(ROOT, 'openai-image-private', 'proxy', 'control.sock');
const CLI = join(ROOT, 'bin', 'openai-image-cli');
const USAGE = '用法：/imagen [text|edit|ref] [studio] [png|gif] [low|medium|high] [flare|sunburst] <描述>\n'
  + '也可以直接说「生成一张插画」「做一张动图」，或附图说「把背景换成雪山」。';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIB = 1024 * 1024;
const ANIMATE_SOURCE = 'edit gif 把原图制作成短循环动图。加一个符合画面的自然微动作，保持原有主体、造型、配色、构图和背景不变。';
const REDRAW_WINDOW_MS = 2 * 60 * 60_000;
const runtimeState = Symbol.for('luke-openai-image.runtime-state.v1');

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

function parseRequest(input, mode) {
  const format = ['png', 'gif'];
  const quality = ['low', 'medium', 'high'];
  const variant = ['flare', 'sunburst'];
  const choices = [format, quality, variant, ['studio']];
  const options = [];
  let prompt = input.trim();
  for (let i = 0; i < choices.length; i++) {
    const [token] = prompt.split(/\s/u, 1);
    const found = choices.findIndex((set) => set.includes(token?.toLowerCase()));
    if (found < 0) break;
    if (options[found]) return null;
    options[found] = token.toLowerCase();
    prompt = prompt.slice(token.length).trimStart();
  }
  if (!prompt || prompt.length > 1800 || prompt === 'help' || prompt === '?') return null;
  const studio = options[3] === 'studio';
  const premium = studio || mode === 'edit';
  const [output_format = inferImagenFormat(prompt),
    imageQuality = premium ? 'high' : output_format === 'gif' ? 'low' : 'medium',
    model = imageQuality === 'low' ? 'flare' : 'sunburst'] = options;
  return { studio, prompt, body: {
    model: `gpt-image-2.6-${model}`, prompt: renderPrompt(mode, prompt),
    quality: imageQuality,
    complexity: imageQuality === 'low' ? 'low' : 'high',
    n: 1, output_format, size: output_format === 'gif' ? '512x512' : mode === 'edit' ? 'auto' : '1024x1024',
    ...(output_format === 'gif' ? { frame_count: 3, frame_duration_ms: 200 } : {}),
  } };
}

export function parseArgs(input = '', mode = 'text') {
  return parseRequest(input, mode)?.body ?? null;
}

function renderPrompt(mode, request, brief) {
  const orientation = mode === 'edit'
    ? 'Image 1 is the original to edit. Make the requested change visibly. If the request replaces or transforms a subject, change that subject to the specified target instead of keeping its original identity. Otherwise preserve the same subjects and their visible traits; do not replace them with lookalikes. Preserve scene and other attributes only where the request does not change them. Other images are supporting references.'
    : mode === 'ref' ? 'Create a new image; use the supplied images as visual references, not as originals to edit.' : '';
  return [orientation, request, brief && `Visual direction (the user's requirements above take precedence):\n${brief}`]
    .filter(Boolean).join('\n\n');
}

function combineRevision(previous, next, feedback) {
  const context = feedback?.length ? `\n此后用户补充（只采用与该图有关的内容）：${feedback.join('；')}` : '';
  const change = `本次要求（优先）：${next}${context}`.slice(0, 1800);
  const label = '\n上一张的出图要求：';
  const available = 1800 - change.length - label.length;
  return available > 0 ? change + label + previous.slice(0, available) : change;
}

function imagenActorKey(context, scope) {
  const actor = typeof context.senderId === 'string' ? context.senderId.trim() : '';
  if (!actor || actor.length > 256) return;
  return JSON.stringify([context.channelId ?? context.channel, context.accountId ?? '', scope.address ?? context.to, actor]);
}

export async function validateImages(paths, root) {
  let total = 0;
  const files = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid_input');
    const file = await realpath(path);
    const sub = relative(root, file);
    if (!sub || sub === '..' || sub.startsWith(`..${sep}`) || isAbsolute(sub)) throw new Error('invalid_input');
    const info = await stat(file);
    total += info.size;
    if (!info.isFile() || info.size > 10 * MIB || total > 20 * MIB) throw new Error('invalid_input');
    const fd = await open(file, 'r');
    const head = Buffer.alloc(12);
    try { await fd.read(head, 0, head.length, 0); }
    finally { await fd.close(); }
    if (!imageMime(head)) {
      throw new Error('invalid_input');
    }
    files.push(file);
  }
  return files;
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

export function readProviderFailure({ killed, stderr, stdout } = {}) {
  if (killed) return { reason: 'timeout' };
  for (const stream of [stderr, stdout]) {
    if (!stream) continue;
    try {
      const root = JSON.parse(stream);
      const err = root.error ?? root;
      const code = err.code ?? root.code;
      const status = Number(err.status_code ?? err.http_status ?? err.status ?? root.status_code ?? root.status);
      if (code === 'insufficient_quota') return { reason: 'quota' };
      if (code === 'rate_limit_exceeded' || status === 429) return { reason: 'rate_limit' };
      if (['content_policy_violation', 'moderation_blocked', 'safety_violations'].includes(code)) return { reason: 'policy' };
      if (status === 401 || status === 403) return { reason: 'auth' };
      if (status === 400 || status === 422 || err.type === 'invalid_request_error') return { reason: 'invalid_request' };
      if (status >= 500 && status <= 599) return { reason: 'upstream' };
    } catch { /* Do not log or replay raw CLI output. */ }
  }
  return { reason: 'provider' };
}

function run(file, args, { input, env, timeout }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const failure = new Error(readProviderFailure({ killed: error.killed, stderr, stdout }).reason);
      reject(failure);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const proxyAddress = (route) => `http://127.0.0.1:${route.port}`;

function apiEnv(key, route) {
  const proxy = proxyAddress(route);
  return {
    PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8',
    OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://api.openai.com/v1',
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy,
    OPENAI_NO_AUTO_UPDATE: '1',
  };
}

async function checkKey(key, model, route) {
  try {
    const output = await run('/usr/bin/curl', ['-q', '--silent', '--fail', '--max-time', '8',
      '--proto', '=https', '--proxy', proxyAddress(route), '--noproxy', '', '--config', '-'], {
      env: apiEnv(key, route), timeout: 10_000,
      input: `url = "https://api.openai.com/v1/models/${model}"\nheader = "Authorization: Bearer ${key}"\n`,
    });
    return JSON.parse(output).id === model;
  } catch { return false; }
}

async function proxyControl(path, seconds) {
  return run('/usr/bin/curl', ['-q', '--silent', '--fail', '--max-time', String(seconds),
    '--unix-socket', PROXY_SOCKET, `http://localhost${path}`], { timeout: (seconds + 1) * 1000, env: {} });
}

async function probeProxy(route) {
  try {
    const status = await run('/usr/bin/curl', ['-q', '--silent', '--max-time', '5', '--proto', '=https',
      '--proxy', proxyAddress(route), '--noproxy', '', '--output', '/dev/null', '--write-out', '%{http_code}',
      OPENAI_PROBE], { timeout: 6000, env: {} });
    return status === '401';
  } catch { return false; }
}

export async function resolveImageProxy() {
  try {
    const { providers } = JSON.parse(await proxyControl('/providers/proxies', 3));
    return await selectImageProxyRoute({
      providers, probe: probeProxy,
      refresh: async ({ group }) => {
        const query = `url=${encodeURIComponent(OPENAI_PROBE)}&timeout=5000&expected=401`;
        const check = (name) => proxyControl(`/group/${name}/delay?${query}`, 7).catch(() => null);
        await Promise.all([check(`${group}-JAPAN-2`), check(`${group}-ALTERNATE`)]);
        await check(group);
      },
    });
  } catch { return null; }
}

export async function planPrompt(input, startAt) {
  const keys = await loadKeys();
  const request = await buildBriefRequest(input);
  const key = keys[startAt];
  const route = await resolveImageProxy();
  if (!route || !await checkKey(key, PLANNER_MODEL, route)) throw new Error('planner_unreachable');
  const output = await run(CLI, ['responses', 'create', '--format', 'json', '--format-error', 'json'], {
    env: apiEnv(key, route), timeout: 90_000, input: JSON.stringify(request),
  });
  const response = JSON.parse(output);
  if (response.status === 'incomplete') throw new Error(
    response.incomplete_details?.reason === 'max_output_tokens' ? 'planner_budget' : 'planner_incomplete',
  );
  if (response.output?.some((item) => item.content?.some((part) => part.type === 'refusal'))) {
    throw new Error('planner_refusal');
  }
  const brief = readVisualBrief(response, input.decideIntent);
  if (!brief) throw new Error('planner_no_brief');
  return brief;
}

export async function generate(body, startAt, images = []) {
  const keys = await loadKeys();
  const route = await resolveImageProxy();
  if (!route) throw new Error('no_provider');
  let rejected;
  for (const key of [keys[startAt], keys[1 - startAt]]) {
    if (!await checkKey(key, body.model, route)) continue;
    let output;
    try {
      output = await run(CLI, ['images', images.length ? 'edit' : 'generate', '--format', 'json', '--format-error', 'json'], {
        env: apiEnv(key, route), timeout: 180_000,
        input: JSON.stringify(images.length ? { ...body, image: images } : body),
      });
    } catch (error) {
      // A request with an uncertain outcome must not generate or charge again.
      if (['quota', 'rate_limit'].includes(error?.message)) { rejected = error; continue; }
      throw error;
    }
    const encoded = JSON.parse(output).data?.[0]?.b64_json;
    const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    const gif = body.output_format === 'gif';
    const valid = gif ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 8).equals(PNG);
    if (!valid || bytes.length > 20 * MIB) throw new Error('invalid_media');
    const dir = join(ROOT, 'media', 'outbound', 'openai-image');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.${body.output_format}`);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return file;
  }
  throw rejected ?? new Error('no_provider');
}

export function createHandler({
  allowedGroups = [], allowAllDingTalkGroups = false, render = generate,
  verify = validateImages, plan = planPrompt, now = Date.now, logger, jobs = createJobPool(),
} = {}) {
  const groups = new Set(allowedGroups.map((value) => value.startsWith('qqbot:') ? value.toLowerCase() : value));
  let nextKey = 0;
  let sequence = 0;
  const recentJobs = new Map();
  function allowedScope(context) {
    const scope = resolveScope(context);
    if (scope && (!scope.group || groups.has(scope.address) ||
        (allowAllDingTalkGroups === true && scope.address.startsWith('ddingtalk:chat:')))) return scope;
  }
  const handle = async (context, signal) => {
    const scope = allowedScope(context);
    if (!scope) return context.intent?.tentative ? undefined : { text: '当前会话未开放生图。' };
    let args = typeof context.args === 'string' ? context.args.trim() : '';
    let images = context.images ?? [];
    const expected = context.expectedImages ?? 0;
    const channel = context.channelId ?? context.channel;
    const actorKey = imagenActorKey(context, scope);
    const previous = actorKey && recentJobs.get(actorKey);
    const redraw = context.intent?.kind === 'redraw' || (!context.intent && isImagenRedraw(args));
    if (redraw && (!previous || now() - previous.at > REDRAW_WINDOW_MS)) {
      return { text: '我没有找到你在这个会话里近期的生图请求。请补充完整出图要求，或把要修改的原图一起发来。' };
    }
    if (context.intent?.kind === 'video') return { text: '目前能做静态图和短 GIF，不能生成视频文件。' };
    if (context.intent?.kind === 'needs-image') return { text: '请引用原图，或把原图和修改要求一起发过来。' };
    if (context.intent?.kind === 'format-correction') {
      const hasExplicitSource = expected > 0 || (channel === 'qqbot' &&
        Number.isSafeInteger(context.quotedImageCount) && context.quotedImageCount > 0);
      if (hasExplicitSource) {
        args = ANIMATE_SOURCE;
      } else {
        if (!previous || previous.mode !== 'text' || previous.format !== 'png' || previous.useContext ||
            now() - previous.at > 5 * 60_000) {
          return { text: '可以做 GIF。请一起发想画的内容；要让某张图动起来，请附上或引用原图。' };
        }
        args = `text gif ${previous.studio ? 'studio ' : ''}${previous.quality} ${previous.variant} ${previous.prompt}`;
      }
    }
    if (!Array.isArray(images) || images.length !== expected || expected > 4) {
      return { text: '图片未下载齐或超过 4 张，请在同一条消息中重新附图。' };
    }
    const modifier = /^(text|edit|ref)(?:\s+|$)/i.exec(args);
    const explicitMode = modifier?.[1].toLowerCase();
    const quoteCount = expected === 0 && explicitMode !== 'text' && Number.isSafeInteger(context.quotedImageCount)
      ? Math.max(0, context.quotedImageCount) : 0;
    if (quoteCount > 4) return { text: '一次最多使用 4 张图，请只引用需要修改的原图。' };
    let source = images.length ? 'attachment' : quoteCount ? 'quote' : 'none';
    let correctionPrompt;
    if (redraw && source === 'none' && previous.paths.length) {
      images = previous.paths;
      source = 'previous-source';
    } else if (source === 'none' && channel === 'qqbot' && explicitMode !== 'text') {
      if (isImagenEditCorrection(args)) {
        if (previous?.mode === 'edit' && previous.paths.length && now() - previous.at <= 10 * 60_000) {
          images = previous.paths;
          correctionPrompt = `此前的编辑目标：${previous.prompt}\n本次纠正：${args}`.slice(0, 1800);
          source = 'previous-edit';
        }
      } else if (wantsRecentImagenSource(args) && Array.isArray(context.recentImages) &&
                 context.recentImages.length > 0 && context.recentImages.length <= 4) {
        images = context.recentImages;
        source = 'recent';
      }
    }
    const hasSource = source !== 'none';
    let mode = explicitMode ?? inferImagenMode(args, hasSource);
    if (correctionPrompt) mode = 'edit';
    if (redraw) mode = hasSource && previous.mode === 'text' ? 'ref' : previous.mode;
    if (!hasSource && (mode !== 'text' || (!explicitMode && (requiresImagenSource(args) || wantsRecentImagenSource(args))))) {
      return { text: '请在同一条消息中上传或引用原图，不会用文字重新画一个替代。' };
    }
    if (mode === 'text' && images.length) return { text: '文生图不接收附件；请去掉图片或使用 edit / ref。' };
    const requestArgs = redraw
      ? `${inferImagenFormat(args) === 'gif' ? 'gif' : previous.format} ${previous.studio ? 'studio ' : ''}${previous.quality} ${previous.variant} ${combineRevision(previous.prompt, args, previous.feedback)}`
      : correctionPrompt ?? args.slice(modifier?.[0].length ?? 0);
    let request = parseRequest(requestArgs, mode);
    if (!request) return { text: USAGE };
    const [quotedText] = boundedContext([context.quotedText]);
    const useContext = Boolean(quotedText);
    if (context.hasQuote && !quotedText && !hasSource && wantsConversationContext(request.prompt)) {
      return { text: '我没有拿到引用内容。请引用原文或原图，或把主题说一下。' };
    }
    const requestSequence = ++sequence;
    if (signal?.aborted) return;
    const release = await jobs.acquire();
    if (!release) return context.intent?.tentative ? undefined : { text: '生图队列繁忙，请稍后再试。' };
    const startAt = nextKey;
    nextKey = 1 - nextKey;
    try {
      if (signal?.aborted) return;
      if (quoteCount > 0) {
        try { images = await context.loadQuotedImages?.(); }
        catch { images = []; }
        if (!Array.isArray(images) || images.length !== quoteCount) {
          return { text: '没能下载到引用里的原图，请把原图重新附在同一条消息中。' };
        }
      }
      const root = channel === 'qqbot' ? join(ROOT, 'media', 'qqbot', 'downloads') : join(ROOT, 'media', 'inbound');
      let files;
      try { files = images.length ? await verify(images, root) : []; }
      catch { return { text: '图片无法使用，请上传 PNG、JPEG 或 WebP（每张不超过 10 MB，总计不超过 20 MB）。' }; }
      const decideIntent = context.intent?.kind === 'generate' && !correctionPrompt;
      let brief;
      let planned;
      let planFailure;
      const planAt = Date.now();
      try {
        planned = await plan({
          prompt: request.prompt, mode, images: files, quotedText,
          format: request.body.output_format, decideIntent,
        }, startAt);
      }
      catch (error) {
        const code = error?.message;
        planFailure = ['timeout', 'provider', 'quota', 'rate_limit', 'policy', 'auth', 'invalid_request', 'upstream',
          'planner_unreachable', 'planner_incomplete', 'planner_budget', 'planner_refusal', 'planner_no_brief'].includes(code)
          ? code : 'unexpected';
        logger?.warn(`[imagen] visual brief failed reason=${planFailure} effort=${PLANNER_EFFORT} elapsedMs=${Date.now() - planAt}`);
      }
      if (planFailure === 'planner_unreachable') {
        return context.intent?.tentative ? undefined : { text: '暂时连不上生图服务，这次没有出图。请稍后再试。' };
      }
      if (decideIntent) {
        if (!planned) return context.intent?.tentative ? undefined : { text: '暂时没能完成生图请求解析，请稍后再试。' };
        if (planned.intent === 'ignore') return;
        if (planned.intent === 'video') return { text: '目前能做静态图和短 GIF，不能生成视频文件。' };
        if (planned.intent === 'needs_image' || (['edit', 'ref'].includes(planned.intent) && !files.length)) {
          return { text: '请引用原图，或把原图和修改要求一起发过来。' };
        }
        if (!['text', 'ref', 'edit'].includes(planned.intent) || !['png', 'gif'].includes(planned.format)) return;
        if (!planned.brief) return { text: '我还不能确定你想画什么。把需要参考的原文或原图发给我吧。' };
        mode = planned.intent === 'text' && files.length ? mode : planned.intent;
        const format = inferImagenFormat(request.prompt) === 'gif' ? 'gif' : planned.format;
        request = parseRequest(`${format} ${requestArgs}`, mode);
        if (!request) return;
        brief = planned.brief;
      } else {
        brief = planned;
      }
      const { body, prompt, studio } = request;
      logger?.info(`[imagen] accepted channel=${channel} mode=${mode} format=${body.output_format} trigger=${redraw ? 'redraw' : context.intent ? 'natural' : 'command'} attachments=${files.length} source=${source}`);
      logger?.info(`[imagen] visual brief ${brief ? 'ready' : 'unavailable'} channel=${channel} mode=${mode} quote=${Boolean(quotedText)} model=${PLANNER_MODEL} effort=${PLANNER_EFFORT} elapsedMs=${Date.now() - planAt}`);
      if (!brief && useContext && !files.length) return { text: '这次没能确认所指的素材，没有继续出图。请补一下原文、原图或目标。' };
      if (!brief && (files.length || redraw)) {
        return { text: planFailure === 'planner_no_brief'
          ? '我没能确认原图应该改成什么样。请补充目标外观，或一起附上目标参考图。'
          : '这次没能完成看图和改图规划，没有继续生成。请稍后再试。' };
      }
      if (brief) body.prompt = renderPrompt(mode, prompt, brief);
      if (signal?.aborted) return;
      logger?.info(`[imagen] render settings model=${body.model} quality=${body.quality} complexity=${body.complexity}`);
      const mediaUrl = await render(body, startAt, files);
      if (actorKey && (recentJobs.get(actorKey)?.sequence ?? 0) < requestSequence) {
        recentJobs.delete(actorKey);
        if (recentJobs.size >= 128) recentJobs.delete(recentJobs.keys().next().value);
        recentJobs.set(actorKey, {
          at: now(), sequence: requestSequence, mode, paths: files, format: body.output_format, useContext,
          prompt: correctionPrompt ? previous.prompt : prompt,
          studio, quality: body.quality, variant: body.model.split('-').at(-1),
        });
      }
      logger?.info(`[imagen] rendered channel=${channel} mode=${mode} format=${body.output_format}`);
      return { mediaUrl, channelData: { imagen: true } };
    } catch (error) {
      const messages = {
        no_provider: '暂时没有可用的生图线路，本次未出图。',
        timeout: '生图接口超时，未收到成品，不能确认服务端是否已完成。',
        quota: '生图账号额度不足，本次未出图。',
        rate_limit: '生图接口限流，本次未出图。',
        policy: '生图服务拒绝了这次请求，本次未出图。',
        auth: '生图服务的账号认证失败，本次未出图。',
        invalid_request: '生图接口拒绝了请求参数，本次未出图。',
        upstream: '生图服务返回错误，未收到成品。',
        invalid_media: '生图接口返回的文件无效，没法发送。',
      };
      const reason = typeof error?.message === 'string' && Object.hasOwn(messages, error.message) ? error.message : 'provider';
      logger?.warn(`[imagen] generation failed reason=${reason}`);
      return { text: messages[reason] ?? '没收到生图成品，暂时无法确定失败原因。',
        details: { status: reason === 'no_provider' ? 'not_started' : 'failed', reason } };
    }
    finally { release(); }
  };
  handle.allowed = context => Boolean(allowedScope(context));
  handle.observe = (context, text) => {
    const scope = allowedScope(context);
    if (!scope) return;
    const job = recentJobs.get(imagenActorKey(context, scope));
    if (!job || now() - job.at > REDRAW_WINDOW_MS) return;
    const [feedback] = boundedContext([text]);
    if (feedback) job.feedback = [...(job.feedback ?? []).filter((line) => line !== feedback), feedback].slice(-3);
  };
  return handle;
}

export default {
  id: 'luke-openai-image',
  register(api) {
    // The gateway can load dispatch hooks and tool factories in separate plugin registries.
    const state = globalThis[runtimeState] ??= { turns: new Map() };
    state.handle ??= createHandler({
      allowedGroups: api.pluginConfig?.allowedGroups ?? [],
      allowAllDingTalkGroups: api.pluginConfig?.allowAllDingTalkGroups === true,
      jobs: createJobPool({ concurrency: api.pluginConfig?.maxConcurrentJobs ?? 4 }),
      logger: api.logger,
    });
    registerImagenTool(api, state.handle, { turns: state.turns });
  },
};
