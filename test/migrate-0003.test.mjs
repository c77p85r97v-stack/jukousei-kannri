import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPgliteDb, migrate } from '../src/db.js';

test('migration turns old 出席・記録なし records into 記録なし', async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const [t] = await db.query(`insert into terms(name, active) values ('t', true) returning id`);
  const [sl] = await db.query(`insert into slots(term_id, code, sort) values ($1,'月',0) returning id`, [t.id]);
  const [ga] = await db.query(`insert into staff(name, role) values ('A','ga') returning id`);
  const [g] = await db.query('insert into groups(slot_id, ga_id) values ($1,$2) returning id', [sl.id, ga.id]);
  const [st] = await db.query(`insert into students(term_id, name, group_id) values ($1,'x',$2) returning id`, [t.id, g.id]);
  await db.query(`insert into records(student_id, round, attendance) values ($1,1,'出席・記録なし')`, [st.id]);
  await db.exec(readFileSync(new URL('../migrations/0003_attendance_labels.sql', import.meta.url), 'utf8'));
  const [r] = await db.query('select attendance from records where student_id=$1', [st.id]);
  assert.equal(r.attendance, '記録なし');
});
