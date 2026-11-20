import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupPolicy } from './group-policy.mjs';

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
