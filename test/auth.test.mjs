import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);
import { hashPin } from '../src/lib/crypto.js';

test('bootstrap lists active staff and active term', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const r = await call(env, 'GET', '/api/bootstrap');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.staff.map(s => s.name).sort(), ['A', 'B', 'C', '管理者'].sort());
  assert.equal(r.body.term.id, f.term.id);
  assert.deepEqual(r.body.term.typing_rounds, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(r.body.slots.length, 9);
});

test('GA login by name sets cookie and /api/me returns role ga', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const cookie = await loginGa(env, f.ga.A.id);
  const me = await call(env, 'GET', '/api/me', undefined, cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'A');
  assert.equal(me.body.role, 'ga');
});

test('GA login with admin staffId → 400', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const r = await call(env, 'POST', '/api/login', { staffId: f.admin.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /暗証番号/);
});

test('GA cookie cannot call admin api → 403', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const cookie = await loginGa(env, f.ga.A.id);
  const r = await call(env, 'GET', '/api/admin/me', undefined, cookie);
  assert.equal(r.status, 403);
});

test('admin login works and /api/me returns role admin', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const cookie = await loginAdmin(env, f);
  const me = await call(env, 'GET', '/api/me', undefined, cookie);
  assert.equal(me.body.role, 'admin');
  const am = await call(env, 'GET', '/api/admin/me', undefined, cookie);
  assert.equal(am.status, 200);
});

test('admin login with wrong pin 5 times locks for 15 minutes', async () => {
  const env = await newEnv();
  const f = await seed(env);
  await env.db.query('update staff set pin_hash=$1 where id=$2', [await hashPin(env, '1234'), f.admin.id]);
  for (let i = 0; i < 5; i++) {
    const r = await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '9999' });
    assert.equal(r.status, 401);
  }
  const r = await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '1234' });
  assert.equal(r.status, 423);
  const [row] = await env.db.query('select locked_until from staff where id=$1', [f.admin.id]);
  const mins = (new Date(row.locked_until) - Date.now()) / 60000;
  assert.ok(mins > 14 && mins <= 15, `locked ${mins}`);
});

test('admin pin must be 4-8 digits', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const r = await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '12a4' });
  assert.equal(r.status, 400);
});

test('deactivated staff cookie → 401', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const cookie = await loginGa(env, f.ga.A.id);
  await env.db.query('update staff set active=false where id=$1', [f.ga.A.id]);
  const me = await call(env, 'GET', '/api/me', undefined, cookie);
  assert.equal(me.status, 401);
});

test('tampered cookie → 401', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const cookie = await loginGa(env, f.ga.A.id);
  const bad = cookie.slice(0, -3) + 'abc';
  const me = await call(env, 'GET', '/api/me', undefined, bad);
  assert.equal(me.status, 401);
});

test('setup works once', async () => {
  const env = await newEnv();
  const s0 = await call(env, 'GET', '/api/admin/setup');
  assert.equal(s0.body.needed, true);
  const bad = await call(env, 'POST', '/api/admin/setup', { token: 'wrong', name: '山田', pin: '1234' });
  assert.equal(bad.status, 403);
  const ok = await call(env, 'POST', '/api/admin/setup', { token: 'setup-token', name: '山田', pin: '1234' });
  assert.equal(ok.status, 200);
  const again = await call(env, 'POST', '/api/admin/setup', { token: 'setup-token', name: '佐藤', pin: '1234' });
  assert.equal(again.status, 409);
  const s1 = await call(env, 'GET', '/api/admin/setup');
  assert.equal(s1.body.needed, false);
});

test('logout clears cookie', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const cookie = await loginGa(env, f.ga.A.id);
  const r = await call(env, 'POST', '/api/logout', {}, cookie);
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('Set-Cookie'), /Max-Age=0/);
});
