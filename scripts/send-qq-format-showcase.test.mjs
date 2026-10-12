import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSamples, resolveAdministrator, runSamples } from './send-qq-format-showcase.mjs';

test('recipient must be the single configured administrator', () => {
  const config = { appId: 'app', clientSecret: 'secret', customRuntime: { admins: ['admin'] } };
  assert.equal(resolveAdministrator(config), 'admin');
  assert.throws(() => resolveAdministrator({ ...config, customRuntime: { admins: [] } }));
  assert.throws(() => resolveAdministrator({ ...config, customRuntime: { admins: ['a', 'b'] } }));
  assert.throws(() => resolveAdministrator({ ...config, enabled: false }));
});

test('buttons only open a real URL or use the read-only help command', () => {
  const samples = buildSamples();
  assert.equal(new Set(samples.map((sample) => sample.label)).size, samples.length);
  const buttons = samples.find((sample) => sample.label === 'keyboard').payload.keyboard.content.rows.flatMap((row) => row.buttons);
  for (const { action } of buttons) {
    assert.equal(action.permission.type, 2);
    assert.ok(action.type === 0 || action.type === 2);
    assert.equal(action.data, action.type === 0 ? 'https://q.qq.com/' : '/help');
  }
});

test('command enter tags omit the unsupported show attribute', () => {
  const content = buildSamples().find((sample) => sample.label === 'command-links').payload.markdown.content;
  assert.match(content, /<qqbot-cmd-input text="\/help" show="填入 \/help"\/>/);
  assert.match(content, /<qqbot-cmd-enter text="\/help"\/>/);
  assert.doesNotMatch(content, /<qqbot-cmd-enter[^>]+show=/);
});

test('uses only C2C, records failures without retrying, redacts secrets', async () => {
  const calls = [];
  const api = { async apiRequest(token, method, endpoint) {
    calls.push(endpoint);
    if (calls.length === 1) throw Object.assign(new Error('ADMIN TOKEN SECRET'), { status: 403, bizCode: 123 });
    return { id: 'message', timestamp: 'now' };
  } };
  const results = await runSamples({ samples: buildSamples().slice(0, 2), api, token: 'TOKEN', admin: 'ADMIN', secrets: ['SECRET'], delayMs: 0, onResult() {} });
  assert.deepEqual(calls, ['/v2/users/ADMIN/messages', '/v2/users/ADMIN/messages']);
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].message, '[redacted] [redacted] [redacted]');
  assert.equal(results[1].accepted, true);
  assert.equal(results[1].renderingVerified, false);
});
