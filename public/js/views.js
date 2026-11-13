// GA 画面と管理者画面で共有する表示（名簿・集計・受講生の履歴）
(() => {
  const { api, h, memo } = koshu;

  const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const fix1 = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1));

  const STATUS_CHIP = {
    予定: ['plan', '△ 予定'],
    未定: ['plan', '△ 未定'],
    済: ['done', '済'],
    できず: ['fail', '× できず'],
  };
  function statusChip(status) {
    const [cls, text] = STATUS_CHIP[status] || ['none', status];
    return h('span', { class: `chip ${cls}` }, text);
  }
  const placeText = m => (m.place === '他班' ? m.hostLabel : m.place === '個別' ? (m.indivLabel ? `個別 ${m.indivLabel}` : '個別（枠未定）') : '場所未定');

  /** 「今日の曜日」に近いコマ（なければ先頭） */
  function defaultSlot(slots) {
    const remembered = memo.get('slot');
    if (remembered && slots.some(s => s.id === remembered)) return remembered;
    const day = '日月火水木金土'[new Date().getDay()];
    return (slots.find(s => s.code.startsWith(day)) || slots[0] || {}).id;
  }
  function defaultRound(term) {
    const remembered = memo.get('round');
    return term.rounds.includes(remembered) ? remembered : term.rounds[0];
  }

  /** コマと回の切り替えボタン。onChange(slotId, round) */
  function slotRoundPicker({ boot, slotSegId, roundSegId, allSlots = false, onChange }) {
    let slotId = defaultSlot(boot.slots);
    let round = defaultRound(boot.term);
    const slotSeg = h('div', { class: 'seg', id: slotSegId, role: 'group', 'aria-label': 'コマ' });
    const roundSeg = h('div', { class: 'seg', id: roundSegId, role: 'group', 'aria-label': '回' });
    const paint = () => {
      for (const b of slotSeg.children) b.classList.toggle('on', b.dataset.slot === String(slotId));
      for (const b of roundSeg.children) b.classList.toggle('on', Number(b.dataset.round) === round);
    };
    // onChange が false を返したら（保存できていない行があるなど）、選択を元に戻す
    const set = async (s, r) => {
      const prev = [slotId, round];
      slotId = s;
      round = r;
      paint();
      if ((await onChange(slotId, round)) === false) {
        [slotId, round] = prev;
        paint();
        return;
      }
      if (s !== 'all') memo.set('slot', s);
      memo.set('round', r);
    };
    for (const s of boot.slots) slotSeg.append(h('button', { type: 'button', dataset: { slot: s.id }, onclick: () => set(s.id, round) }, s.code));
    if (allSlots) slotSeg.append(h('button', { type: 'button', dataset: { slot: 'all' }, onclick: () => set('all', round) }, 'すべて'));
    for (const r of boot.term.rounds) roundSeg.append(h('button', { type: 'button', dataset: { round: r }, onclick: () => set(slotId, r) }, `第${r}回`));
    paint();
    return { slotSeg, roundSeg, get slotId() { return slotId; }, get round() { return round; }, refresh: () => onChange(slotId, round) };
  }

  // ---------- 名簿（印刷） ----------
  function rosterView(root, boot) {
    const body = h('div', {});
    const csv = h('a', { class: 'button no-print' }, 'この回を CSV で保存');
    const picker = slotRoundPicker({
      boot,
      slotSegId: 'rvSlotSeg',
      roundSegId: 'rvRoundSeg',
      allSlots: true,
      onChange: load,
    });
    root.replaceChildren(
      h('div', { class: 'bar no-print' }, picker.slotSeg),
      h('div', { class: 'bar no-print' }, picker.roundSeg, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'primary', onclick: () => window.print() }, '印刷する'), csv),
      body,
    );
    async function load(slotId, round) {
      csv.href = `/api/export/roster.csv?termId=${boot.term.id}&round=${round}`;
      body.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
      try {
        const targets = slotId === 'all' ? boot.slots : boot.slots.filter(s => s.id === slotId);
        const sheets = [];
        for (const s of targets) {
          const data = await api.get(`/api/roster?slotId=${s.id}&round=${round}`);
          sheets.push(sheet(s.code, round, data));
        }
        body.replaceChildren(...sheets);
      } catch (e) {
        body.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    // 前のスプレッドシートの「第N回」シートの形：A4 横 1枚にコマ1つ。
    // 左：補講で来る人（振替）、右：班ごとの名簿（GA 名を縦に結合、1班 12行以上）を2列に並べる
    const MIN_ROWS = 12;
    const PAGE_MM = 178; // A4 横の高さ 210mm − 余白 − 見出し
    function sheet(code, round, data) {
      const groups = [...data.groups].sort((a, b) => a.groupId - b.groupId);
      const rowsOf = g => Math.max(MIN_ROWS, g.members.length);
      // 班を上から順に左右2列へ（左が半分を超えたら右へ）
      const total = groups.reduce((n, g) => n + rowsOf(g), 0);
      const cols = [[], []];
      let left = 0;
      for (const g of groups) {
        if (left < total / 2 && (left === 0 || left + rowsOf(g) / 2 <= total / 2)) {
          cols[0].push(g);
          left += rowsOf(g);
        } else cols[1].push(g);
      }
      const guests = groups.flatMap(g => g.guests.map(m => ({ ...m, hostGa: g.gaName })));
      const colRows = cols.map(c => c.reduce((n, g) => n + rowsOf(g), 0));
      const maxRows = Math.max(...colRows, guests.length + 4, 1) + 1;
      const rh = Math.min(6, PAGE_MM / maxRows);
      const note = m => (m.makeup && m.makeup.status !== '済' ? `補講：${placeText(m.makeup)}${m.makeup.failed ? '（できず）' : ''}` : '');
      const groupTable = list =>
        h(
          'table',
          { class: 'rgrid' },
          h('colgroup', {}, ['ga', 'nm', 'kn', 'nk', 'w', 'rm'].map(c => h('col', { class: `c-${c}` }))),
          h('thead', {}, h('tr', {}, h('th', { class: 'ga' }, 'GA'), h('th', {}, '名前'), h('th', {}, 'ヨミ'), h('th', {}, 'ニックネーム'), h('th', { class: 'w' }, '記入'), h('th', { class: 'rm' }, '備考'))),
          list.map(g => {
            const n = rowsOf(g);
            return h(
              'tbody',
              { class: 'grp' },
              Array.from({ length: n }, (_, i) => {
                const m = g.members[i];
                return h('tr', {}, i === 0 ? h('td', { class: 'ga', rowSpan: n }, g.gaName) : null, h('td', {}, m ? m.name : ''), h('td', {}, m ? m.kana || '' : ''), h('td', {}, m ? m.nickname || '' : ''), h('td', { class: 'w' }), h('td', { class: 'rm' }, m ? note(m) : ''));
              }),
            );
          }),
        );
      const guestRows = Math.max(guests.length + 3, 6);
      const guestTable = h(
        'table',
        { class: 'rgrid' },
        h('colgroup', {}, ['h', 'ga', 'kn', 'nk', 'from', 'w'].map(c => h('col', { class: `g-${c}` }))),
        h('thead', {}, h('tr', {}, h('th', {}, '振替先GA'), h('th', {}, '担当GA'), h('th', {}, 'ナマエ'), h('th', {}, 'ニックネーム'), h('th', {}, '元コマ'), h('th', { class: 'w' }, '記入'))),
        h('tbody', {}, Array.from({ length: guestRows }, (_, i) => {
          const m = guests[i];
          return h('tr', {}, h('td', {}, m ? m.hostGa : ''), h('td', {}, m ? (m.homeLabel || '').split(' ').slice(1).join(' ') : ''), h('td', {}, m ? m.kana || m.name : ''), h('td', {}, m ? m.nickname || '' : ''), h('td', {}, m ? (m.homeLabel || '').split(' ')[0] : ''), h('td', { class: 'w' }));
        })),
      );
      return h(
        'section',
        { class: 'sheet rsheet', style: `--rh:${rh.toFixed(2)}mm` },
        h('div', { class: 'rhead' }, h('b', {}, `第${round}回　${code}`), h('span', {}, `${groups.reduce((n, g) => n + g.members.length, 0)}人${guests.length ? `＋補講で来る人 ${guests.length}人` : ''}`)),
        h('div', { class: 'rbody' }, h('div', { class: 'rleft' }, h('div', { class: 'rcap' }, '補講で来る人（振替）'), guestTable), groups.length ? cols.map(c => h('div', { class: 'rcol' }, c.length ? groupTable(c) : null)) : h('p', { class: 'empty' }, 'このコマには班がありません')),
      );
    }
    picker.refresh();
    return { refresh: picker.refresh };
  }

  // ---------- 記録閲覧（前のスプレッドシートの曜日シートの形・見るだけ） ----------
  function recordsView(root, boot) {
    let slotId = memo.get('slot') && boot.slots.some(s => s.id === memo.get('slot')) ? memo.get('slot') : boot.slots[0]?.id;
    const seg = h('div', { class: 'seg', id: 'rcSlotSeg', role: 'group', 'aria-label': 'コマ' });
    const body = h('div', { id: 'rcBody' });
    const paint = () => {
      for (const b of seg.children) b.classList.toggle('on', Number(b.dataset.slot) === slotId);
    };
    for (const s of boot.slots) seg.append(h('button', { type: 'button', dataset: { slot: s.id }, onclick: () => { slotId = s.id; paint(); load(); } }, s.code));
    paint();
    root.replaceChildren(
      h('div', { class: 'bar' }, seg, h('span', { class: 'grow' }), h('button', { type: 'button', onclick: () => load() }, '最新にする')),
      h('p', { class: 'note' }, '見るだけの画面です。直すときは「記録入力」から。数字はタイピングの秒数、〇は出席（記録なし）、△は補講予定、×は補講できず。'),
      body,
    );
    async function load() {
      memo.set('slot', slotId);
      body.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
      try {
        const d = await api.get(`/api/records/sheet?slotId=${slotId}`);
        const cols = [];
        for (const r of d.rounds) {
          cols.push({ head: `第${r}回`, cls: 'rv', get: x => x.cells[r]?.value || '', out: x => x.cells[r]?.out });
          if (r !== d.freeRound) cols.push({ head: '備考', cls: 'rk', get: x => x.cells[r]?.remark || '', out: x => x.cells[r]?.out });
          if (d.quizRounds.includes(r)) cols.push({ head: 'クイズ', cls: 'rq', get: x => (x.quiz[r] ?? '') + '' });
        }
        cols.push({ head: 'タイピング伸び', cls: 'rg', get: x => (x.typingGain ?? '') + '' }, { head: 'クイズ伸び', cls: 'rg', get: x => (x.quizGain ?? '') + '' });
        const head = h('tr', {}, h('th', { class: 'sx s1' }, 'GA'), h('th', { class: 'sx s2' }, '名前'), h('th', {}, 'ヨミ'), h('th', {}, 'ニックネーム'), h('th', {}, '解約・移動'), cols.map(c => h('th', { class: c.cls }, c.head)));
        const groups = d.groups.filter(g => g.students.length);
        body.replaceChildren(
          groups.length
            ? h(
                'div',
                { class: 'scroll recsheet' },
                h(
                  'table',
                  { class: 'grid' },
                  h('thead', {}, head),
                  groups.map(g =>
                    h(
                      'tbody',
                      { class: 'grp' },
                      g.students.map((x, i) =>
                        h(
                          'tr',
                          { class: x.withdrawnFrom != null ? 'gone' : null },
                          i === 0 ? h('td', { class: 'sx s1 ga', rowSpan: g.students.length }, g.gaName, h('div', { class: 'sub' }, `${g.students.filter(y => y.withdrawnFrom == null).length}人`)) : null,
                          h('td', { class: 'sx s2' }, x.name),
                          h('td', { class: 'sub' }, x.kana || ''),
                          h('td', {}, x.nickname || ''),
                          h('td', { class: 'sub' }, x.status),
                          cols.map(c => h('td', { class: `${c.cls}${c.out && c.out(x) ? ' out' : ''}` }, c.get(x))),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'empty' }, 'このコマには受講生がいません'),
        );
      } catch (e) {
        body.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    load();
    return { refresh: load };
  }

  // ---------- 集計 ----------
  function statsView(root, boot) {
    async function load() {
      root.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
      try {
        const st = await api.get(`/api/stats?termId=${boot.term.id}`);
        const kpi = (label, value) => h('div', { class: 'kpi' }, h('b', {}, value), h('span', {}, label));
        const codes = boot.slots.map(s => s.code);
        root.replaceChildren(
          h('div', { class: 'bar no-print' }, h('span', { class: 'grow' }), h('button', { type: 'button', onclick: load }, '更新'), h('a', { class: 'button', href: `/api/export/stats.csv?termId=${boot.term.id}` }, '集計を CSV で保存'), h('a', { class: 'button', href: `/api/export/records.csv?termId=${boot.term.id}` }, '全記録を CSV で保存')),
          h('div', { class: 'kpis' }, kpi('初期受講生数', st.initialCount), kpi('解約者数', st.withdrawn), kpi('継続率', pct(st.retentionRate)), kpi('継続率（第1回から未受講の解約を除く）', pct(st.retentionRateExclNeverAttended)), kpi('解約率', pct(st.withdrawalRate)), kpi('コマ移動数', st.transfers), st.freeRound ? kpi(`第${st.freeRound.round}回（自由参加）の参加人数`, st.freeRound.attended) : null),
          h(
            'section',
            { class: 'card' },
            h('h3', {}, '回ごとの受講率'),
            h(
              'div',
              { class: 'scroll' },
              h(
                'table',
                { class: 'grid' },
                h('thead', {}, h('tr', {}, h('th', {}, '回'), h('th', { class: 'num' }, '在籍'), h('th', { class: 'num' }, '受講'), h('th', { class: 'num' }, '受講率'), h('th', { class: 'num' }, 'この回から未受講の解約'))),
                h('tbody', {}, Object.keys(st.attendanceRate).map(Number).map(r => h('tr', {}, h('td', {}, `第${r}回`), h('td', { class: 'num' }, st.attendanceRate[r].enrolled), h('td', { class: 'num' }, st.attendanceRate[r].attended), h('td', { class: 'num' }, pct(st.attendanceRate[r].rate)), h('td', { class: 'num' }, st.withdrawnByRound[r] || 0)))),
              ),
            ),
            h('p', { class: 'note' }, '受講率＝その回に在籍している人のうち、出席した人（〇・記録なし・時間切れ・補講済みを含む）の割合。第0回は自由参加なので含めていません。'),
          ),
          h(
            'section',
            { class: 'card' },
            h('h3', {}, 'コマごとの解約・移動'),
            h(
              'div',
              { class: 'scroll' },
              h(
                'table',
                { class: 'grid' },
                h('thead', {}, h('tr', {}, h('th', {}, 'コマ'), h('th', { class: 'num' }, '解約者数'), h('th', { class: 'num' }, '移動で出た人'), h('th', { class: 'num' }, '移動で入った人'))),
                h('tbody', {}, codes.map(c => h('tr', {}, h('td', {}, c), h('td', { class: 'num' }, st.withdrawnBySlot[c] || 0), h('td', { class: 'num' }, st.transfersBySlot[c]?.out || 0), h('td', { class: 'num' }, st.transfersBySlot[c]?.in || 0)))),
              ),
            ),
          ),
          h(
            'section',
            { class: 'card' },
            h('h3', {}, '班ごとの人数と伸び'),
            h(
              'div',
              { class: 'scroll' },
              h(
                'table',
                { class: 'grid' },
                h('thead', {}, h('tr', {}, h('th', {}, 'コマ'), h('th', {}, 'GA'), h('th', { class: 'num' }, '班人数'), h('th', { class: 'num' }, 'タイピング伸び平均（秒）'), h('th', { class: 'num' }, '改善した人の割合'), h('th', { class: 'num' }, 'クイズ伸び平均（点）'))),
                h('tbody', {}, st.groups.length ? st.groups.map(g => h('tr', {}, h('td', {}, g.slotCode), h('td', {}, g.gaName), h('td', { class: 'num' }, g.size), h('td', { class: 'num' }, fix1(g.typingGainAvg)), h('td', { class: 'num' }, pct(g.typingImprovedRatio)), h('td', { class: 'num' }, fix1(g.quizGainAvg)))) : h('tr', {}, h('td', { colSpan: 6, class: 'empty' }, '班がまだありません'))),
              ),
            ),
            h('p', { class: 'note' }, 'タイピングの伸び＝最初の記録 − 最後の回の記録（秒）。短くなった分なので、プラスが改善です。最初と最後の両方に記録がある人だけで平均しています。'),
          ),
        );
      } catch (e) {
        root.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    load();
    return { refresh: load };
  }

  // ---------- 受講生の検索と履歴 ----------
  function searchView(root, boot) {
    const input = h('input', { id: 'searchInput', type: 'search', autocomplete: 'off' });
    const results = h('div', { id: 'searchResults', class: 'names' });
    const box = h('div', { id: 'historyBox' });
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    async function run() {
      const q = input.value.trim();
      if (!q) return results.replaceChildren();
      try {
        const list = await api.get(`/api/students/search?termId=${boot.term.id}&q=${encodeURIComponent(q)}`);
        results.replaceChildren(...(list.length ? list.map(s => h('button', { type: 'button', onclick: () => show(s.id) }, `${s.name}（${s.homeLabel}）`)) : [h('p', { class: 'note' }, '見つかりませんでした')]));
      } catch (e) {
        results.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    async function show(id) {
      box.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
      try {
        const d = await api.get(`/api/students/${id}/history`);
        const rec = new Map(d.records.map(r => [r.round, r]));
        const mk = new Map(d.makeups.map(m => [m.round, m]));
        box.replaceChildren(
          h(
            'section',
            { class: 'card' },
            h('h3', {}, `${d.student.name}（${d.student.nickname || '—'}）　${d.student.homeLabel}`),
            h('p', { class: 'note' }, [d.student.kana, d.withdrawal ? `第${d.withdrawal.fromRound}回から解約${d.withdrawal.reason ? `（${d.withdrawal.reason}）` : ''}` : null, ...d.transfers.map(t => `第${t.fromRound}回から ${t.fromLabel} → ${t.toLabel} に移動`)].filter(Boolean).join('　／　')),
            h(
              'div',
              { class: 'scroll' },
              h(
                'table',
                { class: 'grid' },
                h('thead', {}, h('tr', {}, h('th', {}, '回'), h('th', {}, '出欠'), h('th', { class: 'num' }, 'タイピング'), h('th', { class: 'num' }, 'クイズ'), h('th', {}, 'メモ'), h('th', {}, '補講'))),
                h(
                  'tbody',
                  {},
                  boot.term.rounds.map(r => {
                    const x = rec.get(r);
                    const m = mk.get(r);
                    return h('tr', {}, h('td', {}, `第${r}回`), h('td', {}, x?.attendance === '欠席' ? '当日欠席' : x?.attendance || ''), h('td', { class: 'num' }, x?.typing ?? ''), h('td', { class: 'num' }, x?.quiz ?? ''), h('td', {}, x?.note || ''), h('td', {}, m ? [statusChip(m.status), ' ', placeText(m)] : ''));
                  }),
                ),
              ),
            ),
          ),
        );
      } catch (e) {
        box.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    root.replaceChildren(h('section', { class: 'card' }, h('label', { for: 'searchInput' }, '名前・ヨミ・ニックネーム'), input, h('div', { style: 'height:10px' }), results), box);
    return { focus: () => input.focus(), show };
  }

  // ---------- 個別補講 ①〜⑧（名簿・印刷） ----------
  /** opts.onEdit(slot, round) / opts.onEditBase() があれば、管理者の変更ボタンを出す。 */
  function indivView(root, boot, opts = {}) {
    const rounds = boot.term.rounds.filter(r => r !== 0);
    let round = rounds.includes(memo.get('round')) ? memo.get('round') : rounds[0];
    const seg = h('div', { class: 'seg', id: 'ivRoundSeg', role: 'group', 'aria-label': '回' });
    const body = h('div', { id: 'ivBody' });
    const paint = () => {
      for (const b of seg.children) b.classList.toggle('on', Number(b.dataset.round) === round);
    };
    for (const r of rounds) seg.append(h('button', { type: 'button', dataset: { round: r }, onclick: () => { round = r; paint(); load(); } }, `第${r}回`));
    paint();
    root.replaceChildren(
      h('div', { class: 'bar no-print' }, seg, h('span', { class: 'grow' }), opts.onEditBase ? h('button', { type: 'button', onclick: () => opts.onEditBase() }, '①〜⑦の基本の時間') : null, h('button', { type: 'button', class: 'primary', onclick: () => window.print() }, '印刷する')),
      body,
    );
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
    const studentTable = (list, extra) =>
      h(
        'div',
        { class: 'scroll' },
        h(
          'table',
          { class: 'grid' },
          h('thead', {}, h('tr', {}, h('th', {}, '出席'), h('th', {}, '元コマ'), h('th', {}, 'GA'), h('th', {}, 'ナマエ'), h('th', {}, 'ニックネーム'), extra ? h('th', {}, extra[0]) : null, h('th', {}, '状態'))),
          h('tbody', {}, list.length ? list.map(s => h('tr', {}, h('td', {}, h('span', { class: 'checkbox' })), h('td', {}, s.homeSlot), h('td', {}, s.gaName), h('td', {}, s.kana || s.name), h('td', {}, s.nickname || ''), extra ? h('td', {}, extra[1](s)) : null, h('td', {}, statusChip(s.status)))) : h('tr', {}, h('td', { colSpan: extra ? 7 : 6, class: 'empty' }, 'いません'))),
        ),
      );
    async function load() {
      memo.set('round', round);
      body.replaceChildren(h('p', { class: 'empty' }, '読み込み中…'));
      try {
        const d = await api.get(`/api/indiv?termId=${boot.term.id}&round=${round}`);
        const cards = d.slots.map(sl => {
          const extra = sl.no === 8 ? [['日時', s => s.indivWhen || ''], ['担当', s => s.inCharge || '']] : null;
          const info = [sl.host ? `担当：${sl.host}` : null, sl.room ? `場所：${sl.room}` : null].filter(Boolean).join('　');
          return h(
            'section',
            { class: `sheet card indiv${sl.closed ? ' closed' : ''}`, dataset: { no: sl.no } },
            h('div', { class: 'group-head' }, h('h3', {}, `第${round}回　${CIRCLED[sl.no - 1]} ${sl.label}`), sl.closed ? h('span', { class: 'chip none' }, '実施なし') : null, h('span', { class: 'note' }, `${sl.students.length}人`), info ? h('span', { class: 'note' }, info) : null, opts.onEdit && sl.no !== 8 ? h('button', { type: 'button', class: 'small no-print', onclick: () => opts.onEdit(sl, round, load) }, '変更') : null),
            sl.no === 8
              ? h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '出席'), h('th', {}, '日時'), h('th', {}, '担当'), h('th', {}, '元コマ'), h('th', {}, 'GA'), h('th', {}, 'ナマエ'), h('th', {}, 'ニックネーム'), h('th', {}, '状態'))), h('tbody', {}, sl.students.length ? sl.students.map(s => h('tr', {}, h('td', {}, h('span', { class: 'checkbox' })), h('td', {}, s.indivWhen || ''), h('td', {}, s.inCharge || ''), h('td', {}, s.homeSlot), h('td', {}, s.gaName), h('td', {}, s.kana || s.name), h('td', {}, s.nickname || ''), h('td', {}, statusChip(s.status)))) : h('tr', {}, h('td', { colSpan: 8, class: 'empty' }, 'いません')))))
              : studentTable(sl.students, extra),
          );
        });
        if (d.unassigned.length) cards.push(h('section', { class: 'sheet card' }, h('h3', {}, `第${round}回　個別補講（枠がまだ決まっていない人）`), studentTable(d.unassigned)));
        body.replaceChildren(...cards);
      } catch (e) {
        body.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    load();
    return { refresh: load };
  }

  // ---------- LINE の報告文（コピーするだけ） ----------
  async function lineDialog(title, url) {
    let dlg = document.getElementById('lineDialog');
    if (!dlg) document.body.append((dlg = h('dialog', { id: 'lineDialog' })));
    const area = h('textarea', { id: 'lineText', readOnly: true, rows: 8, style: 'width:100%;font:inherit' });
    const msg = h('p', { class: 'note', id: 'lineMsg', role: 'status' });
    const warn = h('p', { class: 'error', id: 'lineWarn', role: 'alert' });
    const copy = h('button', { type: 'button', class: 'primary', id: 'lineCopy' }, 'コピーする');
    dlg.replaceChildren(h('div', { class: 'dlg' }, h('h3', {}, title), area, warn, msg, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => dlg.close() }, '閉じる'), copy)));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(area.value);
      } catch {
        area.select();
        document.execCommand('copy');
      }
      msg.textContent = 'コピーしました。LINE に貼り付けて送ってください。';
    });
    dlg.showModal();
    area.value = '読み込み中…';
    copy.disabled = true;
    try {
      const d = await api.get(url);
      area.value = d.text;
      copy.disabled = false;
      if (d.unentered) warn.textContent = `出欠が未入力の人が ${d.unentered}人います。入力してから送ってください。`;
    } catch (e) {
      area.value = '';
      warn.textContent = e.message;
    }
  }

  window.koshuViews = { rosterView, statsView, searchView, indivView, recordsView, lineDialog, slotRoundPicker, statusChip, placeText, pct, fix1 };
})();
