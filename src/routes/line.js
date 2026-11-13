// LINE に貼る報告文（コピーするだけ）。名前はカタカナのフルネーム（ヨミ）。解約の報告文は作らない。
import { json, HttpError, intParam } from '../lib/http.js';
import { requireStaff } from '../lib/auth.js';
import { rosterFor, groupAt } from '../domain/roster.js';
import { indivSlots, indivLabel } from '../domain/indiv.js';
import { FREE_ROUND } from './records.js';

const ABSENT = ['欠席', '欠席・補講予定', '欠席・補講できず'];
const kana = st => st.kana || st.name;
/** 「月」は「月曜」、それ以外（火1 など）はそのまま */
const slotText = code => (code.length === 1 ? `${code}曜` : code);
const greet = op => `お疲れ様です。${op.name}です。`;

function placeOf(mk) {
  if (!mk || mk.place === '未定') return null;
  if (mk.place === '他班') return `${mk.hostLabel}班`;
  return `個別補講${mk.indivLabel || ''}`;
}

async function daily(env, req) {
  const op = await requireStaff(env, req);
  const url = new URL(req.url);
  const slotId = intParam(url, 'slotId');
  const round = intParam(url, 'round');
  const [slot] = await env.db.query('select id, code, term_id from slots where id=$1', [slotId]);
  if (!slot) throw new HttpError(404, 'コマが見つかりません');
  const groups = (await rosterFor(env.db, { termId: slot.term_id, slotId, round })).filter(g => g.gaId === op.id);
  if (!groups.length) throw new HttpError(404, 'このコマに自分の班がありません');
  const members = groups.flatMap(g => g.members);
  const lines = [greet(op), `${slotText(slot.code)} 第${round}回の受講生管理が終わりました。`];
  if (round === FREE_ROUND) {
    lines.push(`参加者${members.filter(m => m.record && m.record.attendance === '出席').length}名でした。`);
  } else {
    const absent = members.filter(m => m.record && ABSENT.includes(m.record.attendance));
    if (!absent.length) lines.push('欠席者はいません。');
    else {
      lines.push(`欠席者${absent.length}名です。`);
      for (const m of absent) {
        const p = placeOf(m.makeup);
        const note = m.makeup && m.makeup.failed ? '補講できず' : p ? `補講：${p}` : '補講未定';
        lines.push(`・${kana(m)}さん（${note}）`);
      }
    }
  }
  lines.push('システム入力済みです。');
  const unentered = round === FREE_ROUND ? 0 : members.filter(m => !m.record || !m.record.attendance).length;
  return json({ text: lines.join('\n'), unentered });
}

async function makeup(env, req) {
  const op = await requireStaff(env, req);
  const url = new URL(req.url);
  const studentId = intParam(url, 'studentId');
  const round = intParam(url, 'round');
  const [m] = await env.db.query(
    `select m.*, st.name, st.kana, st.term_id, xs.code || ' ' || xga.name as host_label
       from makeups m join students st on st.id = m.student_id
       left join groups xg on xg.id = m.host_group_id left join slots xs on xs.id = xg.slot_id left join staff xga on xga.id = xg.ga_id
      where m.student_id = $1 and m.round = $2`,
    [studentId, round],
  );
  if (!m) throw new HttpError(404, '補講が登録されていません');
  const slots = m.indiv_no == null ? [] : await indivSlots(env.db, m.term_id, round);
  const place = placeOf({ place: m.place, hostLabel: m.host_label, indivLabel: indivLabel(slots, m.indiv_no, m.indiv_when) });
  if (!place) throw new HttpError(400, '補講の場所がまだ決まっていません');
  const [home] = await env.db.query('select s.code, ga.name from groups g join slots s on s.id=g.slot_id join staff ga on ga.id=g.ga_id where g.id=$1', [await groupAt(env.db, studentId, round)]);
  const text = [greet(op), `${slotText(home.code)} ${home.name}班の${kana(m)}さん（第${round}回欠席）の補講が、${place}に決まりました。`, 'システム入力済みです。'].join('\n');
  return json({ text });
}

async function transfer(env, req) {
  const op = await requireStaff(env, req);
  const id = intParam(new URL(req.url), 'id');
  const [t] = await env.db.query(
    `select tr.from_round, st.name, st.kana, fs.code as from_code, fga.name as from_ga, ts.code as to_code, tga.name as to_ga
       from transfers tr join students st on st.id = tr.student_id
       join groups fg on fg.id = tr.from_group_id join slots fs on fs.id = fg.slot_id join staff fga on fga.id = fg.ga_id
       join groups tg on tg.id = tr.to_group_id join slots ts on ts.id = tg.slot_id join staff tga on tga.id = tg.ga_id
      where tr.id = $1 and tr.cancelled_at is null`,
    [id],
  );
  if (!t) throw new HttpError(404, 'コマ移動が見つかりません');
  const n = kana(t);
  const text = [
    greet(op),
    `${slotText(t.from_code)} ${t.from_ga}班の${n}さんが曜日移動を希望されたため、第${t.from_round}回から${slotText(t.to_code)} ${t.to_ga}班に移動を行いました。受講生管理に記入済みですので、確認お願いします。また、移動先GAと${n}さんには連絡済みです。`,
  ].join('\n');
  return json({ text });
}

export const routes = [
  ['GET', /^\/api\/line\/daily$/, daily],
  ['GET', /^\/api\/line\/makeup$/, makeup],
  ['GET', /^\/api\/line\/transfer$/, transfer],
];
