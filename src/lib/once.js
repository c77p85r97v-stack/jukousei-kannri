// 二重送信の防止：同じ requestId の2回目は、1回目と同じ結果を返す。
// fn はトランザクション t の中で実行され、結果は request_ids に保存される。
export async function once(db, requestId, fn) {
  if (!requestId) return db.tx(fn);
  const id = String(requestId).slice(0, 100);
  const [prev] = await db.query('select response from request_ids where id=$1', [id]);
  if (prev) return prev.response;
  return db.tx(async t => {
    const result = await fn(t);
    const [ins] = await t.query('insert into request_ids(id, response) values ($1,$2) on conflict (id) do nothing returning id', [id, JSON.stringify(result)]);
    if (!ins) {
      // 同時に同じ requestId が来た：こちらは取り消して、先の結果を返す
      const [p] = await t.query('select response from request_ids where id=$1', [id]);
      const err = new Error('duplicate request');
      err.duplicateResponse = p.response;
      throw err;
    }
    return result;
  }).catch(e => {
    if (e.duplicateResponse !== undefined) return e.duplicateResponse;
    throw e;
  });
}
