import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, closeEnv } from './helpers.mjs';
import { computeStats } from '../src/domain/stats.js';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const save = body => call(env, 'POST', '/api/records', { version: 0, ...body }, a);
  return { env, f, a, s, save };
}

test('new term tests the quiz in rounds 1 and 8', async () => {
  const { f } = await setup();
  assert.deepEqual(f.term.quiz_rounds, [1, 8]);
});

test('round 0 accepts 出席', async () => {
  const { s, save } = await setup();
  const r = await save({ studentId: s('青木').id, round: 0, attendance: '出席' });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '出席');
});

test('round 0 refuses 欠席 (free participation)', async () => {
  const { s, save } = await setup();
  const r = await save({ studentId: s('青木').id, round: 0, attendance: '欠席' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /自由参加/);
});

test('round 0 refuses quiz and typing', async () => {
  const { s, save } = await setup();
  assert.equal((await save({ studentId: s('青木').id, round: 0, quiz: 5 })).status, 400);
  assert.equal((await save({ studentId: s('青木').id, round: 0, typing: 100 })).status, 400);
});

test('round 0 refuses makeups', async () => {
  const { env, s, a } = await setup();
  const r = await call(env, 'POST', '/api/makeups', { studentId: s('青木').id, round: 0, place: '未定', version: 0 }, a);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /第0回/);
});

test('roster says whether the round is free', async () => {
  const { env, f, a } = await setup();
  const r0 = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=0`, undefined, a);
  const r1 = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=1`, undefined, a);
  assert.equal(r0.body.isFreeRound, true);
  assert.equal(r0.body.isQuizRound, false);
  assert.equal(r1.body.isFreeRound, false);
  assert.equal(r1.body.isQuizRound, true);
});

test('stats: round 0 is counted apart as participants only', async () => {
  const { env, f, s } = await setup();
  await env.db.query(`insert into records(student_id, round, attendance) values ($1,0,'出席'), ($2,0,'出席')`, [s('青木').id, s('井上').id]);
  const st = await computeStats(env.db, f.term.id);
  assert.deepEqual(st.freeRound, { round: 0, attended: 2 });
  assert.equal(st.attendanceRate[0], undefined);
  assert.equal(st.attendanceRate[1].enrolled, 6);
});

test('stats: never-attended counts withdrawals up to round 1', async () => {
  const { env, f, s } = await setup();
  await env.db.query('insert into withdrawals(student_id, from_round) values ($1, 0), ($2, 1), ($3, 2)', [s('青木').id, s('井上').id, s('上田').id]);
  const st = await computeStats(env.db, f.term.id);
  assert.equal(st.withdrawn, 3);
  assert.equal(st.neverAttended, 2);
  assert.equal(st.retentionRateExclNeverAttended, 5 / 6);
});

test('stats: quiz gain is round 8 minus round 1', async () => {
  const { env, f, s } = await setup();
  await env.db.query(`insert into records(student_id, round, attendance, quiz) values ($1,1,'出席',10), ($1,8,'出席',18)`, [s('青木').id]);
  const st = await computeStats(env.db, f.term.id);
  assert.equal(st.groups.find(g => g.gaName === 'A').quizGainAvg, 8);
});
