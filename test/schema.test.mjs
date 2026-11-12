import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDb, migrate } from '../src/db.js';
import { newEnv, seed } from './helpers.mjs';

async function freshDb() {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

test('migrate twice is idempotent', async () => {
  const db = await createPgliteDb();
  await migrate(db);
  await migrate(db);
  const rows = await db.query('select count(*)::int as n from schema_migrations');
  assert.ok(rows[0].n >= 1);
});

test('tx rolls back on throw', async () => {
  const db = await freshDb();
  await assert.rejects(
    db.tx(async t => {
      await t.query(`insert into staff(name, role) values ('X', 'ga')`);
      throw new Error('boom');
    }),
    /boom/,
  );
  const rows = await db.query('select count(*)::int as n from staff');
  assert.equal(rows[0].n, 0);
});

test('records rejects negative typing', async () => {
  const env = await newEnv();
  const f = await seed(env);
  await assert.rejects(env.db.query('insert into records(student_id, round, typing) values ($1, 1, -1)', [f.students[0].id]));
});

test('records rejects unknown attendance', async () => {
  const env = await newEnv();
  const f = await seed(env);
  await assert.rejects(env.db.query(`insert into records(student_id, round, attendance) values ($1, 1, '補講')`, [f.students[0].id]));
});

test('makeup 他班 requires host', async () => {
  const env = await newEnv();
  const f = await seed(env);
  await assert.rejects(env.db.query(`insert into makeups(student_id, round, place) values ($1, 1, '他班')`, [f.students[0].id]));
});

test('only one active term', async () => {
  const db = await freshDb();
  await db.query(`insert into terms(name, active) values ('a', true)`);
  await assert.rejects(db.query(`insert into terms(name, active) values ('b', true)`));
});

test('seed builds fixture', async () => {
  const env = await newEnv();
  const f = await seed(env);
  const slots = await env.db.query('select count(*)::int as n from slots');
  const students = await env.db.query('select count(*)::int as n from students');
  assert.equal(slots[0].n, 9);
  assert.equal(students[0].n, 6);
  assert.equal(f.ga.A.name, 'A');
});
