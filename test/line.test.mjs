import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, loginAdmin, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const rec = (name, round, attendance) => env.db.query('insert into records(student_id, round, attendance) values ($1,$2,$3)', [s(name).id, round, attendance]);
  return { env, f, a, s, rec };
}

test('daily report: own group, absentees in full katakana, ready to paste', async () => {
  const { env, f, a, s, rec } = await setup();
  await rec('青木', 2, '出席');
  await rec('井上', 2, '欠席');
  await rec('上田', 2, '欠席');
  await call(env, 'POST', '/api/makeups', { studentId: s('上田').id, round: 2, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, a);
  const r = await call(env, 'GET', `/api/line/daily?slotId=${f.slots['月'].id}&round=2`, undefined, a);
  assert.equal(r.status, 200);
  assert.equal(
    r.body.text,
    'お疲れ様です。Aです。\n月曜 第2回の受講生管理が終わりました。\n欠席者2名です。\n・イノウエ ジさん（補講未定）\n・ウエダ サンさん（補講：火1 C班）\nシステム入力済みです。',
  );
  assert.equal(r.body.unentered, 0);
});

test('daily report with no absentees and a count of rows not yet entered', async () => {
  const { env, f, a, rec } = await setup();
  await rec('青木', 3, '出席');
  const r = await call(env, 'GET', `/api/line/daily?slotId=${f.slots['月'].id}&round=3`, undefined, a);
  assert.equal(r.body.text, 'お疲れ様です。Aです。\n月曜 第3回の受講生管理が終わりました。\n欠席者はいません。\nシステム入力済みです。');
  assert.equal(r.body.unentered, 2);
});

test('daily report needs your own group in that slot', async () => {
  const { env, f, a } = await setup();
  const r = await call(env, 'GET', `/api/line/daily?slotId=${f.slots['火1'].id}&round=2`, undefined, a);
  assert.equal(r.status, 404);
});

test('makeup decided message for 個別 uses the slot label', async () => {
  const { env, a, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('青木').id, round: 4, place: '個別', indivNo: 2, version: 0 }, a);
  const r = await call(env, 'GET', `/api/line/makeup?studentId=${s('青木').id}&round=4`, undefined, a);
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'お疲れ様です。Aです。\n月曜 A班のアオキ ハジメさん（第4回欠席）の補講が、個別補講②木曜 13:00に決まりました。\nシステム入力済みです。');
});

test('makeup message is refused while the place is 未定', async () => {
  const { env, a, s } = await setup();
  await call(env, 'POST', '/api/makeups', { studentId: s('青木').id, round: 4, place: '未定', version: 0 }, a);
  const r = await call(env, 'GET', `/api/line/makeup?studentId=${s('青木').id}&round=4`, undefined, a);
  assert.equal(r.status, 400);
});

test('曜日変更 report follows the manual template with full katakana name', async () => {
  const { env, f, s } = await setup();
  const ad = await loginAdmin(env, f);
  const t = await call(env, 'POST', '/api/admin/transfers', { studentId: s('青木').id, toGroupId: f.groups['火1C'].id, fromRound: 3 }, ad);
  const a = await loginGa(env, f.ga.A.id);
  const r = await call(env, 'GET', `/api/line/transfer?id=${t.body.id}`, undefined, a);
  assert.equal(r.status, 200);
  assert.equal(
    r.body.text,
    'お疲れ様です。Aです。\n月曜 A班のアオキ ハジメさんが曜日移動を希望されたため、第3回から火1 C班に移動を行いました。受講生管理に記入済みですので、確認お願いします。また、移動先GAとアオキ ハジメさんには連絡済みです。',
  );
});

test('no 解約 report is offered', async () => {
  const { env, a } = await setup();
  assert.equal((await call(env, 'GET', '/api/line/withdrawal?id=1', undefined, a)).status, 404);
});

test('line texts need login', async () => {
  const { env, f } = await setup();
  assert.equal((await call(env, 'GET', `/api/line/daily?slotId=${f.slots['月'].id}&round=2`)).status, 401);
});

test('daily report lists someone who already did the makeup as 補講済み', async () => {
  const { env, f, a, s, rec } = await setup();
  await rec('青木', 4, '出席');
  await rec('上田', 4, '出席');
  await call(env, 'POST', '/api/makeups', { studentId: s('井上').id, round: 4, place: '他班', hostGroupId: f.groups['火1C'].id, version: 0 }, a);
  const [cur] = await env.db.query('select version from records where student_id=$1 and round=4', [s('井上').id]);
  await call(env, 'POST', '/api/records', { studentId: s('井上').id, round: 4, typing: 140, version: cur.version }, a);
  const r = await call(env, 'GET', `/api/line/daily?slotId=${f.slots['月'].id}&round=4`, undefined, a);
  assert.match(r.body.text, /欠席者1名です。\n・イノウエ ジさん（補講済み：火1 C班）/);
});
