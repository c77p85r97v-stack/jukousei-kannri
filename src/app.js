// API の入口：Web 標準の Request を受け取り Response を返す。
import { json, errorResponse, assertSameOrigin, HttpError } from './lib/http.js';
import * as auth from './routes/auth.js';
import * as master from './routes/master.js';
import * as importer from './routes/importer.js';
import * as records from './routes/records.js';
import * as makeups from './routes/makeups.js';
import * as changes from './routes/changes.js';
import * as reports from './routes/reports.js';
import * as maintenance from './routes/maintenance.js';
import * as indiv from './routes/indiv.js';
import * as line from './routes/line.js';
import * as sheet from './routes/sheet.js';

// [メソッド, パス(正規表現), 処理(env, req, match)]
export const ROUTES = [
  ['GET', /^\/api\/health$/, async () => json({ ok: true })],
  ...auth.routes,
  ...master.routes,
  ...indiv.routes,
  ...line.routes,
  ...sheet.routes,
  ...importer.routes,
  ...records.routes,
  ...makeups.routes,
  ...changes.routes,
  ...reports.routes,
  ...maintenance.routes,
];

export function addRoutes(list) {
  ROUTES.push(...list);
}

export async function handle(request, env) {
  try {
    const url = new URL(request.url);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (method === 'POST') assertSameOrigin(request);
    for (const [m, re, fn] of ROUTES) {
      if (m !== method) continue;
      const match = url.pathname.match(re);
      if (match) return await fn(env, request, match);
    }
    throw new HttpError(404, '見つかりません');
  } catch (e) {
    return errorResponse(e);
  }
}
