const toolName = 'luke_imagen';
const ttl = 5 * 60_000;
const channels = new Set(['qqbot', 'ddingtalk']);
const modes = ['text', 'edit', 'ref'];
const formats = ['png', 'gif'];
const qualities = ['low', 'medium', 'high'];
const variants = ['flare', 'sunburst'];
const answer = text => ({ content: [{ type: 'text', text }] });

function normalizeSlash(ctx, args) {
  const request = args.trim()
    ? '请使用 Imagen 技能完成这次请求（用户显式指定 /imagen）：' + args
    : '用户显式指定了 /imagen，但没写绘图描述。若当前上下文不足，请正常询问要画什么。';
  const body = ctx.BodyForAgent ?? ctx.Body ?? '';
  ctx.BodyForAgent = [body, request].filter(Boolean).join('\n\n');
  ctx.CommandBody = request;
  ctx.RawBody = request;
  ctx.BodyForCommands = request;
}

export function registerImagenTool(api, handle, now = Date.now) {
  const turns = new Map();
  const calls = new Map();
  const key = (session, id) => JSON.stringify([session, id]);
  function sweep() {
    for (const [id, entry] of turns) if (entry.expires <= now()) turns.delete(id);
    for (const [id, entry] of calls) if (entry.expires <= now()) calls.delete(id);
    while (turns.size >= 128) turns.delete(turns.keys().next().value);
  }

  api.on('reply_dispatch', (event, dispatch) => {
    const { ctx, runId } = event;
    const channel = ctx?.Provider;
    const input = ctx?.ImagenInput;
    const sessionKey = ctx?.SessionKey ?? event.sessionKey;
    if (!input || !channels.has(channel) || ctx.OriginatingChannel !== channel ||
      ctx.OriginatingTo !== ctx.To || !runId || !sessionKey || !ctx.SenderId ||
      event.isTailDispatch || event.suppressUserDelivery || event.sendPolicy === 'deny') return;
    const source = { channel, from: ctx.From, to: ctx.To, senderId: ctx.SenderId, accountId: ctx.AccountId };
    if (typeof input.args === 'string') normalizeSlash(ctx, input.args);
    if (!handle.allowed(source)) return;
    if (typeof input.naturalText === 'string') handle.observe?.(source, input.naturalText);
    sweep();
    const id = key(sessionKey, runId);
    if (!turns.has(id)) turns.set(id, {
      source, input, signal: dispatch.abortSignal, expires: now() + ttl,
      quotedText: ctx.ReplyToBody, hasQuote: Boolean(ctx.ReplyToIsQuote || ctx.ReplyToId || ctx.ReplyToBody),
      loadContext: ctx.ConversationContextLoader,
    });
  });

  api.on('before_tool_call', (event, ctx) => {
    if (event.toolName !== toolName) return;
    const entry = turns.get(key(ctx.sessionKey, event.runId ?? ctx.runId));
    const callId = event.toolCallId ?? ctx.toolCallId;
    if (!entry || !callId || !ctx.sessionKey || entry.expires <= now() || entry.signal?.aborted) {
      return { block: true, blockReason: 'Imagen requires a current, permitted QQ or DingTalk message.' };
    }
    const id = key(ctx.sessionKey, callId);
    const existing = calls.get(id);
    if (existing && existing !== entry) return { block: true, blockReason: 'Imagen call identity is ambiguous.' };
    calls.set(id, entry);
  });

  api.registerTool((ctx) => {
    if (!channels.has(ctx.messageChannel) || !ctx.sessionKey) return;
    return {
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
          contextRange: { type: 'string', enum: ['recent', 'today', 'last24h'],
            description: 'When the image depends on this conversation, select the time range requested by the user. Omit for a self-contained request.' },
        },
      },
      async execute(callId, params) {
        const id = key(ctx.sessionKey, callId);
        const entry = calls.get(id);
        calls.delete(id);
        if (!entry || entry.expires <= now() || entry.signal?.aborted ||
          ctx.messageChannel !== entry.source.channel ||
          (ctx.requesterSenderId && ctx.requesterSenderId !== entry.source.senderId)) {
          return answer('当前会话没有可用的生图授权。');
        }
        const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
        if (!prompt || prompt.length > 1700) return answer('请补充描述要画什么。');
        if (!entry.result) {
          const args = [modes.includes(params.mode) && params.mode, formats.includes(params.format) && params.format,
            qualities.includes(params.quality) && params.quality, variants.includes(params.variant) && params.variant,
            params.studio === true && 'studio', prompt].filter(Boolean).join(' ');
          entry.result = Promise.resolve().then(async () => {
            let contextSnapshot;
            if (params.contextRange === 'today' || params.contextRange === 'last24h') {
              contextSnapshot = await entry.loadContext?.(params.contextRange);
              if (!contextSnapshot?.messages?.length) {
                return { text: '我没拿到这段时间内可用的对话，不能把最近几条当成整个时间段来画。请提供素材或改用较近的上下文。' };
              }
            }
            return handle({
              ...entry.source, ...entry.input, args, quotedText: entry.quotedText, hasQuote: entry.hasQuote,
              useRecentChat: params.contextRange === 'recent', contextSnapshot,
            }, entry.signal);
          }).then(result => {
            if (result?.mediaUrl) entry.media = result;
            return result;
          });
        }
        try {
          const result = await entry.result;
          return answer(result?.mediaUrl
            ? '图片已生成，会随本轮最终回复一起发送。请简短正常回复，不要输出路径或重复调用。'
            : result?.text ?? '本次没有生成图片。');
        } catch {
          return answer('生图暂时失败。');
        }
      },
    };
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
