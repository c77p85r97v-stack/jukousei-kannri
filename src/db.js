// データベースの薄い層：query と tx だけを持つ。
// 本番は Neon（@neondatabase/serverless の Pool）、テストと手元の開発サーバーは PGlite。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** PGlite（メモリ上の Postgres）。 */
export async function createPgliteDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.waitReady;
  const wrap = runner => ({
    async query(sql, params = []) {
      const r = await runner.query(sql, params);
      return r.rows;
    },
    async exec(sql) {
      await runner.exec(sql);
    },
  });
  const db = wrap(pg);
  let inTx = false;
  db.tx = async fn => {
    if (inTx) return fn(db); // 入れ子は外側のトランザクションに含める
    return pg.transaction(async t => {
      const inner = wrap(t);
      inner.tx = f => f(inner);
      inTx = true;
      try {
        return await fn(inner);
      } finally {
        inTx = false;
      }
    });
  };
  db.close = () => pg.close();
  return db;
}

/** node-postgres 互換の Pool（Neon も pg も同じ形）を、このアプリの Db に包む。 */
export function wrapPool(pool) {
  // 使っていない接続が切れると Pool が 'error' を出す。受け取らないとプロセスごと落ちるので、記録だけして続ける。
  pool.on('error', e => console.error('koshu pg idle connection error:', e && e.message));
  const wrap = runner => ({
    async query(sql, params = []) {
      const r = await runner.query(sql, params);
      return r.rows;
    },
    async exec(sql) {
      await runner.query(sql);
    },
  });
  const db = wrap(pool);
  db.pool = pool;
  db.tx = async fn => {
    const client = await pool.connect();
    const inner = wrap(client);
    inner.tx = f => f(inner);
    try {
      await client.query('BEGIN');
      const result = await fn(inner);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  return db;
}

/** Neon（本番）。 */
export async function createNeonDb(connectionString) {
  const { Pool } = await import('@neondatabase/serverless');
  return wrapPool(new Pool({ connectionString }));
}

/** ふつうの Postgres（同時実行のテスト用）。options は「-c search_path=...」など。 */
export async function createPgDb(connectionString, options) {
  const { default: pg } = await import('pg');
  return wrapPool(new pg.Pool({ connectionString, options, max: 10 }));
}

/** migrations/*.sql を名前順に、未適用分だけ実行する。 */
export async function migrate(db) {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const applied = async q => new Set((await q.query('select name from schema_migrations')).map(r => r.name));
  // ふだんの起動：適用済みかを1〜2回の問い合わせで確かめて終わる
  const [reg] = await db.query(`select to_regclass('schema_migrations') as t`);
  if (reg.t && files.every((set => f => set.has(f))(await applied(db)))) return;
  // 2つのサーバーが同時に起動しても二重に適用しないよう、ロックを取ってから確かめ直す
  await db.tx(async t => {
    await t.query('select pg_advisory_xact_lock(727274001)');
    await t.exec(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = await applied(t);
    for (const f of files) {
      if (done.has(f)) continue;
      await t.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      await t.query('insert into schema_migrations(name) values ($1)', [f]);
    }
  });
}
