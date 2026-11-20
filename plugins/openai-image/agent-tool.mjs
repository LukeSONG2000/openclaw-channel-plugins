import { registerConversationTool } from './conversation-tool.mjs';
import { boundedContext } from './visual-brief.mjs';

const toolName = 'luke_imagen';
const boundTools = new Set([toolName, 'read_conversation_context']);
const turnBinding = Symbol.for('luke-openai-image.tool-turn-binding');
const ttl = 5 * 60_000;
const channels = new Set(['qqbot', 'ddingtalk']);
const modes = ['text', 'edit', 'ref'];
const formats = ['png', 'gif'];
const qualities = ['low', 'medium', 'high'];
const variants = ['flare', 'sunburst'];
const answer = (text, details) => ({ content: [{ type: 'text', text }], ...(details ? { details } : {}) });

function normalizeSlash(ctx, input) {
  const args = input.args.trim();
  const [quotedText] = boundedContext([ctx.ReplyToBody]);
  const hasMaterial = Boolean(quotedText || input.expectedImages > 0 || input.quotedImageCount > 0);
  const instruction = '请使用 Imagen 技能完成这次请求（用户显式指定 /imagen）。';
  const request = args
    ? instruction + ' 用户补充的要求：' + args
    : instruction + (hasMaterial
      ? '以本轮引用或所附图片为创作素材，提炼后直接调用技能出图，不要让用户重复描述或再确认。'
      : '有明确的同会话素材就据此创作；只有确实无法确定要画什么时才询问。');
  const body = ctx.BodyForAgent ?? ctx.Body ?? '';
  ctx.BodyForAgent = [body, request].filter(Boolean).join('\n\n');
  ctx.CommandBody = request;
  ctx.RawBody = request;
  ctx.BodyForCommands = request;
}

export function registerImagenTool(api, handle, { now = Date.now, turns = new Map() } = {}) {
  const key = (session, id) => JSON.stringify([session, id]);
  function sweep() {
    for (const [id, entry] of turns) if (entry.expires <= now()) turns.delete(id);
    while (turns.size >= 128) turns.delete(turns.keys().next().value);
  }

  api.on('reply_dispatch', (event, dispatch) => {
    const { ctx, runId } = event;
    const channel = ctx?.Provider;
    const input = ctx?.ImagenInput;
    const sessionKey = ctx?.SessionKey ?? event.sessionKey;
    if ((!input && typeof ctx?.ConversationContextLoader !== 'function') || !channels.has(channel) || ctx.OriginatingChannel !== channel ||
      ctx.OriginatingTo !== ctx.To || !runId || !sessionKey || !ctx.SenderId ||
      event.isTailDispatch || event.suppressUserDelivery || event.sendPolicy === 'deny') return;
    const source = { channel, from: ctx.From, to: ctx.To, senderId: ctx.SenderId, accountId: ctx.AccountId };
    if (typeof input?.args === 'string') normalizeSlash(ctx, input);
    if (!handle.allowed(source)) return;
    if (typeof input?.naturalText === 'string') handle.observe?.(source, input.naturalText);
    sweep();
    const id = key(sessionKey, runId);
    if (!turns.has(id)) turns.set(id, {
      source, input, signal: dispatch.abortSignal, expires: now() + ttl,
      quotedText: ctx.ReplyToBody, hasQuote: Boolean(ctx.ReplyToIsQuote || ctx.ReplyToId || ctx.ReplyToBody),
      loadContext: ctx.ConversationContextLoader,
    });
  });

  api.on('before_tool_call', (event, ctx) => {
    if (!boundTools.has(event.toolName)) return;
    const { sessionKey, runId, toolCallId } = ctx;
    if (!sessionKey || !runId || !toolCallId || event.toolCallId !== toolCallId || event.runId !== runId) return;
    const entry = turns.get(key(sessionKey, runId));
    if (!entry || entry.expires <= now() || entry.signal?.aborted) return;
    // The host merges hook overrides into the execution arguments. A symbol keeps the
    // one-use binding out of the model's JSON schema and serialized tool arguments.
    return { params: { [turnBinding]: { sessionKey, runId, toolCallId, name: event.toolName, used: false } } };
  });

  function bindTool(ctx, { execute, ...definition }) {
    return {
      ...definition,
      async execute(callId, params, signal) {
        const binding = params?.[turnBinding];
        const matches = binding && !binding.used && binding.name === definition.name &&
          binding.toolCallId === callId && binding.sessionKey === ctx.sessionKey;
        const entry = matches ? turns.get(key(binding.sessionKey, binding.runId)) : undefined;
        if (!entry || entry.expires <= now() || entry.signal?.aborted || signal?.aborted ||
          entry.source.channel !== ctx.messageChannel) {
          api.logger?.warn?.(`[conversation] no active turn binding for ${definition.name}`);
          return answer('这条消息没能接上原始会话，本次没有执行工具。不要自动重试或声称接口报错；等用户发来新的有效请求再继续。',
            { status: 'not_started', reason: 'no_active_turn' });
        }
        binding.used = true;
        return execute(entry, params);
      },
    };
  }

  registerConversationTool(api, bindTool);
  api.registerTool((ctx) => {
    if (!channels.has(ctx.messageChannel) || !ctx.sessionKey) return;
    return bindTool(ctx, {
      name: toolName,
      label: 'Imagen',
      description: 'Generate, edit or animate an image for the current QQ or DingTalk request. Read the imagen skill before use.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 1700 },
          mode: { type: 'string', enum: modes },
          format: { type: 'string', enum: formats },
          quality: { type: 'string', enum: qualities },
          variant: { type: 'string', enum: variants },
          studio: { type: 'boolean' },
        },
      },
      async execute(entry, params) {
        if (!entry.input) return answer('当前消息没有可用的生图素材入口。');
        const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
        if (!prompt || prompt.length > 1700) return answer('请补充描述要画什么。');
        if (!entry.result) {
          const args = [modes.includes(params.mode) && params.mode, formats.includes(params.format) && params.format,
            qualities.includes(params.quality) && params.quality, variants.includes(params.variant) && params.variant,
            params.studio === true && 'studio', prompt].filter(Boolean).join(' ');
          entry.result = Promise.resolve().then(() => handle({
            ...entry.source, ...entry.input, args, quotedText: entry.quotedText, hasQuote: entry.hasQuote,
          }, entry.signal)).then(result => {
            if (result?.mediaUrl) entry.media = result;
            return result;
          });
        }
        try {
          const result = await entry.result;
          return answer(result?.mediaUrl
            ? '图片已生成，会随本轮最终回复一起发送。请简短正常回复，不要输出路径或重复调用。'
            : result?.text ?? '本次没有生成图片。', result?.details);
        } catch {
          return answer('生图暂时失败。');
        }
      },
    });
  }, { name: toolName });

  api.on('reply_payload_sending', (event, ctx) => {
    if (event.kind !== 'final' || event.payload?.isFallbackNotice || event.payload?.isCompactionNotice ||
      event.payload?.isError) return;
    const id = key(event.sessionKey ?? ctx?.sessionKey, event.runId ?? ctx?.runId);
    const entry = turns.get(id);
    if (!entry?.media || entry.signal?.aborted || entry.expires <= now() ||
      (event.channel ?? ctx?.channelId) !== entry.source.channel) return;
    const { mediaUrl, channelData } = entry.media;
    entry.media = undefined;
    return { payload: { ...event.payload, mediaUrl, mediaUrls: [mediaUrl],
      channelData: { ...event.payload.channelData, ...channelData } } };
  });
}
