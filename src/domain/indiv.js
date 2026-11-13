// 個別補講の枠。①〜⑦は年度の基本（曜日と時間）を回ごとに書き換えられる。⑧は指定時間外で、日時をその都度書く。
export const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
export const EXTRA_NO = 8;

/** 第 round 回の ①〜⑧ の枠（書き換えを反映したもの）。 */
export async function indivSlots(db, termId, round) {
  const [term] = await db.query('select indiv_labels from terms where id=$1', [termId]);
  const over = new Map((await db.query('select * from indiv_slots where term_id=$1 and round=$2', [termId, round])).map(o => [o.no, o]));
  const labels = term ? term.indiv_labels : [];
  const slots = labels.map((def, i) => {
    const o = over.get(i + 1) || {};
    return { no: i + 1, label: o.label || def, defaultLabel: def, host: o.host || null, room: o.room || null, closed: !!o.closed };
  });
  slots.push({ no: EXTRA_NO, label: '指定時間外', defaultLabel: '指定時間外', host: null, room: null, closed: false });
  return slots;
}

/** 「②木曜 13:00」「⑧5/8 15:00〜」のような表示。番号がなければ null。 */
export function indivLabel(slots, no, when) {
  if (no == null) return null;
  if (no === EXTRA_NO) return `${CIRCLED[7]}${when || '指定時間外'}`;
  const s = slots.find(x => x.no === no);
  return `${CIRCLED[no - 1]}${s ? s.label : ''}`;
}

/** 回ごとに枠を読み込んで覚えておく（一覧で何度も読まないため）。 */
export function slotCache(db, termId) {
  const cache = new Map();
  return round => {
    if (!cache.has(round)) cache.set(round, indivSlots(db, termId, round));
    return cache.get(round);
  };
}
