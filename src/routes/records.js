// 記録入力
import { json, readJson, HttpError, intParam } from '../lib/http.js';
import { requireStaff } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normNumber, normText } from '../lib/normalize.js';
import { once } from '../lib/once.js';
import { rosterFor, rosterForRound, isEnrolled } from '../domain/roster.js';
import { activeTerm } from './auth.js';
import { ATTENDED, MAKEUP_DONE } from '../domain/makeup.js';

export const SELECTABLE = ['出席', '記録なし', '時間切れ', '欠席'];
/** 第0回は自由参加：来た人に出席をつけるだけ（欠席・タイピング・クイズ・補講なし）。 */
export const FREE_ROUND = 0;
export const FREE_ATTENDANCE = ['出席'];

export const publicRecord = r =>
  r && {
    studentId: r.student_id,
    round: r.round,
    attendance: r.attendance,
    typing: r.typing == null ? null : Number(r.typing),
    quiz: r.quiz == null ? null : Number(r.quiz),
    note: r.note,
    version: r.version,
  };

/** 受講生の年度を返す（なければ 404）。 */
export async function termOfStudent(t, studentId) {
  if (!Number.isInteger(studentId)) throw new HttpError(400, '受講生を選んでください');
  const [row] = await t.query('select t.* from students s join terms t on t.id = s.term_id where s.id = $1', [studentId]);
  if (!row) throw new HttpError(404, '受講生が見つかりません');
  return row;
}

export function assertRound(term, round) {
  if (!Number.isInteger(round) || !term.rounds.includes(round)) throw new HttpError(400, '回が不正です');
}

/** 楽観ロックつきで記録を書き換える。patch は列名→値。version 0 は「まだ記録がない」。 */
export async function writeRecord(t, { studentId, round, patch, version, operatorId, action = '記録の保存' }) {
  const [before] = await t.query('select * from records where student_id=$1 and round=$2 for update', [studentId, round]);
  const current = before ? before.version : 0;
  if (Number(version) !== current) {
    throw new HttpError(409, 'ほかの人が先に更新しました', { latest: publicRecord(before) || null });
  }
  const next = { attendance: null, typing: null, quiz: null, note: null, ...(before ? { attendance: before.attendance, typing: before.typing, quiz: before.quiz, note: before.note } : {}), ...patch };
  let row;
  if (before) {
    [row] = await t.query(
      `update records set attendance=$1, typing=$2, quiz=$3, note=$4, version=version+1, updated_by=$5, updated_at=now()
        where id=$6 and version=$7 returning *`,
      [next.attendance, next.typing, next.quiz, next.note, operatorId, before.id, before.version],
    );
  } else {
    [row] = await t.query(
      `insert into records(student_id, round, attendance, typing, quiz, note, updated_by) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (student_id, round) do nothing returning *`,
      [studentId, round, next.attendance, next.typing, next.quiz, next.note, operatorId],
    );
  }
  if (!row) {
    const [latest] = await t.query('select * from records where student_id=$1 and round=$2', [studentId, round]);
    throw new HttpError(409, 'ほかの人が先に更新しました', { latest: publicRecord(latest) || null });
  }
  await audit(t, operatorId, action, 'records', row.id, publicRecord(before), publicRecord(row));
  return row;
}

async function saveRecord(env, req) {
  const op = await requireStaff(env, req);
  const b = await readJson(req);
  const studentId = Number(b.studentId);
  const round = Number(b.round);
  const result = await once(env.db, b.requestId, async t => {
    const term = await termOfStudent(t, studentId);
    assertRound(term, round);
    if (!(await isEnrolled(t, studentId, round))) throw new HttpError(409, 'この受講生はこの回は解約済みです');
    const patch = {};
    if ('typing' in b) {
      const v = normNumber(b.typing);
      if (v === 'invalid') throw new HttpError(400, 'タイピングは数字で入力してください。記録が取れないときは出欠で「記録なし」「時間切れ」を選んでください');
      if (v != null && !term.typing_rounds.includes(round)) throw new HttpError(400, 'この回はタイピングを記録しません');
      if (v != null && v > 99999) throw new HttpError(400, 'タイピングの値が大きすぎます');
      patch.typing = v;
    }
    if ('quiz' in b) {
      const v = normNumber(b.quiz);
      if (v === 'invalid' || (v != null && !Number.isInteger(v))) throw new HttpError(400, 'クイズは0以上の整数で入力してください');
      if (v != null && !term.quiz_rounds.includes(round)) throw new HttpError(400, 'この回はクイズを記録しません');
      patch.quiz = v;
    }
    if ('note' in b) patch.note = normText(b.note);
    if ('attendance' in b) {
      const a = b.attendance === '' ? null : b.attendance;
      if (a != null && !SELECTABLE.includes(a)) throw new HttpError(400, '出欠の区分が不正です（△×は「補講」から付けてください）');
      if (a != null && round === FREE_ROUND && !FREE_ATTENDANCE.includes(a)) throw new HttpError(400, '第0回は自由参加なので、来た人に「出席」をつけるだけです');
      patch.attendance = a;
      // 補講がある人は、出欠を補講の状態に合わせる（当日欠席と補講が食い違わないように）
      //  ・補講予定：出席系を選んだら「補講済み」、当日欠席・未入力なら△（振替済み／振替先未定）
      //  ・補講できず：出席系は選べない（補講の「変更」で振替先を選び直す）、当日欠席・未入力なら×
      const mk = await makeupOf(t, studentId, round);
      if (mk && !mk.failed) patch.attendance = a != null && ATTENDED.includes(a) ? MAKEUP_DONE : '欠席・補講予定';
      if (mk && mk.failed) {
        if (a != null && ATTENDED.includes(a)) throw new HttpError(400, '補講できずになっています。受けた場合は、補講の「変更」で振替先を選び直してください');
        patch.attendance = '欠席・補講できず';
      }
    }
    if (patch.typing != null && !('attendance' in b)) {
      const [cur] = await t.query('select attendance from records where student_id=$1 and round=$2', [studentId, round]);
      // 未入力なら出席、△（補講予定）なら補講済みにする。当日欠席と×はそのまま残す。
      if (!cur || cur.attendance == null) {
        const mk = await makeupOf(t, studentId, round);
        patch.attendance = mk ? (mk.failed ? '欠席・補講できず' : MAKEUP_DONE) : '出席';
      } else if (cur.attendance === '欠席・補講予定') patch.attendance = MAKEUP_DONE;
    }
    const row = await writeRecord(t, { studentId, round, patch, version: b.version ?? 0, operatorId: op.id });
    return { record: publicRecord(row) };
  });
  return json(result);
}

async function getRoundRoster(env, req) {
  await requireStaff(env, req);
  const url = new URL(req.url);
  const round = intParam(url, 'round');
  const termId = intParam(url, 'termId', { required: false });
  const [term] = termId
    ? await env.db.query('select id, name, rounds, typing_rounds, quiz_rounds from terms where id=$1', [termId])
    : await env.db.query('select id, name, rounds, typing_rounds, quiz_rounds from terms where active');
  if (!term) throw new HttpError(400, '年度がまだ作られていません');
  assertRound(term, round);
  return json({ term, round, slots: await rosterForRound(env.db, { termId: term.id, round }) });
}

async function getRoster(env, req) {
  const op = await requireStaff(env, req);
  const url = new URL(req.url);
  const slotId = intParam(url, 'slotId');
  const round = intParam(url, 'round');
  // コマと年度は1回の SQL で取る（名簿は入力画面で何度も開くので、往復を減らす）
  const [row] = await env.db.query(
    `select s.id as slot_id, s.code, t.id, t.name, t.rounds, t.typing_rounds, t.quiz_rounds
       from slots s join terms t on t.id = s.term_id where s.id = $1`,
    [slotId],
  );
  if (!row) throw new HttpError(404, 'コマが見つかりません');
  const slot = { id: row.slot_id, code: row.code };
  const term = { id: row.id, name: row.name, rounds: row.rounds, typing_rounds: row.typing_rounds, quiz_rounds: row.quiz_rounds };
  assertRound(term, round);
  const groups = await rosterFor(env.db, { termId: term.id, slotId, round });
  groups.sort((x, y) => (y.gaId === op.id) - (x.gaId === op.id));
  return json({
    term,
    slot: { id: slot.id, code: slot.code },
    round,
    isTypingRound: term.typing_rounds.includes(round),
    isQuizRound: term.quiz_rounds.includes(round),
    isFreeRound: round === FREE_ROUND,
    groups,
  });
}

async function makeupOf(t, studentId, round) {
  const [m] = await t.query('select failed from makeups where student_id=$1 and round=$2', [studentId, round]);
  return m || null;
}

async function setNickname(env, req, m) {
  const op = await requireStaff(env, req);
  const id = Number(m[1]);
  const b = await readJson(req);
  const nickname = normText(b.nickname);
  if (nickname && nickname.length > 50) throw new HttpError(400, 'ニックネームが長すぎます');
  return json(
    await env.db.tx(async t => {
      const [before] = await t.query('select id, nickname from students where id=$1 for update', [id]);
      if (!before) throw new HttpError(404, '受講生が見つかりません');
      const [row] = await t.query('update students set nickname=$1 where id=$2 returning id, nickname', [nickname, id]);
      await audit(t, op.id, 'ニックネームの変更', 'students', id, before, row);
      return { studentId: id, nickname: row.nickname };
    }),
  );
}

export { activeTerm };

export const routes = [
  ['GET', /^\/api\/roster\/round$/, getRoundRoster],
  ['GET', /^\/api\/roster$/, getRoster],
  ['POST', /^\/api\/records$/, saveRecord],
  ['POST', /^\/api\/students\/(\d+)\/nickname$/, setNickname],
];
