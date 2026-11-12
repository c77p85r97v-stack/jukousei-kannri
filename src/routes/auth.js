// ログイン・ログアウト・初期設定
import { json, readJson, HttpError } from '../lib/http.js';
import { hashPin, verifyPin, safeEqual } from '../lib/crypto.js';
import { gaCookie, adminCookie, clearCookies, requireStaff, requireAdmin, MAX_FAILED, LOCK_MS } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normText } from '../lib/normalize.js';

const PIN_RE = /^\d{4,8}$/;

export function assertPin(pin) {
  if (!PIN_RE.test(String(pin ?? ''))) throw new HttpError(400, '暗証番号は数字4〜8桁で入力してください');
}

export async function activeTerm(env) {
  const [term] = await env.db.query('select id, name, rounds, typing_rounds, quiz_rounds, initial_count from terms where active');
  return term || null;
}

async function bootstrap(env) {
  const staff = await env.db.query(`select id, name, role from staff where active order by role desc, name`);
  const term = await activeTerm(env);
  const slots = term ? await env.db.query('select id, code, sort from slots where term_id=$1 order by sort', [term.id]) : [];
  return json({ staff, term, slots });
}

async function login(env, req) {
  const { staffId } = await readJson(req);
  const [s] = await env.db.query('select id, name, role, active from staff where id=$1', [Number(staffId)]);
  if (!s || !s.active) throw new HttpError(400, '名前を選んでください');
  if (s.role === 'admin') throw new HttpError(400, '管理者は暗証番号でログインしてください');
  return json({ id: s.id, name: s.name, role: 'ga' }, 200, { 'Set-Cookie': await gaCookie(env, s.id) });
}

async function adminLogin(env, req) {
  const { staffId, pin } = await readJson(req);
  assertPin(pin);
  const [s] = await env.db.query(`select * from staff where id=$1 and role='admin' and active`, [Number(staffId)]);
  if (!s) throw new HttpError(401, '名前または暗証番号が違います');
  if (s.locked_until && new Date(s.locked_until) > new Date()) {
    throw new HttpError(423, '暗証番号を続けて間違えたため、15分間ログインできません');
  }
  if (!(await verifyPin(env, String(pin), s.pin_hash))) {
    const failed = s.failed_logins + 1;
    const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null;
    await env.db.query('update staff set failed_logins=$1, locked_until=$2 where id=$3', [lock ? 0 : failed, lock, s.id]);
    throw new HttpError(401, '名前または暗証番号が違います');
  }
  await env.db.query('update staff set failed_logins=0, locked_until=null where id=$1', [s.id]);
  return json({ id: s.id, name: s.name, role: 'admin' }, 200, { 'Set-Cookie': await adminCookie(env, s.id, s.pin_hash) });
}

function logout() {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of clearCookies()) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

async function setupStatus(env) {
  const [r] = await env.db.query(`select count(*)::int as n from staff where role='admin'`);
  return json({ needed: r.n === 0 });
}

async function setup(env, req) {
  const { token, name, pin } = await readJson(req);
  if (!env.ADMIN_SETUP_TOKEN || !safeEqual(String(token || ''), env.ADMIN_SETUP_TOKEN)) throw new HttpError(403, '合言葉が違います');
  const n = normText(name);
  if (!n) throw new HttpError(400, '名前を入力してください');
  assertPin(pin);
  const hash = await hashPin(env, String(pin));
  const s = await env.db.tx(async t => {
    const [c] = await t.query(`select count(*)::int as n from staff where role='admin'`);
    if (c.n > 0) throw new HttpError(409, '初期設定はすでに済んでいます');
    const [row] = await t.query(`insert into staff(name, role, pin_hash) values ($1,'admin',$2) returning id, name`, [n, hash]);
    await audit(t, row.id, '初期設定', 'staff', row.id, null, { name: n, role: 'admin' });
    return row;
  });
  return json({ id: s.id, name: s.name, role: 'admin' }, 200, { 'Set-Cookie': await adminCookie(env, s.id, hash) });
}

export const routes = [
  ['GET', /^\/api\/bootstrap$/, env => bootstrap(env)],
  ['POST', /^\/api\/login$/, (env, req) => login(env, req)],
  ['POST', /^\/api\/admin\/login$/, (env, req) => adminLogin(env, req)],
  ['POST', /^\/api\/logout$/, () => logout()],
  ['GET', /^\/api\/me$/, async (env, req) => json(await requireStaff(env, req))],
  ['GET', /^\/api\/admin\/me$/, async (env, req) => json(await requireAdmin(env, req))],
  ['GET', /^\/api\/admin\/setup$/, env => setupStatus(env)],
  ['POST', /^\/api\/admin\/setup$/, (env, req) => setup(env, req)],
];
