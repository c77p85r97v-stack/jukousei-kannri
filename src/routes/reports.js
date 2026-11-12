// 集計・検索・操作履歴・CSV
import { json, HttpError, intParam, csvResponse } from '../lib/http.js';
import { requireStaff, requireAdmin } from '../lib/auth.js';
import { computeStats } from '../domain/stats.js';
import { currentGroupSql, rosterFor } from '../domain/roster.js';
import { makeupStatus } from '../domain/makeup.js';
import { normText } from '../lib/normalize.js';
import { activeTerm } from './auth.js';
import { publicRecord } from './records.js';

export async function termIdFrom(env, url) {
  const id = intParam(url, 'termId', { required: false }) ?? (await activeTerm(env))?.id;
  if (!id) throw new HttpError(400, '年度がまだ作られていません');
  return id;
}

async function loadTerm(env, url) {
  const [term] = await env.db.query('select * from terms where id=$1', [await termIdFrom(env, url)]);
  if (!term) throw new HttpError(404, '年度が見つかりません');
  return term;
}

const lastRoundSql = `(select max(x) from unnest(t.rounds) x)`;
// 受講生の最新（最後の回時点）の班のラベル
const STUDENT_SELECT = `
  select st.id, st.name, st.kana, st.nickname, hg.id as "homeGroupId", hs.code || ' ' || hga.name as "homeLabel",
         hs.code as "slotCode", hga.name as "gaName", hs.sort as slot_sort, hg.sort as group_sort
    from students st join terms t on t.id = st.term_id
    join groups hg on hg.id = ${currentGroupSql('st', lastRoundSql)}
    join slots hs on hs.id = hg.slot_id join staff hga on hga.id = hg.ga_id`;

async function stats(env, req) {
  await requireStaff(env, req);
  const st = await computeStats(env.db, await termIdFrom(env, new URL(req.url)));
  if (!st) throw new HttpError(404, '年度が見つかりません');
  return json(st);
}

// ---- 検索 ----
async function search(env, req) {
  await requireStaff(env, req);
  const url = new URL(req.url);
  const q = normText(url.searchParams.get('q'));
  if (!q) return json([]);
  const termId = await termIdFrom(env, url);
  const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`;
  const rows = await env.db.query(
    `${STUDENT_SELECT}
      where st.term_id = $1 and (st.name like $2 or st.kana like $2 or st.nickname like $2)
      order by st.kana nulls last, st.name limit 50`,
    [termId, like],
  );
  return json(rows.map(({ slot_sort, group_sort, ...r }) => r));
}

async function history(env, req, m) {
  await requireStaff(env, req);
  const id = Number(m[1]);
  const [student] = await env.db.query(`${STUDENT_SELECT} where st.id = $1`, [id]);
  if (!student) throw new HttpError(404, '受講生が見つかりません');
  delete student.slot_sort;
  delete student.group_sort;
  const recs = (await env.db.query('select * from records where student_id=$1 order by round', [id])).map(publicRecord);
  const byRound = new Map(recs.map(r => [r.round, r]));
  const makeups = (
    await env.db.query(
      `select m.round, m.place, m.failed, m.version, m.host_group_id as "hostGroupId", s.code || ' ' || ga.name as "hostLabel"
         from makeups m left join groups g on g.id = m.host_group_id left join slots s on s.id = g.slot_id left join staff ga on ga.id = g.ga_id
        where m.student_id = $1 order by m.round`,
      [id],
    )
  ).map(mk => ({ ...mk, status: makeupStatus(mk, byRound.get(mk.round)) }));
  const transfers = await env.db.query(
    `select tr.id, tr.from_round as "fromRound", fs.code || ' ' || fga.name as "fromLabel", ts.code || ' ' || tga.name as "toLabel", tr.cancelled_at as "cancelledAt"
       from transfers tr
       join groups fg on fg.id = tr.from_group_id join slots fs on fs.id = fg.slot_id join staff fga on fga.id = fg.ga_id
       join groups tg on tg.id = tr.to_group_id join slots ts on ts.id = tg.slot_id join staff tga on tga.id = tg.ga_id
      where tr.student_id = $1 and tr.cancelled_at is null order by tr.from_round, tr.id`,
    [id],
  );
  const [withdrawal] = await env.db.query(
    `select id, from_round as "fromRound", reason, staff_confirmed as "staffConfirmed" from withdrawals where student_id=$1 and cancelled_at is null`,
    [id],
  );
  return json({ student, records: recs, makeups, transfers, withdrawal: withdrawal || null });
}

// ---- 操作履歴 ----
async function auditList(env, req) {
  await requireAdmin(env, req);
  const url = new URL(req.url);
  const limit = Math.min(Math.max(intParam(url, 'limit', { required: false }) ?? 100, 1), 500);
  const beforeId = intParam(url, 'beforeId', { required: false });
  const operatorId = intParam(url, 'operatorId', { required: false });
  const action = normText(url.searchParams.get('action'));
  return json(
    await env.db.query(
      `select a.id, a.at, a.operator_id as "operatorId", s.name as "operatorName", a.action, a.target_table as "targetTable",
              a.target_id as "targetId", a.before_json as before, a.after_json as after
         from audit_log a left join staff s on s.id = a.operator_id
        where ($1::bigint is null or a.id < $1) and ($2::int is null or a.operator_id = $2) and ($3::text is null or a.action = $3)
        order by a.id desc limit $4`,
      [beforeId, operatorId, action, limit],
    ),
  );
}

// ---- CSV ----
async function recordsCsv(env, req) {
  await requireStaff(env, req);
  const term = await loadTerm(env, new URL(req.url));
  const students = await env.db.query(`${STUDENT_SELECT} where st.term_id = $1 order by hs.sort, hg.sort, st.kana nulls last, st.name`, [term.id]);
  const recs = await env.db.query('select r.* from records r join students st on st.id = r.student_id where st.term_id = $1', [term.id]);
  const map = new Map(recs.map(r => [`${r.student_id}:${r.round}`, r]));
  const header = ['コマ', 'GA', '名前', 'ヨミ', 'ニックネーム'];
  for (const r of term.rounds) header.push(`第${r}回出欠`, `第${r}回タイピング`, `第${r}回クイズ`, `第${r}回メモ`);
  const rows = [header];
  for (const s of students) {
    const row = [s.slotCode, s.gaName, s.name, s.kana, s.nickname];
    for (const r of term.rounds) {
      const x = map.get(`${s.id}:${r}`);
      row.push(x?.attendance, x?.typing == null ? null : Number(x.typing), x?.quiz, x?.note);
    }
    rows.push(row);
  }
  return csvResponse(`記録_${term.name}.csv`, rows);
}

async function rosterCsv(env, req) {
  await requireStaff(env, req);
  const url = new URL(req.url);
  const term = await loadTerm(env, url);
  const round = intParam(url, 'round');
  if (!term.rounds.includes(round)) throw new HttpError(400, '回が不正です');
  const slots = await env.db.query('select id, code from slots where term_id=$1 order by sort', [term.id]);
  const rows = [['コマ', 'GA', '区分', '名前', 'ヨミ', 'ニックネーム', '出欠', 'タイピング', 'クイズ', 'メモ', '補講先・元の班']];
  for (const slot of slots) {
    for (const g of await rosterFor(env.db, { termId: term.id, slotId: slot.id, round })) {
      const line = (m, kind, extra) => rows.push([slot.code, g.gaName, kind, m.name, m.kana, m.nickname, m.record?.attendance, m.record?.typing, m.record?.quiz, m.record?.note, extra]);
      for (const m of g.members) line(m, '班員', m.makeup ? `補講先：${m.makeup.hostLabel || m.makeup.place}` : null);
      for (const m of g.guests) line(m, '補講で来る人', `元の班：${m.homeLabel}`);
    }
  }
  return csvResponse(`名簿_第${round}回.csv`, rows);
}

const pct = v => (v == null ? '' : `${(v * 100).toFixed(1)}%`);
const fix1 = v => (v == null ? '' : v.toFixed(1));

async function statsCsv(env, req) {
  await requireStaff(env, req);
  const term = await loadTerm(env, new URL(req.url));
  const st = await computeStats(env.db, term.id);
  const rows = [
    ['指標', '値'],
    ['初期受講生数', st.initialCount],
    ['解約者数', st.withdrawn],
    ['継続率', pct(st.retentionRate)],
    ['継続率（最初の回から未受講の解約を除く）', pct(st.retentionRateExclNeverAttended)],
    ['解約率', pct(st.withdrawalRate)],
    ['コマ移動数', st.transfers],
    [],
    ['回', '在籍', '受講', '受講率'],
    ...term.rounds.map(r => [`第${r}回`, st.attendanceRate[r].enrolled, st.attendanceRate[r].attended, pct(st.attendanceRate[r].rate)]),
    [],
    ['コマ', 'GA', '班人数', 'タイピング伸び平均', '改善した人の割合', 'クイズ伸び平均'],
    ...st.groups.map(g => [g.slotCode, g.gaName, g.size, fix1(g.typingGainAvg), pct(g.typingImprovedRatio), fix1(g.quizGainAvg)]),
  ];
  return csvResponse(`集計_${term.name}.csv`, rows);
}

export const routes = [
  ['GET', /^\/api\/stats$/, stats],
  ['GET', /^\/api\/students\/search$/, search],
  ['GET', /^\/api\/students\/(\d+)\/history$/, history],
  ['GET', /^\/api\/admin\/audit$/, auditList],
  ['GET', /^\/api\/export\/records\.csv$/, recordsCsv],
  ['GET', /^\/api\/export\/roster\.csv$/, rosterCsv],
  ['GET', /^\/api\/export\/stats\.csv$/, statsCsv],
];
