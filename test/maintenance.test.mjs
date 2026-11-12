import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, memoryBlob, closeEnv } from './helpers.mjs';

after(closeEnv);
import { dumpAll } from '../src/routes/maintenance.js';

async function setup() {
  const env = await newEnv({ blob: memoryBlob() });
  const f = await seed(env);
  const admin = await loginAdmin(env, f);
  const ga = await loginGa(env, f.ga.A.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  // 記録・補講・解約・移動を1件ずつ入れておく
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 1, typing: 150.5, note: 'メモ', version: 0 }, ga);
  await call(env, 'POST', '/api/makeups', { studentId: s('井上').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, ga);
  await call(env, 'POST', '/api/admin/withdrawals', { studentId: s('上田').id, fromRound: 4 }, admin);
  await call(env, 'POST', '/api/admin/transfers', { studentId: s('江藤').id, toGroupId: f.groups['月A'].id, fromRound: 3 }, admin);
  const count = async t => (await env.db.query(`select count(*)::int as n from ${t}`))[0].n;
  const strip = d => ({ ...d, at: null, tables: { ...d.tables, audit_log: [] } });
  return { env, f, admin, ga, s, count, strip };
}

test('backup then restore yields identical dump', async () => {
  const { env, admin, ga, s, strip } = await setup();
  const before = await dumpAll(env.db);
  const b = await call(env, 'POST', '/api/admin/backups', {}, admin);
  assert.equal(b.status, 200);
  assert.equal(b.body.kind, '手動');
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 1, typing: 99, version: 1 }, ga);
  await call(env, 'POST', '/api/records', { studentId: s('小川').id, round: 1, typing: 77, version: 0 }, ga);
  const r = await call(env, 'POST', '/api/admin/backups/restore', { key: b.body.key, confirm: '復元' }, admin);
  assert.equal(r.status, 200);
  const after = await dumpAll(env.db);
  assert.deepEqual(strip(after), strip(before));
  // 復元後も新しい行を追加できる（連番がずれていない）
  const again = await call(env, 'POST', '/api/records', { studentId: s('小川').id, round: 1, typing: 77, version: 0 }, ga);
  assert.equal(again.status, 200);
});

test('restore takes a 復元前 backup first and needs confirm text', async () => {
  const { env, admin } = await setup();
  const b = await call(env, 'POST', '/api/admin/backups', {}, admin);
  assert.equal((await call(env, 'POST', '/api/admin/backups/restore', { key: b.body.key }, admin)).status, 400);
  await call(env, 'POST', '/api/admin/backups/restore', { key: b.body.key, confirm: '復元' }, admin);
  const list = await call(env, 'GET', '/api/admin/backups', undefined, admin);
  assert.deepEqual(list.body.map(x => x.kind).sort(), ['復元前', '手動'].sort());
  assert.ok(list.body[0].at >= list.body[1].at);
});

test('restore with unknown or foreign key → 404', async () => {
  const { env, admin } = await setup();
  assert.equal((await call(env, 'POST', '/api/admin/backups/restore', { key: 'backups/none.json', confirm: '復元' }, admin)).status, 404);
  assert.equal((await call(env, 'POST', '/api/admin/backups/restore', { key: '../secret', confirm: '復元' }, admin)).status, 404);
});

test('download returns the dump JSON', async () => {
  const { env, admin } = await setup();
  const b = await call(env, 'POST', '/api/admin/backups', {}, admin);
  const d = await call(env, 'GET', `/api/admin/backups/download?key=${encodeURIComponent(b.body.key)}`, undefined, admin);
  assert.equal(d.status, 200);
  assert.equal(d.body.version, 1);
  assert.equal(d.body.tables.students.length, 6);
});

test('reset without confirm text → 400 and nothing is deleted', async () => {
  const { env, admin, count } = await setup();
  assert.equal((await call(env, 'POST', '/api/admin/reset', { confirm: 'はい' }, admin)).status, 400);
  assert.equal(await count('records'), 2);
});

test('reset preview shows counts', async () => {
  const { env, admin } = await setup();
  const p = await call(env, 'GET', '/api/admin/reset', undefined, admin);
  assert.equal(p.body.records, 2);
  assert.equal(p.body.makeups, 1);
  assert.equal(p.body.withdrawals, 1);
  assert.equal(p.body.transfers, 1);
  assert.equal(p.body.students, 6);
});

test('reset keeps staff, terms, slots, groups, students; clears records, makeups, withdrawals, transfers', async () => {
  const { env, admin, count } = await setup();
  const r = await call(env, 'POST', '/api/admin/reset', { confirm: '初期化' }, admin);
  assert.equal(r.status, 200);
  for (const t of ['records', 'makeups', 'withdrawals', 'transfers']) assert.equal(await count(t), 0, t);
  assert.equal(await count('students'), 6);
  assert.equal(await count('groups'), 3);
  assert.equal(await count('staff'), 4);
  assert.equal(await count('slots'), 9);
  assert.equal(await count('terms'), 1);
  const logs = await env.db.query('select action from audit_log');
  assert.deepEqual(logs.map(l => l.action), ['初期化']);
  assert.equal((await call(env, 'GET', '/api/admin/me', undefined, admin)).status, 200);
});

test('reset with includeRoster clears students and groups too', async () => {
  const { env, admin, count } = await setup();
  await call(env, 'POST', '/api/admin/reset', { confirm: '初期化', includeRoster: true }, admin);
  assert.equal(await count('students'), 0);
  assert.equal(await count('groups'), 0);
  assert.equal(await count('staff'), 4);
  assert.equal(await count('slots'), 9);
});

test('reset can be undone by restoring 初期化前 backup', async () => {
  const { env, admin, count } = await setup();
  await call(env, 'POST', '/api/admin/reset', { confirm: '初期化', includeRoster: true }, admin);
  const list = await call(env, 'GET', '/api/admin/backups', undefined, admin);
  const pre = list.body.find(x => x.kind === '初期化前');
  assert.ok(pre);
  const r = await call(env, 'POST', '/api/admin/backups/restore', { key: pre.key, confirm: '復元' }, admin);
  assert.equal(r.status, 200);
  assert.equal(await count('students'), 6);
  assert.equal(await count('records'), 2);
  assert.equal(await count('makeups'), 1);
});

test('GA cannot backup, restore or reset', async () => {
  const { env, ga } = await setup();
  assert.equal((await call(env, 'POST', '/api/admin/backups', {}, ga)).status, 403);
  assert.equal((await call(env, 'POST', '/api/admin/reset', { confirm: '初期化' }, ga)).status, 403);
  assert.equal((await call(env, 'GET', '/api/admin/backups', undefined, ga)).status, 403);
});

test('cron without secret → 401', async () => {
  const { env } = await setup();
  assert.equal((await call(env, 'GET', '/api/cron/backup')).status, 401);
});

test('cron makes 自動 backup and deletes 自動 backups older than 30 days only', async () => {
  const { env, admin } = await setup();
  const manual = await call(env, 'POST', '/api/admin/backups', {}, admin);
  const { handle } = await import('../src/app.js');
  const cron = () => handle(new Request('http://localhost/api/cron/backup', { headers: { Authorization: 'Bearer cron-secret' } }), env);
  assert.equal((await cron()).status, 200);
  const old = new Date(Date.now() - 31 * 24 * 3600e3);
  for (const v of env.blob._store.values()) v.uploadedAt = old; // 手動も自動も31日前にする
  assert.equal((await cron()).status, 200);
  const list = await call(env, 'GET', '/api/admin/backups', undefined, admin);
  assert.deepEqual(list.body.map(x => x.kind).sort(), ['手動', '自動'].sort());
  assert.ok(list.body.some(x => x.key === manual.body.key));
});

test('dumpAll reads every table inside one read-only snapshot transaction', async () => {
  const { env } = await setup();
  const seen = [];
  const spy = {
    query: () => {
      throw new Error('dumpAll must not query outside the transaction');
    },
    tx: fn =>
      env.db.tx(t =>
        fn({
          ...t,
          query: (sql, p) => (seen.push(sql), t.query(sql, p)),
          exec: sql => (seen.push(sql), t.exec(sql)),
        }),
      ),
  };
  const dump = await dumpAll(spy);
  assert.equal(dump.tables.students.length, 6);
  assert.match(seen[0], /repeatable read/i);
});
