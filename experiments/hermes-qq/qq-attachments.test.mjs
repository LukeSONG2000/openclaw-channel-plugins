import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionFiles, sendQqFile } from './qq-attachments.mjs';

test('only explicit native completion files are eligible, inside the exact task store', () => {
  const id = 't_12345678';
  const file = { uploaded_by: 'kanban_complete', filename: 'paper.pdf', size: 8,
    stored_path: `/opt/data/kanban/attachments/${id}/paper.pdf` };
  assert.deepEqual(completionFiles(id, [{ ...file, uploaded_by: 'agent' }, file]),
    [{ name: 'paper.pdf', storedName: 'paper.pdf', size: 8 }]);
  for (const bad of [{ filename: '../paper.pdf' }, { filename: 'run.sh' }, { size: 13 * 1024 * 1024 },
    { stored_path: '/opt/data/kanban/attachments/t_00000000/paper.pdf' }]) {
    assert.throws(() => completionFiles(id, [{ ...file, ...bad }]));
  }
});

test('group and direct file sends use media type 4 and check the reply window after upload', async () => {
  const file = { name: 'paper.pdf', bytes: Buffer.from('%PDF-1.7') };
  for (const scope of ['group', 'c2c']) {
    const target = { scope, targetId: scope, msgId: 'source' };
    const calls = [];
    const bot = { uploadMedia: async req => { calls.push(req); return { file_info: 'media' }; },
      send: async req => { calls.push(req); return { id: 'receipt' }; } };
    assert.deepEqual(await sendQqFile(bot, target, file, 3, () => false), { retryable: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(await sendQqFile(bot, target, file, 3, () => true), { id: 'receipt' });
    assert.deepEqual(calls.at(-2), { target, fileType: 4, buffer: file.bytes, fileName: file.name, srvSendMsg: false });
    assert.deepEqual(calls.at(-1), { target, msgType: 7, media: { file_info: 'media' }, extra: { msg_seq: 3 } });
  }
});
