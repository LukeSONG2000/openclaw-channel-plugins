import { createHash } from 'node:crypto';

const HOUR = 3_600_000;
const SAFE_ACCOUNT = /^[a-zA-Z0-9_-]{1,80}$/;
const QQ = /^qqbot:(group|c2c):([a-fA-F0-9]{32})$/;
const DING = /^ddingtalk:(chat:cid[\w+/]+={0,2}|user:[\w.+@=-]+)$/;

export function sourceRoute(channel, account, to) {
  if (typeof account !== 'string' || !SAFE_ACCOUNT.test(account) || typeof to !== 'string' || to.length > 256) return;
  const valid = channel === 'qqbot' ? QQ.exec(to) : channel === 'ddingtalk' ? DING.exec(to) : null;
  if (valid) return { channel, account, to, group: valid[1] === 'group' || valid[1].startsWith('chat:') };
}

export function routeKey({ channel, account, to }) {
  return JSON.stringify([channel, account, to]);
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
}

export function acceptedSource(event) {
  const c = event.ctx;
  if (!c || event.sendPolicy !== 'allow' || event.suppressUserDelivery || event.isTailDispatch ||
      c.OriginatingChannel !== c.Provider || c.OriginatingTo !== c.To ||
      (event.originatingChannel && event.originatingChannel !== c.Provider) ||
      (event.originatingAccountId && event.originatingAccountId !== c.AccountId) ||
      (event.originatingTo && event.originatingTo !== c.OriginatingTo) ||
      !identifier(c.MessageSid) || !identifier(c.SenderId) || typeof c.RawBody !== 'string' ||
      c.CommandSource || c.CommandTurn || c.RawBody.trimStart().startsWith('/')) return;
  const route = sourceRoute(c.Provider, c.AccountId, c.OriginatingTo);
  if (!route || Boolean(c.ChatType === 'group') !== route.group) return;
  if (!route.group && !route.to.endsWith(`:${c.SenderId}`)) return;
  return { ...route, message: c.MessageSid, sender: c.SenderId, text: c.RawBody.trim() };
}

export function identifyTask(text, group, hasFiles) {
  if (!text || text.length > 400 || /\n|^(?:不[要用]|别)/u.test(text)) return;
  const request = text.replace(/^(?:(?:请|帮我|麻烦|能否|能不能)\s*)+/u, '');
  if (!/^(?:总结|概括|整理|梳理|提炼|归纳)/u.test(request)) return;
  if (group && /(?:这个群|本群|群里|群内|群聊)/u.test(request) &&
      /(?:讨论|话题|聊天|消息|记录|聊了)/u.test(request) && /(?<!\d)24\s*(?:h\b|小时)/iu.test(request)) {
    return 'history';
  }
  if (/(?:附件|这份(?:资料|报告|文档|文件|材料|表格)?|文件|文档|材料|报告|表格|资料)/u.test(request) &&
      (hasFiles || /(?:附件|这份|文件里|文档里)/u.test(request))) return 'document';
}

export function historyRow(event, ctx, now = Date.now()) {
  const route = sourceRoute(ctx?.channelId, ctx?.accountId, ctx?.conversationId);
  const message = event?.messageId;
  const sender = event?.senderId;
  const text = typeof event?.content === 'string' ? event.content.trim() : '';
  if (!route?.group || !identifier(message) || !identifier(sender) || !text || text.startsWith('/') ||
      identifyTask(text, true, false) || /(?:密码|密钥|验证码|access[_ -]?token|api[_ -]?key)/iu.test(text)) return;
  if (Number.isFinite(event.timestamp) && (event.timestamp < now - 24 * HOUR || event.timestamp > now + 60_000)) return;
  const at = Number.isFinite(event.timestamp) ? Math.min(event.timestamp, now) : now;
  const safeText = text.replace(/<@!?[^>]+>|https?:\/\/[^\s<>]+|\bsk-[\w-]{10,}/giu, '').trim().slice(0, 480);
  if (safeText) return { key: routeKey(route), message, sender, text: safeText, at };
}

export function policyVersion(cfg, route, pluginRoutes) {
  if (!cfg?.channels?.[route.channel] || cfg.channels[route.channel].enabled === false ||
      cfg.channels[route.channel].accounts?.[route.account]?.enabled === false ||
      cfg.plugins?.entries?.['luke-aoa-async']?.enabled === false || !Array.isArray(pluginRoutes) ||
      !pluginRoutes.some((r) => r?.channel === route.channel && r?.account === route.account && r?.to === route.to)) return;
  return createHash('sha256').update(JSON.stringify([
    cfg.channels[route.channel], cfg.session?.sendPolicy, cfg.bindings, cfg.agents, cfg.tools, cfg.commands,
  ])).digest('hex');
}
