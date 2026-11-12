// 実データでの突き合わせ（手元専用）。
//   python3 -I tools/reconcile-extract.py private/2026.xlsx private/2026.json
//   node tools/reconcile.mjs private/2026.json
// 旧スプレッドシートの内容を、画面と同じ API を通して新システム（メモリ上）に入れ、
// 班人数・解約者数・継続率・欠席数がスプレッドシートの数字と合うかを比べる。
// 旧シートの第1〜9回は、新システムの第0〜8回に読み替える。
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.js';
import { createDevEnv } from './dev-server.mjs';
import { computeStats } from '../src/domain/stats.js';

const data = JSON.parse(readFileSync(process.argv[2] || 'private/2026.json', 'utf8'));
const env = await createDevEnv();
const SLOTS = ['月', '火1', '火2', '水1', '水2', '木1', '木2', '金1', '金2'];

async function call(method, path, body, cookie) {
  const headers = { 'X-Requested-With': 'koshu', ...(cookie ? { Cookie: cookie } : {}) };
  const res = await handle(new Request(`http://localhost${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  const set = res.headers.get('Set-Cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: set ? set.split(';')[0] : cookie };
}
const must = (r, what) => {
  if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const admin = (await call('POST', '/api/admin/setup', { token: env.ADMIN_SETUP_TOKEN, name: '突き合わせ', pin: '1234' })).cookie;
const term = must(await call('POST', '/api/admin/terms', { name: '突き合わせ', active: true, typingRounds: [0, 1, 2, 3, 4, 5, 6, 7, 8], initialCount: data.summary.initialTotal }, admin), '年度');

// 1. 名簿の一括取り込み
const text = data.roster.map(r => [r.slot, r.ga, r.name, r.kana || '', r.nickname || ''].join('\t')).join('\n');
const preview = must(await call('POST', '/api/admin/import/preview', { termId: term.id, text }, admin), 'プレビュー');
const findings = [];
if (preview.errors.length) findings.push(`取り込めない行：${preview.errors.length}（${preview.errors.slice(0, 5).map(e => `${e.line}行目 ${e.reason}`).join(' / ')}）`);
const dups = preview.rows.filter(r => r.duplicate);
if (dups.length) findings.push(`名簿に同じ名前＋ヨミが重複：${dups.length}件（${dups.map(d => `${d.slotCode} ${d.name}`).join(' / ')}）`);
const imported = must(await call('POST', '/api/admin/import/commit', { termId: term.id, text, requestId: 'reconcile' }, admin), '取り込み');
console.log(`名簿：シート ${data.roster.length}行 → 取り込み ${imported.imported}人（重複で飛ばした ${imported.skipped}）`);

const groups = must(await call('GET', `/api/groups?termId=${term.id}`, null, admin), '班');
const groupId = (slot, ga) => groups.find(g => g.slotCode === slot && g.gaName === ga)?.id;
const students = await env.db.query('select id, name, kana, group_id from students');
// 名前の照合は、全角・半角と空白の違いを無視する（旧シートは解約シートと名簿で表記がずれていることがある）
const norm = s => (s || '').normalize('NFKC').replace(/\s+/g, '');
const byKey = new Map(students.map(s => [`${norm(s.name)}|${s.group_id}`, s]));
const byName = new Map();
for (const s of students) (byName.get(norm(s.name)) || byName.set(norm(s.name), []).get(norm(s.name))).push(s);

// 2. 解約
let wdOk = 0;
const withdrawnAt = new Map();
for (const w of data.withdrawals) {
  let cands = byName.get(norm(w.name)) || [];
  if (cands.length > 1) cands = cands.filter(s => s.group_id === groupId(w.slot, w.ga));
  let st = cands[0];
  if (st && st.name !== w.name) findings.push(`解約シートと名簿で名前の表記が違う（空白など）：${w.slot} ${w.ga}「${w.name}」`);
  if (!st) {
    const gid = groupId(w.slot, w.ga);
    if (!gid) {
      findings.push(`解約シートの ${w.slot} ${w.ga}「${w.name}」：名簿にも班にも見つからない`);
      continue;
    }
    st = must(await call('POST', '/api/admin/students', { name: w.name, kana: w.kana, groupId: gid }, admin), '受講生追加');
    findings.push(`解約シートにいるが、コマのシートにいない：${w.slot} ${w.ga}「${w.name}」（新システムには追加して解約にした）`);
  }
  const r = await call('POST', '/api/admin/withdrawals', { studentId: st.id, fromRound: Number(w.round) - 1 }, admin);
  if (r.status === 200) {
    wdOk++;
    withdrawnAt.set(st.id, Number(w.round) - 1);
  } else findings.push(`解約を登録できない：「${w.name}」未受講回=${w.round} → ${r.body?.error}`);
}
console.log(`解約：シート ${data.withdrawals.length}件 → 登録 ${wdOk}件`);

// 3. 各回の記録（GA として画面と同じ API で入れる）
const gaStaff = (await env.db.query(`select id from staff where role='ga' limit 1`))[0];
const ga = (await call('POST', '/api/login', { staffId: gaStaff.id })).cookie;
const tally = { saved: 0, empty: 0, afterWithdrawal: 0, rejected: 0 };
const rejected = [];
const lostAbsent = {}; // 保存しなかったマスのうち、備考が「欠席」だった数（コマ:回）
const lost = (row, c) => c.note === '欠席' && (lostAbsent[`${row.slot}:${c.round}`] = (lostAbsent[`${row.slot}:${c.round}`] || 0) + 1);
for (const row of data.roster) {
  const st = byKey.get(`${norm(row.name)}|${groupId(row.slot, row.ga)}`);
  if (!st) continue;
  for (const c of row.cells) {
    const body = { studentId: st.id, round: c.round, version: 0 };
    const t = c.typing;
    if (typeof t === 'number') body.typing = t;
    else if (t != null && String(t).trim() !== '') {
      const s = String(t).trim();
      if (s === '〇' || s === '○' || s === '◯') body.attendance = '出席・記録なし';
      else if (s === '記録なし' || s === '時間切れ') body.attendance = s;
      else if (s === '△' || s === '×' || s === '欠席') body.attendance = '欠席';
      else body.typing = s; // そのまま送って、API が弾くかを見る
    }
    if (c.note) {
      body.note = c.note;
      if (!('typing' in body) && !body.attendance && /欠席|×/.test(c.note)) body.attendance = '欠席';
    }
    if (c.round === 0 && row.quizFirst != null) body.quiz = row.quizFirst;
    if (c.round === 8 && row.quizLast != null) body.quiz = row.quizLast;
    if (Object.keys(body).length === 3) {
      tally.empty++;
      continue;
    }
    const r = await call('POST', '/api/records', body, ga);
    if (r.status === 200) tally.saved++;
    else if (r.status === 409 && /解約済み/.test(r.body?.error || '')) {
      tally.afterWithdrawal++;
      lost(row, c);
    } else {
      tally.rejected++;
      lost(row, c);
      rejected.push(`${row.slot} 第${c.round + 1}回「${row.name}」typing=${JSON.stringify(c.typing)} quiz=${JSON.stringify(body.quiz)} → ${r.body?.error}`);
    }
  }
}
console.log(`記録：保存 ${tally.saved}／空欄 ${tally.empty}／解約後の回に記録あり ${tally.afterWithdrawal}／弾かれた ${tally.rejected}`);
for (const r of rejected.slice(0, 15)) console.log('   弾かれた例：', r);

// 4. 比較
const st = await computeStats(env.db, term.id);
let mismatches = 0;
const cmp = (label, sheet, sys) => {
  const ok = sheet === sys;
  if (!ok) mismatches++;
  return `${ok ? '一致' : '不一致'}  ${label}：シート ${sheet} ／ 新システム ${sys}`;
};
console.log('\n■ 班人数（シートの「班人数」＝名前の数 − 解約の印）');
let groupOk = 0;
for (const g of data.groups) {
  const sys = st.groups.find(x => x.slotCode === g.slot && x.gaName === g.ga);
  if (sys && sys.size === g.size) groupOk++;
  else console.log('  ' + cmp(`${g.slot} ${g.ga}`, g.size, sys ? sys.size : '（班なし）'));
}
console.log(`  ${groupOk}/${data.groups.length} 班が一致`);

console.log('\n■ コマごとの最終受講生数');
const finalBySlot = {};
for (const g of st.groups) finalBySlot[g.slotCode] = (finalBySlot[g.slotCode] || 0) + g.size;
for (const s of SLOTS) console.log('  ' + cmp(s, data.summary.finalBySlot[s], finalBySlot[s] || 0));
console.log('  ' + cmp('合計', data.summary.finalTotal, Object.values(finalBySlot).reduce((a, b) => a + b, 0)));

console.log('\n■ 解約者数（コマ別）');
for (const s of SLOTS) console.log('  ' + cmp(s, data.summary.withdrawnBySlotRound[s].reduce((a, b) => a + b, 0), st.withdrawnBySlot[s] || 0));
console.log('■ 解約者数（未受講回別。シートの未第N回＝新システムの第N−1回）');
for (let k = 0; k < 9; k++) console.log('  ' + cmp(`未第${k + 1}回`, SLOTS.reduce((a, s) => a + data.summary.withdrawnBySlotRound[s][k], 0), st.withdrawnByRound[k] || 0));

console.log('\n■ 欠席数（備考が「欠席」の数。コマ×回）');
const absent = await env.db.query(
  `select sl.code, r.round, count(*)::int as n from records r join students s on s.id=r.student_id join groups g on g.id=s.group_id join slots sl on sl.id=g.slot_id
    where r.note = '欠席' group by 1,2`,
);
let absOk = 0, absAll = 0;
for (const s of SLOTS) {
  for (let k = 0; k < 9; k++) {
    const sheet = (data.footer[s]?.['欠席'] || [])[k] || 0;
    const sys = absent.find(a => a.code === s && a.round === k)?.n || 0;
    absAll++;
    const skipped = lostAbsent[`${s}:${k}`] || 0;
    if (sheet === sys) absOk++;
    else if (sheet === sys + skipped) {
      absOk++;
      console.log(`  説明がつく差  ${s} 第${k + 1}回：シート ${sheet} ／ 新システム ${sys} ＋ 解約後の回・弾かれた行の「欠席」${skipped}`);
    } else console.log('  ' + cmp(`${s} 第${k + 1}回`, sheet, sys));
  }
}
console.log(`  ${absOk}/${absAll} マスが一致（説明がつく差を含む）`);

console.log('\n■ 継続率');
console.log(`  初期受講生数：シート ${data.summary.initialTotal} ／ 新システム ${st.initialCount}`);
console.log(`  シートの継続率 ${(data.summary.retention * 100).toFixed(2)}%（第1回未受講の解約者を除く計算）`);
console.log(`  新システムの継続率 ${(st.retentionRate * 100).toFixed(2)}%（解約者全員を引く計算）`);
const firstRound = st.withdrawnByRound[0] || 0;
console.log(`  新システムの数字でシートと同じ計算をすると ${(((st.initialCount - (st.withdrawn - firstRound)) / st.initialCount) * 100).toFixed(2)}%`);

console.log('\n■ 気づいた点');
for (const f of findings) console.log('  ・' + f);
if (!findings.length) console.log('  なし');
console.log(`\n不一致の数：${mismatches}`);
