// 名簿の計算（表に保存せず、毎回 SQL で決める）
//  ・その回の班：取り消していないコマ移動のうち from_round <= 回 で最も新しいものの移動先。なければ入学時の班
//  ・在籍：取り消していない解約がない、または解約の from_round > 回
//  ・補講で来る人：その回の補講先がこの班（他班・できなかったでない）で、在籍している人
import { makeupStatus } from './makeup.js';
import { indivSlots, indivLabel } from './indiv.js';

/** 受講生 alias のその回の班（SQL 式）。roundSql は '$2' のようなプレースホルダ。 */
export function currentGroupSql(alias, roundSql) {
  return `coalesce((select tr.to_group_id from transfers tr
                     where tr.student_id = ${alias}.id and tr.cancelled_at is null and tr.from_round <= ${roundSql}
                     order by tr.from_round desc, tr.created_at desc, tr.id desc limit 1), ${alias}.group_id)`;
}

/** 受講生 alias がその回に在籍しているか（SQL 条件）。 */
export function enrolledSql(alias, roundSql) {
  return `not exists (select 1 from withdrawals w where w.student_id = ${alias}.id and w.cancelled_at is null and w.from_round <= ${roundSql})`;
}

const num = v => (v == null ? null : Number(v));

function toMember(r) {
  return {
    studentId: r.id,
    name: r.name,
    kana: r.kana,
    nickname: r.nickname,
    homeGroupId: r.cg,
    homeLabel: `${r.home_slot} ${r.home_ga}`,
    record: r.rversion == null ? null : { attendance: r.attendance, typing: num(r.typing), quiz: num(r.quiz), note: r.note, version: r.rversion },
    makeup:
      r.place == null
        ? null
        : {
            place: r.place,
            hostGroupId: r.host_group_id,
            hostLabel: r.host_slot ? `${r.host_slot} ${r.host_ga}` : null,
            failed: r.failed,
            version: r.mversion,
            indivNo: r.indiv_no,
            indivWhen: r.indiv_when,
          },
  };
}

/** students の条件（where 句）と引数を受け取り、その回の名簿の行を返す（rosterFor・補講一覧で共用）。 */
export async function rosterRows(db, { termId, round, groupIds }) {
  return db.query(
    `with cur as (
        select st.id, st.name, st.kana, st.nickname, ${currentGroupSql('st', '$2')} as cg
          from students st
         where st.term_id = $1 and ${enrolledSql('st', '$2')}
     ), lst as (
        select c.*, 'member' as kind, c.cg as shown_group from cur c where c.cg = any($3::int[])
        union all
        select c.*, 'guest' as kind, m.host_group_id as shown_group
          from cur c join makeups m on m.student_id = c.id and m.round = $2
         where m.place = '他班' and not m.failed and m.host_group_id = any($3::int[])
           and m.host_group_id <> c.cg -- 補講先の班に移動してきた人は、班員として1回だけ出す
     )
     select l.*, hs.code as home_slot, hga.name as home_ga,
            r.attendance, r.typing, r.quiz, r.note, r.version as rversion,
            m.place, m.host_group_id, m.failed, m.version as mversion, m.indiv_no, m.indiv_when, xs.code as host_slot, xga.name as host_ga
       from lst l
       join groups hg on hg.id = l.cg join slots hs on hs.id = hg.slot_id join staff hga on hga.id = hg.ga_id
       left join records r on r.student_id = l.id and r.round = $2
       left join makeups m on m.student_id = l.id and m.round = $2
       left join groups xg on xg.id = m.host_group_id left join slots xs on xs.id = xg.slot_id left join staff xga on xga.id = xg.ga_id
      order by l.kana nulls last, l.name, l.id`,
    [termId, round, groupIds],
  );
}

/**
 * 第 round 回・コマ slotId の名簿。
 * 戻り値：[{groupId, gaId, gaName, members: Member[], guests: Member[]}]
 */
export async function rosterFor(db, { termId, slotId, round }) {
  const groups = await db.query(
    `select g.id as "groupId", g.ga_id as "gaId", st.name as "gaName"
       from groups g join staff st on st.id = g.ga_id where g.slot_id = $1 order by g.sort, st.name`,
    [slotId],
  );
  const byId = new Map(groups.map(g => [g.groupId, { ...g, members: [], guests: [] }]));
  if (!groups.length) return [];
  const rows = await rosterRows(db, { termId, round, groupIds: groups.map(g => g.groupId) });
  const slots = rows.some(r => r.indiv_no != null) ? await indivSlots(db, termId, round) : [];
  for (const r of rows) {
    const m = toMember(r);
    if (m.makeup) {
      m.makeup.status = makeupStatus(m.makeup, m.record);
      m.makeup.indivLabel = indivLabel(slots, m.makeup.indivNo, m.makeup.indivWhen);
    }
    byId.get(r.shown_group)[r.kind === 'guest' ? 'guests' : 'members'].push(m);
  }
  return [...byId.values()];
}

export { toMember };

export async function isEnrolled(db, studentId, round) {
  const [r] = await db.query(`select ${enrolledSql('st', '$2')} as ok from students st where st.id = $1`, [studentId, round]);
  return !!(r && r.ok);
}

/** その回の班（groups.id）。 */
export async function groupAt(db, studentId, round) {
  const [r] = await db.query(`select ${currentGroupSql('st', '$2')} as g from students st where st.id = $1`, [studentId, round]);
  return r ? r.g : null;
}
