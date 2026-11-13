// 出欠と補講の組み合わせが矛盾しないこと
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const ver = async (id, round) => ((await env.db.query('select version from records where student_id=$1 and round=$2', [id, round]))[0] || { version: 0 }).version;
  const save = async (id, round, body) => call(env, 'POST', '/api/records', { studentId: id, round, version: await ver(id, round), ...body }, a);
  const mk = (id, round, body) => call(env, 'POST', '/api/makeups', { studentId: id, round, place: '未定', version: 0, ...body }, a);
  return { env, f, a, s, ver, save, mk };
}

test('choosing 当日欠席 for someone with a makeup keeps △ (not a plain 当日欠席 next to an active makeup)', async () => {
  const { s, save, mk } = await setup();
  const id = s('青木').id;
  await mk(id, 2);
  const r = await save(id, 2, { attendance: '欠席' });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席・補講予定');
});

test('clearing attendance for someone with a makeup keeps △', async () => {
  const { s, save, mk } = await setup();
  const id = s('青木').id;
  await mk(id, 2);
  const r = await save(id, 2, { attendance: '' });
  assert.equal(r.body.record.attendance, '欠席・補講予定');
});

test('choosing 当日欠席 on a 補講済み row goes back to △ (makeup not done yet)', async () => {
  const { s, save, mk } = await setup();
  const id = s('青木').id;
  await mk(id, 2);
  await save(id, 2, { typing: 120 });
  const r = await save(id, 2, { attendance: '欠席' });
  assert.equal(r.body.record.attendance, '欠席・補講予定');
});

test('after 補講できず, choosing 出席 is refused with a hint to change the makeup', async () => {
  const { env, a, s, save, mk } = await setup();
  const id = s('青木').id;
  const m = await mk(id, 2);
  await call(env, 'POST', '/api/makeups/fail', { studentId: id, round: 2, version: m.body.makeup.version }, a);
  const r = await save(id, 2, { attendance: '出席' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /補講できず/);
  const r2 = await save(id, 2, { attendance: '欠席' });
  assert.equal(r2.body.record.attendance, '欠席・補講できず');
});

test('「できなかった」 is refused once the makeup is done', async () => {
  const { env, a, s, save, mk } = await setup();
  const id = s('青木').id;
  const m = await mk(id, 2);
  await save(id, 2, { typing: 120 });
  const r = await call(env, 'POST', '/api/makeups/fail', { studentId: id, round: 2, version: m.body.makeup.version }, a);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /補講済み/);
});

test('registering a makeup for someone who attended that day is refused', async () => {
  const { s, save, mk } = await setup();
  const id = s('青木').id;
  await save(id, 2, { typing: 150 });
  const r = await mk(id, 2);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /出席/);
});

test('changing the 振替先 of a done makeup keeps it done', async () => {
  const { f, s, save, mk } = await setup();
  const id = s('青木').id;
  const m = await mk(id, 2);
  await save(id, 2, { typing: 120 });
  const r = await mk(id, 2, { place: '他班', hostGroupId: f.groups['火1C'].id, version: m.body.makeup.version });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席・補講済み');
  assert.equal(r.body.makeup.status, '済');
});

test('records.csv says 振替先未定 when the makeup place is not decided', async () => {
  const { env, f, a, s, mk } = await setup();
  await mk(s('青木').id, 2);
  await mk(s('井上').id, 2, { place: '他班', hostGroupId: f.groups['火1C'].id });
  const text = (await call(env, 'GET', `/api/export/records.csv?termId=${f.term.id}`, undefined, a)).text;
  const line = name => text.split('\r\n').find(l => l.includes(name));
  assert.match(line('青木 一'), /当日欠席・振替先未定/);
  assert.match(line('井上 二'), /当日欠席・振替済み/);
});
