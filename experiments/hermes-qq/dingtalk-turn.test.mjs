import assert from 'node:assert/strict';
import test from 'node:test';
import { dingtalkTurn, readDingTalkDecision } from './dingtalk-turn.mjs';

const turn = { account: 'fixture', scope: 'group', chat: 'group-one', messageId: 'm1',
  ambient: false, text: 'Current question', images: [] };

test('DingTalk session IDs and receipt keys are scoped by account, peer and turn type', () => {
  const initial = dingtalkTurn(turn);
  assert.equal(dingtalkTurn(turn).requestKey, initial.requestKey);
  const next = dingtalkTurn({ ...turn, messageId: 'm2' });
  assert.equal(next.sessionId, initial.sessionId);
  assert.notEqual(next.requestKey, initial.requestKey);
  for (const scope of [{ chat: 'group-two' }, { scope: 'direct' }, { ambient: true }, { account: 'other' }]) {
    assert.notEqual(dingtalkTurn({ ...turn, ...scope }).sessionId, initial.sessionId);
  }
});

test('DingTalk images are native inputs and cannot carry file paths or external URLs', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const result = dingtalkTurn({ ...turn, images: [dataUrl] });
  assert.deepEqual(result.input[0].content[1], { type: 'image_url', image_url: { url: dataUrl } });
  assert.throws(() => dingtalkTurn({ ...turn, images: ['https://example.test/forbidden'] }), /invalid image/);
  assert.throws(() => dingtalkTurn({ ...turn, scope: 'direct', ambient: true }), /invalid DingTalk turn/);
});

test('DingTalk only advertises the render skill to addressed, eligible turns', () => {
  assert.match(dingtalkTurn({ ...turn, imageSkillAvailable: true }).input, /"kind":"skill","name":"imagen"/);
  assert.doesNotMatch(dingtalkTurn({ ...turn, imageSkillAvailable: true, ambient: true }).input, /"kind":"skill"/);
  assert.doesNotMatch(dingtalkTurn(turn).input, /"kind":"skill"/);
  assert.deepEqual(readDingTalkDecision('{"kind":"skill","name":"imagen"}'), { kind: 'skill', name: 'imagen' });
  assert.throws(() => readDingTalkDecision('{"kind":"skill","name":"restart"}'), /invalid DingTalk decision/);
});
