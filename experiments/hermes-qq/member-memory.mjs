import { qqMemberIdentity } from './member-identity.mjs';

const observer = 'luke';
const session = 'qq-mentions';
const limit = 4;

export function makeMemberMemory({ origin, token, account, groupId, timeoutMs = 450, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' ||
    url.username || url.password || url.search || url.hash || !token) throw new Error('invalid local Honcho endpoint');
  const { workspaceId } = qqMemberIdentity({ account, groupId, senderId: observer });
  const base = '/v3/workspaces/' + workspaceId;
  let writing = false;
  let ready = false;
  const registered = new Set();

  function identify(event) {
    if (event?.channel !== 'qqbot' || event.account !== account || event.groupId !== groupId ||
      event.mentioned !== true) throw new Error('memory event is outside the bound QQ route');
    return qqMemberIdentity(event).peerId;
  }

  async function post(path, body, signal, missing = false) {
    const response = await fetchImpl(new URL(path, url), {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (missing && response.status === 404) return null;
      if (response.status === 404) { ready = false; registered.clear(); }
      throw new Error('Honcho request failed');
    }
    return response.json();
  }

  return {
    async recall(event) {
      const peerId = identify(event);
      const result = await post(base + '/conclusions/list?size=' + limit,
        { filters: { observer_id: observer, observed_id: peerId } }, AbortSignal.timeout(timeoutMs), true);
      return (result?.items ?? []).filter(item =>
        item?.observed_id === peerId && item.observer_id === observer && typeof item.content === 'string')
        .slice(0, limit).map(item => item.content.trim().slice(0, 240)).filter(Boolean);
    },
    async observe(event) {
      const peerId = identify(event);
      const text = typeof event.text === 'string' ? event.text.trim() : '';
      if (writing || !text || text.startsWith('/') || event.quote || event.attachmentCount ||
        /https?:\/\/|\bsk-[\w-]{10,}|\bBearer\s+\S+|api[_ -]?key|app[_ -]?secret|access[_ -]?token|\u5bc6\u7801|\u5bc6\u94a5|\u9a8c\u8bc1\u7801/iu.test(text)) return;
      writing = true;
      try {
        const signal = AbortSignal.timeout(4000);
        if (!ready) {
          await post('/v3/workspaces', { id: workspaceId }, signal);
          await post(base + '/peers', { id: observer }, signal);
          ready = true;
        }
        if (!registered.has(peerId)) {
          await post(base + '/peers', { id: peerId }, signal);
          await post(base + '/sessions', { id: session, peers: {
            [observer]: { observe_me: false, observe_others: true },
            [peerId]: { observe_me: true, observe_others: false },
          } }, signal);
          if (registered.size >= 256) registered.clear();
          registered.add(peerId);
        }
        // The bridge only observes claimed events; do not replay an ambiguous remote write.
        await post(base + '/sessions/' + session + '/messages', { messages: [
          { peer_id: peerId, content: text.slice(0, 800) },
        ] }, signal);
      } finally { writing = false; }
    },
  };
}
