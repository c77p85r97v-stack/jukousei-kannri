// 入力の正規化（全角→半角、空白の整理）

export const SLOT_CODES = ['月', '火1', '火2', '水1', '水2', '木1', '木2', '金1', '金2'];

function toHalfWidth(s) {
  return String(s)
    .replace(/[０-９．－]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/** 「火１」「 火 1 」→「火1」。知らないコマは null。 */
export function normSlotCode(s) {
  if (s == null) return null;
  const v = toHalfWidth(s).replace(/\s+/g, '');
  return SLOT_CODES.includes(v) ? v : null;
}

/** 数値の入力。空→null、数字でない・負→'invalid'。 */
export function normNumber(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : 'invalid';
  const v = toHalfWidth(s).trim();
  if (v === '') return null;
  if (!/^\d+(\.\d+)?$/.test(v)) return 'invalid';
  return Number(v);
}

/** 文字の入力。全角スペース→半角、連続空白を1つに、前後の空白を除去。空→null。 */
export function normText(s) {
  if (s == null) return null;
  const v = String(s).replace(/　/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return v === '' ? null : v;
}
