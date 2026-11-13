// 解約・コマ移動（管理者のみ）。削除せず、取り消しとして残す。
import { json, readJson, HttpError, intParam } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normText } from '../lib/normalize.js';
import { groupAt } from '../domain/roster.js';
import { ATTENDED } from '../domain/makeup.js';
import { termOfStudent, assertRound } from './records.js';
import { activeTerm } from './auth.js';

const LABEL_JOIN = `join groups g on g.id = %COL% join slots sl on sl.id = g.slot_id join staff ga on ga.id = g.ga_id`;

async function termIdOf(env, url) {
  return intParam(url, 'termId', { required: false }) ?? (await activeTerm(env))?.id ?? 0;
}

// ---- 解約 ----
async function listWithdrawals(env, req) {
  await requireAdmin(env, req);
  const termId = await termIdOf(env, new URL(req.url));
  return json(
    await env.db.query(
      `select w.id, w.student_id as "studentId", st.name, st.kana, st.nickname, w.from_round as "fromRound", w.reason,
              w.manager_checked_by as "managerCheckedBy", mc.name as "managerCheckedName", w.staff_confirmed as "staffConfirmed",
              w.created_at as "createdAt", w.cancelled_at as "cancelledAt", sl.code as "slotCode", ga.name as "gaName"
         from withdrawals w join students st on st.id = w.student_id
         ${LABEL_JOIN.replace('%COL%', 'st.group_id')}
         left join staff mc on mc.id = w.manager_checked_by
        where st.term_id = $1 order by w.cancelled_at nulls first, w.created_at desc`,
      [termId],
    ),
  );
}

async function addWithdrawal(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const studentId = Number(b.studentId);
  const fromRound = Number(b.fromRound);
  return json(
    await env.db.tx(async t => {
      const term = await termOfStudent(t, studentId);
      assertRound(term, fromRound);
      // 解約した回より後に受けた記録があると食い違うので止める
      const [later] = await t.query('select round from records where student_id=$1 and round >= $2 and attendance = any($3) order by round limit 1', [studentId, fromRound, ATTENDED]);
      if (later) throw new HttpError(409, `第${later.round}回に受けた記録があります。「この回から受けていない」は第${later.round + 1}回以降を選ぶか、記録を直してください`);
      let row;
      try {
        [row] = await t.query('insert into withdrawals(student_id, from_round, reason, created_by) values ($1,$2,$3,$4) returning *', [studentId, fromRound, normText(b.reason), op.id]);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'この受講生はすでに解約登録されています');
        throw e;
      }
      await audit(t, op.id, '解約の登録', 'withdrawals', row.id, null, row);
      return row;
    }),
  );
}

async function updateWithdrawal(env, req, m, kind) {
  const op = await requireAdmin(env, req);
  const id = Number(m[1]);
  return json(
    await env.db.tx(async t => {
      const [before] = await t.query('select * from withdrawals where id=$1 for update', [id]);
      if (!before) throw new HttpError(404, '解約が見つかりません');
      if (before.cancelled_at) throw new HttpError(409, '取り消し済みです');
      const sql = { check: 'manager_checked_by=$2', confirm: 'staff_confirmed=true', cancel: 'cancelled_at=now()' }[kind];
      const [row] = await t.query(`update withdrawals set ${sql} where id=$1 returning *`, kind === 'check' ? [id, op.id] : [id]);
      await audit(t, op.id, { check: '解約の受講生管理確認', confirm: '解約の職員確認', cancel: '解約の取り消し' }[kind], 'withdrawals', id, before, row);
      return row;
    }),
  );
}

// ---- コマ移動 ----
async function listTransfers(env, req) {
  await requireAdmin(env, req);
  const termId = await termIdOf(env, new URL(req.url));
  return json(
    await env.db.query(
      `select tr.id, tr.student_id as "studentId", st.name, st.kana, st.nickname, tr.from_round as "fromRound",
              tr.from_group_id as "fromGroupId", fs.code || ' ' || fga.name as "fromLabel",
              tr.to_group_id as "toGroupId", ts.code || ' ' || tga.name as "toLabel",
              tr.manager_checked_by as "managerCheckedBy", mc.name as "managerCheckedName",
              tr.created_at as "createdAt", tr.cancelled_at as "cancelledAt"
         from transfers tr join students st on st.id = tr.student_id
         join groups fg on fg.id = tr.from_group_id join slots fs on fs.id = fg.slot_id join staff fga on fga.id = fg.ga_id
         join groups tg on tg.id = tr.to_group_id join slots ts on ts.id = tg.slot_id join staff tga on tga.id = tg.ga_id
         left join staff mc on mc.id = tr.manager_checked_by
        where st.term_id = $1 order by tr.cancelled_at nulls first, tr.created_at desc`,
      [termId],
    ),
  );
}

async function addTransfer(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const studentId = Number(b.studentId);
  const fromRound = Number(b.fromRound);
  const toGroupId = Number(b.toGroupId);
  return json(
    await env.db.tx(async t => {
      const term = await termOfStudent(t, studentId);
      assertRound(term, fromRound);
      const [g] = await t.query('select s.term_id from groups g join slots s on s.id=g.slot_id where g.id=$1', [toGroupId]);
      if (!g || g.term_id !== term.id) throw new HttpError(400, '移動先の班を選んでください');
      const fromGroupId = await groupAt(t, studentId, fromRound);
      if (fromGroupId === toGroupId) throw new HttpError(400, '移動先が今の班と同じです');
      const [wd] = await t.query('select from_round from withdrawals where student_id=$1 and cancelled_at is null', [studentId]);
      if (wd && wd.from_round <= fromRound) throw new HttpError(409, `この受講生は第${wd.from_round}回から解約しています。移動するときは先に解約を取り消してください`);
      // 移動先の班が、その後の回の補講先になっていると「自分の班に補講」になるので止める
      const [mk] = await t.query(`select round from makeups where student_id=$1 and round >= $2 and place='他班' and host_group_id=$3 order by round limit 1`, [studentId, fromRound, toGroupId]);
      if (mk) throw new HttpError(409, `第${mk.round}回の補講先が移動先の班になっています。先にその補講の振替先を変えてください`);
      const [row] = await t.query('insert into transfers(student_id, from_group_id, to_group_id, from_round, created_by) values ($1,$2,$3,$4,$5) returning *', [
        studentId, fromGroupId, toGroupId, fromRound, op.id,
      ]);
      await audit(t, op.id, 'コマ移動の登録', 'transfers', row.id, null, row);
      return row;
    }),
  );
}

async function updateTransfer(env, req, m, kind) {
  const op = await requireAdmin(env, req);
  const id = Number(m[1]);
  return json(
    await env.db.tx(async t => {
      const [before] = await t.query('select * from transfers where id=$1 for update', [id]);
      if (!before) throw new HttpError(404, 'コマ移動が見つかりません');
      if (before.cancelled_at) throw new HttpError(409, '取り消し済みです');
      const sql = { check: 'manager_checked_by=$2', cancel: 'cancelled_at=now()' }[kind];
      const [row] = await t.query(`update transfers set ${sql} where id=$1 returning *`, kind === 'check' ? [id, op.id] : [id]);
      await audit(t, op.id, { check: 'コマ移動の受講生管理確認', cancel: 'コマ移動の取り消し' }[kind], 'transfers', id, before, row);
      return row;
    }),
  );
}

export const routes = [
  ['GET', /^\/api\/admin\/withdrawals$/, listWithdrawals],
  ['POST', /^\/api\/admin\/withdrawals$/, addWithdrawal],
  ['POST', /^\/api\/admin\/withdrawals\/(\d+)\/check$/, (e, r, m) => updateWithdrawal(e, r, m, 'check')],
  ['POST', /^\/api\/admin\/withdrawals\/(\d+)\/confirm$/, (e, r, m) => updateWithdrawal(e, r, m, 'confirm')],
  ['POST', /^\/api\/admin\/withdrawals\/(\d+)\/cancel$/, (e, r, m) => updateWithdrawal(e, r, m, 'cancel')],
  ['GET', /^\/api\/admin\/transfers$/, listTransfers],
  ['POST', /^\/api\/admin\/transfers$/, addTransfer],
  ['POST', /^\/api\/admin\/transfers\/(\d+)\/check$/, (e, r, m) => updateTransfer(e, r, m, 'check')],
  ['POST', /^\/api\/admin\/transfers\/(\d+)\/cancel$/, (e, r, m) => updateTransfer(e, r, m, 'cancel')],
];
