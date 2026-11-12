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
  const placeText = m => (m.place === '他班' ? m.hostLabel : m.place === '個別' ? '個別' : '場所未定');

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
    const set = (s, r) => {
      slotId = s;
      round = r;
      if (s !== 'all') memo.set('slot', s);
      memo.set('round', r);
      paint();
      onChange(slotId, round);
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
          const groups = [...data.groups].sort((a, b) => a.groupId - b.groupId);
          for (const g of groups) sheets.push(sheet(s.code, round, g));
        }
        body.replaceChildren(...(sheets.length ? sheets : [h('p', { class: 'empty' }, 'このコマには班がありません')]));
      } catch (e) {
        body.replaceChildren(h('p', { class: 'error' }, e.message));
      }
    }
    function sheet(code, round, g) {
      const line = (m, guest) =>
        h(
          'tr',
          { class: guest ? 'guest' : null },
          h('td', {}, h('span', { class: 'checkbox' })),
          h('td', {}, m.nickname || ''),
          h('td', {}, m.name),
          h('td', { class: 'sub' }, m.kana || ''),
          h('td', {}, guest ? `補講で来る人（${m.homeLabel}）` : m.makeup && m.makeup.status !== '済' ? `補講：${placeText(m.makeup)}${m.makeup.failed ? '（できず）' : ''}` : ''),
        );
      return h(
        'section',
        { class: 'sheet card' },
        h('h3', {}, `第${round}回　${code}　${g.gaName} の班（${g.members.length}人${g.guests.length ? `＋補講 ${g.guests.length}人` : ''}）`),
        h(
          'div',
          { class: 'scroll' },
          h(
            'table',
            { class: 'grid' },
            h('thead', {}, h('tr', {}, h('th', {}, '出席'), h('th', {}, 'ニックネーム'), h('th', {}, '名前'), h('th', {}, 'ヨミ'), h('th', {}, '備考'))),
            h('tbody', {}, g.members.map(m => line(m, false)), g.guests.map(m => line(m, true)), !g.members.length && !g.guests.length ? h('tr', {}, h('td', { colSpan: 5, class: 'empty' }, '受講生がいません')) : null),
          ),
        ),
      );
    }
    picker.refresh();
    return { refresh: picker.refresh };
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
          h('div', { class: 'kpis' }, kpi('初期受講生数', st.initialCount), kpi('解約者数', st.withdrawn), kpi('継続率', pct(st.retentionRate)), kpi('継続率（最初の回から未受講の解約を除く）', pct(st.retentionRateExclNeverAttended)), kpi('解約率', pct(st.withdrawalRate)), kpi('コマ移動数', st.transfers)),
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
                h('tbody', {}, boot.term.rounds.map(r => h('tr', {}, h('td', {}, `第${r}回`), h('td', { class: 'num' }, st.attendanceRate[r].enrolled), h('td', { class: 'num' }, st.attendanceRate[r].attended), h('td', { class: 'num' }, pct(st.attendanceRate[r].rate)), h('td', { class: 'num' }, st.withdrawnByRound[r] || 0)))),
              ),
            ),
            h('p', { class: 'note' }, '受講率＝その回に在籍している人のうち、出席した人（〇・記録なし・時間切れ・補講済みを含む）の割合。'),
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
                    return h('tr', {}, h('td', {}, `第${r}回`), h('td', {}, x?.attendance || ''), h('td', { class: 'num' }, x?.typing ?? ''), h('td', { class: 'num' }, x?.quiz ?? ''), h('td', {}, x?.note || ''), h('td', {}, m ? [statusChip(m.status), ' ', placeText(m)] : ''));
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

  window.koshuViews = { rosterView, statsView, searchView, slotRoundPicker, statusChip, placeText, pct, fix1 };
})();
