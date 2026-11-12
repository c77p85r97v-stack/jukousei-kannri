import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVercelBlob } from '../src/blob-vercel.js';

// @vercel/blob と同じ形の偽物
function fakeSdk() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    async put(pathname, body, opts) {
      calls.push(['put', pathname, opts]);
      store.set(pathname, { body, uploadedAt: new Date('2026-11-01T00:00:00Z') });
      return { pathname, url: `https://blob.example/${pathname}` };
    },
    async get(pathname, opts) {
      calls.push(['get', pathname, opts]);
      const v = store.get(pathname);
      if (!v) return null;
      return { statusCode: 200, stream: new Response(v.body).body, blob: {} };
    },
    async list({ prefix, cursor }) {
      const all = [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([pathname, v]) => ({ pathname, size: v.body.length, uploadedAt: v.uploadedAt, url: `https://blob.example/${pathname}` }));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 2); // 2件ずつ返して、ページ送りを確かめる
      return { blobs: page, hasMore: start + 2 < all.length, cursor: String(start + 2) };
    },
    async del(urls) {
      calls.push(['del', urls]);
      for (const u of [].concat(urls)) store.delete(u.replace('https://blob.example/', ''));
    },
  };
}

test('put stores privately without random suffix; get returns the text', async () => {
  const sdk = fakeSdk();
  const blob = createVercelBlob(sdk);
  await blob.put('backups/a.json', '{"x":"日本語"}');
  const [, , opts] = sdk.calls[0];
  assert.equal(opts.access, 'private');
  assert.equal(opts.addRandomSuffix, false);
  assert.equal(await blob.get('backups/a.json'), '{"x":"日本語"}');
});

test('get of a missing key throws', async () => {
  const blob = createVercelBlob(fakeSdk());
  await assert.rejects(blob.get('backups/none.json'));
});

test('list follows pagination and maps fields', async () => {
  const sdk = fakeSdk();
  const blob = createVercelBlob(sdk);
  for (const n of ['a', 'b', 'c']) await blob.put(`backups/${n}.json`, n);
  await blob.put('other/x.json', 'x');
  const items = await blob.list('backups/');
  assert.deepEqual(items.map(i => i.key), ['backups/a.json', 'backups/b.json', 'backups/c.json']);
  assert.equal(items[0].size, 1);
  assert.ok(items[0].uploadedAt instanceof Date);
});

test('del removes by key', async () => {
  const sdk = fakeSdk();
  const blob = createVercelBlob(sdk);
  await blob.put('backups/a.json', 'a');
  await blob.del('backups/a.json');
  assert.equal(sdk.store.size, 0);
  await blob.del('backups/none.json'); // 無くてもエラーにしない
});
