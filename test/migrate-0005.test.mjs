import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPgliteDb } from '../src/db.js';

test('migration 0005 repairs attendance that contradicts the makeup', async () => {
  const db = await createPgliteDb();
  for (const f of ['0001_init.sql', '0002_round0_indiv.sql', '0003_attendance_labels.sql', '0004_makeup_done.sql']) await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  const [t] = await db.query(`insert into terms(name, active) values ('t', true) returning id`);
  const [sl] = await db.query(`insert into slots(term_id, code, sort) values ($1,'月',0) returning id`, [t.id]);
  const [ga] = await db.query(`insert into staff(name, role) values ('A','ga') returning id`);
  const [g] = await db.query('insert into groups(slot_id, ga_id) values ($1,$2) returning id', [sl.id, ga.id]);
  const st = [];
  for (const n of ['a', 'b', 'c', 'd', 'e']) st.push((await db.query(`insert into students(term_id, name, group_id) values ($1,$2,$3) returning id`, [t.id, n, g.id]))[0].id);
  // a: 補講予定なのに当日欠席 / b: できずなのに△ / c: 補講済みなのに failed / d: 補講だけあって記録なし / e: 補講なしの当日欠席（そのまま）
  await db.query(`insert into records(student_id, round, attendance) values ($1,2,'欠席'), ($2,2,'欠席・補講予定'), ($3,2,'欠席・補講済み'), ($4,2,'欠席')`, [st[0], st[1], st[2], st[4]]);
  await db.query(`insert into makeups(student_id, round, place, failed) values ($1,2,'未定',false), ($2,2,'未定',true), ($3,2,'個別',true), ($4,2,'未定',false)`, [st[0], st[1], st[2], st[3]]);
  await db.exec(readFileSync(new URL('../migrations/0005_makeup_consistency.sql', import.meta.url), 'utf8'));
  const att = async id => (await db.query('select attendance from records where student_id=$1 and round=2', [id]))[0]?.attendance;
  assert.equal(await att(st[0]), '欠席・補講予定');
  assert.equal(await att(st[1]), '欠席・補講できず');
  assert.equal(await att(st[2]), '欠席・補講済み');
  assert.equal((await db.query('select failed from makeups where student_id=$1', [st[2]]))[0].failed, false);
  assert.equal(await att(st[3]), '欠席・補講予定');
  assert.equal(await att(st[4]), '欠席');
});
