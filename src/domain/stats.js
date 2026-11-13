// 集計（表に保存せず、毎回計算する）。定義は設計書 3章「集計の定義」。
import { currentGroupSql, enrolledSql } from './roster.js';
import { ATTENDED, MAKEUP_DONE } from './makeup.js';

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

export async function computeStats(db, termId) {
  const [term] = await db.query('select * from terms where id=$1', [termId]);
  if (!term) return null;
  // 第0回は自由参加：参加人数だけ別に数え、受講率・解約の基準には入れない
  const FREE = 0;
  const rounds = term.rounds.filter(r => r !== FREE);
  const lastRound = rounds[rounds.length - 1];

  // 受講生 × 回：その回の班・在籍・記録
  const cells = await db.query(
    `select st.id, rd.round, ${currentGroupSql('st', 'rd.round')} as g, (${enrolledSql('st', 'rd.round')}) as enrolled,
            r.attendance, r.typing, r.quiz
       from students st cross join unnest($2::int[]) as rd(round)
       left join records r on r.student_id = st.id and r.round = rd.round
      where st.term_id = $1`,
    [termId, rounds],
  );

  const attendanceRate = {};
  for (const r of rounds) attendanceRate[r] = { enrolled: 0, attended: 0, sameDay: 0, byMakeup: 0, rate: null };
  const byStudent = new Map();
  for (const c of cells) {
    if (c.enrolled) {
      attendanceRate[c.round].enrolled++;
      if (ATTENDED.includes(c.attendance)) {
        attendanceRate[c.round].attended++;
        attendanceRate[c.round][c.attendance === MAKEUP_DONE ? 'byMakeup' : 'sameDay']++;
      }
    }
    if (!byStudent.has(c.id)) byStudent.set(c.id, {});
    byStudent.get(c.id)[c.round] = c;
  }
  for (const r of rounds) attendanceRate[r].rate = ratio(attendanceRate[r].attended, attendanceRate[r].enrolled);
  const freeRound = term.rounds.includes(FREE)
    ? { round: FREE, attended: Number((await db.query(`select count(*) as n from records r join students st on st.id = r.student_id where st.term_id = $1 and r.round = $2 and r.attendance = any($3)`, [termId, FREE, ATTENDED]))[0].n) }
    : null;

  // 解約
  const wd = await db.query(
    `select w.from_round, sl.code
       from withdrawals w join students st on st.id = w.student_id
       join groups g on g.id = ${currentGroupSql('st', 'w.from_round')} join slots sl on sl.id = g.slot_id
      where st.term_id = $1 and w.cancelled_at is null`,
    [termId],
  );
  const withdrawnBySlot = {};
  const withdrawnByRound = {};
  for (const w of wd) {
    withdrawnBySlot[w.code] = (withdrawnBySlot[w.code] || 0) + 1;
    withdrawnByRound[w.from_round] = (withdrawnByRound[w.from_round] || 0) + 1;
  }
  // 初期受講生数：設定があればそれ、なければ登録されている受講生の人数（最初の回の前に解約した人も含む）
  const initialCount = term.initial_count ?? byStudent.size;
  const withdrawn = wd.length;
  // 第1回から一度も受けずに解約した人（旧シートの「第1回未受講者」）。第0回からの解約も含む。
  const firstRound = rounds[0];
  const neverAttended = firstRound == null ? 0 : wd.filter(w => w.from_round <= firstRound).length;

  // コマ移動
  const tr = await db.query(
    `select fs.code as from_code, ts.code as to_code
       from transfers t join students st on st.id = t.student_id
       join groups fg on fg.id = t.from_group_id join slots fs on fs.id = fg.slot_id
       join groups tg on tg.id = t.to_group_id join slots ts on ts.id = tg.slot_id
      where st.term_id = $1 and t.cancelled_at is null`,
    [termId],
  );
  const transfersBySlot = {};
  const slot = code => (transfersBySlot[code] ||= { out: 0, in: 0 });
  for (const t of tr) {
    slot(t.from_code).out++;
    slot(t.to_code).in++;
  }

  // 班ごと（最後の回の時点の班）
  const groupRows = await db.query(
    `select g.id as "groupId", sl.code as "slotCode", st.name as "gaName"
       from groups g join slots sl on sl.id = g.slot_id join staff st on st.id = g.ga_id
      where sl.term_id = $1 order by sl.sort, g.sort, st.name`,
    [termId],
  );
  const acc = new Map(groupRows.map(g => [g.groupId, { size: 0, typing: [], quiz: [] }]));
  const typingRounds = term.typing_rounds;
  const quizRounds = term.quiz_rounds;
  for (const perRound of byStudent.values()) {
    const last = perRound[lastRound];
    if (!last || !last.enrolled) continue;
    const a = acc.get(last.g);
    if (!a) continue;
    a.size++;
    const val = (r, col) => (perRound[r] && perRound[r][col] != null ? Number(perRound[r][col]) : null);
    if (typingRounds.length) {
      const end = val(typingRounds[typingRounds.length - 1], 'typing');
      const firstRound = typingRounds.slice(0, -1).find(r => val(r, 'typing') != null);
      if (end != null && firstRound != null) a.typing.push(val(firstRound, 'typing') - end);
    }
    if (quizRounds.length >= 2) {
      const q0 = val(quizRounds[0], 'quiz');
      const q1 = val(quizRounds[quizRounds.length - 1], 'quiz');
      if (q0 != null && q1 != null) a.quiz.push(q1 - q0);
    }
  }
  const groups = groupRows.map(g => {
    const a = acc.get(g.groupId);
    return {
      ...g,
      size: a.size,
      typingGainAvg: avg(a.typing),
      typingImprovedRatio: ratio(a.typing.filter(x => x > 0).length, a.typing.length),
      typingCount: a.typing.length,
      quizGainAvg: avg(a.quiz),
      quizCount: a.quiz.length,
    };
  });

  return {
    termId,
    initialCount,
    withdrawn,
    retentionRate: ratio(initialCount - withdrawn, initialCount),
    withdrawalRate: ratio(withdrawn, initialCount),
    neverAttended,
    retentionRateExclNeverAttended: ratio(initialCount - (withdrawn - neverAttended), initialCount),
    withdrawnBySlot,
    withdrawnByRound,
    transfers: tr.length,
    transfersBySlot,
    attendanceRate,
    freeRound,
    groups,
  };
}
