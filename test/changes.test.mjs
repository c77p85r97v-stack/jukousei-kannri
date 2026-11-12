import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const names = async (code, round, ga) =>
    (await call(env, 'GET', `/api/roster?slotId=${f.slots[code].id}&round=${round}`, undefined, c)).body.groups.find(g => g.gaName === ga).members.map(m => m.name.split(' ')[0]);
  return { env, f, c, s, names };
}

test('withdraw from round 4 → roster for 4 excludes, 3 includes', async () => {
  const { env, c, s, names } = await setup();
  const r = await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('井上').id, fromRound: 4, reason: '多忙' }, c);
  assert.equal(r.status, 200);
  assert.deepEqual(await names('月', 3, 'A'), ['青木', '井上', '上田']);
  assert.deepEqual(await names('月', 4, 'A'), ['青木', '上田']);
  const list = await call(env, 'GET', '/api/admin/withdrawals', undefined, c);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].slotCode, '月');
  assert.equal(list.body[0].gaName, 'A');
  assert.equal(list.body[0].staffConfirmed, false);
});

test('check and confirm record who did it', async () => {
  const { env, f, c, s } = await setup();
  const r = await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('井上').id, fromRound: 4 }, c);
  await call(env, 'POST', `/api/admin/withdrawals/${r.body.id}/check`, {}, c);
  await call(env, 'POST', `/api/admin/withdrawals/${r.body.id}/confirm`, {}, c);
  const [w] = await env.db.query('select * from withdrawals where id=$1', [r.body.id]);
  assert.equal(w.manager_checked_by, f.admin.id);
  assert.equal(w.staff_confirmed, true);
});

test('second active withdrawal → 409; after cancel can withdraw again', async () => {
  const { env, c, s, names } = await setup();
  const r = await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('井上').id, fromRound: 4 }, c);
  assert.equal((await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('井上').id, fromRound: 5 }, c)).status, 409);
  assert.equal((await call(env, 'POST', `/api/admin/withdrawals/${r.body.id}/cancel`, {}, c)).status, 200);
  assert.deepEqual(await names('月', 4, 'A'), ['青木', '井上', '上田']);
  assert.equal((await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('井上').id, fromRound: 5 }, c)).status, 200);
});

test('transfer stores from_group_id automatically and moves roster', async () => {
  const { env, f, c, s, names } = await setup();
  const r = await call(env, 'POST', '/api/admin/transfers', { studentId: s('青木').id, toGroupId: f.groups['火1C'].id, fromRound: 5 }, c);
  assert.equal(r.status, 200);
  const [t] = await env.db.query('select * from transfers where id=$1', [r.body.id]);
  assert.equal(t.from_group_id, f.groups['月A'].id);
  assert.deepEqual(await names('火1', 5, 'C'), ['青木', '加藤']);
  const list = await call(env, 'GET', '/api/admin/transfers', undefined, c);
  assert.equal(list.body[0].fromLabel, '月 A');
  assert.equal(list.body[0].toLabel, '火1 C');
  const r2 = await call(env, 'POST', '/api/admin/transfers', { studentId: s('青木').id, toGroupId: f.groups['月B'].id, fromRound: 7 }, c);
  const [t2] = await env.db.query('select * from transfers where id=$1', [r2.body.id]);
  assert.equal(t2.from_group_id, f.groups['火1C'].id);
  assert.equal((await call(env, 'POST', `/api/admin/transfers/${r2.body.id}/cancel`, {}, c)).status, 200);
  assert.deepEqual(await names('火1', 7, 'C'), ['青木', '加藤']);
});

test('transfer to the same group → 400', async () => {
  const { env, f, c, s } = await setup();
  const r = await call(env, 'POST', '/api/admin/transfers', { studentId: s('青木').id, toGroupId: f.groups['月A'].id, fromRound: 5 }, c);
  assert.equal(r.status, 400);
});

test('fromRound outside term.rounds → 400', async () => {
  const { env, f, c, s } = await setup();
  assert.equal((await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('青木').id, fromRound: 9 }, c)).status, 400);
  assert.equal((await call(env, 'POST', '/api/admin/transfers', { studentId: s('青木').id, toGroupId: f.groups['月B'].id, fromRound: -1 }, c)).status, 400);
});

test('GA cannot call → 403', async () => {
  const { env, f, s } = await setup();
  const ga = await loginGa(env, f.ga.A.id);
  assert.equal((await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('青木').id, fromRound: 1 }, ga)).status, 403);
  assert.equal((await call(env, 'GET', '/api/admin/transfers', undefined, ga)).status, 403);
});
