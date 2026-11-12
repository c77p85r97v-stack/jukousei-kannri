// 名簿の一括取り込み（スプレッドシートからの貼り付け）
// 1行＝タブ区切り「コマ, GA, 名前, ヨミ, ニックネーム」
import { json, readJson, HttpError } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { normSlotCode, normText } from '../lib/normalize.js';
import { once } from '../lib/once.js';

const keyOf = (name, kana) => `${name}\u0000${kana || ''}`;

/**
 * ctx: { slots:[{id,code}], staff:[{id,name,role}], groups:[{id,slot_id,ga_id}], students:[{name,kana}] }
 */
export function parseRoster(text, ctx) {
  const rows = [];
  const errors = [];
  const staffByName = new Map(ctx.staff.map(s => [s.name, s]));
  const slotByCode = new Map(ctx.slots.map(s => [s.code, s]));
  const groupKeys = new Set(ctx.groups.map(g => `${g.slot_id}:${g.ga_id}`));
  const existing = new Set(ctx.students.map(s => keyOf(s.name, s.kana)));
  const seen = new Set();
  const newGas = new Set();
  const newGroups = new Set();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.replace(/[\s　]/g, '') === '') return;
    const cols = raw.split('\t');
    if (i === 0 && cols.some(c => normText(c) === 'コマ')) return; // 見出し
    const rawSlot = normText(cols[0]) || '';
    const slotCode = normSlotCode(rawSlot);
    const gaName = normText(cols[1]);
    const name = normText(cols[2]);
    const kana = normText(cols[3]);
    const nickname = normText(cols[4]);
    if (!slotCode) return errors.push({ line, reason: rawSlot ? `コマ「${rawSlot}」が見つかりません` : 'コマが空です' });
    if (!gaName) return errors.push({ line, reason: 'GA が空です' });
    if (!name) return errors.push({ line, reason: '名前が空です' });
    const ga = staffByName.get(gaName);
    if (ga && ga.role !== 'ga') return errors.push({ line, reason: `「${gaName}」は管理者です。GA の名前を入れてください` });
    const slot = slotByCode.get(slotCode);
    const newGa = !ga;
    if (newGa) newGas.add(gaName);
    const newGroup = newGa || !groupKeys.has(`${slot.id}:${ga.id}`);
    if (newGroup) newGroups.add(`${slotCode}:${gaName}`);
    const k = keyOf(name, kana);
    const duplicate = existing.has(k) || seen.has(k);
    seen.add(k);
    rows.push({ line, slotCode, gaName, name, kana, nickname, newGa, newGroup, duplicate });
  });
  const summary = {
    students: rows.filter(r => !r.duplicate).length,
    newGa: newGas.size,
    newGroups: newGroups.size,
    duplicates: rows.filter(r => r.duplicate).length,
  };
  return { rows, errors, summary };
}

async function loadCtx(db, termId) {
  const [term] = await db.query('select id from terms where id=$1', [termId]);
  if (!term) throw new HttpError(400, '年度を選んでください');
  return {
    slots: await db.query('select id, code from slots where term_id=$1', [termId]),
    staff: await db.query('select id, name, role from staff'),
    groups: await db.query('select g.id, g.slot_id, g.ga_id from groups g join slots s on s.id=g.slot_id where s.term_id=$1', [termId]),
    students: await db.query('select name, kana from students where term_id=$1', [termId]),
  };
}

async function preview(env, req) {
  await requireAdmin(env, req);
  const { termId, text } = await readJson(req);
  return json(parseRoster(text, await loadCtx(env.db, Number(termId))));
}

async function commit(env, req) {
  const op = await requireAdmin(env, req);
  const { termId, text, requestId } = await readJson(req);
  const result = await once(env.db, requestId, async t => {
    const ctx = await loadCtx(t, Number(termId));
    const parsed = parseRoster(text, ctx);
    if (parsed.errors.length) throw new HttpError(400, '取り込めない行があります。確認画面で直してください', { errors: parsed.errors });
    const staff = new Map(ctx.staff.map(s => [s.name, s.id]));
    const slots = new Map(ctx.slots.map(s => [s.code, s.id]));
    const groups = new Map(ctx.groups.map(g => [`${g.slot_id}:${g.ga_id}`, g.id]));
    let imported = 0;
    for (const r of parsed.rows) {
      if (r.duplicate) continue;
      if (!staff.has(r.gaName)) {
        const [s] = await t.query(`insert into staff(name, role) values ($1,'ga') returning id`, [r.gaName]);
        staff.set(r.gaName, s.id);
        await audit(t, op.id, 'スタッフの追加（取り込み）', 'staff', s.id, null, { name: r.gaName, role: 'ga' });
      }
      const slotId = slots.get(r.slotCode);
      const gaId = staff.get(r.gaName);
      const gk = `${slotId}:${gaId}`;
      if (!groups.has(gk)) {
        const [{ n }] = await t.query('select count(*)::int as n from groups where slot_id=$1', [slotId]);
        const [g] = await t.query('insert into groups(slot_id, ga_id, sort) values ($1,$2,$3) returning id', [slotId, gaId, n]);
        groups.set(gk, g.id);
      }
      await t.query('insert into students(term_id, name, kana, nickname, group_id) values ($1,$2,$3,$4,$5)', [Number(termId), r.name, r.kana, r.nickname, groups.get(gk)]);
      imported++;
    }
    await audit(t, op.id, '名簿の一括取り込み', 'students', null, null, { termId: Number(termId), imported, skipped: parsed.summary.duplicates });
    return { imported, skipped: parsed.summary.duplicates };
  });
  return json(result);
}

export const routes = [
  ['POST', /^\/api\/admin\/import\/preview$/, preview],
  ['POST', /^\/api\/admin\/import\/commit$/, commit],
];
