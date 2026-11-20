import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { makeMemberMemory } from './member-memory.mjs';
import { qqMemberIdentity } from './member-identity.mjs';

const alice = { channel: 'qqbot', account: 'fixture', groupId: 'old-group', senderId: 'alice',
  mentioned: true, text: 'I prefer short replies.' };
const ids = qqMemberIdentity(alice);
const options = { origin: 'http://127.0.0.1:8000', token: 'fixture-only', account: alice.account, groupId: alice.groupId };

test('reads choose a trusted peer and writes only the source text once', async () => {
  const calls = [];
  const memory = makeMemberMemory({ ...options, fetchImpl: async (url, request) => {
    calls.push({ path: url.pathname, data: JSON.parse(request.body), redirect: request.redirect });
    return Response.json({ items: [
      { observed_id: ids.peerId, observer_id: 'luke', content: 'Short replies' },
      { observed_id: 'different', observer_id: 'luke', content: 'Not this person' },
      { observed_id: ids.peerId, observer_id: 'different', content: 'Not this observer' },
    ] });
  } });
  assert.deepEqual(await memory.recall({ ...alice, peerId: 'spoofed', workspaceId: 'spoofed' }), ['Short replies']);
  assert.deepEqual(calls[0].data, { filters: { observer_id: 'luke', observed_id: ids.peerId } });
  await assert.rejects(memory.recall({ ...alice, groupId: 'different' }), /outside the bound/);
  await memory.observe({ ...alice, attachmentCount: 1 });
  await memory.observe({ ...alice, quote: { text: 'not mine' } });
  await memory.observe({ ...alice, text: 'api key: secret' });
  await memory.observe({ ...alice, text: '/not-a-preference' });
  assert.equal(calls.length, 1);
  await memory.observe(alice);
  assert.equal(calls.filter(call => call.path.endsWith('/messages')).length, 1);
  assert.deepEqual(calls.at(-1).data, { messages: [{ peer_id: ids.peerId, content: alice.text }] });
  assert.ok(calls.slice(2).every(call => call.path.includes(ids.workspaceId) && call.redirect === 'error'));
  assert.throws(() => makeMemberMemory({ ...options, origin: 'https://honcho.example' }), /invalid local/);
});

test('recall has a real network timeout', async t => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const memory = makeMemberMemory({ ...options, origin: 'http://127.0.0.1:' + server.address().port, timeoutMs: 40 });
  await assert.rejects(memory.recall(alice), { name: 'TimeoutError' });
});

test('self-hosted Honcho accepts attributed source messages and scoped recall', {
  skip: process.env.LUKE_HONCHO_FIXTURE !== '1',
}, async () => {
  const event = { ...alice, groupId: 'fixture-' + Date.now() };
  const bob = { ...event, senderId: 'bob', text: 'I prefer detailed replies.' };
  const { workspaceId, peerId } = qqMemberIdentity(event);
  const base = options.origin + '/v3/workspaces/' + workspaceId;
  const memory = makeMemberMemory({ ...options, groupId: event.groupId, timeoutMs: 2000 });
  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.token },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, path + ' returned HTTP ' + response.status);
    return response.json();
  };
  await memory.observe(event);
  await memory.observe(bob);
  const messages = await post('/sessions/qq-mentions/messages/list', {});
  assert.deepEqual(messages.items.map(row => [row.peer_id, row.content]).sort(), [
    [peerId, event.text], [qqMemberIdentity(bob).peerId, bob.text],
  ].sort());
  await post('/conclusions', { conclusions: [event, bob].map(row => ({
    observer_id: 'luke', observed_id: qqMemberIdentity(row).peerId, session_id: 'qq-mentions', content: row.text,
  })) });
  assert.deepEqual(await memory.recall(event), [event.text]);
  assert.deepEqual(await memory.recall(bob), [bob.text]);
  const elsewhere = { ...event, groupId: event.groupId + '-other' };
  assert.deepEqual(await makeMemberMemory({ ...options, groupId: elsewhere.groupId }).recall(elsewhere), []);
});
