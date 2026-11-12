import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const ga = await loginGa(env, f.ga.A.id);
  const admin = await loginAdmin(env, f);
  const s = name => f.students.find(x => x.name.startsWith(name));
  return { env, f, ga, admin, s };
}

test('search matches kana, name and nickname partially', async () => {
  const { env, ga } = await setup();
  const byKana = await call(env, 'GET', `/api/students/search?q=${encodeURIComponent('ウエ')}`, undefined, ga);
  assert.deepEqual(byKana.body.map(x => x.name).sort(), ['上田 三', '井上 二'].sort());
  assert.equal(byKana.body[0].homeLabel.startsWith('月'), true);
  const byNick = await call(env, 'GET', `/api/students/search?q=${encodeURIComponent('ろく')}`, undefined, ga);
  assert.deepEqual(byNick.body.map(x => x.name), ['加藤 六']);
  const empty = await call(env, 'GET', '/api/students/search?q=', undefined, ga);
  assert.deepEqual(empty.body, []);
});

test('search treats % and _ literally', async () => {
  const { env, ga } = await setup();
  const r = await call(env, 'GET', `/api/students/search?q=${encodeURIComponent('%')}`, undefined, ga);
  assert.deepEqual(r.body, []);
});

test('history returns all parts', async () => {
  const { env, f, ga, admin, s } = await setup();
  const id = s('青木').id;
  await call(env, 'POST', '/api/records', { studentId: id, round: 1, typing: 150, version: 0 }, ga);
  await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, ga);
  await call(env, 'POST', '/api/admin/transfers', { studentId: id, toGroupId: f.groups['月B'].id, fromRound: 5 }, admin);
  await call(env, 'POST', '/api/admin/withdrawals', { studentId: id, fromRound: 7, reason: '多忙' }, admin);
  const r = await call(env, 'GET', `/api/students/${id}/history`, undefined, ga);
  assert.equal(r.status, 200);
  assert.equal(r.body.student.name, '青木 一');
  assert.equal(r.body.student.homeLabel, '月 B'); // 最新（最後の回時点）の班
  assert.equal(r.body.records.length, 2);
  assert.equal(r.body.records.find(x => x.round === 1).typing, 150);
  assert.equal(r.body.makeups[0].hostLabel, '火1 C');
  assert.equal(r.body.makeups[0].status, '予定');
  assert.equal(r.body.transfers[0].toLabel, '月 B');
  assert.equal(r.body.withdrawal.fromRound, 7);
  assert.equal((await call(env, 'GET', '/api/students/99999/history', undefined, ga)).status, 404);
});

test('audit pagination by beforeId and filters', async () => {
  const { env, f, ga, admin, s } = await setup();
  for (let i = 1; i <= 3; i++) await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: i, typing: 100 + i, version: 0 }, ga);
  const p1 = await call(env, 'GET', '/api/admin/audit?limit=2', undefined, admin);
  assert.equal(p1.body.length, 2);
  assert.ok(p1.body[0].id > p1.body[1].id);
  assert.equal(p1.body[0].operatorName, 'A');
  const p2 = await call(env, 'GET', `/api/admin/audit?limit=2&beforeId=${p1.body[1].id}`, undefined, admin);
  assert.equal(p2.body.length, 1);
  const byOp = await call(env, 'GET', `/api/admin/audit?operatorId=${f.admin.id}`, undefined, admin);
  assert.equal(byOp.body.length, 0);
  const byAction = await call(env, 'GET', `/api/admin/audit?action=${encodeURIComponent('記録の保存')}`, undefined, admin);
  assert.equal(byAction.body.length, 3);
});

test('GA cannot read audit → 403', async () => {
  const { env, ga } = await setup();
  assert.equal((await call(env, 'GET', '/api/admin/audit', undefined, ga)).status, 403);
});

test('records.csv starts with BOM and has 5 + 4×9 columns', async () => {
  const { env, f, ga, s } = await setup();
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 1, typing: 150.5, note: 'a,b', version: 0 }, ga);
  const r = await call(env, 'GET', `/api/export/records.csv?termId=${f.term.id}`, undefined, ga);
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('Content-Type'), /text\/csv/);
  assert.equal(r.text.charCodeAt(0), 0xfeff);
  const lines = r.text.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[0].split(',').length, 5 + 4 * 9);
  assert.ok(lines[0].startsWith('コマ,GA,名前,ヨミ,ニックネーム,第0回出欠,第0回タイピング,第0回クイズ,第0回メモ,第1回出欠'));
  const aoki = lines.find(l => l.includes('青木 一'));
  assert.ok(aoki.includes('出席,150.5,,"a,b"'));
});

test('roster.csv lists members and guests for a round', async () => {
  const { env, f, ga, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('江藤').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, ga);
  const r = await call(env, 'GET', `/api/export/roster.csv?termId=${f.term.id}&round=2`, undefined, ga);
  const lines = r.text.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 1 + 6 + 1);
  assert.ok(lines.some(l => l.startsWith('火1,C,補講で来る人,江藤 四')));
});

test('stats.csv contains retention', async () => {
  const { env, f, ga } = await setup();
  const r = await call(env, 'GET', `/api/export/stats.csv?termId=${f.term.id}`, undefined, ga);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('継続率,100.0%'));
});

test('export requires login', async () => {
  const { env, f } = await setup();
  assert.equal((await call(env, 'GET', `/api/export/records.csv?termId=${f.term.id}`)).status, 401);
});

test('CSV cells that look like formulas are neutralised', async () => {
  const { env, f, ga, s } = await setup();
  await call(env, 'POST', '/api/records', { studentId: s('青木').id, round: 1, typing: 150, note: '=HYPERLINK("http://x","y")', version: 0 }, ga);
  await call(env, 'POST', '/api/records', { studentId: s('井上').id, round: 1, typing: 150, note: '+1 @x', version: 0 }, ga);
  const r = await call(env, 'GET', `/api/export/records.csv?termId=${f.term.id}`, undefined, ga);
  assert.ok(r.text.includes(`"'=HYPERLINK(""http://x"",""y"")"`), r.text.split('\r\n')[1]);
  assert.ok(r.text.includes(`,'+1 @x,`));
  assert.ok(r.text.includes(',150,'));
});
