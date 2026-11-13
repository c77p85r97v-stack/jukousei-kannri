// 補講以外の組み合わせの矛盾（年度・解約・コマ移動・個別補講の枠・タイピング）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const ad = await loginAdmin(env, f);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const term = body => call(env, 'POST', '/api/admin/terms', { id: f.term.id, name: f.term.name, active: true, ...body }, ad);
  return { env, f, a, ad, s, term };
}

test('a new year starts with the test (クイズ) in rounds 1 and 8', async () => {
  const { env, ad } = await setup();
  const t = await call(env, 'POST', '/api/admin/terms', { name: '次の年度' }, ad);
  assert.deepEqual(t.body.quiz_rounds, [1, 8]);
  assert.deepEqual(t.body.typing_rounds, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('typing or test cannot be set on 第0回 (free participation)', async () => {
  const { term } = await setup();
  const r = await term({ quizRounds: [0, 8] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /第0回/);
  assert.equal((await term({ typingRounds: [0, 1, 2] })).status, 400);
});

test('a round that already has records cannot be removed from the year', async () => {
  const { env, a, s, term } = await setup();
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 5, typing: 100, version: 0 }, a);
  const r = await term({ rounds: [0, 1, 2, 3, 4], typingRounds: [1, 2, 3, 4], quizRounds: [1, 4] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /第5回/);
});

test('typing cannot be dropped from a round that already has typing; same for the test', async () => {
  const { env, a, s, term } = await setup();
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 3, typing: 100, version: 0 }, a);
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 1, quiz: 10, attendance: '出席', version: 0 }, a);
  assert.equal((await term({ typingRounds: [1, 2, 4, 5, 6, 7, 8] })).status, 409);
  assert.equal((await term({ quizRounds: [2, 8] })).status, 409);
});

test('withdrawing from round 4 is refused when the student has a record of attending round 5', async () => {
  const { env, a, ad, s } = await setup();
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 5, typing: 100, version: 0 }, a);
  const r = await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('青木').id, fromRound: 4 }, ad);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /第5回/);
  assert.equal((await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('青木').id, fromRound: 6 }, ad)).status, 200);
});

test('moving a student into the group that hosts their later makeup is refused', async () => {
  const { env, f, a, ad, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('井上').id, round: 6, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, a);
  const r = await call(env, 'POST', '/api/admin/transfers', { studentId: s('井上').id, toGroupId: f.groups['火1C'].id, fromRound: 3 }, ad);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /第6回/);
});

test('moving a student is refused from a round after they withdrew', async () => {
  const { env, f, ad, s } = await setup();
  await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('上田').id, fromRound: 2 }, ad);
  const r = await call(env, 'POST', '/api/admin/transfers', { studentId: s('上田').id, toGroupId: f.groups['火1C'].id, fromRound: 5 }, ad);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /解約/);
});

test('an individual slot with students booked cannot be set to 実施なし', async () => {
  const { env, a, ad, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 5, place: '個別', indivNo: 1, version: 0 }, a);
  const r = await call(env, 'POST', '/api/admin/indiv-slots', { round: 5, no: 1, closed: true }, ad);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /1人/);
  assert.equal((await call(env, 'POST', '/api/admin/indiv-slots', { round: 5, no: 1, label: '水曜 14:00' }, ad)).status, 200);
});

test('typing time must be more than 0 seconds', async () => {
  const { env, a, s } = await setup();
  const r = await call(env, 'POST', '/api/records', { studentId: s('小川').id, round: 2, typing: 0, version: 0 }, a);
  assert.equal(r.status, 400);
});
