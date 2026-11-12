// 同時に操作されたときの動き。PGlite でも動くが、本物の Postgres（TEST_DATABASE_URL）で意味を持つ。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';
import { hashPin } from '../src/lib/crypto.js';
import { createPgDb, migrate } from '../src/db.js';

after(closeEnv);

test('pool has an error listener so an idle connection error cannot crash the process', async () => {
  const db = await createPgDb('postgres://nobody@127.0.0.1:1/none');
  assert.ok(db.pool.listenerCount('error') >= 1);
  await db.close();
});

test('parallel wrong PINs cannot bypass the lockout', async () => {
  const env = await newEnv();
  const f = await seed(env);
  await env.db.query('update staff set pin_hash=$1 where id=$2', [await hashPin(env, '1234'), f.admin.id]);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: String(5000 + i) })));
  const count = s => results.filter(r => r.status === s).length;
  assert.equal(count(401), 5, `401=${count(401)} 423=${count(423)}`);
  assert.equal(count(423), 25);
  const ok = await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '1234' });
  assert.equal(ok.status, 423);
});

test('lock expires: after locked_until passes, the correct PIN works and the counter restarts', async () => {
  const env = await newEnv();
  const f = await seed(env);
  await env.db.query(`update staff set pin_hash=$1, failed_logins=5, locked_until=now() - interval '1 second' where id=$2`, [await hashPin(env, '1234'), f.admin.id]);
  assert.equal((await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '9999' })).status, 401);
  const [s] = await env.db.query('select failed_logins, locked_until from staff where id=$1', [f.admin.id]);
  assert.equal(s.failed_logins, 1);
  assert.equal(s.locked_until, null);
  assert.equal((await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '1234' })).status, 200);
});

test('two GAs registering the first makeup at the same moment: one wins, the other gets 409 (never 500)', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const b = await loginGa(env, f.ga.B.id);
  const id = f.students.find(s => s.name.startsWith('江藤')).id;
  for (let round = 1; round <= 6; round++) {
    const [x, y] = await Promise.all([
      call(env, 'POST', '/api/makeups', { studentId: id, round, place: '未定', version: 0 }, a),
      call(env, 'POST', '/api/makeups', { studentId: id, round, place: '個別', version: 0 }, b),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${round}: ${x.status} ${y.status}`);
  }
});

test('two saves of the same new record at the same moment: one wins, the other gets 409', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const b = await loginGa(env, f.ga.B.id);
  const id = f.students[0].id;
  for (let round = 1; round <= 6; round++) {
    const [x, y] = await Promise.all([
      call(env, 'POST', '/api/records', { studentId: id, round, typing: 100, version: 0 }, a),
      call(env, 'POST', '/api/records', { studentId: id, round, typing: 200, version: 0 }, b),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${round}`);
  }
});

test('the same requestId sent twice at the same moment is applied once', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const body = { termId: f.term.id, text: '月\tA\t同時 太郎', requestId: 'dup-1' };
  const [x, y] = await Promise.all([call(env, 'POST', '/api/admin/import/commit', body, c), call(env, 'POST', '/api/admin/import/commit', body, c)]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.deepEqual(x.body, y.body);
  const [{ n }] = await env.db.query(`select count(*)::int as n from students where name='同時 太郎'`);
  assert.equal(n, 1);
});

test('migrate from two cold starts at once applies each migration once', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `m_${process.pid}`;
  const admin = await createPgDb(process.env.TEST_DATABASE_URL);
  await admin.exec(`drop schema if exists ${schema} cascade; create schema ${schema}`);
  const d1 = await createPgDb(process.env.TEST_DATABASE_URL, `-c search_path=${schema}`);
  const d2 = await createPgDb(process.env.TEST_DATABASE_URL, `-c search_path=${schema}`);
  await Promise.all([migrate(d1), migrate(d2)]);
  const [{ n }] = await d1.query('select count(*)::int as n from schema_migrations');
  assert.equal(n, 1);
  await d1.close();
  await d2.close();
  await admin.exec(`drop schema ${schema} cascade`);
  await admin.close();
});
