import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPgliteDb } from '../src/db.js';

// 0001〜0003 だけ当てた古いデータベースに 0004 を当てる
test('migration 0004 allows 補講済み and marks finished makeups as 補講済み', async () => {
  const db = await createPgliteDb();
  for (const f of ['0001_init.sql', '0002_round0_indiv.sql', '0003_attendance_labels.sql']) await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  const [t] = await db.query(`insert into terms(name, active) values ('t', true) returning id`);
  const [sl] = await db.query(`insert into slots(term_id, code, sort) values ($1,'月',0) returning id`, [t.id]);
  const [ga] = await db.query(`insert into staff(name, role) values ('A','ga') returning id`);
  const [g] = await db.query('insert into groups(slot_id, ga_id) values ($1,$2) returning id', [sl.id, ga.id]);
  const st = [];
  for (const n of ['x', 'y', 'z']) st.push((await db.query(`insert into students(term_id, name, group_id) values ($1,$2,$3) returning id`, [t.id, n, g.id]))[0].id);
  await db.query(`insert into records(student_id, round, attendance, typing) values ($1,2,'出席',100), ($2,2,'出席',100), ($3,2,'欠席・補講できず',null)`, st);
  await db.query(`insert into makeups(student_id, round, place) values ($1,2,'個別')`, [st[0]]);
  await db.query(`insert into makeups(student_id, round, place, failed) values ($1,2,'個別',true)`, [st[2]]);
  await db.exec(readFileSync(new URL('../migrations/0004_makeup_done.sql', import.meta.url), 'utf8'));
  const rows = await db.query('select student_id, attendance from records order by student_id');
  assert.deepEqual(rows.map(r => r.attendance), ['欠席・補講済み', '出席', '欠席・補講できず']);
  await db.query(`update records set attendance='欠席・補講済み' where student_id=$1`, [st[1]]);
});
