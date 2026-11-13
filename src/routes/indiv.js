// 個別補講 ①〜⑧：枠の一覧（名簿）と、管理者による枠の書き換え
import { json, readJson, HttpError, intParam } from '../lib/http.js';
import { requireStaff, requireAdmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normText } from '../lib/normalize.js';
import { currentGroupSql, enrolledSql } from '../domain/roster.js';
import { makeupStatus } from '../domain/makeup.js';
import { indivSlots, indivLabel } from '../domain/indiv.js';
import { assertRound, publicRecord, FREE_ROUND } from './records.js';
import { activeTerm } from './auth.js';

async function termOf(env, idOrNull) {
  const id = idOrNull ?? (await activeTerm(env))?.id;
  const [term] = id ? await env.db.query('select * from terms where id=$1', [id]) : [];
  if (!term) throw new HttpError(400, '年度がまだ作られていません');
  return term;
}

async function list(env, req) {
  await requireStaff(env, req);
  const url = new URL(req.url);
  const term = await termOf(env, intParam(url, 'termId', { required: false }));
  const round = intParam(url, 'round');
  assertRound(term, round);
  const slots = await indivSlots(env.db, term.id, round);
  const rows = await env.db.query(
    `with b as (
        select m.*, st.name, st.kana, st.nickname, ${currentGroupSql('st', '$2')} as cg
          from makeups m join students st on st.id = m.student_id
         where st.term_id = $1 and m.round = $2 and m.place = '個別' and ${enrolledSql('st', '$2')}
     )
     select b.*, hs.code as home_slot, hga.name as home_ga, ib.name as in_charge,
            r.attendance, r.typing, r.quiz, r.note, r.version as rversion
       from b join groups hg on hg.id = b.cg join slots hs on hs.id = hg.slot_id join staff hga on hga.id = hg.ga_id
       left join staff ib on ib.id = b.indiv_by
       left join records r on r.student_id = b.student_id and r.round = b.round
      order by hs.sort, b.kana nulls last, b.name, b.student_id`,
    [term.id, round],
  );
  const out = { round, slots: slots.map(s => ({ ...s, students: [] })), unassigned: [] };
  for (const r of rows) {
    const record = r.rversion == null ? null : publicRecord({ ...r, version: r.rversion });
    const st = {
      studentId: r.student_id,
      name: r.name,
      kana: r.kana,
      nickname: r.nickname,
      gaName: r.home_ga,
      homeSlot: r.home_slot,
      homeLabel: `${r.home_slot} ${r.home_ga}`,
      indivNo: r.indiv_no,
      indivWhen: r.indiv_when,
      indivLabel: indivLabel(slots, r.indiv_no, r.indiv_when),
      inCharge: r.indiv_no === 8 ? r.in_charge : null,
      status: makeupStatus(r, record),
      version: r.version,
    };
    if (r.indiv_no == null) out.unassigned.push(st);
    else out.slots[r.indiv_no - 1].students.push(st);
  }
  return json(out);
}

const short = (v, max, what) => {
  const t = normText(v);
  if (t && t.length > max) throw new HttpError(400, `${what}が長すぎます`);
  return t;
};

async function saveSlot(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const term = await termOf(env, b.termId == null ? null : Number(b.termId));
  const round = Number(b.round);
  const no = Number(b.no);
  assertRound(term, round);
  if (round === FREE_ROUND) throw new HttpError(400, '第0回は補講がありません');
  if (!Number.isInteger(no) || no < 1 || no > 7) throw new HttpError(400, '枠は①〜⑦から選んでください');
  const vals = [short(b.label, 30, '時間'), short(b.host, 30, '担当'), short(b.room, 30, '場所'), !!b.closed];
  return json(
    await env.db.tx(async t => {
      const [before] = await t.query('select * from indiv_slots where term_id=$1 and round=$2 and no=$3 for update', [term.id, round, no]);
      const [row] = await t.query(
        `insert into indiv_slots(term_id, round, no, label, host, room, closed) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (term_id, round, no) do update set label=excluded.label, host=excluded.host, room=excluded.room, closed=excluded.closed
         returning *`,
        [term.id, round, no, ...vals],
      );
      await audit(t, op.id, '個別補講の枠の変更', 'indiv_slots', row.id, before || null, row);
      return (await indivSlots(t, term.id, round))[no - 1];
    }),
  );
}

async function saveLabels(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const term = await termOf(env, b.termId == null ? null : Number(b.termId));
  const labels = Array.isArray(b.labels) ? b.labels.map(x => short(x, 30, '時間')) : [];
  if (labels.length !== 7 || labels.some(x => !x)) throw new HttpError(400, '①〜⑦の曜日と時間をすべて入れてください');
  return json(
    await env.db.tx(async t => {
      const [row] = await t.query('update terms set indiv_labels=$1 where id=$2 returning id, indiv_labels', [labels, term.id]);
      await audit(t, op.id, '個別補講の基本時間の変更', 'terms', term.id, { indiv_labels: term.indiv_labels }, row);
      return { termId: term.id, labels: row.indiv_labels };
    }),
  );
}

export const routes = [
  ['GET', /^\/api\/indiv$/, list],
  ['POST', /^\/api\/admin\/indiv-slots$/, saveSlot],
  ['POST', /^\/api\/admin\/indiv-labels$/, saveLabels],
];
