import assert from 'node:assert/strict';
import test from 'node:test';
import { planWindowReplies } from './window-reply.mjs';

test('native mention only resolves a current-window anchor on a channel that supports it', async () => {
  const unread = [{ id: 'original', text: 'Can you confirm Tuesday?', speaker: 'a' }];
  const result = target => JSON.stringify({ natural: null, reply: { target, text: 'Tuesday works.', mode: 'mention' } });
  assert.deepEqual(await planWindowReplies({ unread, generate: () => result('m1') }), []);
  assert.deepEqual(await planWindowReplies({ unread, allowMention: true, generate: () => result('m2') }), []);
  assert.deepEqual(await planWindowReplies({ unread, allowMention: true, generate: () => result('m1') }),
    [{ mode: 'mention', replyToId: 'original', text: 'Tuesday works.' }]);
});

const cases = [
  ['a1', '小明', '周末一起吃火锅吗'],
  ['a2', '小李', '我想吃鸳鸯锅'],
  ['b1', '阿文', '共享表格导出总是把列名截断'],
  ['b2', '阿陶', '我试了直接复制，列名倒是都在'],
  ['a3', '阿文', '火锅约周六晚上吧'],
  ['c1', '阿青', '小赵，你答应我的快递单号发私聊'],
  ['c2', '小顾', '小沈，我刚接到电话，晚点单聊。'],
  ['a4', '小明', '那就周六七点'],
  ['a5', '小李', '好，记得帮我留个蘸料碟'],
].map(([id, speaker, text]) => ({ id, speaker, text }));

test('AA BB A CC AA gives one natural A reply and one anchored B reply from one decision', async () => {
  let calls = 0;
  const result = await planWindowReplies({
    unread: cases,
    generate: async (prompt) => {
      calls++;
      const data = JSON.parse(prompt.split('\n').at(-1));
      assert.deepEqual(data.unread.map(({ target, text }) => [target, text]), cases.map(({ text }, index) => [`m${index + 1}`, text]));
      assert.match(prompt, /各聊各的.*不参与/);
      assert.match(prompt, /开放话题，优先参与/);
      assert.match(prompt, /不解释接了什么、为什么没接/);
      return '{"natural":"蘸料碟管够，鸳鸯锅别点成全辣就行。","reply":{"target":"m3","text":"可以先试 CSV，导出后看原文件里的列名全不全。"}}';
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, [
    { mode: 'natural', text: '蘸料碟管够，鸳鸯锅别点成全辣就行。' },
    { mode: 'reply', replyToId: 'b1', text: '可以先试 CSV，导出后看原文件里的列名全不全。' },
  ]);
});

test('empty window never calls the model; a window with no useful opening stays silent', async () => {
  assert.deepEqual(await planWindowReplies({ unread: [], generate: assert.fail }), []);
  assert.deepEqual(await planWindowReplies({
    unread: cases.slice(5, 7), generate: async () => '{"natural":null,"reply":null}',
  }), []);
});

test('a reply cannot target old context or an arbitrary platform message ID', async () => {
  const unread = cases.slice(0, 2);
  const context = [{ id: 'old-secret-id', text: '昨天的内容', speaker: '小明' }];
  for (const target of ['m3', 'old-secret-id', 'a1']) {
    assert.deepEqual(await planWindowReplies({
      unread, context, generate: async (prompt) => {
        assert.doesNotMatch(prompt, /old-secret-id/);
        return JSON.stringify({ natural: '鸳鸯锅好。', reply: { target, text: '不应发送。' } });
      },
    }), [{ mode: 'natural', text: '鸳鸯锅好。' }]);
  }
});

test('one mode may be omitted; duplicate prose, internal narration and malformed output are not sent', async () => {
  async function plan(output) {
    return planWindowReplies({ unread: cases, generate: async () => output });
  }
  assert.deepEqual(await plan('{"natural":null,"reply":{"target":"m4","text":"复制也可以。"}}'),
    [{ mode: 'reply', replyToId: 'b2', text: '复制也可以。' }]);
  assert.deepEqual(await plan('{"natural":"同意。","reply":{"target":"m3","text":"同意。"}}'),
    [{ mode: 'natural', text: '同意。' }]);
  assert.deepEqual(await plan('{"natural":"我接一句","reply":{"target":"m7","text":"<@123> 你好"}}'), []);
  assert.deepEqual(await plan('我先判断一下。\n{"natural":"不应公开","reply":null}'), []);
});
