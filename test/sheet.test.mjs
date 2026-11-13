import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const rec = (name, round, attendance, typing = null, quiz = null, note = null) =>
    env.db.query('insert into records(student_id, round, attendance, typing, quiz, note) values ($1,$2,$3,$4,$5,$6)', [s(name).id, round, attendance, typing, quiz, note]);
  const sheet = (slot = '月', cookie = a) => call(env, 'GET', `/api/records/sheet?slotId=${f.slots[slot].id}`, undefined, cookie);
  const row = (body, name) => body.groups.flatMap(g => g.students).find(x => x.name.startsWith(name));
  return { env, f, a, s, rec, sheet, row };
}

test('groups of the slot with their students, like the old weekday sheet', async () => {
  const { sheet } = await setup();
  const r = await sheet();
  assert.equal(r.status, 200);
  assert.equal(r.body.slot.code, '月');
  assert.deepEqual(r.body.rounds, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(r.body.quizRounds, [1, 8]);
  assert.deepEqual(r.body.groups.map(g => [g.gaName, g.students.map(x => x.kana)]), [
    ['A', ['アオキ ハジメ', 'イノウエ ジ', 'ウエダ サン']],
    ['B', ['エトウ シ', 'オガワ ゴ']],
  ]);
});

test('cells: typing value, or the old marks for attendance without typing', async () => {
  const { rec, sheet, row } = await setup();
  await rec('青木', 0, '出席');
  await rec('青木', 1, '出席', 145.2, 11);
  await rec('青木', 2, '出席・記録なし'); // 古いデータ（移行前）も「記録なし」と出す
  await rec('青木', 3, '記録なし');
  await rec('青木', 4, '時間切れ');
  await rec('青木', 5, '欠席');
  await rec('青木', 8, '出席', 120.5, 18);
  const r = row((await sheet()).body, '青木');
  assert.equal(r.cells[0].value, '〇');
  assert.equal(r.cells[1].value, '145.2');
  assert.equal(r.cells[2].value, '記録なし');
  assert.equal(r.cells[3].value, '記録なし');
  assert.equal(r.cells[4].value, '時間切れ');
  assert.equal(r.cells[5].value, '欠席');
  assert.equal(r.cells[6].value, '');
  assert.deepEqual(r.quiz, { 1: 11, 8: 18 });
  assert.equal(r.typingGain, 24.7);
  assert.equal(r.quizGain, 7);
});

test('remark shows makeup place and the memo; △ and × for makeups', async () => {
  const { env, f, a, s, rec, sheet, row } = await setup();
  await rec('井上', 2, '欠席', null, null, '体調不良');
  await call(env, 'POST', '/api/makeups', { studentId: s('井上').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, a);
  await call(env, 'POST', '/api/makeups', { studentId: s('上田').id, round: 2, place: '個別', indivNo: 2, version: 0 }, a);
  await call(env, 'POST', '/api/makeups', { studentId: s('上田').id, round: 3, place: '未定', version: 0 }, a);
  await call(env, 'POST', '/api/makeups/fail', { studentId: s('上田').id, round: 3, version: 1 }, a);
  const body = (await sheet()).body;
  const i = row(body, '井上').cells[2];
  assert.equal(i.value, '△');
  assert.equal(i.remark, '火1 C補講・体調不良');
  assert.equal(row(body, '上田').cells[2].remark, '個別②');
  assert.equal(row(body, '上田').cells[3].value, '×');
  assert.equal(row(body, '上田').cells[3].remark, '補講できず');
});

test('withdrawn students stay listed, marked, with later rounds blank', async () => {
  const { env, s, rec, sheet, row } = await setup();
  await rec('上田', 1, '出席', 200);
  await env.db.query('insert into withdrawals(student_id, from_round) values ($1, 3)', [s('上田').id]);
  const u = row((await sheet()).body, '上田');
  assert.equal(u.withdrawnFrom, 3);
  assert.equal(u.status, '第3回〜解約');
  assert.equal(u.cells[1].value, '200');
  assert.equal(u.cells[3].out, true);
});

test('a transferred student appears under the new slot, with a note', async () => {
  const { env, f, s, sheet, row } = await setup();
  const ad = await loginAdmin(env, f);
  await call(env, 'POST', '/api/admin/transfers', { studentId: s('青木').id, toGroupId: f.groups['火1C'].id, fromRound: 3 }, ad);
  assert.equal(row((await sheet('月')).body, '青木'), undefined);
  const t = row((await sheet('火1')).body, '青木');
  assert.equal(t.status, '第3回から移動（月 Aから）');
});

test('records sheet needs login', async () => {
  const { env, f } = await setup();
  assert.equal((await call(env, 'GET', `/api/records/sheet?slotId=${f.slots['月'].id}`)).status, 401);
});
