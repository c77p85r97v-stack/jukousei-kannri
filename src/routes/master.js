// 年度・コマ・班・スタッフ・受講生
import { json, readJson, HttpError, intParam } from '../lib/http.js';
import { requireAdmin, requireStaff } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normText, SLOT_CODES } from '../lib/normalize.js';
import { hashPin } from '../lib/crypto.js';
import { assertPin } from './auth.js';

function intArray(v, label) {
  if (v == null) return null;
  if (!Array.isArray(v) || !v.every(n => Number.isInteger(n) && n >= 0 && n <= 99)) throw new HttpError(400, `${label}が不正です`);
  return [...new Set(v)].sort((a, b) => a - b);
}

const isUnique = e => e && e.code === '23505';

// ---- 年度 ----
async function listTerms(env, req) {
  await requireAdmin(env, req);
  return json(await env.db.query('select * from terms order by id desc'));
}

async function saveTerm(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const name = normText(b.name);
  if (!name) throw new HttpError(400, '年度の名前を入力してください');
  const rounds = intArray(b.rounds, '回');
  const typing = intArray(b.typingRounds, 'タイピングの回');
  const quiz = intArray(b.quizRounds, 'クイズの回');
  const initial = b.initialCount == null || b.initialCount === '' ? null : Number(b.initialCount);
  if (initial != null && !(Number.isInteger(initial) && initial >= 0)) throw new HttpError(400, '初期受講生数が不正です');
  return json(
    await env.db.tx(async t => {
      let before = null;
      let base = { rounds: [0, 1, 2, 3, 4, 5, 6, 7, 8], typing_rounds: [1, 2, 3, 4, 5, 6, 7, 8], quiz_rounds: [1, 8] };
      if (b.id) {
        [before] = await t.query('select * from terms where id=$1', [b.id]);
        if (!before) throw new HttpError(404, '年度が見つかりません');
        base = before;
      }
      const r = rounds || base.rounds;
      const tr = typing || base.typing_rounds;
      const qr = quiz || base.quiz_rounds;
      if (![...tr, ...qr].every(n => r.includes(n))) throw new HttpError(400, 'タイピング・クイズの回は、回の中から選んでください');
      if ([...tr, ...qr].includes(0)) throw new HttpError(400, '第0回は自由参加なので、タイピング・クイズの回にはできません');
      if (before) {
        // すでに記録がある回を外すと、その記録が画面から見えなくなるので止める
        const used = await t.query(
          `select r.round, bool_or(true) as any, bool_or(r.typing is not null) as typing, bool_or(r.quiz is not null) as quiz
             from records r join students st on st.id = r.student_id where st.term_id = $1 group by r.round order by r.round`,
          [before.id],
        );
        for (const u of used) {
          if (!r.includes(u.round)) throw new HttpError(409, `第${u.round}回にはすでに記録があるので、回から外せません`);
          if (u.typing && !tr.includes(u.round)) throw new HttpError(409, `第${u.round}回にはすでにタイピングの記録があるので、タイピングの回から外せません`);
          if (u.quiz && !qr.includes(u.round)) throw new HttpError(409, `第${u.round}回にはすでにクイズの記録があるので、クイズの回から外せません`);
        }
      }
      if (b.active) await t.query('update terms set active=false where active');
      let row;
      if (before) {
        [row] = await t.query(
          'update terms set name=$1, rounds=$2, typing_rounds=$3, quiz_rounds=$4, initial_count=$5, active=$6 where id=$7 returning *',
          [name, r, tr, qr, initial, b.active == null ? before.active : !!b.active, b.id],
        );
      } else {
        [row] = await t.query('insert into terms(name, rounds, typing_rounds, quiz_rounds, initial_count, active) values ($1,$2,$3,$4,$5,$6) returning *', [
          name, r, tr, qr, initial, !!b.active,
        ]);
        for (const [i, code] of SLOT_CODES.entries()) await t.query('insert into slots(term_id, code, sort) values ($1,$2,$3)', [row.id, code, i]);
      }
      await audit(t, op.id, before ? '年度の変更' : '年度の追加', 'terms', row.id, before, row);
      return row;
    }),
  );
}

// ---- 班 ----
export async function listGroups(db, termId) {
  return db.query(
    `select g.id, g.slot_id as "slotId", s.code as "slotCode", g.ga_id as "gaId", st.name as "gaName", st.active as "gaActive", g.sort
       from groups g join slots s on s.id=g.slot_id join staff st on st.id=g.ga_id
      where s.term_id=$1 order by s.sort, g.sort, st.name`,
    [termId],
  );
}

async function getGroups(env, req) {
  await requireStaff(env, req);
  return json(await listGroups(env.db, intParam(new URL(req.url), 'termId')));
}

async function addGroup(env, req) {
  const op = await requireAdmin(env, req);
  const { slotId, gaId } = await readJson(req);
  return json(
    await env.db.tx(async t => {
      const [ga] = await t.query(`select id from staff where id=$1 and role='ga'`, [gaId]);
      if (!ga) throw new HttpError(400, 'GA を選んでください');
      const [{ n }] = await t.query('select count(*)::int as n from groups where slot_id=$1', [slotId]);
      let row;
      try {
        [row] = await t.query('insert into groups(slot_id, ga_id, sort) values ($1,$2,$3) returning *', [slotId, gaId, n]);
      } catch (e) {
        if (isUnique(e)) throw new HttpError(409, 'このコマにはすでにその GA の班があります');
        if (e.code === '23503') throw new HttpError(400, 'コマが見つかりません');
        throw e;
      }
      await audit(t, op.id, '班の追加', 'groups', row.id, null, row);
      return row;
    }),
  );
}

async function deleteGroup(env, req, m) {
  const op = await requireAdmin(env, req);
  const id = Number(m[1]);
  await env.db.tx(async t => {
    const [g] = await t.query('select * from groups where id=$1', [id]);
    if (!g) throw new HttpError(404, '班が見つかりません');
    const [{ n }] = await t.query(
      `select (select count(*) from students where group_id=$1) + (select count(*) from transfers where to_group_id=$1 or from_group_id=$1)
            + (select count(*) from makeups where host_group_id=$1) as n`,
      [id],
    );
    if (Number(n) > 0) throw new HttpError(409, '受講生・移動・補講の記録がある班は削除できません');
    await t.query('delete from groups where id=$1', [id]);
    await audit(t, op.id, '班の削除', 'groups', id, g, null);
  });
  return json({ ok: true });
}

// ---- スタッフ ----
async function listStaff(env, req) {
  await requireAdmin(env, req);
  return json(
    await env.db.query(
      `select id, name, role, active, (pin_hash is not null) as "hasPin", (locked_until > now()) as locked from staff order by active desc, role desc, name`,
    ),
  );
}

const publicStaff = s => s && { id: s.id, name: s.name, role: s.role, active: s.active };

async function saveStaff(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const name = normText(b.name);
  if (!name) throw new HttpError(400, '名前を入力してください');
  if (!['ga', 'admin'].includes(b.role)) throw new HttpError(400, '役割を選んでください');
  return json(
    await env.db.tx(async t => {
      let before = null;
      let row;
      try {
        if (b.id) {
          [before] = await t.query('select * from staff where id=$1', [b.id]);
          if (!before) throw new HttpError(404, 'スタッフが見つかりません');
          if (before.id === op.id && (b.active === false || b.role !== 'admin')) throw new HttpError(400, '自分自身を無効化・GA に変更することはできません');
          [row] = await t.query('update staff set name=$1, role=$2, active=$3 where id=$4 returning *', [name, b.role, b.active !== false, b.id]);
        } else {
          [row] = await t.query('insert into staff(name, role) values ($1,$2) returning *', [name, b.role]);
        }
      } catch (e) {
        if (isUnique(e)) throw new HttpError(409, '同じ名前のスタッフがすでにいます');
        throw e;
      }
      await audit(t, op.id, before ? 'スタッフの変更' : 'スタッフの追加', 'staff', row.id, publicStaff(before), publicStaff(row));
      return publicStaff(row);
    }),
  );
}

async function setPin(env, req, m) {
  const op = await requireAdmin(env, req);
  const { pin } = await readJson(req);
  assertPin(pin);
  const hash = await hashPin(env, String(pin));
  await env.db.tx(async t => {
    const [s] = await t.query(`update staff set pin_hash=$1, failed_logins=0, locked_until=null where id=$2 and role='admin' returning id`, [hash, Number(m[1])]);
    if (!s) throw new HttpError(400, '暗証番号は管理者にだけ設定できます');
    await audit(t, op.id, '暗証番号の設定', 'staff', s.id, null, null);
  });
  return json({ ok: true });
}

async function unlock(env, req, m) {
  const op = await requireAdmin(env, req);
  await env.db.tx(async t => {
    await t.query('update staff set failed_logins=0, locked_until=null where id=$1', [Number(m[1])]);
    await audit(t, op.id, 'ロック解除', 'staff', Number(m[1]), null, null);
  });
  return json({ ok: true });
}

// ---- 受講生 ----
async function listStudents(env, req) {
  await requireAdmin(env, req);
  const url = new URL(req.url);
  const termId = intParam(url, 'termId');
  const q = normText(url.searchParams.get('q'));
  const like = q ? `%${q}%` : null;
  return json(
    await env.db.query(
      `select st.id, st.name, st.kana, st.nickname, st.group_id as "groupId", s.code as "slotCode", ga.name as "gaName"
         from students st join groups g on g.id=st.group_id join slots s on s.id=g.slot_id join staff ga on ga.id=g.ga_id
        where st.term_id=$1 and ($2::text is null or st.name like $2 or st.kana like $2 or st.nickname like $2)
        order by s.sort, g.sort, st.kana nulls last, st.name`,
      [termId, like],
    ),
  );
}

async function saveStudent(env, req) {
  const op = await requireAdmin(env, req);
  const b = await readJson(req);
  const name = normText(b.name);
  if (!name) throw new HttpError(400, '名前を入力してください');
  return json(
    await env.db.tx(async t => {
      const [g] = await t.query('select s.term_id from groups g join slots s on s.id=g.slot_id where g.id=$1', [b.groupId]);
      if (!g) throw new HttpError(400, '班を選んでください');
      const vals = [name, normText(b.kana), normText(b.nickname), b.groupId];
      let before = null;
      let row;
      if (b.id) {
        [before] = await t.query('select * from students where id=$1', [b.id]);
        if (!before) throw new HttpError(404, '受講生が見つかりません');
        [row] = await t.query('update students set name=$1, kana=$2, nickname=$3, group_id=$4 where id=$5 returning *', [...vals, b.id]);
      } else {
        [row] = await t.query('insert into students(name, kana, nickname, group_id, term_id) values ($1,$2,$3,$4,$5) returning *', [...vals, g.term_id]);
      }
      await audit(t, op.id, before ? '受講生の変更' : '受講生の追加', 'students', row.id, before, row);
      return row;
    }),
  );
}

export const routes = [
  ['GET', /^\/api\/admin\/terms$/, listTerms],
  ['POST', /^\/api\/admin\/terms$/, saveTerm],
  ['GET', /^\/api\/groups$/, getGroups],
  ['POST', /^\/api\/admin\/groups$/, addGroup],
  ['POST', /^\/api\/admin\/groups\/(\d+)\/delete$/, deleteGroup],
  ['GET', /^\/api\/admin\/staff$/, listStaff],
  ['POST', /^\/api\/admin\/staff$/, saveStaff],
  ['POST', /^\/api\/admin\/staff\/(\d+)\/pin$/, setPin],
  ['POST', /^\/api\/admin\/staff\/(\d+)\/unlock$/, unlock],
  ['GET', /^\/api\/admin\/students$/, listStudents],
  ['POST', /^\/api\/admin\/students$/, saveStudent],
];
