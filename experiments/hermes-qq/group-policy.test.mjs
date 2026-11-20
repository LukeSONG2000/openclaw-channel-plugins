import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationPolicy, groupPolicy } from './group-policy.mjs';

test('verified names map behavior without copying an R2 open ID or granting administration', () => {
  const config = {
    namedModes: { 'Chat A': 'free', 'Chat B': 'default', 'Former management': 'free' },
    verifiedNames: { 'luke-a': 'Chat A', 'luke-b': 'Chat B', 'luke-c': 'Former management' },
  };
  const mode = groupPolicy(config, 'legacy');
  assert.deepEqual(['luke-a', 'luke-b', 'luke-c', 'r2-a', 'new-group'].map(mode),
    ['free', 'default', 'free', 'default', 'default']);
  assert.throws(() => groupPolicy({ ...config, verifiedNames: { ...config.verifiedNames, clone: 'Chat A' } }, 'legacy'));
  assert.throws(() => groupPolicy({ ...config, namedModes: { broken: 'admin' } }, 'legacy'));
});

test('backend switches are scoped to a trusted address and independently override legacy defaults', () => {
  const policy = conversationPolicy({
    verifiedNames: { a: 'Chat A' }, namedModes: { 'Chat A': 'free' },
    conversations: { 'group:a': { freeReply: false, imageGeneration: true },
      'group:b': { memory: true }, 'direct:a': { memory: false } },
  }, { pilotGroup: 'pilot', groupMemory: id => id === 'legacy' });
  assert.deepEqual(policy.groupIds, ['a', 'b']);
  assert.deepEqual(policy.forGroup('a'), { freeReply: false, imageGeneration: true, memory: false });
  assert.deepEqual(policy.forGroup('b'), { freeReply: false, imageGeneration: false, memory: true });
  assert.equal(policy.forGroup('legacy').memory, true);
  assert.deepEqual(policy.forGroup('Chat A'), { freeReply: false, imageGeneration: false, memory: false });
  assert.deepEqual(policy.forDirect('a'), { imageGeneration: false, memory: false });
  assert.deepEqual(policy.forDirect('b'), { imageGeneration: false, memory: true });
  for (const conversations of [
    { 'group:a': { approval: true } }, { 'group:a': { memory: 'true' } },
    { 'direct:a': { freeReply: true } }, { 'group:Chat A': { freeReply: true } },
  ]) assert.throws(() => conversationPolicy({ conversations }));
});
