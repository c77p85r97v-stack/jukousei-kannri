// バックアップ・復元・初期化・毎日の自動バックアップ
// バックアップの実体は Blob（非公開）に置く JSON。一覧は Blob を正とする（データベースが壊れても残る）。
import { json, readJson, HttpError } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';

// 外部キーの順（親 → 子）
const TABLES = ['terms', 'slots', 'staff', 'groups', 'students', 'records', 'makeups', 'withdrawals', 'transfers', 'audit_log'];
const PREFIX = 'backups/';
const KINDS = { auto: '自動', manual: '手動', 'pre-restore': '復元前', 'pre-reset': '初期化前' };
const KEEP_DAYS = 30;

export async function dumpAll(db) {
  const tables = {};
  for (const t of TABLES) tables[t] = await db.query(`select * from ${t} order by id`);
  return JSON.parse(JSON.stringify({ version: 1, at: new Date().toISOString(), tables }));
}

/** 全表を空にして入れ直す。t はトランザクション。 */
export async function restoreAll(t, dump) {
  if (!dump || dump.version !== 1 || !dump.tables) throw new HttpError(400, 'バックアップの形式が違います');
  await t.exec(`truncate ${[...TABLES, 'request_ids'].join(', ')} restart identity cascade`);
  for (const name of TABLES) {
    const rows = dump.tables[name] || [];
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      if (!cols.every(c => /^[a-z_]+$/.test(c))) throw new HttpError(400, 'バックアップの形式が違います');
      const list = cols.join(', ');
      for (let i = 0; i < rows.length; i += 2000) {
        await t.query(`insert into ${name} (${list}) select ${list} from jsonb_populate_recordset(null::${name}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 2000))]);
      }
    }
    await t.query(`select setval(pg_get_serial_sequence('${name}', 'id'), coalesce((select max(id) from ${name}), 0) + 1, false)`);
  }
}

function blobOf(env) {
  if (!env.blob) throw new HttpError(503, 'バックアップの保存先が設定されていません');
  return env.blob;
}

const kindOfKey = key => KINDS[key.slice(PREFIX.length).replace(/\.json$/, '').split('_')[1]] || '不明';

export async function takeBackup(env, kindCode) {
  const dump = await dumpAll(env.db);
  const body = JSON.stringify(dump);
  const key = `${PREFIX}${dump.at.replace(/[:.]/g, '-')}_${kindCode}.json`;
  await blobOf(env).put(key, body);
  return { key, kind: KINDS[kindCode], at: dump.at, size: body.length };
}

async function listBackups(env) {
  const items = await blobOf(env).list(PREFIX);
  return items
    .map(i => ({ key: i.key, kind: kindOfKey(i.key), at: new Date(i.uploadedAt).toISOString(), size: i.size }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1));
}

async function readBackup(env, key) {
  if (typeof key !== 'string' || !key.startsWith(PREFIX) || key.includes('..')) throw new HttpError(404, 'バックアップが見つかりません');
  try {
    return JSON.parse(await blobOf(env).get(key));
  } catch {
    throw new HttpError(404, 'バックアップが見つかりません');
  }
}

async function create(env, req) {
  const op = await requireAdmin(env, req);
  const b = await takeBackup(env, 'manual');
  await env.db.tx(t => audit(t, op.id, '手動バックアップ', null, b.key, null, null));
  return json(b);
}

async function list(env, req) {
  await requireAdmin(env, req);
  return json(await listBackups(env));
}

async function download(env, req) {
  await requireAdmin(env, req);
  const key = new URL(req.url).searchParams.get('key');
  const dump = await readBackup(env, key);
  return json(dump, 200, { 'Content-Disposition': `attachment; filename="${key.slice(PREFIX.length)}"` });
}

async function restore(env, req) {
  const op = await requireAdmin(env, req);
  const { key, confirm } = await readJson(req);
  if (confirm !== '復元') throw new HttpError(400, '確認のため「復元」と入力してください');
  const dump = await readBackup(env, key);
  const pre = await takeBackup(env, 'pre-restore');
  await env.db.tx(async t => {
    await restoreAll(t, dump);
    await audit(t, op.id, '復元', null, key, null, { restoredFrom: key, backupBefore: pre.key });
  });
  return json({ ok: true, backupBefore: pre.key });
}

const RESET_TABLES = ['records', 'makeups', 'withdrawals', 'transfers'];

async function resetPreview(env, req) {
  await requireAdmin(env, req);
  const out = {};
  for (const t of [...RESET_TABLES, 'audit_log', 'students', 'groups']) out[t] = (await env.db.query(`select count(*)::int as n from ${t}`))[0].n;
  return json(out);
}

async function reset(env, req) {
  const op = await requireAdmin(env, req);
  const { confirm, includeRoster } = await readJson(req);
  if (confirm !== '初期化') throw new HttpError(400, '確認のため「初期化」と入力してください');
  const pre = await takeBackup(env, 'pre-reset');
  await env.db.tx(async t => {
    const tables = [...RESET_TABLES, 'audit_log', 'request_ids', ...(includeRoster ? ['students', 'groups'] : [])];
    await t.exec(`truncate ${tables.join(', ')} restart identity cascade`);
    await audit(t, op.id, '初期化', null, null, null, { includeRoster: !!includeRoster, backupBefore: pre.key });
  });
  return json({ ok: true, backupBefore: pre.key });
}

async function cron(env, req) {
  const auth = req.headers.get('Authorization') || '';
  if (!env.CRON_SECRET || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) throw new HttpError(401, '認証が必要です');
  const b = await takeBackup(env, 'auto');
  const limit = Date.now() - KEEP_DAYS * 24 * 3600e3;
  let deleted = 0;
  for (const i of await blobOf(env).list(PREFIX)) {
    if (i.key !== b.key && kindOfKey(i.key) === '自動' && new Date(i.uploadedAt).getTime() < limit) {
      await blobOf(env).del(i.key);
      deleted++;
    }
  }
  return json({ ok: true, key: b.key, deleted });
}

export const routes = [
  ['GET', /^\/api\/admin\/backups$/, list],
  ['POST', /^\/api\/admin\/backups$/, create],
  ['GET', /^\/api\/admin\/backups\/download$/, download],
  ['POST', /^\/api\/admin\/backups\/restore$/, restore],
  ['GET', /^\/api\/admin\/reset$/, resetPreview],
  ['POST', /^\/api\/admin\/reset$/, reset],
  ['GET', /^\/api\/cron\/backup$/, cron],
];
