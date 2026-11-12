// 集計・検索・操作履歴・CSV
import { json, HttpError, intParam } from '../lib/http.js';
import { requireStaff } from '../lib/auth.js';
import { computeStats } from '../domain/stats.js';
import { activeTerm } from './auth.js';

export async function termIdFrom(env, url) {
  const id = intParam(url, 'termId', { required: false }) ?? (await activeTerm(env))?.id;
  if (!id) throw new HttpError(400, '年度がまだ作られていません');
  return id;
}

async function stats(env, req) {
  await requireStaff(env, req);
  const st = await computeStats(env.db, await termIdFrom(env, new URL(req.url)));
  if (!st) throw new HttpError(404, '年度が見つかりません');
  return json(st);
}

export const routes = [['GET', /^\/api\/stats$/, stats]];
