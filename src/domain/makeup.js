// 補講の状態（保存せず、補講と記録から毎回決める）
export const ATTENDED = ['出席', '出席・記録なし', '記録なし', '時間切れ', '欠席・補講済み'];
/** 当日欠席して補講で受けた人（受講には数えるが、当日の出席とは分けて残す） */
export const MAKEUP_DONE = '欠席・補講済み';
/** 画面・CSV での出欠の呼び方（保存する値はそのまま） */
export const ATTENDANCE_LABEL = {
  記録なし: '出席（記録なし）',
  '出席・記録なし': '出席（記録なし）',
  時間切れ: '出席（時間切れ）',
  欠席: '当日欠席',
  '欠席・補講予定': '当日欠席・振替済み',
  '欠席・補講済み': '当日欠席・補講済み',
  '欠席・補講できず': '当日欠席・補講できず',
};
/** 出欠の呼び方。△は振替先が決まっているかどうかで変える（makeupPlace：'他班'・'個別'・'未定'） */
export const attendanceLabel = (a, makeupPlace) => (a == null ? a : a === '欠席・補講予定' && makeupPlace === '未定' ? '当日欠席・振替先未定' : ATTENDANCE_LABEL[a] || a);

export function makeupStatus(makeup, record) {
  if (record && ATTENDED.includes(record.attendance)) return '済';
  if (makeup.failed) return 'できず';
  if (makeup.place === '未定') return '未定';
  return '予定';
}
