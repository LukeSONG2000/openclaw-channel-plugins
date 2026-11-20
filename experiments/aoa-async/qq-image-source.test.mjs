import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qqImageLocators, readQqImages } from './qq-image-source.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2sAAAAASUVORK5CYII=', 'base64');

test('only QQ image attachment locators can enter the inbox', () => {
  const image = url => ({ content_type: 'image/png', url });
  assert.deepEqual(qqImageLocators([
    image('//gchat.qpic.cn/example'),
    image('https://gchat.qpic.cn/example'),
    image('http://gchat.qpic.cn/example'),
    image('https://gchat.qpic.cn.attacker.test/example'),
    image('https://user@gchat.qpic.cn/example'),
    image('https://gchat.qpic.cn:8443/example'),
    { content_type: 'application/pdf', url: 'https://gchat.qpic.cn/example.pdf' },
    { contentType: 'image/jpeg', url: 'https://multimedia.nt.qq.com.cn/download?fixture=1' },
  ]), ['https://gchat.qpic.cn/example', 'https://multimedia.nt.qq.com.cn/download?fixture=1']);
});

test('read bytes with the QQ token only on the token CDN, never follow redirects', async () => {
  const calls = [];
  const data = await readQqImages([
    { origin: 'current', locator: 'https://gchat.qpic.cn/direct' },
    { origin: 'quote', locator: 'https://multimedia.nt.qq.com.cn/download?fixture=1' },
  ], {
    getToken: async () => 'synthetic',
    async fetchImage(url, init) {
      calls.push([url.hostname, init.headers.authorization, init.redirect]);
      return new Response(png, { headers: { 'content-type': 'application/octet-stream' } });
    },
  });
  assert.deepEqual(calls, [
    ['gchat.qpic.cn', undefined, 'error'],
    ['multimedia.nt.qq.com.cn', 'QQBot synthetic', 'error'],
  ]);
  assert.deepEqual(data, ['current', 'quote'].map(origin => ({
    origin, dataUrl: 'data:image/png;base64,' + png.toString('base64'),
  })));
});

test('unavailable, oversized, delayed authorization and non-images degrade independently', async () => {
  const locator = file => 'https://gchat.qpic.cn/' + file;
  const items = (...files) => files.map(file => ({ origin: 'quote', locator: locator(file) }));
  const fetchImage = async url => {
    if (url.pathname === '/oversize') return new Response(Buffer.alloc(2_097_153));
    if (url.pathname === '/html') return new Response('<html>expired</html>', { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/expired') return new Response(null, { status: 403 });
    return new Response(png);
  };
  assert.deepEqual(await readQqImages(items('oversize', 'html'), { fetchImage }), []);
  assert.equal((await readQqImages(items('expired', 'valid'), { fetchImage })).length, 1);
  const controller = new AbortController();
  const pending = readQqImages([{ origin: 'quote', locator: 'https://multimedia.nt.qq.com.cn/download' }], {
    getToken: () => new Promise(() => {}),
    fetchImage: () => assert.fail('fetch must not start'),
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await pending, []);
});
