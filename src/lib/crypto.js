// 暗証番号のハッシュ・署名
import { HttpError } from './http.js';

const te = new TextEncoder();
const ITER = 100000;

export function pepper(env) {
  if (env.PIN_PEPPER && String(env.PIN_PEPPER).length >= 16) return String(env.PIN_PEPPER);
  if (env.ENVIRONMENT === 'production') throw new HttpError(500, 'サーバー設定が未完了です（PIN_PEPPER）。');
  return 'koshu-local-development-pepper';
}

export const b64u = buf =>
  Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function pbkdf2(env, pin, salt) {
  const key = await crypto.subtle.importKey('raw', te.encode(pepper(env) + '\u0000' + pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
}

/** 形式：pbkdf2$<回数>$<salt>$<hash> */
export async function hashPin(env, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64u(salt)}$${b64u(await pbkdf2(env, pin, salt))}`;
}

export async function verifyPin(env, pin, stored) {
  if (!stored) return false;
  const [kind, , saltS, hashS] = stored.split('$');
  if (kind !== 'pbkdf2') return false;
  const salt = Buffer.from(saltS.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return safeEqual(b64u(await pbkdf2(env, pin, salt)), hashS);
}

export async function hmacSign(env, text, purpose) {
  const key = await crypto.subtle.importKey('raw', te.encode(pepper(env) + '\u0000' + purpose), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, te.encode(text)));
}

export async function sha256(text) {
  return b64u(await crypto.subtle.digest('SHA-256', te.encode(text)));
}
