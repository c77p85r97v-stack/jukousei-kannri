// 補講：受ける場所を1つ選ぶだけ。△×は自動で付く。
import { json, readJson, HttpError, intParam } from '../lib/http.js';
import { requireStaff } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { once } from '../lib/once.js';
import { isEnrolled, groupAt, currentGroupSql } from '../domain/roster.js';
import { makeupStatus, ATTENDED, MAKEUP_DONE } from '../domain/makeup.js';
import { indivSlots, indivLabel, slotCache, EXTRA_NO } from '../domain/indiv.js';
import { normText } from '../lib/normalize.js';
import { termOfStudent, assertRound, writeRecord, publicRecord, FREE_ROUND } from './records.js';
import { activeTerm } from './auth.js';

const PLACES = ['他班', '個別', '未定'];

async function labelOf(t, groupId) {
  if (!groupId) return null;
  const [g] = await t.query('select s.code, st.name from groups g join slots s on s.id=g.slot_id join staff st on st.id=g.ga_id where g.id=$1', [groupId]);
  return g ? `${g.code} ${g.name}` : null;
}

async function publicMakeup(t, m, record, termId) {
  if (!m) return null;
  const slots = m.indiv_no == null ? [] : await indivSlots(t, termId, m.round);
  return {
    indivNo: m.indiv_no,
    indivWhen: m.indiv_when,
    indivLabel: indivLabel(slots, m.indiv_no, m.indiv_when),
    place: m.place,
    hostGroupId: m.host_group_id,
    hostLabel: await labelOf(t, m.host_group_id),
    failed: m.failed,
    version: m.version,
    status: makeupStatus(m, publicRecord(record)),
  };
}

/** 記録の出欠を、補講の操作に合わせて自動で変える（すでに出席系なら触らない）。 */
async function setAttendance(t, studentId, round, attendance, operatorId, action, { undoDone = false } = {}) {
  const [cur] = await t.query('select * from records where student_id=$1 and round=$2', [studentId, round]);
  // 補講を取り消したら「補講済み」は当日欠席に戻す（タイピングは残す）
  if (undoDone && cur && cur.attendance === MAKEUP_DONE) return writeRecord(t, { studentId, round, patch: { attendance }, version: cur.version, operatorId, action });
  if (cur && ATTENDED.includes(cur.attendance)) return cur;
  if (cur && cur.attendance === attendance) return cur;
  return writeRecord(t, { studentId, round, patch: { attendance }, version: cur ? cur.version : 0, operatorId, action });
}

async function lockMakeup(t, studentId, round, version) {
  const [m] = await t.query('select * from makeups where student_id=$1 and round=$2 for update', [studentId, round]);
  if ((m ? m.version : 0) !== Number(version ?? 0)) throw new HttpError(409, 'ほかの人が先に補講を変更しました。画面を更新してください');
  return m;
}

async function common(t, b) {
  const studentId = Number(b.studentId);
  const round = Number(b.round);
  const term = await termOfStudent(t, studentId);
  assertRound(term, round);
  if (round === FREE_ROUND) throw new HttpError(400, '第0回は自由参加なので補講はありません');
  if (!(await isEnrolled(t, studentId, round))) throw new HttpError(409, 'この受講生はこの回は解約済みです');
  return { studentId, round, term };
}

async function setPlace(env, req) {
  const op = await requireStaff(env, req);
  const b = await readJson(req);
  if (!PLACES.includes(b.place)) throw new HttpError(400, '補講の場所を選んでください');
  const result = await once(env.db, b.requestId, async t => {
    const { studentId, round, term } = await common(t, b);
    let host = null;
    if (b.place === '他班') {
      host = Number(b.hostGroupId);
      if (!Number.isInteger(host)) throw new HttpError(400, '補講先の班を選んでください');
      const [g] = await t.query('select s.term_id from groups g join slots s on s.id=g.slot_id where g.id=$1', [host]);
      if (!g || g.term_id !== term.id) throw new HttpError(400, '補講先の班を選んでください');
      if (host === (await groupAt(t, studentId, round))) throw new HttpError(400, '補講先が自分の班になっています');
    }
    // 個別補講の枠：①〜⑦は実施する枠だけ、⑧は日時が必要。担当は⑧を登録したGA。
    let indivNo = null;
    let when = null;
    if (b.place === '個別' && b.indivNo != null && b.indivNo !== '') {
      indivNo = Number(b.indivNo);
      if (!Number.isInteger(indivNo) || indivNo < 1 || indivNo > EXTRA_NO) throw new HttpError(400, '個別補講の枠は①〜⑧から選んでください');
      if (indivNo === EXTRA_NO) {
        when = normText(b.indivWhen);
        if (!when) throw new HttpError(400, '⑧（指定時間外）は日時を入れてください');
        if (when.length > 50) throw new HttpError(400, '日時が長すぎます');
      } else if ((await indivSlots(t, term.id, round))[indivNo - 1].closed) {
        throw new HttpError(400, 'その枠はこの回は実施なしです');
      }
    }
    const before = await lockMakeup(t, studentId, round, b.version);
    const by = indivNo === EXTRA_NO ? (before && before.indiv_no === EXTRA_NO && before.indiv_by ? before.indiv_by : op.id) : null;
    let m;
    if (before) {
      [m] = await t.query('update makeups set place=$1, host_group_id=$2, failed=false, indiv_no=$4, indiv_when=$5, indiv_by=$6, version=version+1 where id=$3 returning *', [b.place, host, before.id, indivNo, when, by]);
    } else {
      // 2人が同時に最初の登録をした場合、後の人は何も入らない（一意制約）→ 409
      [m] = await t.query('insert into makeups(student_id, round, place, host_group_id, created_by, indiv_no, indiv_when, indiv_by) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (student_id, round) do nothing returning *', [studentId, round, b.place, host, op.id, indivNo, when, by]);
      if (!m) throw new HttpError(409, 'ほかの人が先に補講を変更しました。画面を更新してください');
    }
    await audit(t, op.id, before ? '補講の変更' : '補講の登録', 'makeups', m.id, before, m);
    const rec = await setAttendance(t, studentId, round, '欠席・補講予定', op.id, '補講の登録（△）');
    return { makeup: await publicMakeup(t, m, rec, term.id), record: publicRecord(rec) };
  });
  return json(result);
}

async function fail(env, req) {
  const op = await requireStaff(env, req);
  const b = await readJson(req);
  const result = await env.db.tx(async t => {
    const { studentId, round, term } = await common(t, b);
    const before = await lockMakeup(t, studentId, round, b.version);
    if (!before) throw new HttpError(404, '補講が登録されていません');
    const [m] = await t.query('update makeups set failed=true, version=version+1 where id=$1 returning *', [before.id]);
    await audit(t, op.id, '補講できなかった', 'makeups', m.id, before, m);
    const rec = await setAttendance(t, studentId, round, '欠席・補講できず', op.id, '補講できなかった（×）');
    return { makeup: await publicMakeup(t, m, rec, term.id), record: publicRecord(rec) };
  });
  return json(result);
}

async function cancel(env, req) {
  const op = await requireStaff(env, req);
  const b = await readJson(req);
  const result = await env.db.tx(async t => {
    const { studentId, round } = await common(t, b);
    const before = await lockMakeup(t, studentId, round, b.version);
    if (!before) throw new HttpError(404, '補講が登録されていません');
    await t.query('delete from makeups where id=$1', [before.id]);
    await audit(t, op.id, '補講の取り消し', 'makeups', before.id, before, null);
    const rec = await setAttendance(t, studentId, round, '欠席', op.id, '補講の取り消し', { undoDone: true });
    return { makeup: null, record: publicRecord(rec) };
  });
  return json(result);
}

async function list(env, req) {
  await requireStaff(env, req);
  const url = new URL(req.url);
  const termId = intParam(url, 'termId', { required: false }) ?? (await activeTerm(env))?.id;
  if (!termId) return json([]);
  const round = intParam(url, 'round', { required: false });
  const status = url.searchParams.get('status');
  const rows = await env.db.query(
    `with base as (
        select m.*, st.name, st.kana, st.nickname, ${currentGroupSql('st', 'm.round')} as cg
          from makeups m join students st on st.id = m.student_id
         where st.term_id = $1 and ($2::int is null or m.round = $2)
           and not exists (select 1 from withdrawals w where w.student_id = st.id and w.cancelled_at is null and w.from_round <= m.round)
     )
     select b.*, hs.code || ' ' || hga.name as home_label, xs.code || ' ' || xga.name as host_label,
            r.attendance, r.typing, r.quiz, r.note, r.version as rversion
       from base b
       join groups hg on hg.id = b.cg join slots hs on hs.id = hg.slot_id join staff hga on hga.id = hg.ga_id
       left join groups xg on xg.id = b.host_group_id left join slots xs on xs.id = xg.slot_id left join staff xga on xga.id = xg.ga_id
       left join records r on r.student_id = b.student_id and r.round = b.round
      order by b.round, b.kana nulls last, b.name, b.student_id`,
    [termId, round],
  );
  const slotsOf = slotCache(env.db, termId);
  const out = [];
  for (const r of rows) {
    const record = r.rversion == null ? null : publicRecord({ student_id: r.student_id, round: r.round, attendance: r.attendance, typing: r.typing, quiz: r.quiz, note: r.note, version: r.rversion });
    const st = makeupStatus(r, record);
    if (status && st !== status) continue;
    out.push({
      studentId: r.student_id,
      round: r.round,
      name: r.name,
      kana: r.kana,
      nickname: r.nickname,
      homeGroupId: r.cg,
      homeLabel: r.home_label,
      place: r.place,
      hostGroupId: r.host_group_id,
      hostLabel: r.host_label,
      failed: r.failed,
      version: r.version,
      indivNo: r.indiv_no,
      indivWhen: r.indiv_when,
      indivLabel: r.indiv_no == null ? null : indivLabel(await slotsOf(r.round), r.indiv_no, r.indiv_when),
      status: st,
      record,
    });
  }
  return json(out);
}

export const routes = [
  ['POST', /^\/api\/makeups$/, setPlace],
  ['POST', /^\/api\/makeups\/fail$/, fail],
  ['POST', /^\/api\/makeups\/cancel$/, cancel],
  ['GET', /^\/api\/makeups$/, list],
];
