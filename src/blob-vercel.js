// Vercel Blob（非公開ストア）を、このアプリの blob インターフェース（put/get/list/del）に合わせる。
// sdk は @vercel/blob と同じ形（テストでは偽物を渡す）。
export function createVercelBlob(sdk) {
  async function list(prefix) {
    const out = [];
    let cursor;
    do {
      const r = await sdk.list({ prefix, cursor, limit: 1000 });
      for (const b of r.blobs) out.push({ key: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt), url: b.url });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  return {
    async put(key, body) {
      await sdk.put(key, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json; charset=utf-8' });
    },
    async get(key) {
      const r = await sdk.get(key, { access: 'private', useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) throw new Error('blob not found');
      return new Response(r.stream).text();
    },
    list,
    async del(key) {
      const hit = (await list(key)).find(b => b.key === key);
      if (hit) await sdk.del(hit.url);
    },
  };
}
