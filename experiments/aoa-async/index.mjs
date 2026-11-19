import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { collectAttachments } from './input.mjs';
import { acceptedSource, historyRow, identifyTask, policyVersion, routeKey, sourceRoute } from './routing.mjs';
import { openStore, testRoot } from './store.mjs';
import { createWindowRuntime } from './window-runtime.mjs';

const ID = 'luke-aoa-async';
const REJECT_INPUT = '这次没有拿到可整理的本地附件。请在同一条消息里附上文本、表格（CSV/TSV）或可复制文字的 PDF。';

export function createBridge({ store, mediaRoot, current, send, generateWindow, now = Date.now, log = () => {} }) {
  let active = true;
  let lastPrune = -Infinity;
  let sending;
  const grants = new Set(store.routes());
  const windows = generateWindow && createWindowRuntime({ store, current, send, generate: generateWindow, now, log });

  function livePolicy(route) {
    const { cfg, routes } = current();
    return policyVersion(cfg, route, routes);
  }

  async function reply(event, dispatch) {
    const source = acceptedSource(event);
    if (!active || !source) return;
    const ctx = event.ctx;
    windows?.onMention(source, ctx);
    const kind = identifyTask(source.text, source.group, Boolean(ctx.MediaPath || ctx.MediaPaths?.length ||
      ctx.media?.length || ctx.MediaUrl || ctx.mediaStagingPending));
    const captureWindow = !kind && windows?.admit(source, ctx);
    if (!kind && !captureWindow) return;
    const policy = livePolicy(source);
    if (!policy) return;
    const route = routeKey(source);
    const finish = (text) => {
      const queuedFinal = text ? dispatch.dispatcher.sendFinalReply({ text }) : false;
      dispatch.recordProcessed('completed', { reason: 'aoa_async' });
      dispatch.markIdle('message_completed');
      return { handled: true, queuedFinal, counts: dispatch.dispatcher.getQueuedCounts() };
    };
    await dispatch.turnAdoption?.adopt();
    dispatch.turnAdoption?.assertCurrent();
    if (!active || dispatch.abortSignal?.aborted) return finish();
    if (livePolicy(source) !== policy) return finish();
    if (captureWindow) {
      try {
        if (captureWindow()) return finish();
      } catch { log('window_admission_error'); }
      return;
    }
    let response;
    try {
      if (store.known(route, source.message)) return finish();
      const when = now();
      const input = kind === 'history' ? { rows: store.history(route, source.message, when) }
        : { files: collectAttachments(ctx, mediaRoot) };
      if (kind === 'history' && !input.rows.length) response = '本群最近 24 小时没有我已收到的可总结文本。';
      else if (kind === 'document' && !input.files) response = REJECT_INPUT;
      else {
        store.grant(route, policy, when + 5_000);
        grants.add(route);
        const id = store.enqueue({ route, message: source.message, sender: source.sender, kind, policy, input }, when);
        if (id) {
          log('accepted', { id, kind });
          response = `已接单 #${id.slice(0, 8)}，整理好后我会发回这里。`;
        }
      }
    } catch {
      log('admission_error', { kind });
      response = '这次没能确认后台任务已接单，请先不要重复提交。';
    }
    return finish(response);
  }

  function observe(event, ctx) {
    if (!active) return;
    const source = sourceRoute(ctx?.channelId, ctx?.accountId, ctx?.conversationId);
    if (!source?.group || !livePolicy(source)) return;
    const row = historyRow(event, ctx, now());
    if (!row) return;
    try { store.remember(row); } catch { log('history_write_error'); }
  }

  async function cycle() {
    if (!active) return;
    const at = now();
    const cfgRoutes = current().routes;
    const live = new Set();
    for (const candidate of cfgRoutes) {
      const route = sourceRoute(candidate?.channel, candidate?.account, candidate?.to);
      if (!route) continue;
      const key = routeKey(route);
      live.add(key);
      const policy = livePolicy(route);
      store.grant(key, policy ?? 'revoked', policy ? at + 5_000 : 0);
    }
    for (const route of grants) if (!live.has(route)) store.grant(route, 'revoked', 0);
    grants.clear();
    for (const route of live) grants.add(route);
    if (at - lastPrune >= 60_000) {
      store.prune(at);
      lastPrune = at;
    }
    const job = store.claimDelivery(at);
    if (!job) return;
    const [channel, account, to] = JSON.parse(job.route);
    const route = sourceRoute(channel, account, to);
    try {
      if (!active || !route || livePolicy(route) !== job.policy) {
        store.finishDelivery(job.id, 'revoked', null, 'policy_changed', now());
        return;
      }
      const result = await send({ ...route, replyToId: job.message, text: job.result, assertCurrent: () => (
        active && livePolicy(route) === job.policy
      ) });
      const receipt = result?.channel === route.channel && typeof result.messageId === 'string' &&
        result.messageId.length > 0 && result.messageId.length <= 512 ? result.messageId : null;
      store.finishDelivery(job.id, receipt ? 'sent' : 'uncertain', receipt, receipt ? null : 'no_platform_receipt', now());
      log('delivery', { id: job.id, state: receipt ? 'sent' : 'uncertain' });
    } catch {
      store.finishDelivery(job.id, 'uncertain', null, 'delivery_error', now());
      log('delivery', { id: job.id, state: 'uncertain' });
    }
  }

  function tick() {
    try { windows?.pump(); } catch { log('window_cycle_error'); }
    if (!sending) sending = cycle().finally(() => { sending = undefined; });
    return sending;
  }
  async function stop() {
    active = false;
    const windowStop = windows?.stop();
    for (const route of grants) {
      const [channel, account, to] = JSON.parse(route);
      const policy = livePolicy({ channel, account, to });
      store.grant(route, policy ?? 'revoked', 0);
    }
    if (sending) await sending.catch(() => {});
    await windowStop;
  }
  return { reply, observe, tick, stop };
}

export default {
  id: ID,
  register(api) {
    let bridge;
    let store;
    let timer;
    api.on('message_received', (event, ctx) => bridge?.observe(event, ctx));
    api.on('reply_dispatch', (event, ctx) => bridge?.reply(event, ctx), { eligibleDispatchKinds: ['agent'] });
    api.registerService({
      id: ID,
      reload: { configPrefixes: ['channels.qqbot', 'channels.ddingtalk', `plugins.entries.${ID}`] },
      async start({ stateDir }) {
        const root = testRoot(process.env.AOA_LAB_ROOT);
        if (realpathSync(stateDir) !== join(root, 'gateway')) throw new Error('aoa-async only runs in its isolated gateway');
        store = openStore(root);
        const current = () => {
          const cfg = api.runtime.config.current();
          return { cfg, routes: cfg.plugins?.entries?.[ID]?.config?.routes ?? [] };
        };
        bridge = createBridge({
          store, mediaRoot: join(stateDir, 'media'), current,
          generateWindow: typeof api.runtime.subagent?.complete === 'function'
            ? async ({ agentId, prompt, signal }) => (await api.runtime.subagent.complete({
              agentId, message: prompt, signal, timeoutMs: 15_000,
            })).text
            : undefined,
          log: (event, details = {}) => api.logger.info(`[aoa-async] ${JSON.stringify({ event, ...details })}`),
          async send({ channel, account, to, replyToId, text, assertCurrent }) {
            const adapter = await api.runtime.channel.outbound.loadAdapter(channel);
            if (!adapter?.sendText || !assertCurrent()) throw new Error('outbound_unavailable');
            return adapter.sendText({ cfg: current().cfg, to, accountId: account, replyToId, text });
          },
        });
        const tick = () => bridge?.tick().catch(() => api.logger.warn('[aoa-async] queue_tick_error'));
        await tick();
        timer = setInterval(tick, 750);
        timer.unref();
      },
      async stop() {
        clearInterval(timer);
        const instance = bridge;
        bridge = undefined;
        await instance?.stop();
        store?.close();
        store = undefined;
      },
    });
  },
};
