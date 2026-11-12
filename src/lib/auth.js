// ログイン状態（署名付き Cookie。サーバーには保存しない）
// GA：     koshu_sid   = s1.<id>.<有効期限>.<署名>
// 管理者： koshu_admin = a1.<id>.<有効期限>.<暗証番号の指紋>.<署名>
//   暗証番号を変えると指紋が変わり、古いログインは使えなくなる。
import { HttpError } from './http.js';
import { hmacSign, safeEqual, sha256 } from './crypto.js';

export const GA_COOKIE = 'koshu_sid';
export const ADMIN_COOKIE = 'koshu_admin';
export const TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60 * 1000;

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookieHeader(name, value, maxAgeSec) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export function clearCookies() {
  return [cookieHeader(GA_COOKIE, '', 0), cookieHeader(ADMIN_COOKIE, '', 0)];
}

const pinTag = async hash => (await sha256(hash || '')).slice(0, 12);

export async function gaCookie(env, staffId) {
  const body = `s1.${staffId}.${Date.now() + TTL_MS}`;
  return cookieHeader(GA_COOKIE, `${body}.${await hmacSign(env, body, 'ga')}`, TTL_MS / 1000);
}

export async function adminCookie(env, staffId, pinHash) {
  const body = `a1.${staffId}.${Date.now() + TTL_MS}.${await pinTag(pinHash)}`;
  return cookieHeader(ADMIN_COOKIE, `${body}.${await hmacSign(env, body, 'admin')}`, TTL_MS / 1000);
}

async function verify(env, token, prefix, purpose) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts[0] !== prefix) return null;
  const sig = parts.pop();
  const body = parts.join('.');
  if (!safeEqual(sig, await hmacSign(env, body, purpose))) return null;
  if (!(Number(parts[2]) > Date.now())) return null;
  return { id: Number(parts[1]), tag: parts[3] };
}

async function loadStaff(env, id) {
  const [s] = await env.db.query('select id, name, role, pin_hash, active from staff where id=$1', [id]);
  return s && s.active ? s : null;
}

/** 管理者としてログインしていればその人、いなければ null。 */
export async function currentAdmin(env, request) {
  const v = await verify(env, readCookie(request, ADMIN_COOKIE), 'a1', 'admin');
  if (!v) return null;
  const s = await loadStaff(env, v.id);
  if (!s || s.role !== 'admin') return null;
  if (!safeEqual(v.tag, await pinTag(s.pin_hash))) return null;
  return { id: s.id, name: s.name, role: 'admin' };
}

/** GA か管理者。どちらでもなければ 401。 */
export async function requireStaff(env, request) {
  const admin = await currentAdmin(env, request);
  if (admin) return admin;
  const v = await verify(env, readCookie(request, GA_COOKIE), 's1', 'ga');
  if (v) {
    const s = await loadStaff(env, v.id);
    if (s) return { id: s.id, name: s.name, role: s.role };
  }
  throw new HttpError(401, 'ログインしてください');
}

/** 管理者のみ。GA なら 403、未ログインなら 401。 */
export async function requireAdmin(env, request) {
  const admin = await currentAdmin(env, request);
  if (admin) return admin;
  await requireStaff(env, request); // 未ログインなら 401
  throw new HttpError(403, '管理者のみ使えます');
}
