import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed } from './helpers.mjs';
import { rosterFor, isEnrolled } from '../src/domain/roster.js';

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const roster = (code, round) => rosterFor(env.db, { termId: f.term.id, slotId: f.slots[code].id, round });
  const names = (groups, key, field = 'members') => groups.find(g => g.gaName === key)[field].map(m => m.name.split(' ')[0]);
  return { env, f, s, roster, names };
}

test('members are students whose current group is this group', async () => {
  const { roster, names } = await setup();
  const g = await roster('月', 1);
  assert.deepEqual(g.map(x => x.gaName), ['A', 'B']);
  assert.deepEqual(names(g, 'A'), ['青木', '井上', '上田']);
  assert.deepEqual(names(g, 'B'), ['江藤', '小川']);
  assert.equal(g[0].members[0].homeLabel, '月 A');
});

test('transfer from round 5 moves student only for rounds >= 5', async () => {
  const { env, f, s, roster, names } = await setup();
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round) values ($1,$2,$3,5)', [s('青木').id, f.groups['月A'].id, f.groups['火1C'].id]);
  assert.deepEqual(names(await roster('月', 4), 'A'), ['青木', '井上', '上田']);
  assert.deepEqual(names(await roster('月', 5), 'A'), ['井上', '上田']);
  assert.deepEqual(names(await roster('火1', 5), 'C'), ['青木', '加藤']);
  assert.deepEqual(names(await roster('火1', 4), 'C'), ['加藤']);
});

test('latest transfer wins and cancelled transfer is ignored', async () => {
  const { env, f, s, roster, names } = await setup();
  const id = s('青木').id;
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round) values ($1,$2,$3,2)', [id, f.groups['月A'].id, f.groups['月B'].id]);
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round, cancelled_at) values ($1,$2,$3,3, now())', [id, f.groups['月B'].id, f.groups['火1C'].id]);
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round) values ($1,$2,$3,6)', [id, f.groups['月B'].id, f.groups['火1C'].id]);
  assert.deepEqual(names(await roster('月', 4), 'B'), ['青木', '江藤', '小川']);
  assert.deepEqual(names(await roster('火1', 4), 'C'), ['加藤']);
  assert.deepEqual(names(await roster('火1', 6), 'C'), ['青木', '加藤']);
});

test('withdrawal from round 4 removes student from round 4 onward only', async () => {
  const { env, s, roster, names } = await setup();
  await env.db.query('insert into withdrawals(student_id, from_round) values ($1, 4)', [s('井上').id]);
  assert.deepEqual(names(await roster('月', 3), 'A'), ['青木', '井上', '上田']);
  assert.deepEqual(names(await roster('月', 4), 'A'), ['青木', '上田']);
  assert.equal(await isEnrolled(env.db, s('井上').id, 3), true);
  assert.equal(await isEnrolled(env.db, s('井上').id, 4), false);
});

test('cancelled withdrawal is ignored', async () => {
  const { env, s, roster, names } = await setup();
  await env.db.query('insert into withdrawals(student_id, from_round, cancelled_at) values ($1, 4, now())', [s('井上').id]);
  assert.deepEqual(names(await roster('月', 5), 'A'), ['青木', '井上', '上田']);
});

test('guest appears in host roster with homeLabel and stays in home roster with hostLabel', async () => {
  const { env, f, s, roster, names } = await setup();
  await env.db.query(`insert into makeups(student_id, round, place, host_group_id) values ($1, 2, '他班', $2)`, [s('江藤').id, f.groups['火1C'].id]);
  const host = await roster('火1', 2);
  assert.deepEqual(names(host, 'C', 'guests'), ['江藤']);
  assert.equal(host[0].guests[0].homeLabel, '月 B');
  const home = await roster('月', 2);
  const m = home.find(g => g.gaName === 'B').members.find(x => x.name.startsWith('江藤'));
  assert.equal(m.makeup.place, '他班');
  assert.equal(m.makeup.hostLabel, '火1 C');
  assert.deepEqual(names(await roster('火1', 3), 'C', 'guests'), []);
});

test('failed makeup removes guest from host roster', async () => {
  const { env, f, s, roster, names } = await setup();
  await env.db.query(`insert into makeups(student_id, round, place, host_group_id, failed) values ($1, 2, '他班', $2, true)`, [s('江藤').id, f.groups['火1C'].id]);
  assert.deepEqual(names(await roster('火1', 2), 'C', 'guests'), []);
});

test('withdrawal after makeup registration removes the guest too', async () => {
  const { env, f, s, roster, names } = await setup();
  await env.db.query(`insert into makeups(student_id, round, place, host_group_id) values ($1, 4, '他班', $2)`, [s('江藤').id, f.groups['火1C'].id]);
  await env.db.query('insert into withdrawals(student_id, from_round) values ($1, 4)', [s('江藤').id]);
  assert.deepEqual(names(await roster('火1', 4), 'C', 'guests'), []);
});

test('transfer after makeup registration keeps guest as registered', async () => {
  const { env, f, s, roster, names } = await setup();
  await env.db.query(`insert into makeups(student_id, round, place, host_group_id) values ($1, 4, '他班', $2)`, [s('江藤').id, f.groups['火1C'].id]);
  await env.db.query('insert into transfers(student_id, from_group_id, to_group_id, from_round) values ($1,$2,$3,3)', [s('江藤').id, f.groups['月B'].id, f.groups['月A'].id]);
  const host = await roster('火1', 4);
  assert.deepEqual(names(host, 'C', 'guests'), ['江藤']);
  assert.equal(host[0].guests[0].homeLabel, '月 A');
});

test('records are attached to members and guests', async () => {
  const { env, f, s, roster } = await setup();
  await env.db.query(`insert into makeups(student_id, round, place, host_group_id) values ($1, 2, '他班', $2)`, [s('江藤').id, f.groups['火1C'].id]);
  await env.db.query(`insert into records(student_id, round, attendance, typing) values ($1, 2, '出席', 150.5)`, [s('江藤').id]);
  const host = await roster('火1', 2);
  assert.equal(host[0].guests[0].record.typing, 150.5);
  assert.equal(host[0].guests[0].record.version, 1);
  const home = await roster('月', 2);
  assert.equal(home.find(g => g.gaName === 'B').members[0].record.typing, 150.5);
  assert.equal(home.find(g => g.gaName === 'A').members[0].record, null);
});

test('slot with 60 students returns within 300ms on PGlite', async () => {
  const { env, f, roster } = await setup();
  await env.db.query(
    `insert into students(term_id, name, kana, nickname, group_id)
     select $1, '生徒' || i, 'セイト' || i, 'n' || i, case when i % 2 = 0 then $2::int else $3::int end from generate_series(1, 55) i`,
    [f.term.id, f.groups['月A'].id, f.groups['月B'].id],
  );
  await env.db.query(`insert into records(student_id, round, attendance, typing) select id, 3, '出席', 100 from students`);
  await roster('月', 3); // 準備運転
  const t0 = performance.now();
  const g = await roster('月', 3);
  const ms = performance.now() - t0;
  assert.equal(g[0].members.length + g[1].members.length, 60);
  assert.ok(ms < 300, `${ms}ms`);
});
