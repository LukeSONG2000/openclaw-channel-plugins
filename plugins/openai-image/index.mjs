import { execFile } from 'node:child_process';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { inferImagenFormat, inferImagenMode, isImagenEditCorrection, recognizeImagenIntent, requiresImagenSource, wantsRecentImagenSource } from './intent.mjs';
import { boundedContext, buildBriefRequest, imageMime, PLANNER_EFFORT, PLANNER_MODEL, readVisualBrief, wantsGroupContext } from './visual-brief.mjs';

const ROOT = join(homedir(), '.openclaw');
const PROXY = 'http://127.0.0.1:17979';
const CLI = join(ROOT, 'bin', 'openai-image-cli');
const USAGE = '用法：/imagen [text|edit|ref] [studio] [png|gif] [low|medium|high] [flare|sunburst] <描述>\n'
  + '也可以直接说「生成一张插画」「做一张动图」，或附图说「把背景换成雪山」。';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIB = 1024 * 1024;
const ANIMATE_SOURCE = 'edit gif 把原图制作成短循环动图。加一个符合画面的自然微动作，保持原有主体、造型、配色、构图和背景不变。';

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

async function refreshProxy() {
  try {
    await run('/usr/bin/curl', ['-q', '--silent', '--fail', '--max-time', '8', '--unix-socket',
      join(ROOT, 'openai-image-private', 'proxy', 'control.sock'),
      'http://localhost/group/OPENAI-IMAGE/delay?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fmodels&timeout=6500&expected=401'],
    { timeout: 10_000, env: {} });
  } catch { /* A failed refresh must not trigger a paid request. */ }
}

export async function planPrompt(input, startAt) {
  const keys = await loadKeys();
  const request = await buildBriefRequest(input);
  const key = keys[startAt];
  if (!await checkKey(key, PLANNER_MODEL)) {
    await refreshProxy();
    if (!await checkKey(key, PLANNER_MODEL)) throw new Error('planner_unreachable');
  }
  const output = await run(CLI, ['responses', 'create', '--format', 'json', '--format-error', 'json'], {
    env: apiEnv(key), timeout: 90_000, input: JSON.stringify(request),
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
  let refreshed = false;
  for (const key of [keys[startAt], keys[1 - startAt]]) {
    let ready = await checkKey(key, body.model);
    if (!ready && !refreshed) {
      refreshed = true;
      await refreshProxy();
      ready = await checkKey(key, body.model);
    }
    if (!ready) continue;
    let output;
    try {
      output = await run(CLI, ['images', images.length ? 'edit' : 'generate', '--format', 'json', '--format-error', 'json'], {
        env: apiEnv(key), timeout: 180_000,
        input: JSON.stringify(images.length ? { ...body, image: images } : body),
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
      : bytes.subarray(0, 8).equals(PNG);
    if (!valid || bytes.length > 20 * MIB) throw new Error('invalid_media');
    const dir = join(ROOT, 'media', 'outbound', 'openai-image');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${randomUUID()}.${body.output_format}`);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return file;
  }
  throw new Error('no_provider');
}

export function createHandler({
  allowedGroups = [], allowAllDingTalkGroups = false, render = generate,
  verify = validateImages, plan = planPrompt, now = Date.now, logger,
} = {}) {
  const groups = new Set(allowedGroups.map((value) => value.startsWith('qqbot:') ? value.toLowerCase() : value));
  let active = false;
  let nextKey = 0;
  let lastStart = -Infinity;
  const recentTextJobs = new Map();
  const recentEdits = new Map();
  return async (context) => {
    const scope = resolveScope(context);
    if (!scope || (scope.group && !groups.has(scope.address) &&
        !(allowAllDingTalkGroups === true && scope.address.startsWith('ddingtalk:chat:')))) {
      return { text: '当前会话未开放生图。' };
    }
    let args = typeof context.args === 'string' ? context.args.trim() : '';
    let images = context.images ?? [];
    const expected = context.expectedImages ?? 0;
    const channel = context.channelId ?? context.channel;
    const actor = typeof context.senderId === 'string' ? context.senderId.trim() : '';
    const actorKey = actor && actor.length <= 256 ? JSON.stringify([
      context.channelId ?? context.channel, context.accountId ?? '', scope.address ?? context.to, actor,
    ]) : undefined;
    if (context.intent?.kind === 'video') return { text: '目前能做静态图和短 GIF，不能生成视频文件。' };
    if (context.intent?.kind === 'needs-image') return { text: '请引用原图，或把原图和修改要求一起发过来。' };
    if (context.intent?.kind === 'format-correction') {
      const hasExplicitSource = expected > 0 || (channel === 'qqbot' &&
        Number.isSafeInteger(context.quotedImageCount) && context.quotedImageCount > 0);
      if (hasExplicitSource) {
        args = ANIMATE_SOURCE;
      } else {
        const previous = actorKey && recentTextJobs.get(actorKey);
        if (!previous || now() - previous.at > 5 * 60_000) {
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
    if (source === 'none' && channel === 'qqbot' && explicitMode !== 'text') {
      if (isImagenEditCorrection(args)) {
        const previous = actorKey && recentEdits.get(actorKey);
        if (previous && now() - previous.at <= 10 * 60_000) {
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
    if (!hasSource && (mode !== 'text' || (!explicitMode && (requiresImagenSource(args) || wantsRecentImagenSource(args))))) {
      return { text: '请在同一条消息中上传或引用原图，不会用文字重新画一个替代。' };
    }
    if (mode === 'text' && images.length) return { text: '文生图不接收附件；请去掉图片或使用 edit / ref。' };
    const requestArgs = correctionPrompt ?? args.slice(modifier?.[0].length ?? 0);
    let request = parseRequest(requestArgs, mode);
    if (!request) return { text: USAGE };
    const useContext = scope.group && wantsGroupContext(request.prompt);
    const contextLines = useContext ? boundedContext(context.recentChat) : [];
    if (useContext && !contextLines.length) return { text: '我现在没有足够的本群近期消息来构图。发我想画的主题或一个群梗吧。' };
    if (active || now() - lastStart < 10_000) return { text: '生图繁忙，请稍后再试。' };
    active = true;
    lastStart = now();
    const startAt = nextKey;
    nextKey = 1 - nextKey;
    try {
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
          prompt: request.prompt, mode, images: files, context: contextLines,
          format: request.body.output_format, decideIntent,
        }, startAt);
      }
      catch (error) {
        const code = error?.message;
        planFailure = ['timeout', 'provider', 'planner_unreachable', 'planner_incomplete', 'planner_budget', 'planner_refusal', 'planner_no_brief'].includes(code)
          ? code : 'unexpected';
        logger?.warn(`[imagen] visual brief failed reason=${planFailure} effort=${PLANNER_EFFORT} elapsedMs=${Date.now() - planAt}`);
      }
      if (decideIntent) {
        if (!planned) return { text: '暂时没能完成生图请求解析，请稍后再试。' };
        if (planned.intent === 'ignore') return;
        if (planned.intent === 'video') return { text: '目前能做静态图和短 GIF，不能生成视频文件。' };
        if (planned.intent === 'needs_image' || (['edit', 'ref'].includes(planned.intent) && !files.length)) {
          return { text: '请引用原图，或把原图和修改要求一起发过来。' };
        }
        if (!['text', 'ref', 'edit'].includes(planned.intent) || !['png', 'gif'].includes(planned.format) || !planned.brief) return;
        mode = planned.intent === 'text' && files.length ? mode : planned.intent;
        const format = inferImagenFormat(request.prompt) === 'gif' ? 'gif' : planned.format;
        request = parseRequest(`${format} ${requestArgs}`, mode);
        if (!request) return;
        brief = planned.brief;
      } else {
        brief = planned;
      }
      const { body, prompt, studio } = request;
      logger?.info(`[imagen] accepted channel=${channel} mode=${mode} format=${body.output_format} trigger=${context.intent ? 'natural' : 'command'} attachments=${files.length} source=${source}`);
      logger?.info(`[imagen] visual brief ${brief ? 'ready' : 'unavailable'} channel=${channel} mode=${mode} context=${contextLines.length} model=${PLANNER_MODEL} effort=${PLANNER_EFFORT} elapsedMs=${Date.now() - planAt}`);
      if (!brief && useContext) return { text: '这次没能整理出本群主题。请稍后再试，或直接告诉我想画什么。' };
      if (!brief && files.length) {
        return { text: planFailure === 'planner_no_brief'
          ? '我没能确认原图应该改成什么样。请补充目标外观，或一起附上目标参考图。'
          : '这次没能完成看图和改图规划，没有继续生成。请稍后再试。' };
      }
      if (brief) body.prompt = renderPrompt(mode, prompt, brief);
      logger?.info(`[imagen] render settings model=${body.model} quality=${body.quality} complexity=${body.complexity}`);
      const mediaUrl = await render(body, startAt, files);
      if (actorKey) {
        recentTextJobs.delete(actorKey);
        if (mode === 'text' && !useContext && body.output_format === 'png') {
          if (recentTextJobs.size >= 128) recentTextJobs.delete(recentTextJobs.keys().next().value);
          recentTextJobs.set(actorKey, { at: now(), prompt, studio, quality: body.quality, variant: body.model.split('-').at(-1) });
        }
        if (mode === 'edit' && channel === 'qqbot' && files.length) {
          const originalPrompt = correctionPrompt ? recentEdits.get(actorKey)?.prompt ?? prompt : prompt;
          recentEdits.delete(actorKey);
          if (recentEdits.size >= 128) recentEdits.delete(recentEdits.keys().next().value);
          recentEdits.set(actorKey, { at: now(), paths: files, prompt: originalPrompt });
        } else {
          recentEdits.delete(actorKey);
        }
      }
      logger?.info(`[imagen] rendered channel=${channel} mode=${mode} format=${body.output_format}`);
      return { mediaUrl, channelData: { imagen: true } };
    } catch (error) {
      const code = error?.message === 'no_provider' ? 'unavailable' : 'failed';
      logger?.warn(`[imagen] generation ${code}`);
      return { text: code === 'unavailable' ? '生图服务暂时连不上，请稍后再试。' : '生图暂时失败，请稍后再试。' };
    }
    finally { active = false; }
  };
}

export function createDispatchHook(handler) {
  return async (event, dispatch) => {
    const ctx = event.ctx;
    const input = ctx?.ImagenInput;
    const channel = ctx?.Provider;
    if (!input || !['qqbot', 'ddingtalk'].includes(channel) || ctx.OriginatingChannel !== channel) return;
    const hasPotentialSource = input.expectedImages > 0 || input.quotedImageCount > 0 ||
      (channel === 'qqbot' && (isImagenEditCorrection(input.naturalText ?? '') ||
        (input.recentImages?.length > 0 && wantsRecentImagenSource(input.naturalText ?? ''))));
    const intent = typeof input.args === 'string' ? undefined : recognizeImagenIntent(input.naturalText, hasPotentialSource);
    if (typeof input.args !== 'string' && !intent) return;
    const { dispatcher } = dispatch;
    let queuedFinal = false;
    if (event.sendPolicy !== 'deny' && !event.suppressUserDelivery && !event.isTailDispatch &&
        ctx.OriginatingTo === ctx.To) {
      const reply = await handler({
        channel, from: ctx.From, to: ctx.To,
        args: input.args ?? intent?.args, intent, images: input.images, expectedImages: input.expectedImages,
        recentChat: input.recentChat, senderId: ctx.SenderId, accountId: ctx.AccountId,
        quotedImageCount: channel === 'qqbot' ? input.quotedImageCount : undefined,
        loadQuotedImages: channel === 'qqbot' ? input.loadQuotedImages : undefined,
        recentImages: channel === 'qqbot' ? input.recentImages : undefined,
      });
      if (!reply) return;
      if (channel === 'ddingtalk' && reply.text) reply.text = `<dingtalk_final>${reply.text}</dingtalk_final>`;
      queuedFinal = dispatcher.sendFinalReply(reply);
    }
    dispatch.recordProcessed('completed', { reason: 'imagen_handled' });
    dispatch.markIdle('message_completed');
    return { handled: true, queuedFinal, counts: dispatcher.getQueuedCounts() };
  };
}

export default {
  id: 'luke-openai-image',
  register(api) {
    api.on('reply_dispatch', createDispatchHook(createHandler({
      allowedGroups: api.pluginConfig?.allowedGroups ?? [],
      allowAllDingTalkGroups: api.pluginConfig?.allowAllDingTalkGroups === true,
      logger: api.logger,
    })));
    api.registerCommand({
      name: 'imagen', description: '文生图、精修和参考图生成',
      channels: ['qqbot', 'ddingtalk'], acceptsArgs: true, requireAuth: false,
      handler: (ctx) => ({
        text: (ctx?.channelId ?? ctx?.channel) === 'ddingtalk' ? `<dingtalk_final>${USAGE}</dingtalk_final>` : USAGE,
      }),
    });
  },
};
