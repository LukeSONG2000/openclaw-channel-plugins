import { createHash } from 'node:crypto';
import { policyVersion, routeKey, sourceRoute } from './routing.mjs';
import { planWindowReplies } from './window-reply.mjs';

const TRUSTED_INPUT = 'qq-group-single-v1';

function windowPolicy(route, { cfg, routes }) {
  if (route.channel !== 'qqbot' || !route.group) return;
  const options = routes.find((entry) => entry?.channel === route.channel &&
    entry?.account === route.account && entry?.to === route.to)?.windowReply;
  if (!options || typeof options.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(options.agentId)) return;
  const seconds = options.seconds ?? 60;
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 120) return;
  const channelPolicy = policyVersion(cfg, route, routes);
  if (!channelPolicy) return;
  return {
    agentId: options.agentId, windowMs: seconds * 1000,
    version: createHash('sha256').update(JSON.stringify([channelPolicy, options.agentId, seconds])).digest('hex'),
  };
}

export function createWindowRuntime({ store, current, generate, send, now = Date.now, log = () => {} }) {
  const controller = new AbortController();
  const running = new Map();
  const invalidated = new Set();

  function admit(source, context) {
    if (controller.signal.aborted || !source.text || source.message.length > 256 || context.WasMentioned !== false ||
        context.QQBotWindowIngress !== TRUSTED_INPUT || context.SenderIsBot || context.SenderIsSelf ||
        context.ReplyToIsQuote || context.ReplyToBody || context.MediaPath || context.MediaUrl ||
        context.MediaPaths?.length || context.MediaUrls?.length || context.media?.length || context.mediaStagingPending) return;
    const policy = windowPolicy(source, current());
    if (!policy) return;
    return () => {
      if (controller.signal.aborted || windowPolicy(source, current())?.version !== policy.version) return false;
      const text = /(?:密码|密钥|验证码|access[_ -]?token|api[_ -]?key)/iu.test(source.text) ? ''
        : source.text.replace(/<@!?[^>]+>|https?:\/\/[^\s<>]+|\bsk-[\w-]{10,}/giu, '').trim().slice(0, 320);
      if (!text) return false;
      const speaker = typeof context.SenderName === 'string' && context.SenderName.trim()
        ? context.SenderName.trim().slice(0, 60) : source.sender.slice(0, 60);
      store.rememberWindow({
        route: routeKey(source), policy: policy.version, message: source.message, sender: speaker, text, at: now(),
      });
      return true;
    };
  }

  function onMention(source, context) {
    if (context.WasMentioned === true) {
      const key = routeKey(source);
      if (running.has(key)) invalidated.add(key);
    }
  }

  function pump() {
    if (controller.signal.aborted || running.size >= 2) return;
    const config = current();
    for (const entry of config.routes) {
      if (running.size >= 2) break;
      const route = sourceRoute(entry?.channel, entry?.account, entry?.to);
      if (!route) continue;
      const key = routeKey(route);
      const policy = windowPolicy(route, config);
      if (!policy || running.has(key)) continue;
      const batch = store.claimWindow(key, policy.version, now(), policy.windowMs);
      if (!batch) continue;
      const assertCurrent = () => !controller.signal.aborted && !invalidated.has(key) &&
        windowPolicy(route, current())?.version === policy.version;
      const run = (async () => {
        const actions = await planWindowReplies({
          ...batch, generate: (prompt) => generate({ agentId: policy.agentId, prompt, signal: controller.signal }),
        });
        let sent = 0;
        for (const action of actions) {
          if (!assertCurrent()) break;
          const receipt = await send({ ...route, text: action.text, replyToId: action.replyToId, assertCurrent });
          if (receipt?.channel !== route.channel || !receipt.messageId) {
            log('window_delivery_uncertain', { mode: action.mode });
            break;
          }
          sent++;
        }
        log('window_complete', { messages: batch.unread.length, sent });
      })().catch(() => log('window_delivery_uncertain')).finally(() => {
        running.delete(key);
        invalidated.delete(key);
      });
      running.set(key, run);
    }
  }

  return { admit, onMention, pump, stop: () => {
    controller.abort();
    return Promise.allSettled(running.values());
  } };
}
