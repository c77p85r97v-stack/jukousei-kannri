import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa } from './helpers.mjs';
import { makeupStatus } from '../src/domain/makeup.js';

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const b = await loginGa(env, f.ga.B.id);
  const c = await loginGa(env, f.ga.C.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const roster = (code, round, cookie = b) => call(env, 'GET', `/api/roster?slotId=${f.slots[code].id}&round=${round}`, undefined, cookie);
  const member = async (code, round, gaName, name, field = 'members') =>
    (await roster(code, round)).body.groups.find(g => g.gaName === gaName)[field].find(m => m.name.startsWith(name));
  return { env, f, b, c, s, roster, member };
}

test('choosing a place sets △ (欠席・補講予定) and puts student in host roster', async () => {
  const { env, f, b, s, member } = await setup();
  const r = await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席・補講予定');
  assert.equal(r.body.makeup.status, '予定');
  const guest = await member('火1', 2, 'C', '江藤', 'guests');
  assert.ok(guest);
  const home = await member('月', 2, 'B', '江藤');
  assert.equal(home.makeup.hostLabel, '火1 C');
  assert.equal(home.record.attendance, '欠席・補講予定');
});

test("host GA typing on the student's record marks status 済 and home roster shows the same record", async () => {
  const { env, f, b, c, s, member } = await setup();
  const id = s('江藤').id;
  const m = await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  const guest = await member('火1', 2, 'C', '江藤', 'guests');
  const r = await call(env, 'POST', '/api/records', { studentId: id, round: 2, typing: 133.3, version: guest.record.version }, c);
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '出席');
  const home = await member('月', 2, 'B', '江藤');
  assert.equal(home.record.typing, 133.3);
  assert.equal(home.makeup.status, '済');
  assert.ok(m);
});

test('fail sets × and removes from host roster', async () => {
  const { env, f, b, s, member } = await setup();
  const id = s('江藤').id;
  const m = await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  const r = await call(env, 'POST', '/api/makeups/fail', { studentId: id, round: 2, version: m.body.makeup.version }, b);
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席・補講できず');
  assert.equal(r.body.makeup.status, 'できず');
  assert.equal(await member('火1', 2, 'C', '江藤', 'guests'), undefined);
});

test('changing place moves the guest to the new host', async () => {
  const { env, f, b, s, member } = await setup();
  const id = s('江藤').id;
  const m = await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  const r = await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['月A'].id, version: m.body.makeup.version }, b);
  assert.equal(r.status, 200);
  assert.equal(await member('火1', 2, 'C', '江藤', 'guests'), undefined);
  assert.ok(await member('月', 2, 'A', '江藤', 'guests'));
});

test('stale makeup version → 409', async () => {
  const { env, f, b, s } = await setup();
  const id = s('江藤').id;
  await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '未定', version: 0 }, b);
  const r = await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  assert.equal(r.status, 409);
});

test('place 未定 then 個別 then entering record → 済', async () => {
  const { env, b, s } = await setup();
  const id = s('江藤').id;
  const m1 = await call(env, 'POST', '/api/makeups', { studentId: id, round: 3, place: '未定', version: 0 }, b);
  assert.equal(m1.body.makeup.status, '未定');
  const m2 = await call(env, 'POST', '/api/makeups', { studentId: id, round: 3, place: '個別', version: m1.body.makeup.version }, b);
  assert.equal(m2.body.makeup.status, '予定');
  await call(env, 'POST', '/api/records', { studentId: id, round: 3, typing: 99, version: m2.body.record.version }, b);
  const list = await call(env, 'GET', `/api/makeups?round=3`, undefined, b);
  assert.equal(list.body[0].status, '済');
  assert.equal(list.body[0].place, '個別');
});

test('cancel restores 欠席 and removes guest', async () => {
  const { env, f, b, s, member } = await setup();
  const id = s('江藤').id;
  const m = await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  const r = await call(env, 'POST', '/api/makeups/cancel', { studentId: id, round: 2, version: m.body.makeup.version }, b);
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席');
  assert.equal(r.body.makeup, null);
  assert.equal(await member('火1', 2, 'C', '江藤', 'guests'), undefined);
});

test('host equal to own group → 400; 他班 without host → 400', async () => {
  const { env, f, b, s } = await setup();
  const r = await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 2, place: '他班', hostGroupId: f.groups['月B'].id, version: 0 }, b);
  assert.equal(r.status, 400);
  const r2 = await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 2, place: '他班', version: 0 }, b);
  assert.equal(r2.status, 400);
});

test('list filters by status', async () => {
  const { env, f, b, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 2, place: '未定', version: 0 }, b);
  await call(env, 'POST', '/api/makeups', { studentId: s('小川').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, b);
  const all = await call(env, 'GET', '/api/makeups?round=2', undefined, b);
  assert.equal(all.body.length, 2);
  const undecided = await call(env, 'GET', '/api/makeups?round=2&status=未定', undefined, b);
  assert.deepEqual(undecided.body.map(x => x.name.split(' ')[0]), ['江藤']);
  assert.equal(all.body.find(x => x.name.startsWith('小川')).hostLabel, '火1 C');
  assert.equal(all.body[0].homeLabel, '月 B');
});

test('makeupStatus truth table', () => {
  assert.equal(makeupStatus({ place: '他班', failed: false }, { attendance: '出席' }), '済');
  assert.equal(makeupStatus({ place: '他班', failed: true }, { attendance: '欠席・補講できず' }), 'できず');
  assert.equal(makeupStatus({ place: '未定', failed: false }, { attendance: '欠席・補講予定' }), '未定');
  assert.equal(makeupStatus({ place: '個別', failed: false }, null), '予定');
});
