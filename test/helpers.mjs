// テスト用の共通処理
import { createPgliteDb, migrate } from '../src/db.js';

export const SLOT_CODES = ['月', '火1', '火2', '水1', '水2', '木1', '木2', '金1', '金2'];

// 1つのテストファイル（＝1プロセス）で PGlite を1つだけ作り、テストごとに全表を空にする。
let shared = null;
export async function newEnv(extra = {}) {
  if (!shared) {
    shared = await createPgliteDb();
    await migrate(shared);
  }
  const db = shared;
  const tables = (await db.query(`select tablename from pg_tables where schemaname='public' and tablename <> 'schema_migrations'`)).map(r => r.tablename);
  await db.exec(`truncate ${tables.join(', ')} restart identity cascade`);
  return {
    db,
    PIN_PEPPER: 'test-pepper-0123456789abcdef',
    ADMIN_SETUP_TOKEN: 'setup-token',
    CRON_SECRET: 'cron-secret',
    ENVIRONMENT: 'test',
    ...extra,
  };
}

/**
 * 年度1・コマ9・GA 3人（A,B,C）・管理者1人（暗証番号は env.ADMIN_PIN_HASH があればそれ）
 * 月の班 A と B、火1 の班 C、受講生6人（月A:3, 月B:2, 火1C:1）
 */
export async function seed(env, { adminPinHash = null } = {}) {
  const db = env.db;
  const [term] = await db.query(`insert into terms(name, active) values ('2027年度PC講習会', true) returning *`);
  const slots = {};
  for (const [i, code] of SLOT_CODES.entries()) {
    const [s] = await db.query('insert into slots(term_id, code, sort) values ($1,$2,$3) returning *', [term.id, code, i]);
    slots[code] = s;
  }
  const ga = {};
  for (const name of ['A', 'B', 'C']) {
    const [s] = await db.query(`insert into staff(name, role) values ($1, 'ga') returning *`, [name]);
    ga[name] = s;
  }
  const [admin] = await db.query(`insert into staff(name, role, pin_hash) values ('管理者', 'admin', $1) returning *`, [adminPinHash]);
  const groups = {};
  const mk = async (key, code, gaName, sort) => {
    const [g] = await db.query('insert into groups(slot_id, ga_id, sort) values ($1,$2,$3) returning *', [slots[code].id, ga[gaName].id, sort]);
    groups[key] = g;
  };
  await mk('月A', '月', 'A', 0);
  await mk('月B', '月', 'B', 1);
  await mk('火1C', '火1', 'C', 0);
  const students = [];
  const add = async (name, kana, nick, gkey) => {
    const [s] = await db.query('insert into students(term_id, name, kana, nickname, group_id) values ($1,$2,$3,$4,$5) returning *', [term.id, name, kana, nick, groups[gkey].id]);
    students.push(s);
  };
  await add('青木 一', 'アオキ ハジメ', 'はじめ', '月A');
  await add('井上 二', 'イノウエ ジ', 'じ', '月A');
  await add('上田 三', 'ウエダ サン', 'さん', '月A');
  await add('江藤 四', 'エトウ シ', 'し', '月B');
  await add('小川 五', 'オガワ ゴ', 'ご', '月B');
  await add('加藤 六', 'カトウ ロク', 'ろく', '火1C');
  return { term, slots, ga, admin, groups, students };
}

/**
 * API を呼ぶ。cookie は前回の応答の cookie（文字列）を渡す。
 * 戻り値：{ status, body, cookie, res }
 */
export async function call(env, method, path, body, cookie) {
  const { handle } = await import('../src/app.js');
  const headers = { 'X-Requested-With': 'koshu' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const set = res.headers.get('Set-Cookie');
  // res.text() は先頭の BOM を取り除くので、BOM を確かめられるよう自分でデコードする
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, cookie: set ? set.split(';')[0] : cookie, res, text };
}

/** GA としてログインした cookie を返す */
export async function loginGa(env, staffId) {
  const r = await call(env, 'POST', '/api/login', { staffId });
  if (r.status !== 200) throw new Error(`loginGa failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.cookie;
}

/** 管理者（暗証番号 1234）を用意してログインした cookie を返す */
export async function loginAdmin(env, f) {
  const { hashPin } = await import('../src/lib/crypto.js');
  await env.db.query('update staff set pin_hash=$1 where id=$2', [await hashPin(env, '1234'), f.admin.id]);
  const r = await call(env, 'POST', '/api/admin/login', { staffId: f.admin.id, pin: '1234' });
  if (r.status !== 200) throw new Error(`loginAdmin failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.cookie;
}
