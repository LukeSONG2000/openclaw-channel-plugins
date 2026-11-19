import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const stock = process.env.AOA_STOCK_QQ_PACKAGE;
const exec = promisify(execFile);

test('minimal metadata patch applies to QQBot 2.0.4 and marks only verified single plain input', { skip: !stock }, async (t) => {
  const pack = JSON.parse(await readFile(join(stock, 'package.json'), 'utf8'));
  assert.equal(pack.name, '@tencent-connect/openclaw-qqbot');
  assert.equal(pack.version, '2.0.4');
  const scratch = await mkdtemp(join(tmpdir(), 'aoa-qq-metadata-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'src', 'dispatch'), { recursive: true });
  const path = join('src', 'dispatch', 'ctx-builder.ts');
  await copyFile(join(stock, path), join(scratch, path));
  const patch = fileURLToPath(new URL('./qqbot-2.0.4-window-ingress.patch', import.meta.url));
  await exec('git', ['apply', '--check', patch], { cwd: scratch });
  await exec('git', ['apply', patch], { cwd: scratch });
  const { buildCtxPayload } = await import(pathToFileURL(join(scratch, path)));
  const plain = { mention: { wasMentioned: false, implicit: false } };
  const event = { kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', senderIsBot: false };
  const invoke = (state, msg = event) => buildCtxPayload({
    assembled: { rawBody: '测试消息' },
    envelope: { chatScope: 'group', groupId: 'group1', targetId: 'route', senderId: 'person1', messageId: 'm1' },
    route: { accountId: 'default', sessionKey: 'fixture:group' },
    ctx: { state }, msg,
    adapters: { buildInboundContext: ({ extra }) => extra },
  });
  assert.equal(invoke(plain).QQBotWindowIngress, 'qq-group-single-v1');
  assert.equal(invoke(plain).WasMentioned, false);
  assert.equal(invoke({ mention: { wasMentioned: true } }, { ...event, rawEventType: 'GROUP_AT_MESSAGE_CREATE' }).WasMentioned, true);
  for (const args of [
    [{ ...plain, mergedMessages: [{}, {}] }], [{}],
    [{ mention: { wasMentioned: false, implicit: true } }],
    [plain, { ...event, rawEventType: 'GROUP_AT_MESSAGE_CREATE' }],
    [plain, { ...event, senderIsBot: true }], [plain, { ...event, attachments: [{}] }],
  ]) assert.equal(invoke(...args).QQBotWindowIngress, undefined);
});
