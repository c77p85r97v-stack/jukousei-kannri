import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const b = await loginGa(env, f.ga.B.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const mk = (cookie, body) => call(env, 'POST', '/api/makeups', { version: 0, place: '個別', ...body }, cookie);
  const indiv = (cookie, round) => call(env, 'GET', `/api/indiv?round=${round}`, undefined, cookie);
  return { env, f, a, b, s, mk, indiv };
}

test('individual slots ①〜⑦ use the term defaults, ⑧ is 指定時間外', async () => {
  const { a, indiv } = await setup();
  const r = await indiv(a, 2);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots.map(x => x.no), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(r.body.slots[0].label, '水曜 13:00');
  assert.equal(r.body.slots[6].label, '火曜 16:30');
  assert.equal(r.body.slots[7].label, '指定時間外');
});

test('register 個別 ② and it shows in the slot with katakana name and home GA', async () => {
  const { a, s, mk, indiv } = await setup();
  const r = await mk(a, { studentId: s('青木').id, round: 2, indivNo: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.makeup.indivNo, 2);
  assert.equal(r.body.makeup.indivLabel, '②木曜 13:00');
  const list = await indiv(a, 2);
  const st = list.body.slots[1].students;
  assert.equal(st.length, 1);
  assert.equal(st[0].kana, 'アオキ ハジメ');
  assert.equal(st[0].homeLabel, '月 A');
  assert.equal(st[0].status, '予定');
});

test('⑧ needs a date/time and the registering GA is in charge', async () => {
  const { a, b, s, mk, indiv } = await setup();
  assert.equal((await mk(a, { studentId: s('青木').id, round: 2, indivNo: 8 })).status, 400);
  const r = await mk(b, { studentId: s('青木').id, round: 2, indivNo: 8, indivWhen: '5/8 15:00〜' });
  assert.equal(r.status, 200);
  assert.equal(r.body.makeup.indivLabel, '⑧5/8 15:00〜');
  const st = (await indiv(a, 2)).body.slots[7].students[0];
  assert.equal(st.indivWhen, '5/8 15:00〜');
  assert.equal(st.inCharge, 'B');
});

test('個別 without a number is listed as 未割り当て', async () => {
  const { a, s, mk, indiv } = await setup();
  await mk(a, { studentId: s('青木').id, round: 2 });
  const r = await indiv(a, 2);
  assert.equal(r.body.unassigned.length, 1);
});

test('indivNo is only for 個別', async () => {
  const { a, f, s, mk } = await setup();
  const r = await mk(a, { studentId: s('青木').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, indivNo: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.makeup.indivNo, null);
});

test('admin overrides a slot for one round (time change, 実施なし, 担当, 場所)', async () => {
  const { env, f, a, s, mk, indiv } = await setup();
  const ad = await loginAdmin(env, f);
  const r = await call(env, 'POST', '/api/admin/indiv-slots', { round: 5, no: 2, label: '木曜 15:00', host: 'たくゆき', room: '集会室3' }, ad);
  assert.equal(r.status, 200);
  await call(env, 'POST', '/api/admin/indiv-slots', { round: 5, no: 1, closed: true }, ad);
  const l5 = await indiv(a, 5);
  assert.equal(l5.body.slots[1].label, '木曜 15:00');
  assert.equal(l5.body.slots[1].host, 'たくゆき');
  assert.equal(l5.body.slots[1].room, '集会室3');
  assert.equal(l5.body.slots[0].closed, true);
  assert.equal((await indiv(a, 4)).body.slots[1].label, '木曜 13:00');
  const closed = await mk(a, { studentId: s('青木').id, round: 5, indivNo: 1 });
  assert.equal(closed.status, 400);
  assert.match(closed.body.error, /実施なし/);
});

test('indiv-slots needs admin', async () => {
  const { env, a } = await setup();
  assert.equal((await call(env, 'POST', '/api/admin/indiv-slots', { round: 5, no: 2, label: 'x' }, a)).status, 403);
});

test('admin changes the default labels of ①〜⑦', async () => {
  const { env, f, a, indiv } = await setup();
  const ad = await loginAdmin(env, f);
  const labels = ['水曜 13:00', '木曜 14:00', '金曜 13:00', '月曜 13:00', '月曜 16:30', '火曜 13:00', '火曜 14:30'];
  const r = await call(env, 'POST', '/api/admin/indiv-labels', { termId: f.term.id, labels }, ad);
  assert.equal(r.status, 200);
  assert.equal((await indiv(a, 3)).body.slots[6].label, '火曜 14:30');
  assert.equal((await call(env, 'POST', '/api/admin/indiv-labels', { termId: f.term.id, labels: ['x'] }, ad)).status, 400);
});

test('roster and makeup list show the individual slot', async () => {
  const { env, f, a, s, mk } = await setup();
  await mk(a, { studentId: s('青木').id, round: 2, indivNo: 3 });
  const ro = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=2`, undefined, a);
  const m = ro.body.groups.flatMap(g => g.members).find(x => x.name.startsWith('青木'));
  assert.equal(m.makeup.indivLabel, '③金曜 13:00');
  const list = await call(env, 'GET', '/api/makeups?round=2', undefined, a);
  assert.equal(list.body[0].indivLabel, '③金曜 13:00');
});
