import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  return { env, f, a, s };
}

test('one request returns the roster of every slot for a round, same as asking slot by slot', async () => {
  const { env, f, a, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, a);
  const all = await call(env, 'GET', '/api/roster/round?round=2', undefined, a);
  assert.equal(all.status, 200);
  assert.equal(all.body.round, 2);
  assert.deepEqual(all.body.slots.map(x => x.slot.code), ['月', '火1', '火2', '水1', '水2', '木1', '木2', '金1', '金2']);
  for (const code of ['月', '火1']) {
    const one = await call(env, 'GET', `/api/roster?slotId=${f.slots[code].id}&round=2`, undefined, a);
    const mine = all.body.slots.find(x => x.slot.code === code).groups;
    const sort = gs => [...gs].sort((x, y) => x.groupId - y.groupId);
    assert.deepEqual(sort(mine), sort(one.body.groups), code);
  }
  const host = all.body.slots.find(x => x.slot.code === '火1').groups[0];
  assert.deepEqual(host.guests.map(m => m.name), ['江藤 四']);
});

test('the whole round takes a fixed, small number of queries', async () => {
  const { env, a } = await setup();
  let n = 0;
  const q = env.db.query.bind(env.db);
  env.db.query = (...args) => (n++, q(...args));
  const r = await call(env, 'GET', '/api/roster/round?round=2', undefined, a);
  env.db.query = q;
  assert.equal(r.status, 200);
  assert.ok(n <= 4, `queries: ${n}`);
});

test('a single slot roster uses at most 4 queries', async () => {
  const { env, f, a } = await setup();
  let n = 0;
  const q = env.db.query.bind(env.db);
  env.db.query = (...args) => (n++, q(...args));
  const r = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=2`, undefined, a);
  env.db.query = q;
  assert.equal(r.status, 200);
  assert.ok(n <= 4, `queries: ${n}`);
});

test('round roster rejects a bad round and needs login', async () => {
  const { env, a } = await setup();
  assert.equal((await call(env, 'GET', '/api/roster/round?round=99', undefined, a)).status, 400);
  assert.equal((await call(env, 'GET', '/api/roster/round?round=2')).status, 401);
});
