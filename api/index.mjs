// Vercel の入口：/api/* はすべてここに来る（vercel.json の rewrites）。
import * as blobSdk from '@vercel/blob';
import { handle } from '../src/app.js';
import { createNeonDb, migrate } from '../src/db.js';
import { createVercelBlob } from '../src/blob-vercel.js';

let envPromise = null;

async function buildEnv() {
  const e = process.env;
  const url = e.DATABASE_URL || e.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL が設定されていません（Vercel の Storage で Neon を追加してください）');
  const db = await createNeonDb(url);
  await migrate(db); // 未適用の migrations だけを実行（通常は確認の1回だけ）
  return {
    db,
    blob: e.BLOB_READ_WRITE_TOKEN ? createVercelBlob(blobSdk) : null,
    PIN_PEPPER: e.PIN_PEPPER,
    ADMIN_SETUP_TOKEN: e.ADMIN_SETUP_TOKEN,
    CRON_SECRET: e.CRON_SECRET,
    ENVIRONMENT: e.ENVIRONMENT || 'production',
  };
}

export default {
  async fetch(request) {
    let env;
    try {
      env = await (envPromise ||= buildEnv());
    } catch (err) {
      envPromise = null; // 次のリクエストでやり直す
      console.error('koshu startup error:', err);
      return new Response(JSON.stringify({ error: 'サーバーの準備ができていません。少し待ってからもう一度お試しください。' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return handle(request, env);
  },
};
