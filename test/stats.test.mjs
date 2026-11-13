import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, closeEnv } from './helpers.mjs';

after(closeEnv);
import { computeStats } from '../src/domain/stats.js';

// 受講生10人（月A:3 月B:2 火1C:5）、解約2人（江藤=第2回から、小川=第3回から）
async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const db = env.db;
  for (let i = 1; i <= 4; i++) {
    const [s] = await db.query(`insert into students(term_id, name, kana, nickname, group_id) values ($1,$2,$3,$4,$5) returning *`, [f.term.id, `追加 ${i}`, `ツイカ ${i}`, `t${i}`, f.groups['火1C'].id]);
    f.students.push(s);
  }
  const s = name => f.students.find(x => x.name.startsWith(name));
  await db.query('insert into withdrawals(student_id, from_round) values ($1, 2)', [s('江藤').id]);
  await db.query('insert into withdrawals(student_id, from_round) values ($1, 3)', [s('小川').id]);
  const rec = (name, round, attendance, typing = null, quiz = null) =>
    db.query('insert into records(student_id, round, attendance, typing, quiz) values ($1,$2,$3,$4,$5)', [s(name).id, round, attendance, typing, quiz]);
  // 第3回：在籍8人のうち出席系6人
  for (const n of ['青木', '井上', '上田', '加藤', '追加 1']) await rec(n, 3, '出席', 100);
  await rec('追加 2', 3, '記録なし');
  await rec('追加 3', 3, '欠席');
  // 伸び：青木は第1回なし・第2回200→第8回150（+50）、井上は第1回100→第8回120（−20）
  await rec('青木', 2, '出席', 200);
  await rec('青木', 8, '出席', 150, 18);
  await rec('青木', 1, '出席', null, 10);
  await rec('井上', 1, '出席', 100);
  await rec('井上', 8, '出席', 120);
  return { env, f, s };
}

test('retention and withdrawal rates', async () => {
  const { env, f } = await setup();
  const st = await computeStats(env.db, f.term.id);
  assert.equal(st.initialCount, 10);
  assert.equal(st.withdrawn, 2);
  assert.equal(st.retentionRate, 0.8);
  assert.equal(st.withdrawalRate, 0.2);
  assert.deepEqual(st.withdrawnBySlot, { 月: 2 });
  assert.deepEqual(st.withdrawnByRound, { 2: 1, 3: 1 });
});

test('attendance rate per round', async () => {
  const { env, f } = await setup();
  const st = await computeStats(env.db, f.term.id);
  assert.deepEqual(st.attendanceRate[3], { enrolled: 8, attended: 6, rate: 0.75 });
  assert.equal(st.attendanceRate[1].enrolled, 10);
  assert.equal(st.attendanceRate[2].enrolled, 9);
  assert.deepEqual(Object.keys(st.attendanceRate).map(Number), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('typing and quiz gain per group', async () => {
  const { env, f } = await setup();
  const st = await computeStats(env.db, f.term.id);
  const a = st.groups.find(g => g.groupId === f.groups['月A'].id);
  assert.equal(a.slotCode, '月');
  assert.equal(a.gaName, 'A');
  assert.equal(a.size, 3);
  assert.equal(a.typingGainAvg, 15);
  assert.equal(a.typingImprovedRatio, 0.5);
  assert.equal(a.quizGainAvg, 8);
  const b = st.groups.find(g => g.groupId === f.groups['月B'].id);
  assert.equal(b.size, 0);
  assert.equal(b.typingGainAvg, null);
});

test('explicit initial_count is used; transfers are counted by slot', async () => {
  const { env, f, s } = await setup();
  await env.db.query('update terms set initial_count=20 where id=$1', [f.term.id]);
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round) values ($1,$2,$3,5)', [s('上田').id, f.groups['月A'].id, f.groups['火1C'].id]);
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round, cancelled_at) values ($1,$2,$3,5, now())', [s('加藤').id, f.groups['火1C'].id, f.groups['月A'].id]);
  const st = await computeStats(env.db, f.term.id);
  assert.equal(st.initialCount, 20);
  assert.equal(st.retentionRate, 0.9);
  assert.equal(st.transfers, 1);
  assert.deepEqual(st.transfersBySlot['月'], { out: 1, in: 0 });
  assert.deepEqual(st.transfersBySlot['火1'], { out: 0, in: 1 });
  assert.equal(st.groups.find(g => g.groupId === f.groups['火1C'].id).size, 6);
});

test('empty term does not divide by zero', async () => {
  const env = await newEnv();
  const [t] = await env.db.query(`insert into terms(name) values ('空') returning id`);
  const st = await computeStats(env.db, t.id);
  assert.equal(st.initialCount, 0);
  assert.equal(st.retentionRate, null);
  assert.equal(st.attendanceRate[1].rate, null);
  assert.deepEqual(st.freeRound, { round: 0, attended: 0 });
});

test('GET /api/stats is available to GA', async () => {
  const { env, f } = await setup();
  const ga = await loginGa(env, f.ga.A.id);
  const r = await call(env, 'GET', `/api/stats?termId=${f.term.id}`, undefined, ga);
  assert.equal(r.status, 200);
  assert.equal(r.body.withdrawn, 2);
  assert.equal((await call(env, 'GET', `/api/stats?termId=${f.term.id}`)).status, 401);
});

test('retention excluding students who never attended the first round (旧シートと同じ計算)', async () => {
  const { env, f, s } = await setup();
  // 追加で1人、最初の回（第0回）から未受講で解約
  await env.db.query('insert into withdrawals(student_id, from_round) values ($1, 0)', [s('追加 4').id]);
  const st = await computeStats(env.db, f.term.id);
  // 初期受講生数は「解約者も含めた全員」＝10
  assert.equal(st.initialCount, 10);
  assert.equal(st.withdrawn, 3);
  assert.equal(st.retentionRate, 0.7);
  assert.equal(st.neverAttended, 1);
  assert.equal(st.retentionRateExclNeverAttended, 0.8);
});
