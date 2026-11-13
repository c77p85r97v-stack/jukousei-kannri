import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, SLOT_CODES, closeEnv } from './helpers.mjs';

after(closeEnv);

test('creating a term creates 9 slots in fixed order', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/terms', { name: '2028年度' }, c);
  assert.equal(r.status, 200);
  const slots = await env.db.query('select code from slots where term_id=$1 order by sort', [r.body.id]);
  assert.deepEqual(slots.map(s => s.code), SLOT_CODES);
  const list = await call(env, 'GET', '/api/admin/terms', undefined, c);
  assert.equal(list.body.length, 2);
});

test('activating a term deactivates others', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/terms', { name: '2028年度', active: true }, c);
  assert.equal(r.status, 200);
  const rows = await env.db.query('select id from terms where active');
  assert.deepEqual(rows.map(x => x.id), [r.body.id]);
});

test('term settings can change rounds', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/terms', { id: f.term.id, name: f.term.name, rounds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], typingRounds: [1, 9], quizRounds: [1, 9], initialCount: 400, active: true }, c);
  assert.equal(r.status, 200);
  const [t] = await env.db.query('select * from terms where id=$1', [f.term.id]);
  assert.deepEqual(t.typing_rounds, [1, 9]);
  assert.equal(t.initial_count, 400);
});

test('typing/quiz rounds must be inside rounds', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/terms', { id: f.term.id, name: 'x', rounds: [0, 1], typingRounds: [5] }, c);
  assert.equal(r.status, 400);
});

test('deactivated GA disappears from bootstrap but group and records remain', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/staff', { id: f.ga.A.id, name: 'A', role: 'ga', active: false }, c);
  assert.equal(r.status, 200);
  const b = await call(env, 'GET', '/api/bootstrap');
  assert.ok(!b.body.staff.some(s => s.name === 'A'));
  const g = await call(env, 'GET', `/api/groups?termId=${f.term.id}`, undefined, c);
  const a = g.body.find(x => x.id === f.groups['月A'].id);
  assert.equal(a.gaName, 'A');
  assert.equal(a.gaActive, false);
});

test('no endpoint deletes staff', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', `/api/admin/staff/${f.ga.A.id}/delete`, {}, c);
  assert.equal(r.status, 404);
});

test('admin pin can be set and must be 4-8 digits', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const [newAdmin] = await env.db.query(`insert into staff(name, role) values ('副チーフ','admin') returning id`);
  assert.equal((await call(env, 'POST', `/api/admin/staff/${newAdmin.id}/pin`, { pin: '12' }, c)).status, 400);
  assert.equal((await call(env, 'POST', `/api/admin/staff/${newAdmin.id}/pin`, { pin: '5678' }, c)).status, 200);
  const login = await call(env, 'POST', '/api/admin/login', { staffId: newAdmin.id, pin: '5678' });
  assert.equal(login.status, 200);
});

test('unlock clears lock', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  await env.db.query(`update staff set locked_until=now()+interval '10 minutes' where id=$1`, [f.ga.B.id]);
  await call(env, 'POST', `/api/admin/staff/${f.ga.B.id}/unlock`, {}, c);
  const [s] = await env.db.query('select locked_until from staff where id=$1', [f.ga.B.id]);
  assert.equal(s.locked_until, null);
});

test('duplicate staff name → 409', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/staff', { name: 'B', role: 'ga' }, c);
  assert.equal(r.status, 409);
});

test('groups: add, list order, cannot delete with students', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const add = await call(env, 'POST', '/api/admin/groups', { slotId: f.slots['月'].id, gaId: f.ga.C.id }, c);
  assert.equal(add.status, 200);
  const ga = await loginGa(env, f.ga.A.id);
  const list = await call(env, 'GET', `/api/groups?termId=${f.term.id}`, undefined, ga);
  assert.deepEqual(list.body.map(g => `${g.slotCode}${g.gaName}`), ['月A', '月B', '月C', '火1C']);
  const del = await call(env, 'POST', `/api/admin/groups/${f.groups['月A'].id}/delete`, {}, c);
  assert.equal(del.status, 409);
  const del2 = await call(env, 'POST', `/api/admin/groups/${add.body.id}/delete`, {}, c);
  assert.equal(del2.status, 200);
});

test('students: add, edit, search', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const add = await call(env, 'POST', '/api/admin/students', { name: '　新井　七 ', kana: 'アライ ナナ', nickname: 'なな', groupId: f.groups['月B'].id }, c);
  assert.equal(add.status, 200);
  assert.equal(add.body.name, '新井 七');
  const edit = await call(env, 'POST', '/api/admin/students', { id: add.body.id, name: '新井 七', kana: 'アライ ナナ', nickname: 'ななちゃん', groupId: f.groups['月B'].id }, c);
  assert.equal(edit.body.nickname, 'ななちゃん');
  const s = await call(env, 'GET', `/api/admin/students?termId=${f.term.id}&q=アライ`, undefined, c);
  assert.equal(s.body.length, 1);
  assert.equal(s.body[0].slotCode, '月');
  assert.equal(s.body[0].gaName, 'B');
});

test('every write leaves an audit_log row with before/after', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  await call(env, 'POST', '/api/admin/staff', { id: f.ga.B.id, name: 'B2', role: 'ga', active: true }, c);
  const [a] = await env.db.query(`select * from audit_log where target_table='staff' order by id desc limit 1`);
  assert.equal(a.before_json.name, 'B');
  assert.equal(a.after_json.name, 'B2');
  assert.equal(a.operator_id, f.admin.id);
});

test('GA cannot write master data', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const ga = await loginGa(env, f.ga.A.id);
  assert.equal((await call(env, 'POST', '/api/admin/students', { name: 'x', groupId: f.groups['月A'].id }, ga)).status, 403);
});
