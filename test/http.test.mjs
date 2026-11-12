import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, ROUTES } from '../src/app.js';
import { newEnv } from './helpers.mjs';

const BASE = 'http://localhost';

test('unknown api path → 404 {error}', async () => {
  const env = await newEnv();
  const res = await handle(new Request(`${BASE}/api/nothing`), env);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

test('POST without X-Requested-With → 403', async () => {
  const env = await newEnv();
  const res = await handle(new Request(`${BASE}/api/logout`, { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 403);
});

test('POST with foreign Origin → 403', async () => {
  const env = await newEnv();
  const res = await handle(
    new Request(`${BASE}/api/logout`, { method: 'POST', body: '{}', headers: { 'X-Requested-With': 'koshu', Origin: 'https://evil.example' } }),
    env,
  );
  assert.equal(res.status, 403);
});

test('unexpected error → 500 with Japanese message and no SQL', async () => {
  const env = await newEnv();
  ROUTES.push(['GET', /^\/api\/__boom$/, async e => e.db.query('select * from no_such_table')]);
  const res = await handle(new Request(`${BASE}/api/__boom`), env);
  ROUTES.pop();
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /サーバーでエラー/);
  assert.doesNotMatch(body.error, /no_such_table/);
});
