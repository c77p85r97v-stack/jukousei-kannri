// 補講の状態（保存せず、補講と記録から毎回決める）
export const ATTENDED = ['出席', '出席・記録なし', '記録なし', '時間切れ', '欠席・補講済み'];
/** 当日欠席して補講で受けた人（受講には数えるが、当日の出席とは分けて残す） */
export const MAKEUP_DONE = '欠席・補講済み';

export function makeupStatus(makeup, record) {
  if (record && ATTENDED.includes(record.attendance)) return '済';
  if (makeup.failed) return 'できず';
  if (makeup.place === '未定') return '未定';
  return '予定';
}
