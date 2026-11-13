// GA 画面：記録入力・補講・検索・名簿・集計
(async () => {
  const { api, $, $$, h, toast, newId, requireLogin, logout } = koshu;
  const { statsView, searchView, indivView, recordsView, lineDialog, slotRoundPicker, statusChip, placeText } = koshuViews;

  const me = await requireLogin();
  $('#whoName').textContent = `${me.name} さん`;
  $('#toAdmin').hidden = me.role !== 'admin';
  $('#logout').addEventListener('click', logout);

  let boot;
  let groupsAll = [];
  try {
    boot = await api.get('/api/bootstrap');
    if (!boot.term) {
      $('#pageError').textContent = '年度がまだ作られていません。管理者が管理画面の「受講生・班」で作成すると使えるようになります。';
      return;
    }
    groupsAll = await api.get(`/api/groups?termId=${boot.term.id}`);
  } catch (e) {
    $('#pageError').textContent = e.message;
    return;
  }

  // ---------- タブ ----------
  const views = {};
  $('#tabs').hidden = false;
  async function openTab(id) {
    if (id !== 'entryTab') await flushAll();
    for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === id);
    for (const s of ['entryTab', 'searchTab', 'recordsTab', 'indivTab', 'statsTab']) $('#' + s).hidden = s !== id;
    if (id === 'indivTab') views.indiv ? views.indiv.refresh() : (views.indiv = indivView($('#indivView'), boot));
    if (id === 'searchTab') (views.search ||= searchView($('#searchTab'), boot)).focus();
    if (id === 'recordsTab') views.records ? views.records.refresh() : (views.records = recordsView($('#recordsView'), boot));
    if (id === 'statsTab') views.stats ? views.stats.refresh() : (views.stats = statsView($('#statsView'), boot));
    if (id === 'entryTab') picker.refresh();
  }
  for (const b of $$('#tabs button')) b.addEventListener('click', () => openTab(b.dataset.tab));

  // ---------- 記録入力 ----------
  const SELECTABLE = ['出席', '記録なし', '時間切れ', '欠席'];
  const LABEL = { 記録なし: '出席（記録なし）', 時間切れ: '出席（時間切れ）', 欠席: '当日欠席' };
  const AUTO_LABEL = { '欠席・補講予定': '△ 欠席・補講予定', '欠席・補講できず': '× 欠席・補講できず' };
  const ABSENT = ['欠席', '欠席・補講予定', '欠席・補講できず'];
  const entry = $('#entry');
  let rows = [];
  let current = null; // { slotId, round, data }
  let loadSeq = 0;

  const picker = slotRoundPicker({ boot, slotSegId: 'slotSeg', roundSegId: 'roundSeg', onChange: load });
  $('#slotBar').append(picker.slotSeg);
  $('#roundBar').append(picker.roundSeg, h('span', { class: 'grow' }), h('button', { type: 'button', onclick: () => picker.refresh() }, '最新にする'));

  const str = v => (v == null ? '' : String(v));

  async function load(slotId, round) {
    await flushAll();
    // 保存できていない行が残っているときは、表を作り直さない（入力が消えてしまうため）
    if (rows.some(r => r.saving || r.tr.dataset.state === 'failed' || Object.keys(diff(r)).length)) {
      toast('保存できていない行があります。赤い行の「再送」を押すか、内容を直してから切り替えてください', true);
      return false;
    }
    const seq = ++loadSeq;
    delete entry.dataset.loaded;
    try {
      const data = await api.get(`/api/roster?slotId=${slotId}&round=${round}`);
      if (seq !== loadSeq) return;
      current = { slotId, round, data };
      render(data);
      entry.dataset.loaded = `${data.slot.code}:${round}`;
    } catch (e) {
      if (seq !== loadSeq) return;
      rows = [];
      entry.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  }

  function render(data) {
    rows = [];
    if (!data.groups.length) {
      entry.replaceChildren(h('p', { class: 'empty' }, 'このコマにはまだ班がありません'));
      return;
    }
    const cols = 3 + (data.isTypingRound ? 1 : 0) + (data.isQuizRound ? 1 : 0) + 1 + (data.isFreeRound ? 0 : 1);
    entry.replaceChildren(
      ...data.groups.map(g => {
        const tbody = h('tbody', {});
        const counts = h('span', { class: 'note counts' });
        const grp = { counts, rows: [] };
        for (const m of g.members) tbody.append(makeRow(m, data, false, grp));
        if (g.guests.length) {
          tbody.append(h('tr', { class: 'subhead' }, h('td', { colSpan: cols }, `補講で来る人（${g.guests.length}人）`)));
          for (const m of g.guests) tbody.append(makeRow(m, data, true));
        }
        paintCounts(grp, data);
        if (!g.members.length && !g.guests.length) tbody.append(h('tr', {}, h('td', { colSpan: cols, class: 'empty' }, '受講生がいません')));
        return h(
          'section',
          { class: 'group' },
          h('div', { class: 'group-head' }, h('h3', {}, `${data.slot.code}　${g.gaName} の班`), g.gaId === me.id ? h('span', { class: 'mine' }, '自分の班') : null, g.gaId === me.id ? h('button', { type: 'button', class: 'small line', onclick: async () => { await flushAll(); lineDialog('LINE の報告文', `/api/line/daily?slotId=${data.slot.id}&round=${data.round}`); } }, 'LINE報告文') : null, h('span', { class: 'note' }, `${g.members.length}人`), counts),
          h(
            'div',
            { class: 'scroll' },
            h(
              'table',
              { class: 'grid' },
              h('thead', {}, h('tr', {}, h('th', {}, 'ニックネーム'), h('th', {}, '名前'), h('th', {}, '出欠'), data.isTypingRound ? h('th', {}, 'タイピング（秒）') : null, data.isQuizRound ? h('th', {}, 'クイズ（点）') : null, h('th', { style: 'width:28%' }, 'メモ'), data.isFreeRound ? null : h('th', {}, '補講'))),
              tbody,
            ),
          ),
        );
      }),
    );
  }

  /** 班の見出しの「欠席 N人・補講 M人」 */
  function paintCounts(grp, data) {
    if (data.isFreeRound) {
      const n = grp.rows.filter(r => r.saved.attendance === '出席').length;
      grp.counts.textContent = `参加 ${n}人`;
      return;
    }
    const absent = grp.rows.filter(r => ABSENT.includes(r.saved.attendance)).length;
    const mk = grp.rows.filter(r => r.makeup);
    const done = mk.filter(r => r.makeup.status === '済').length;
    grp.counts.textContent = `欠席 ${absent}人・補講 ${mk.length}人${mk.length ? `（済 ${done}）` : ''}`;
  }

  function makeRow(m, data, isGuest, grp = null) {
    const row = { m, isGuest, grp, data, round: data.round, version: m.record ? m.record.version : 0, makeup: m.makeup, saving: null, again: false, retry: null, saved: {} };
    const choices = data.isFreeRound ? ['出席'] : SELECTABLE;
    const att = h('select', { class: 'att', 'aria-label': `出欠 ${m.name}` }, h('option', { value: '' }, data.isFreeRound ? '（来ていない）' : '（未入力）'), choices.map(a => h('option', { value: a }, LABEL[a] || a)));
    const nick = h('input', { class: 'nick', autocomplete: 'off', maxLength: 50, value: m.nickname || '', 'aria-label': `ニックネーム ${m.name}` });
    const typing = data.isTypingRound ? h('input', { class: 'typing', inputMode: 'decimal', autocomplete: 'off', 'aria-label': `タイピング ${m.name}` }) : null;
    const quiz = data.isQuizRound ? h('input', { class: 'quiz', inputMode: 'numeric', autocomplete: 'off', 'aria-label': `クイズ ${m.name}` }) : null;
    const note = h('input', { class: 'note', autocomplete: 'off', maxLength: 200, 'aria-label': `メモ ${m.name}` });
    const msg = h('div', { class: 'rowmsg' });
    const mkCell = h('td', {});
    const tr = h(
      'tr',
      { class: isGuest ? 'guest' : null, dataset: { student: m.studentId } },
      h('td', {}, nick),
      h('td', {}, m.name, h('div', { class: 'sub' }, m.kana || ''), msg),
      h('td', {}, att),
      typing ? h('td', {}, typing) : null,
      quiz ? h('td', {}, quiz) : null,
      h('td', {}, note),
      data.isFreeRound ? null : mkCell,
    );
    Object.assign(row, { tr, att, typing, quiz, note, nick, msg, mkCell });
    if (grp && !isGuest) grp.rows.push(row);
    applyRecord(row, m.record);
    paintMakeup(row);
    nick.addEventListener('change', () => saveNickname(row));

    att.addEventListener('change', () => save(row));
    tr.addEventListener('focusout', e => {
      if (!tr.contains(e.relatedTarget)) save(row);
    });
    tr.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.isComposing) return;
      e.preventDefault();
      const cls = e.target.className.split(' ')[0];
      const all = $$(`#entry input.${cls}`);
      const next = all[all.indexOf(e.target) + 1];
      if (next) {
        next.focus();
        next.select();
      } else {
        e.target.blur();
      }
    });
    rows.push(row);
    return tr;
  }

  /** サーバーの記録を行に反映する（saved＝サーバーにある値） */
  function applyRecord(row, rec) {
    const a = rec ? rec.attendance : null;
    row.saved = { attendance: str(a), typing: str(rec?.typing), quiz: str(rec?.quiz), note: str(rec?.note) };
    row.version = rec ? rec.version : 0;
    const auto = row.att.querySelector('option[data-auto]');
    if (auto) auto.remove();
    if (a && AUTO_LABEL[a]) row.att.append(h('option', { value: a, dataset: { auto: '1' }, disabled: true }, AUTO_LABEL[a]));
    row.att.value = str(a);
    if (row.typing) row.typing.value = row.saved.typing;
    if (row.quiz) row.quiz.value = row.saved.quiz;
    row.note.value = row.saved.note;
    if (row.grp) paintCounts(row.grp, row.data);
  }

  async function saveNickname(row) {
    const v = row.nick.value.trim();
    if (v === (row.m.nickname || '')) return;
    try {
      const res = await api.post(`/api/students/${row.m.studentId}/nickname`, { nickname: v });
      row.m.nickname = res.nickname;
      row.nick.value = res.nickname || '';
      setState(row, 'saved');
    } catch (e) {
      if (e.status === 401) return location.replace('/');
      setState(row, 'failed', e.message);
    }
  }

  function diff(row) {
    const p = {};
    if (row.att.value !== row.saved.attendance && !AUTO_LABEL[row.att.value]) p.attendance = row.att.value;
    if (row.typing && row.typing.value.trim() !== row.saved.typing) p.typing = row.typing.value.trim();
    if (row.quiz && row.quiz.value.trim() !== row.saved.quiz) p.quiz = row.quiz.value.trim();
    if (row.note.value.trim() !== row.saved.note) p.note = row.note.value.trim();
    return p;
  }

  function setState(row, state, message = '', retry = false) {
    row.tr.dataset.state = state;
    row.tr.classList.toggle('saving', state === 'saving');
    row.tr.classList.toggle('failed', state === 'failed');
    row.msg.replaceChildren(message, retry ? h('button', { type: 'button', class: 'small', style: 'margin-left:6px', onclick: () => save(row) }, '再送') : '');
    if (state === 'saved') {
      row.tr.classList.remove('saved-flash');
      void row.tr.offsetWidth;
      row.tr.classList.add('saved-flash');
    }
  }

  function save(row) {
    if (row.saving) {
      row.again = true;
      return row.saving;
    }
    const patch = diff(row);
    if (!Object.keys(patch).length) {
      if (row.tr.dataset.state === 'failed') setState(row, 'idle'); // 入力を元に戻したので、赤い表示を消す
      return Promise.resolve();
    }
    const key = JSON.stringify(patch);
    const requestId = row.retry && row.retry.key === key ? row.retry.id : newId();
    setState(row, 'saving');
    row.saving = (async () => {
      try {
        const res = await api.post('/api/records', { studentId: row.m.studentId, round: row.round, ...patch, version: row.version, requestId });
        row.retry = null;
        // 送ってから利用者がさらに打ち込んだ欄は、打ち込んだ内容を残す
        const typed = { typing: row.typing?.value.trim(), quiz: row.quiz?.value.trim(), note: row.note.value.trim(), attendance: row.att.value };
        const before = { ...row.saved }; // 送る前にサーバーにあった値
        applyRecord(row, res.record);
        for (const k of ['typing', 'quiz', 'note']) {
          if (!row[k]) continue;
          const changedSince = k in patch ? typed[k] !== patch[k] : typed[k] !== before[k];
          if (changedSince) row[k].value = typed[k];
        }
        // 出欠も同じ：送ったあとで選び直していたら、選び直したほうを残す（このあと自動でもう一度保存される）
        const attChanged = 'attendance' in patch ? typed.attendance !== patch.attendance : typed.attendance !== before.attendance;
        if (attChanged && !AUTO_LABEL[typed.attendance]) row.att.value = typed.attendance;
        setState(row, 'saved');
        if (row.makeup) {
          row.makeup = { ...row.makeup, status: ['出席', '出席・記録なし', '記録なし', '時間切れ'].includes(res.record.attendance) ? '済' : row.makeup.failed ? 'できず' : row.makeup.place === '未定' ? '未定' : '予定' };
          paintMakeup(row);
        }
      } catch (e) {
        if (e.status === 409 && e.data && 'latest' in e.data) {
          applyRecord(row, e.data.latest);
          row.retry = null;
          setState(row, 'conflict', 'ほかの人が先に更新しました（最新の内容を表示しています）');
        } else if (e.status === 401) {
          location.replace('/');
        } else {
          row.retry = e.network ? { id: requestId, key } : null;
          setState(row, 'failed', e.message, true);
        }
        row.again = false;
      } finally {
        row.saving = null;
      }
      if (row.again || (row.tr.dataset.state === 'saved' && Object.keys(diff(row)).length)) {
        row.again = false;
        return save(row);
      }
    })();
    return row.saving;
  }

  async function flushAll() {
    if (entry.contains(document.activeElement)) document.activeElement.blur();
    await Promise.all(rows.map(r => r.saving || save(r)));
  }

  window.addEventListener('beforeunload', e => {
    if (rows.some(r => r.saving || Object.keys(diff(r)).length)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- 補講 ----------
  function paintMakeup(row) {
    if (row.grp) paintCounts(row.grp, row.data);
    const mk = row.makeup;
    const cell = row.mkCell;
    if (row.isGuest) {
      cell.replaceChildren(h('span', { class: 'chip info' }, `元の班：${row.m.homeLabel}`), ' ', mk ? statusChip(mk.status) : '');
      return;
    }
    if (!mk) {
      cell.replaceChildren(h('button', { type: 'button', class: 'small', onclick: () => openMakeup(row) }, '補講'));
      return;
    }
    cell.replaceChildren(
      statusChip(mk.status),
      ' ',
      h('span', {}, placeText(mk)),
      h(
        'div',
        { style: 'margin-top:4px;display:flex;gap:4px;flex-wrap:wrap' },
        h('button', { type: 'button', class: 'small', onclick: () => openMakeup(row) }, '変更'),
        mk.place !== '未定' && !mk.failed ? h('button', { type: 'button', class: 'small line', onclick: () => lineDialog('補講が決まったときの LINE 文', `/api/line/makeup?studentId=${row.m.studentId}&round=${row.round}`) }, 'LINE文') : null,
        mk.status === '予定' || mk.status === '未定' ? h('button', { type: 'button', class: 'small danger', onclick: () => makeupAction(row, '/api/makeups/fail') }, 'できなかった') : null,
        h('button', { type: 'button', class: 'small', onclick: () => makeupAction(row, '/api/makeups/cancel') }, '取り消し'),
      ),
    );
  }

  async function makeupAction(row, path, extra = {}) {
    await save(row);
    try {
      const res = await api.post(path, { studentId: row.m.studentId, round: row.round, version: row.makeup ? row.makeup.version : 0, ...extra });
      row.makeup = res.makeup;
      applyRecord(row, res.record);
      paintMakeup(row);
      setState(row, 'saved');
      return true;
    } catch (e) {
      if (e.status === 409) {
        toast('ほかの人が先に変更しました。最新の内容を表示します', true);
        picker.refresh();
      } else {
        toast(e.message, true);
      }
      return false;
    }
  }

  const dlg = $('#mkDialog');
  let dlgRow = null;
  const slotSel = $('#mkSlot');
  const groupSel = $('#mkGroup');
  slotSel.append(...boot.slots.map(s => h('option', { value: s.id }, s.code)));
  function fillGroups() {
    const own = dlgRow ? dlgRow.m.homeGroupId : null;
    const list = groupsAll.filter(g => String(g.slotId) === slotSel.value && g.id !== own);
    groupSel.replaceChildren(...(list.length ? list.map(g => h('option', { value: g.id }, g.gaName)) : [h('option', { value: '' }, '（班がありません）')]));
  }
  slotSel.addEventListener('change', () => {
    fillGroups();
    $('#mkOther').checked = true;
  });
  groupSel.addEventListener('change', () => ($('#mkOther').checked = true));
  $('#mkCancel').addEventListener('click', () => dlg.close());
  const indivNo = $('#mkIndivNo');
  const indivWhen = $('#mkIndivWhen');
  const paintWhen = () => ($('#mkWhenLabel').hidden = indivNo.value !== '8');
  indivNo.addEventListener('change', () => {
    paintWhen();
    $('#mkIndivRadio').checked = true;
  });
  indivWhen.addEventListener('input', () => ($('#mkIndivRadio').checked = true));
  async function fillIndiv(row) {
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
    indivNo.replaceChildren(h('option', { value: '' }, '（枠はあとで決める）'));
    try {
      const d = await api.get(`/api/indiv?round=${row.round}`);
      indivNo.append(...d.slots.map(sl => h('option', { value: sl.no, disabled: sl.closed }, `${CIRCLED[sl.no - 1]} ${sl.label}${sl.closed ? '（実施なし）' : ''}`)));
    } catch (e) {
      $('#mkError').textContent = e.message;
    }
    indivNo.value = row.makeup && row.makeup.indivNo ? String(row.makeup.indivNo) : '';
    indivWhen.value = (row.makeup && row.makeup.indivWhen) || '';
    paintWhen();
  }

  function openMakeup(row) {
    dlgRow = row;
    $('#mkTitle').textContent = `補講：${row.m.name}（第${row.round}回）`;
    $('#mkError').textContent = '';
    const mk = row.makeup;
    const place = mk ? mk.place : '他班';
    for (const r of $$('input[name=place]')) r.checked = r.value === place;
    const host = mk && mk.hostGroupId ? groupsAll.find(g => g.id === mk.hostGroupId) : null;
    slotSel.value = String(host ? host.slotId : current.slotId);
    fillGroups();
    if (host) groupSel.value = String(host.id);
    fillIndiv(row);
    dlg.showModal();
  }

  $('#mkForm').addEventListener('submit', async e => {
    e.preventDefault();
    const place = ($$('input[name=place]').find(r => r.checked) || {}).value;
    if (!place) return void ($('#mkError').textContent = '受ける場所を選んでください');
    const extra = { place };
    if (place === '他班') {
      if (!groupSel.value) return void ($('#mkError').textContent = '補講先の班を選んでください');
      extra.hostGroupId = Number(groupSel.value);
    }
    if (place === '個別' && indivNo.value) {
      extra.indivNo = Number(indivNo.value);
      if (extra.indivNo === 8) {
        if (!indivWhen.value.trim()) return void ($('#mkError').textContent = '⑧（指定時間外）は日時を入れてください');
        extra.indivWhen = indivWhen.value.trim();
      }
    }
    $('#mkOk').disabled = true;
    try {
      const row = dlgRow;
      await save(row);
      const res = await api.post('/api/makeups', { studentId: row.m.studentId, round: row.round, version: row.makeup ? row.makeup.version : 0, requestId: newId(), ...extra });
      row.makeup = res.makeup;
      applyRecord(row, res.record);
      paintMakeup(row);
      setState(row, 'saved');
      dlg.close();
    } catch (err) {
      $('#mkError').textContent = err.status === 409 ? 'ほかの人が先に変更しました。いちど閉じて「最新にする」を押してください' : err.message;
    } finally {
      $('#mkOk').disabled = false;
    }
  });

  $('#entryTab').hidden = false;
  picker.refresh();
})();
