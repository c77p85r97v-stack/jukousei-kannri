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

/** Neon（本番）。 */
export async function createNeonDb(connectionString) {
  const { Pool } = await import('@neondatabase/serverless');
  const pool = new Pool({ connectionString });
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

/** migrations/*.sql を名前順に、未適用分だけ実行する。 */
export async function migrate(db) {
  await db.exec(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query('select name from schema_migrations')).map(r => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await db.tx(async t => {
      await t.exec(sql);
      await t.query('insert into schema_migrations(name) values ($1)', [f]);
    });
  }
}
