// 記録閲覧：前のスプレッドシートの曜日シート（月・火1…）と同じ形で、コマごとに全回の記録を並べる。見るだけ。
import { json, HttpError, intParam } from '../lib/http.js';
import { requireStaff } from '../lib/auth.js';
import { currentGroupSql } from '../domain/roster.js';
import { CIRCLED } from '../domain/indiv.js';
import { FREE_ROUND } from './records.js';

// タイピングがない回の書き方（前のシートと同じ）
const MARK = {
  出席: '〇',
  '出席・記録なし': '〇',
  記録なし: '記録なし',
  時間切れ: '時間切れ',
  欠席: '欠席',
  '欠席・補講予定': '△',
  '欠席・補講できず': '×',
};

const num = v => (v == null ? null : Number(v));
const round1 = n => Math.round(n * 10) / 10;

function makeupRemark(m) {
  if (!m) return null;
  if (m.failed) return '補講できず';
  if (m.place === '他班') return `${m.host_label}補講`;
  if (m.place === '個別') return m.indiv_no == null ? '個別' : m.indiv_no === 8 ? `個別⑧${m.indiv_when || ''}` : `個別${CIRCLED[m.indiv_no - 1]}`;
  return '補講未定';
}

async function sheet(env, req) {
  await requireStaff(env, req);
  const slotId = intParam(new URL(req.url), 'slotId');
  const [slot] = await env.db.query('select id, code, term_id from slots where id=$1', [slotId]);
  if (!slot) throw new HttpError(404, 'コマが見つかりません');
  const [term] = await env.db.query('select * from terms where id=$1', [slot.term_id]);
  const last = Math.max(...term.rounds);

  // 最後の回の時点の班で、このコマの班にいる受講生（解約した人も含める）
  const students = await env.db.query(
    `select x.* from (
        select st.id, st.name, st.kana, st.nickname, ${currentGroupSql('st', '$2')} as gid
          from students st where st.term_id = $1) x
       join groups g on g.id = x.gid
      where g.slot_id = $3
      order by x.kana nulls last, x.name, x.id`,
    [term.id, last, slot.id],
  );
  const groups = await env.db.query(
    `select g.id, s.name as ga_name from groups g join staff s on s.id = g.ga_id where g.slot_id = $1 order by g.sort, s.name, g.id`,
    [slot.id],
  );
  const ids = students.map(s => s.id);
  const by = rows => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.student_id)) m.set(r.student_id, []);
      m.get(r.student_id).push(r);
    }
    return m;
  };
  const recs = by(await env.db.query('select * from records where student_id = any($1)', [ids]));
  const mks = by(
    await env.db.query(
      `select m.*, xs.code || ' ' || xga.name as host_label from makeups m
         left join groups xg on xg.id = m.host_group_id left join slots xs on xs.id = xg.slot_id left join staff xga on xga.id = xg.ga_id
        where m.student_id = any($1)`,
      [ids],
    ),
  );
  const wds = by(await env.db.query('select * from withdrawals where cancelled_at is null and student_id = any($1)', [ids]));
  const trs = by(
    await env.db.query(
      `select t.*, fs.code || ' ' || fga.name as from_label from transfers t
         join groups fg on fg.id = t.from_group_id join slots fs on fs.id = fg.slot_id join staff fga on fga.id = fg.ga_id
        where t.cancelled_at is null and t.student_id = any($1) order by t.from_round desc, t.id desc`,
      [ids],
    ),
  );

  const out = new Map(groups.map(g => [g.id, { groupId: g.id, gaName: g.ga_name, students: [] }]));
  for (const st of students) {
    const rr = new Map((recs.get(st.id) || []).map(r => [r.round, r]));
    const mm = new Map((mks.get(st.id) || []).map(m => [m.round, m]));
    const wd = (wds.get(st.id) || [])[0];
    const tr = (trs.get(st.id) || []).find(t => t.to_group_id === st.gid);
    const cells = {};
    for (const r of term.rounds) {
      const rec = rr.get(r);
      const value = rec ? (rec.typing != null && r !== FREE_ROUND ? String(num(rec.typing)) : MARK[rec.attendance] || '') : '';
      const m = mm.get(r);
      const remark = [makeupRemark(m), rec && rec.note].filter(Boolean).join('・');
      cells[r] = { value, remark, out: !!(wd && r >= wd.from_round) };
    }
    const quiz = {};
    for (const r of term.quiz_rounds) quiz[r] = rr.get(r) ? num(rr.get(r).quiz) : null;
    const typ = r => (rr.get(r) ? num(rr.get(r).typing) : null);
    const tRounds = term.typing_rounds;
    const end = tRounds.length ? typ(tRounds[tRounds.length - 1]) : null;
    const first = tRounds.slice(0, -1).find(r => typ(r) != null);
    const qr = term.quiz_rounds;
    const q0 = qr.length >= 2 ? quiz[qr[0]] : null;
    const q1 = qr.length >= 2 ? quiz[qr[qr.length - 1]] : null;
    const status = [wd ? `第${wd.from_round}回〜解約` : null, tr ? `第${tr.from_round}回から移動（${tr.from_label}から）` : null].filter(Boolean).join('・');
    out.get(st.gid)?.students.push({
      studentId: st.id,
      name: st.name,
      kana: st.kana,
      nickname: st.nickname,
      withdrawnFrom: wd ? wd.from_round : null,
      status,
      cells,
      quiz,
      typingGain: end != null && first != null ? round1(typ(first) - end) : null,
      quizGain: q0 != null && q1 != null ? q1 - q0 : null,
    });
  }
  return json({
    slot: { id: slot.id, code: slot.code },
    rounds: term.rounds,
    typingRounds: term.typing_rounds,
    quizRounds: term.quiz_rounds,
    freeRound: FREE_ROUND,
    groups: [...out.values()],
  });
}

export const routes = [['GET', /^\/api\/records\/sheet$/, sheet]];
