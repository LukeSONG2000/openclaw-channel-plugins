import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { imagenJobs, imagenReceiptStore } from './imagen.mjs';

test('an admitted task uses only its own image and renders at most once, even across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'luke-imagen-'));
  const db = new DatabaseSync(':memory:');
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const artifacts = imagenReceiptStore(db, directory);
  const key = 'a'.repeat(64);
  const denied = 'b'.repeat(64);
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=';
  const bytes = Buffer.from(base64, 'base64');
  let renders = 0;
  const opts = { directory, artifacts,
    getTask: id => id === 't_11111111' ? { key, source: { account: 'luke', groupId: 'a', senderId: 'member' },
      quote: { text: 'Use the wording on the quoted sign', attachmentCount: 1 },
      images: [{ origin: 'quote', dataUrl: 'data:image/png;base64,' + base64 }] }
      : { key: denied, source: { account: 'luke', groupId: 'b' }, images: [] },
    allowed: source => source.groupId === 'a',
    renderer: async ({ from, to, images, args, quotedText, hasQuote }) => {
      renders++;
      assert.equal(from, 'qqbot:group:a');
      assert.equal(from, to);
      assert.equal(args, 'edit keep the same shape');
      assert.equal(quotedText, 'Use the wording on the quoted sign');
      assert.equal(hasQuote, true);
      assert.deepEqual(await readFile(images[0]), bytes);
      const mediaUrl = join(directory, 'fixture.png');
      await writeFile(mediaUrl, bytes);
      return { mediaUrl };
    },
  };
  const request = { id: 't_11111111', args: 'edit keep the same shape', useImages: true };
  const render = imagenJobs(opts);
  assert.deepEqual(await render({ ...request, id: 't_22222222' }), { status: 'denied' });
  assert.deepEqual(await Promise.all([render(request), render(request)]), [{ status: 'ready' }, { status: 'ready' }]);
  assert.deepEqual(await imagenJobs(opts)(request), { status: 'ready' });
  assert.equal(renders, 1);
  assert.deepEqual(await artifacts.read(key), { bytes, format: 'png' });
  assert.equal(artifacts.lookup(denied), undefined);
});
