// 記録入力
import { json, readJson, HttpError, intParam } from '../lib/http.js';
import { requireStaff } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normNumber, normText } from '../lib/normalize.js';
import { once } from '../lib/once.js';
import { rosterFor, isEnrolled } from '../domain/roster.js';
import { ATTENDED } from '../domain/makeup.js';
import { activeTerm } from './auth.js';

export const SELECTABLE = ['出席', '出席・記録なし', '記録なし', '時間切れ', '欠席'];

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
      patch.attendance = a;
    }
    if (patch.typing != null && !('attendance' in b)) {
      const [cur] = await t.query('select attendance from records where student_id=$1 and round=$2', [studentId, round]);
      if (!cur || !ATTENDED.includes(cur.attendance)) patch.attendance = '出席';
    }
    const row = await writeRecord(t, { studentId, round, patch, version: b.version ?? 0, operatorId: op.id });
    return { record: publicRecord(row) };
  });
  return json(result);
}

async function getRoster(env, req) {
  const op = await requireStaff(env, req);
  const url = new URL(req.url);
  const slotId = intParam(url, 'slotId');
  const round = intParam(url, 'round');
  const [slot] = await env.db.query('select s.id, s.code, s.term_id from slots s where s.id=$1', [slotId]);
  if (!slot) throw new HttpError(404, 'コマが見つかりません');
  const [term] = await env.db.query('select id, name, rounds, typing_rounds, quiz_rounds from terms where id=$1', [slot.term_id]);
  assertRound(term, round);
  const groups = await rosterFor(env.db, { termId: term.id, slotId, round });
  groups.sort((x, y) => (y.gaId === op.id) - (x.gaId === op.id));
  return json({
    term,
    slot: { id: slot.id, code: slot.code },
    round,
    isTypingRound: term.typing_rounds.includes(round),
    isQuizRound: term.quiz_rounds.includes(round),
    groups,
  });
}

export { activeTerm };

export const routes = [
  ['GET', /^\/api\/roster$/, getRoster],
  ['POST', /^\/api\/records$/, saveRecord],
];
