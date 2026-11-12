import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

const T = (...cols) => cols.join('\t');

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const c = await loginAdmin(env, f);
  const preview = text => call(env, 'POST', '/api/admin/import/preview', { termId: f.term.id, text }, c);
  const commit = (text, requestId = 'r-' + Math.random()) => call(env, 'POST', '/api/admin/import/commit', { termId: f.term.id, text, requestId }, c);
  return { env, f, c, preview, commit };
}

test('header row and blank lines are ignored', async () => {
  const { preview } = await setup();
  const text = [T('コマ', 'GA', '名前', 'ヨミ', 'ニックネーム'), '', T('月', 'A', '佐々木 七', 'ササキ ナナ', 'なな'), '   ', ''].join('\n');
  const r = await preview(text);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 1);
  assert.deepEqual(r.body.errors, []);
  assert.equal(r.body.rows[0].line, 3);
});

test('full-width spaces and trailing tabs are normalized', async () => {
  const { preview } = await setup();
  const r = await preview(T('火１', 'C', '山田　太郎', 'ヤマダ タロウ', 'たろう', '', '') + '\r\n');
  const row = r.body.rows[0];
  assert.equal(row.slotCode, '火1');
  assert.equal(row.name, '山田 太郎');
  assert.equal(row.newGa, false);
  assert.equal(row.newGroup, false);
});

test('unknown slot is reported with line number', async () => {
  const { preview } = await setup();
  const r = await preview([T('月', 'A', '佐々木 七'), T('土', 'A', '高橋 八')].join('\n'));
  assert.deepEqual(r.body.errors, [{ line: 2, reason: 'コマ「土」が見つかりません' }]);
});

test('missing name or GA is an error', async () => {
  const { preview } = await setup();
  const r = await preview([T('月', 'A', ''), T('月', '', '高橋 八')].join('\n'));
  assert.deepEqual(
    r.body.errors.map(e => e.line),
    [1, 2],
  );
});

test('fewer columns are fine if name exists', async () => {
  const { preview } = await setup();
  const r = await preview(T('月', 'A', '佐々木 七'));
  assert.equal(r.body.rows[0].kana, null);
  assert.equal(r.body.rows[0].nickname, null);
});

test('admin name as GA is an error', async () => {
  const { preview } = await setup();
  const r = await preview(T('月', '管理者', '佐々木 七'));
  assert.match(r.body.errors[0].reason, /管理者/);
});

test('duplicate within paste and against existing are flagged and skipped on commit', async () => {
  const { env, f, preview, commit } = await setup();
  const text = [T('月', 'A', '佐々木 七', 'ササキ ナナ'), T('月', 'A', '佐々木 七', 'ササキ ナナ'), T('月', 'A', '青木 一', 'アオキ ハジメ')].join('\n');
  const p = await preview(text);
  assert.deepEqual(p.body.rows.map(r => r.duplicate), [false, true, true]);
  assert.equal(p.body.summary.duplicates, 2);
  const c = await commit(text);
  assert.equal(c.status, 200);
  assert.equal(c.body.imported, 1);
  const [{ n }] = await env.db.query('select count(*)::int as n from students where term_id=$1', [f.term.id]);
  assert.equal(n, 7);
});

test('commit creates missing GA and group', async () => {
  const { env, f, preview, commit } = await setup();
  const text = T('水2', 'たくゆき', '鈴木 九', 'スズキ キュウ', 'きゅう');
  const p = await preview(text);
  assert.equal(p.body.rows[0].newGa, true);
  assert.equal(p.body.rows[0].newGroup, true);
  assert.equal(p.body.summary.newGa, 1);
  const c = await commit(text);
  assert.equal(c.status, 200);
  const [g] = await env.db.query(
    `select st.name as ga, s.code from students x join groups g on g.id=x.group_id join slots s on s.id=g.slot_id join staff st on st.id=g.ga_id where x.name='鈴木 九'`,
  );
  assert.deepEqual(g, { ga: 'たくゆき', code: '水2' });
  const [ga] = await env.db.query(`select role from staff where name='たくゆき'`);
  assert.equal(ga.role, 'ga');
  assert.ok(f);
});

test('commit with errors writes nothing', async () => {
  const { env, commit } = await setup();
  const r = await commit([T('月', 'A', '佐々木 七'), T('土', 'A', '高橋 八')].join('\n'));
  assert.equal(r.status, 400);
  const [{ n }] = await env.db.query('select count(*)::int as n from students');
  assert.equal(n, 6);
});

test('same requestId twice imports once', async () => {
  const { env, commit } = await setup();
  const text = T('月', 'A', '佐々木 七');
  const a = await commit(text, 'same');
  const b = await commit(text, 'same');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body, a.body);
  const [{ n }] = await env.db.query('select count(*)::int as n from students');
  assert.equal(n, 7);
});
