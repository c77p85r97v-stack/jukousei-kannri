// HTTP まわりの共通処理（応答形式・エラー・CSRF 対策・CSV）

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, ...(err.extra || {}) }, err.status);
  }
  console.error('koshu unexpected error:', err && err.stack ? err.stack : String(err));
  return json({ error: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。' }, 500);
}

const MAX_BODY = 4 * 1024 * 1024;

export async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'データが大きすぎます');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'データが大きすぎます');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, '送信データの形式が不正です');
  }
}

/** 書き込み系リクエストの CSRF 対策：同一オリジンの fetch() からだけ受け付ける。 */
export function assertSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, '不正なリクエストです');
  if (origin && origin !== url.origin) throw new HttpError(403, '不正なリクエストです');
  if (request.headers.get('X-Requested-With') !== 'koshu') throw new HttpError(403, '不正なリクエストです');
}

function csvCell(v) {
  if (v == null) return '';
  // 文字の先頭が = + - @ などだと、Excel が数式として実行してしまう。先頭に ' を付けて文字として扱わせる。
  const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8（BOM 付き）の CSV。Excel で文字化けしない。 */
export function csvResponse(filename, rows) {
  const body = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}

export function intParam(url, name, { required = true } = {}) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') {
    if (required) throw new HttpError(400, `${name} を指定してください`);
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} が不正です`);
  return n;
}
