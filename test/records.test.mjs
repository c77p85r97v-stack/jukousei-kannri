import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newEnv, seed, call, loginGa, closeEnv } from './helpers.mjs';

after(closeEnv);

async function setup() {
  const env = await newEnv();
  const f = await seed(env);
  const a = await loginGa(env, f.ga.A.id);
  const b = await loginGa(env, f.ga.B.id);
  const s = name => f.students.find(x => x.name.startsWith(name));
  const save = (cookie, body) => call(env, 'POST', '/api/records', { version: 0, ...body }, cookie);
  return { env, f, a, b, s, save };
}

test('save creates record with version 1 and audit', async () => {
  const { env, s, a, save } = await setup();
  const r = await save(a, { studentId: s('青木').id, round: 1, typing: 145.2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.version, 1);
  assert.equal(r.body.record.typing, 145.2);
  const [log] = await env.db.query(`select * from audit_log where target_table='records'`);
  assert.equal(log.after_json.typing, 145.2);
});

test('save with stale version → 409 with latest (two GAs at once)', async () => {
  const { s, a, b, save } = await setup();
  const id = s('青木').id;
  const first = await save(a, { studentId: id, round: 2, typing: 150 });
  const [x, y] = await Promise.all([
    save(a, { studentId: id, round: 2, typing: 140, version: first.body.record.version }),
    save(b, { studentId: id, round: 2, typing: 130, version: first.body.record.version }),
  ]);
  const statuses = [x.status, y.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = x.status === 409 ? x : y;
  const winner = x.status === 200 ? x : y;
  assert.equal(loser.body.error, 'ほかの人が先に更新しました');
  assert.equal(loser.body.latest.typing, winner.body.record.typing);
  assert.equal(loser.body.latest.version, 2);
});

test('creating when someone already created → 409', async () => {
  const { s, a, b, save } = await setup();
  await save(a, { studentId: s('青木').id, round: 2, typing: 150 });
  const r = await save(b, { studentId: s('青木').id, round: 2, typing: 120, version: 0 });
  assert.equal(r.status, 409);
});

test('typing on round 0 → 400, quiz on round 3 → 400, round outside term → 400', async () => {
  const { s, a, save } = await setup();
  assert.equal((await save(a, { studentId: s('青木').id, round: 0, typing: 100 })).status, 400);
  assert.equal((await save(a, { studentId: s('青木').id, round: 3, quiz: 10 })).status, 400);
  assert.equal((await save(a, { studentId: s('青木').id, round: 9, attendance: '出席' })).status, 400);
  assert.equal((await save(a, { studentId: s('青木').id, round: 1, quiz: 12, attendance: '出席' })).status, 200);
});

test('full-width typing is accepted', async () => {
  const { s, a, save } = await setup();
  const r = await save(a, { studentId: s('青木').id, round: 1, typing: '１４５．２' });
  assert.equal(r.body.record.typing, 145.2);
});

test('text in typing → 400 with guidance', async () => {
  const { s, a, save } = await setup();
  const r = await save(a, { studentId: s('青木').id, round: 1, typing: '記録なし' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /出欠で「記録なし」「時間切れ」を選んでください/);
});

test('typing auto-sets 出席 but keeps explicit attendance', async () => {
  const { s, a, save } = await setup();
  const r1 = await save(a, { studentId: s('青木').id, round: 1, typing: 120 });
  assert.equal(r1.body.record.attendance, '出席');
  const r2 = await save(a, { studentId: s('井上').id, round: 1, attendance: '記録なし' });
  assert.equal(r2.body.record.attendance, '記録なし');
  assert.equal(r2.body.record.typing, null);
});

test('the old 〇 (出席・記録なし) is no longer a choice; 記録なし and 時間切れ are', async () => {
  const { s, a, save } = await setup();
  assert.equal((await save(a, { studentId: s('青木').id, round: 2, attendance: '出席・記録なし' })).status, 400);
  assert.equal((await save(a, { studentId: s('青木').id, round: 2, attendance: '時間切れ' })).status, 200);
});

test('partial save keeps other fields', async () => {
  const { s, a, save } = await setup();
  const r1 = await save(a, { studentId: s('青木').id, round: 1, typing: 120, note: 'メモ' });
  const r2 = await save(a, { studentId: s('青木').id, round: 1, note: '変更', version: r1.body.record.version });
  assert.equal(r2.body.record.typing, 120);
  assert.equal(r2.body.record.note, '変更');
  const r3 = await save(a, { studentId: s('青木').id, round: 1, typing: '', version: r2.body.record.version });
  assert.equal(r3.body.record.typing, null);
});

test('cannot set 欠席・補講予定 directly', async () => {
  const { s, a, save } = await setup();
  assert.equal((await save(a, { studentId: s('青木').id, round: 1, attendance: '欠席・補講予定' })).status, 400);
  assert.equal((await save(a, { studentId: s('青木').id, round: 1, attendance: '欠席・補講できず' })).status, 400);
  assert.equal((await save(a, { studentId: s('青木').id, round: 1, attendance: '欠席' })).status, 200);
});

test('withdrawn round → 409', async () => {
  const { env, s, a, save } = await setup();
  await env.db.query('insert into withdrawals(student_id, from_round) values ($1, 3)', [s('青木').id]);
  const r = await save(a, { studentId: s('青木').id, round: 3, attendance: '出席' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'この受講生はこの回は解約済みです');
});

test('requestId replay does not bump version', async () => {
  const { s, a, save } = await setup();
  const r1 = await save(a, { studentId: s('青木').id, round: 1, typing: 120, requestId: 'x1' });
  const r2 = await save(a, { studentId: s('青木').id, round: 1, typing: 120, requestId: 'x1' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.record.version, r1.body.record.version);
});

test('roster API shape and own group first', async () => {
  const { env, f, b } = await setup();
  const r = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=1`, undefined, b);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.groups.map(g => g.gaName), ['B', 'A']);
  assert.equal(r.body.isTypingRound, true);
  assert.equal(r.body.isQuizRound, true);
  assert.equal(r.body.slot.code, '月');
  const r0 = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=0`, undefined, b);
  assert.equal(r0.body.isTypingRound, false);
  assert.equal(r0.body.isQuizRound, false);
});

test('roster requires login', async () => {
  const { env, f } = await setup();
  const r = await call(env, 'GET', `/api/roster?slotId=${f.slots['月'].id}&round=1`);
  assert.equal(r.status, 401);
});

test('missing or non-numeric ids → 400 not 500', async () => {
  const { env, a, save } = await setup();
  assert.equal((await save(a, { round: 1, typing: 100 })).status, 400);
  assert.equal((await save(a, { studentId: 'x', round: 1 })).status, 400);
  assert.equal((await call(env, 'POST', '/api/makeups', { studentId: 'x', round: 1, place: '未定' }, a)).status, 400);
  assert.equal((await call(env, 'GET', '/api/roster?slotId=abc&round=1', undefined, a)).status, 400);
});

test('typing does not turn 当日欠席 into 出席', async () => {
  const { s, a, save } = await setup();
  const id = s('青木').id;
  const first = await save(a, { studentId: id, round: 2, attendance: '欠席' });
  const r = await save(a, { studentId: id, round: 2, typing: 120, version: first.body.record.version });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席');
  assert.equal(r.body.record.typing, 120);
});

test('typing does not turn × (補講できず) into 出席', async () => {
  const { env, s, a, save } = await setup();
  const id = s('青木').id;
  await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '未定', version: 0 }, a);
  await call(env, 'POST', '/api/makeups/fail', { studentId: id, round: 2, version: 1 }, a);
  const [cur] = await env.db.query('select version from records where student_id=$1 and round=2', [id]);
  const r = await save(a, { studentId: id, round: 2, typing: 120, version: cur.version });
  assert.equal(r.body.record.attendance, '欠席・補講できず');
});

test('typing turns △ (補講予定) into 補講済み (absent that day stays on record) so the makeup becomes done', async () => {
  const { env, s, a, save } = await setup();
  const id = s('青木').id;
  await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '未定', version: 0 }, a);
  const [cur] = await env.db.query('select version from records where student_id=$1 and round=2', [id]);
  const r = await save(a, { studentId: id, round: 2, typing: 120, version: cur.version });
  assert.equal(r.body.record.attendance, '欠席・補講済み');
});

test('choosing 出席/記録なし/時間切れ for someone with a makeup records 補講済み', async () => {
  const { env, s, a, save } = await setup();
  const id = s('青木').id;
  await call(env, 'POST', '/api/makeups', { studentId: id, round: 2, place: '個別', indivNo: 3, version: 0 }, a);
  const [cur] = await env.db.query('select version from records where student_id=$1 and round=2', [id]);
  const r = await save(a, { studentId: id, round: 2, attendance: '記録なし', version: cur.version });
  assert.equal(r.status, 200);
  assert.equal(r.body.record.attendance, '欠席・補講済み');
});

test('補講済み cannot be chosen by hand', async () => {
  const { s, a, save } = await setup();
  assert.equal((await save(a, { studentId: s('青木').id, round: 2, attendance: '欠席・補講済み' })).status, 400);
});

test('GA can set a nickname, with audit', async () => {
  const { env, s, a } = await setup();
  const id = s('青木').id;
  const r = await call(env, 'POST', `/api/students/${id}/nickname`, { nickname: ' あおちゃん ' }, a);
  assert.equal(r.status, 200);
  assert.equal(r.body.nickname, 'あおちゃん');
  const [st] = await env.db.query('select nickname from students where id=$1', [id]);
  assert.equal(st.nickname, 'あおちゃん');
  const [log] = await env.db.query(`select * from audit_log where action='ニックネームの変更'`);
  assert.equal(log.after_json.nickname, 'あおちゃん');
});

test('nickname needs login', async () => {
  const { env, s } = await setup();
  assert.equal((await call(env, 'POST', `/api/students/${s('青木').id}/nickname`, { nickname: 'x' })).status, 401);
});
