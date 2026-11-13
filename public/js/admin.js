// 管理者画面
(async () => {
  const { api, $, $$, h, toast, newId, requireLogin, logout } = koshu;
  const { rosterView, statsView, indivView, recordsView, lineDialog, statusChip } = koshuViews;

  const me = await requireLogin('admin');
  $('#whoName').textContent = `${me.name} さん（管理者）`;
  $('#logout').addEventListener('click', logout);

  let boot;
  try {
    boot = await api.get('/api/bootstrap');
  } catch (e) {
    $('#pageError').textContent = e.message;
    return;
  }
  if (!boot.term) {
    $('#firstTerm').hidden = false;
    $('#firstTermForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api.post('/api/admin/terms', { name: $('#firstTermName').value, active: true });
        location.reload();
      } catch (err) {
        $('#firstTermError').textContent = err.message;
      }
    });
    return;
  }
  const term = boot.term;
  const roundLabel = r => `第${r}回`;
  const when = at => new Date(at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  const guard = fn => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e.status === 401) return location.replace('/');
      toast(e.message, true);
    }
  };

  // ---------- 小さな部品 ----------
  function table(id, headers, rows, emptyText = 'まだありません') {
    return h(
      'div',
      { class: 'scroll' },
      h(
        'table',
        { class: 'grid', id },
        h('thead', {}, h('tr', {}, headers.map(x => (typeof x === 'string' ? h('th', {}, x) : h('th', { class: 'num' }, x.num))))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: headers.length, class: 'empty' }, emptyText))),
      ),
    );
  }
  const td = (...c) => h('td', {}, ...c);
  const btn = (label, onclick, cls = 'small') => h('button', { type: 'button', class: cls, onclick: guard(onclick) }, label);

  /** 入力ダイアログ。onSubmit が例外を投げたら、閉じずにメッセージを出す。 */
  function formDialog({ title, note, fields, okLabel = '保存', danger = false, onSubmit }) {
    const dlg = $('#formDialog');
    const err = h('p', { class: 'error', role: 'alert' });
    const inputs = {};
    const body = fields.map(f => {
      const id = `fd_${f.name}`;
      let el;
      if (f.type === 'select') {
        el = h('select', { id }, f.options.map(o => h('option', { value: o.value }, o.label)));
        el.value = String(f.value ?? (f.options[0] || {}).value ?? '');
      } else {
        el = h('input', { id, type: f.type || 'text', value: f.value ?? '', required: !!f.required, pattern: f.pattern, maxLength: f.maxLength, inputMode: f.inputMode, autocomplete: 'off' });
      }
      el.style.width = '100%';
      inputs[f.name] = el;
      return [h('label', { for: id }, f.label), el];
    });
    const ok = h('button', { type: 'submit', class: danger ? 'primary danger-fill' : 'primary' }, okLabel);
    const form = h('form', { class: 'dlg' }, h('h3', {}, title), note ? h('p', { class: 'note' }, note) : null, body, err, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'やめる'), ok));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      ok.disabled = true;
      err.textContent = '';
      try {
        await onSubmit(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
        dlg.close();
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        ok.disabled = false;
      }
    });
    dlg.replaceChildren(form);
    dlg.showModal();
  }

  /** 受講生を検索して1人選ぶ部品 */
  function studentPicker(id) {
    let chosen = null;
    const input = h('input', { type: 'search', placeholder: '名前・ヨミ・ニックネームで探す', autocomplete: 'off', style: 'width:100%' });
    const list = h('div', { class: 'names', style: 'margin-top:6px' });
    const picked = h('div', { hidden: true });
    const box = h('div', { id }, input, list, picked);
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) return list.replaceChildren();
        try {
          const found = await api.get(`/api/students/search?termId=${term.id}&q=${encodeURIComponent(q)}`);
          list.replaceChildren(...(found.length ? found.map(s => h('button', { type: 'button', onclick: () => set(s) }, `${s.name}（${s.homeLabel}）`)) : [h('p', { class: 'note' }, '見つかりませんでした')]));
        } catch (e) {
          list.replaceChildren(h('p', { class: 'error' }, e.message));
        }
      }, 250);
    });
    function set(s) {
      chosen = s;
      input.hidden = !!s;
      list.replaceChildren();
      picked.hidden = !s;
      if (s) picked.replaceChildren(h('span', { class: 'chip info' }, `${s.name}（${s.homeLabel}）`), ' ', h('button', { type: 'button', class: 'link', onclick: () => set(null) }, '選び直す'));
      else input.value = '';
    }
    return { el: box, get value() { return chosen; }, clear: () => set(null) };
  }

  let groupsCache = [];
  const loadGroups = async () => (groupsCache = await api.get(`/api/groups?termId=${term.id}`));
  const groupLabel = g => `${g.slotCode} ${g.gaName}`;
  const groupOptions = () => groupsCache.map(g => h('option', { value: g.id }, groupLabel(g)));
  const roundOptions = () => term.rounds.map(r => h('option', { value: r }, roundLabel(r)));

  // ---------- タブ ----------
  const tabs = {};
  async function openTab(name) {
    for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
    for (const b of $$('#tabs button')) $(`#tab-${b.dataset.tab}`).hidden = b.dataset.tab !== name;
    await guard(tabs[name])();
  }
  for (const b of $$('#tabs button')) b.addEventListener('click', () => openTab(b.dataset.tab));
  $('#tabs').hidden = false;

  // ---------- 名簿・集計 ----------
  let rosterV, statsV;
  tabs.roster = async () => (rosterV ? rosterV.refresh() : (rosterV = rosterView($('#rosterView'), boot)));
  let recordsV;
  tabs.records = async () => (recordsV ? recordsV.refresh() : (recordsV = recordsView($('#recordsView'), boot)));
  tabs.stats = async () => (statsV ? statsV.refresh() : (statsV = statsView($('#statsView'), boot)));

  // ---------- 個別補講 ----------
  let indivV;
  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];
  tabs.indiv = async () =>
    indivV
      ? indivV.refresh()
      : (indivV = indivView($('#indivView'), boot, {
          onEdit: (sl, round, reload) =>
            formDialog({
              title: `第${round}回 ${CIRCLED[sl.no - 1]} の変更`,
              note: `基本は「${sl.defaultLabel}」です。この回だけ時間が違うときに書き換えてください。空にすると基本に戻ります。`,
              fields: [
                { name: 'label', label: '曜日と時間', value: sl.label === sl.defaultLabel ? '' : sl.label, maxLength: 30 },
                { name: 'host', label: '補講担当者', value: sl.host || '', maxLength: 30 },
                { name: 'room', label: '場所', value: sl.room || '', maxLength: 30 },
                { name: 'closed', label: '実施', type: 'select', value: sl.closed ? '1' : '', options: [{ value: '', label: '実施する' }, { value: '1', label: '実施なし（祝日など）' }] },
              ],
              onSubmit: async v => {
                await api.post('/api/admin/indiv-slots', { termId: term.id, round, no: sl.no, label: v.label, host: v.host, room: v.room, closed: v.closed === '1' });
                await reload();
              },
            }),
          onEditBase: async () => {
            const d = await api.get(`/api/indiv?termId=${term.id}&round=${term.rounds.find(r => r !== 0)}`);
            formDialog({
              title: '①〜⑦の基本の曜日と時間',
              note: '毎回この時間で表示されます。ある回だけ違うときは、その回の枠の「変更」で書き換えてください。',
              fields: d.slots.slice(0, 7).map(sl => ({ name: `l${sl.no}`, label: CIRCLED[sl.no - 1], value: sl.defaultLabel, required: true, maxLength: 30 })),
              onSubmit: async v => {
                await api.post('/api/admin/indiv-labels', { termId: term.id, labels: [1, 2, 3, 4, 5, 6, 7].map(n => v[`l${n}`]) });
                await indivV.refresh();
              },
            });
          },
        }));

  // ---------- 補講 ----------
  const SELECTABLE = ['出席', '記録なし', '時間切れ'];
  const ATT_LABEL = { 記録なし: '出席（記録なし）', 時間切れ: '出席（時間切れ）' };
  tabs.makeups = async () => {
    const root = $('#tab-makeups');
    await loadGroups();
    if (!root.firstChild) {
      root.append(
        h(
          'div',
          { class: 'bar' },
          h('label', { class: 'inline' }, '回 ', h('select', { id: 'mkRound', onchange: () => tabs.makeups() }, h('option', { value: '' }, 'すべて'), term.rounds.filter(r => r !== 0).map(r => h('option', { value: r }, roundLabel(r))))),
          h('label', { class: 'inline' }, '状態 ', h('select', { id: 'mkStatus', onchange: () => tabs.makeups() }, h('option', { value: '' }, 'すべて'), ['未定', '予定', '済', 'できず'].map(s => h('option', { value: s }, s)))),
          h('span', { class: 'grow' }),
          btn('更新', () => tabs.makeups(), ''),
        ),
        h('p', { class: 'note' }, '振替先GAを選び直すと、補講先の名簿に自動で反映されます。個別補講で受けた人は、ここで出欠とタイピングを入れると「済」になり、出欠は「欠席・補講済み」として残ります。'),
        h('div', { id: 'mkBox' }),
      );
    }
    const q = new URLSearchParams({ termId: term.id });
    if ($('#mkRound').value) q.set('round', $('#mkRound').value);
    if ($('#mkStatus').value) q.set('status', $('#mkStatus').value);
    const list = await api.get(`/api/makeups?${q}`);
    const bySlot = new Map();
    for (const g of groupsCache) (bySlot.get(g.slotCode) || bySlot.set(g.slotCode, []).get(g.slotCode)).push(g);
    $('#mkBox').replaceChildren(
      table(
        'mkList',
        ['回', '名前', '元の班', '振替先GA', '状態', '出欠', 'タイピング', ''],
        list.map(m => {
          const place = h(
            'select',
            { class: 'place', 'aria-label': `振替先GA ${m.name}` },
            h('option', { value: '未定' }, '振替先未定'),
            h('option', { value: '個別' }, '個別補講'),
            [...bySlot].map(([code, gs]) => h('optgroup', { label: code }, gs.filter(g => g.id !== m.homeGroupId).map(g => h('option', { value: `g${g.id}` }, groupLabel(g))))),
          );
          place.value = m.place === '他班' ? `g${m.hostGroupId}` : m.place;
          place.addEventListener(
            'change',
            guard(async () => {
              const v = place.value;
              try {
                await api.post('/api/makeups', { studentId: m.studentId, round: m.round, version: m.version, requestId: newId(), ...(v.startsWith('g') ? { place: '他班', hostGroupId: Number(v.slice(1)) } : { place: v }) });
              } finally {
                await tabs.makeups();
              }
            }),
          );
          const saveRecord = guard(async patch => {
            try {
              await api.post('/api/records', { studentId: m.studentId, round: m.round, version: m.record ? m.record.version : 0, requestId: newId(), ...patch });
            } finally {
              await tabs.makeups();
            }
          });
          const att = h('select', { 'aria-label': `出欠 ${m.name}` }, h('option', { value: m.record && !SELECTABLE.includes(m.record.attendance) ? m.record.attendance || '' : '' }, m.record && m.record.attendance && !SELECTABLE.includes(m.record.attendance) ? m.record.attendance : '（未入力）'), SELECTABLE.map(a => h('option', { value: a }, ATT_LABEL[a] || a)));
          if (m.record && SELECTABLE.includes(m.record.attendance)) att.value = m.record.attendance;
          att.addEventListener('change', () => SELECTABLE.includes(att.value) && saveRecord({ attendance: att.value }));
          const typing = term.typing_rounds.includes(m.round) ? h('input', { class: 'typing', style: 'width:80px;text-align:right', inputMode: 'decimal', value: m.record?.typing ?? '', 'aria-label': `タイピング ${m.name}` }) : null;
          if (typing) typing.addEventListener('change', () => saveRecord({ typing: typing.value }));
          return h(
            'tr',
            {},
            td(roundLabel(m.round)),
            td(m.name, h('div', { class: 'sub' }, m.nickname || '')),
            td(m.homeLabel),
            td(place, m.indivLabel ? h('div', { class: 'sub' }, m.indivLabel) : null),
            td(statusChip(m.status)),
            td(att),
            td(typing || '—'),
            td(
              m.status === '予定' || m.status === '未定' ? btn('できなかった', async () => { await api.post('/api/makeups/fail', { studentId: m.studentId, round: m.round, version: m.version }); await tabs.makeups(); }, 'small danger') : null,
              ' ',
              btn('取り消し', async () => { await api.post('/api/makeups/cancel', { studentId: m.studentId, round: m.round, version: m.version }); await tabs.makeups(); }),
            ),
          );
        }),
        '補講の登録はありません',
      ),
    );
  };

  // ---------- 解約・移動 ----------
  let wdPick, trPick;
  tabs.changes = async () => {
    const root = $('#tab-changes');
    await loadGroups();
    if (!root.firstChild) {
      wdPick = studentPicker('wdPick');
      trPick = studentPicker('trPick');
      root.append(
        h(
          'section',
          { class: 'card' },
          h('h2', {}, '解約'),
          h('label', {}, '受講生'),
          wdPick.el,
          h('div', { class: 'bar', style: 'margin-top:10px' }, h('label', { class: 'inline' }, 'この回から受けていない ', h('select', { id: 'wdRound' }, roundOptions())), h('label', { class: 'inline grow' }, '理由（任意） ', h('input', { id: 'wdReason', style: 'flex:1;min-width:160px', maxLength: 200 })), btn('解約を登録', addWithdrawal, 'primary')),
          h('div', { id: 'wdBox' }),
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'コマ移動'),
          h('label', {}, '受講生'),
          trPick.el,
          h('div', { class: 'bar', style: 'margin-top:10px' }, h('label', { class: 'inline' }, '移動先の班 ', h('select', { id: 'trGroup' })), h('label', { class: 'inline' }, '移動後に受ける最初の回 ', h('select', { id: 'trRound' }, roundOptions())), btn('移動を登録', addTransfer, 'primary')),
          h('div', { id: 'trBox' }),
        ),
      );
    }
    $('#trGroup').replaceChildren(...groupOptions());
    const [wd, tr] = await Promise.all([api.get(`/api/admin/withdrawals?termId=${term.id}`), api.get(`/api/admin/transfers?termId=${term.id}`)]);
    const act = (path, label, cls) => btn(label, async () => { await api.post(path); await tabs.changes(); }, cls);
    $('#wdBox').replaceChildren(
      table(
        'wdList',
        ['名前', 'コマ・班', '未受講回', '理由', '受講生管理', '職員確認', ''],
        wd.map(w =>
          h(
            'tr',
            { style: w.cancelledAt ? 'opacity:.5' : null },
            td(w.name, h('div', { class: 'sub' }, w.kana || '')),
            td(`${w.slotCode} ${w.gaName}`),
            td(`${roundLabel(w.fromRound)}から`),
            td(w.reason || ''),
            td(w.cancelledAt ? '' : w.managerCheckedBy ? h('span', { class: 'chip done' }, `確認：${w.managerCheckedName}`) : act(`/api/admin/withdrawals/${w.id}/check`, '確認する')),
            td(w.cancelledAt ? '' : w.staffConfirmed ? h('span', { class: 'chip done' }, '職員 OK') : act(`/api/admin/withdrawals/${w.id}/confirm`, 'OK を付ける')),
            td(w.cancelledAt ? h('span', { class: 'chip none' }, '取り消し済み') : act(`/api/admin/withdrawals/${w.id}/cancel`, '取り消し', 'small danger')),
          ),
        ),
        '解約の登録はありません',
      ),
    );
    $('#trBox').replaceChildren(
      table(
        'trList',
        ['名前', '移動', 'この回から', '受講生管理', '', '報告'],
        tr.map(t =>
          h(
            'tr',
            { style: t.cancelledAt ? 'opacity:.5' : null },
            td(t.name, h('div', { class: 'sub' }, t.kana || '')),
            td(`${t.fromLabel} → ${t.toLabel}`),
            td(roundLabel(t.fromRound)),
            td(t.cancelledAt ? '' : t.managerCheckedBy ? h('span', { class: 'chip done' }, `確認：${t.managerCheckedName}`) : act(`/api/admin/transfers/${t.id}/check`, '確認する')),
            td(t.cancelledAt ? h('span', { class: 'chip none' }, '取り消し済み') : act(`/api/admin/transfers/${t.id}/cancel`, '取り消し', 'small danger')),
            td(t.cancelledAt ? '' : btn('LINE文', () => lineDialog('曜日変更の LINE 文', `/api/line/transfer?id=${t.id}`))),
          ),
        ),
        'コマ移動の登録はありません',
      ),
    );
  };
  async function addWithdrawal() {
    if (!wdPick.value) return toast('受講生を選んでください', true);
    await api.post('/api/admin/withdrawals', { studentId: wdPick.value.id, fromRound: Number($('#wdRound').value), reason: $('#wdReason').value });
    wdPick.clear();
    $('#wdReason').value = '';
    toast('解約を登録しました');
    await tabs.changes();
  }
  async function addTransfer() {
    if (!trPick.value) return toast('受講生を選んでください', true);
    await api.post('/api/admin/transfers', { studentId: trPick.value.id, toGroupId: Number($('#trGroup').value), fromRound: Number($('#trRound').value) });
    trPick.clear();
    toast('コマ移動を登録しました');
    await tabs.changes();
  }

  // ---------- 受講生・班 ----------
  const parseRounds = s => String(s).split(/[,、\s]+/).filter(Boolean).map(Number);
  let students = [];
  tabs.master = async () => {
    const root = $('#tab-master');
    if (!root.firstChild) {
      root.append(
        h(
          'section',
          { class: 'card' },
          h('h2', {}, '名簿の一括取り込み'),
          h('p', { class: 'note' }, 'スプレッドシートで「コマ・GA・名前・ヨミ・ニックネーム」の順に並んだ列を選んでコピーし、下に貼り付けてください。すでに登録済みの人（名前とヨミが同じ）は飛ばします。'),
          h('textarea', { id: 'importText', rows: 6, style: 'width:100%;font-family:monospace', placeholder: '月\tいけ\t山田 太郎\tヤマダ タロウ\tたろう', 'aria-label': '貼り付け欄' }),
          h('div', { class: 'bar', style: 'margin-top:8px' }, btn('確認する', previewImport, ''), h('button', { type: 'button', class: 'primary', id: 'importCommit', disabled: true, onclick: guard(commitImport) }, 'この内容で取り込む')),
          h('div', { id: 'importPreview' }),
        ),
        h('section', { class: 'card' }, h('h2', {}, '受講生'), h('div', { class: 'bar' }, h('input', { id: 'studentFilter', type: 'search', placeholder: '名前・ヨミ・ニックネーム・コマ・GA で絞り込み', style: 'flex:1;min-width:200px', oninput: paintStudents, 'aria-label': '受講生の絞り込み' }), btn('受講生を1人追加', () => editStudent(null), '')), h('div', { id: 'studentBox' })),
        h('section', { class: 'card' }, h('h2', {}, '班'), h('div', { class: 'bar' }, h('label', { class: 'inline' }, 'コマ ', h('select', { id: 'groupSlot' }, boot.slots.map(s => h('option', { value: s.id }, s.code)))), h('label', { class: 'inline' }, 'GA ', h('select', { id: 'groupGa' })), btn('班を追加', addGroup, '')), h('div', { id: 'groupBox' })),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, '年度の設定'),
          h('div', { class: 'bar' }, h('label', { class: 'inline' }, '年度の名前 ', h('input', { id: 'termName', value: term.name, style: 'min-width:220px' })), h('label', { class: 'inline' }, '初期受講生数 ', h('input', { id: 'termInitial', inputMode: 'numeric', style: 'width:90px', value: term.initial_count ?? '', placeholder: '自動' }))),
          h('div', { class: 'bar' }, h('label', { class: 'inline' }, '回 ', h('input', { id: 'termRounds', value: term.rounds.join(','), style: 'width:170px' })), h('label', { class: 'inline' }, 'タイピングの回 ', h('input', { id: 'termTyping', value: term.typing_rounds.join(','), style: 'width:150px' })), h('label', { class: 'inline' }, 'クイズの回 ', h('input', { id: 'termQuiz', value: term.quiz_rounds.join(','), style: 'width:90px' }))),
          h('p', { class: 'note' }, '初期受講生数は継続率の分母です。空のままにすると、登録されている受講生の人数を使います。第0回は自由参加（出席のみ）として扱います。回は「0,1,2」のように数字をカンマで区切ります。'),
          h('div', { class: 'bar' }, btn('年度の設定を保存', saveTerm, 'primary'), h('span', { class: 'grow' }), btn('新しい年度を始める', newTerm, '')),
        ),
      );
    }
    await loadGroups();
    const staff = await api.get('/api/admin/staff');
    $('#groupGa').replaceChildren(...staff.filter(s => s.role === 'ga' && s.active).map(s => h('option', { value: s.id }, s.name)));
    students = await api.get(`/api/admin/students?termId=${term.id}`);
    paintStudents();
    const sizes = new Map();
    for (const s of students) sizes.set(s.groupId, (sizes.get(s.groupId) || 0) + 1);
    $('#groupBox').replaceChildren(
      table(
        'groupList',
        ['コマ', 'GA', { num: '登録時の人数' }, ''],
        groupsCache.map(g => h('tr', {}, td(g.slotCode), td(g.gaName, g.gaActive ? '' : h('span', { class: 'chip none', style: 'margin-left:6px' }, '無効')), h('td', { class: 'num' }, sizes.get(g.id) || 0), td(sizes.get(g.id) ? '' : btn('削除', async () => { await api.post(`/api/admin/groups/${g.id}/delete`); await tabs.master(); }, 'small danger')))),
        '班がまだありません。名簿を取り込むと自動で作られます',
      ),
    );
  };
  function paintStudents() {
    const q = ($('#studentFilter').value || '').trim();
    const list = q ? students.filter(s => [s.name, s.kana, s.nickname, s.slotCode, s.gaName].some(v => v && v.includes(q))) : students;
    const shown = list.slice(0, 200);
    $('#studentBox').replaceChildren(
      h('p', { class: 'note' }, `${list.length}人${list.length > shown.length ? `（先頭の${shown.length}人を表示。絞り込んでください）` : ''}`),
      table('studentList', ['名前', 'ヨミ', 'ニックネーム', '登録時のコマ・班', ''], shown.map(s => h('tr', {}, td(s.name), td(s.kana || ''), td(s.nickname || ''), td(`${s.slotCode} ${s.gaName}`), td(btn('編集', () => editStudent(s))))), '受講生がまだいません'),
    );
  }
  function editStudent(s) {
    if (!groupsCache.length) return toast('先に班を作ってください', true);
    formDialog({
      title: s ? '受講生の編集' : '受講生の追加',
      note: s ? 'コマを移る場合は、ここではなく「解約・移動」タブで登録してください（過去の回の名簿が変わらないようにするため）。' : null,
      fields: [
        { name: 'name', label: '名前', value: s?.name, required: true, maxLength: 60 },
        { name: 'kana', label: 'ヨミ', value: s?.kana, maxLength: 60 },
        { name: 'nickname', label: 'ニックネーム', value: s?.nickname, maxLength: 40 },
        { name: 'groupId', label: '班', type: 'select', value: s?.groupId, options: groupsCache.map(g => ({ value: g.id, label: groupLabel(g) })) },
      ],
      onSubmit: async v => {
        await api.post('/api/admin/students', { id: s?.id, name: v.name, kana: v.kana, nickname: v.nickname, groupId: Number(v.groupId) });
        toast('保存しました');
        await tabs.master();
      },
    });
  }
  async function addGroup() {
    if (!$('#groupGa').value) return toast('先に「スタッフ」タブで GA を登録してください', true);
    await api.post('/api/admin/groups', { slotId: Number($('#groupSlot').value), gaId: Number($('#groupGa').value) });
    toast('班を追加しました');
    await tabs.master();
  }
  async function saveTerm() {
    const t = await api.post('/api/admin/terms', { id: term.id, name: $('#termName').value, rounds: parseRounds($('#termRounds').value), typingRounds: parseRounds($('#termTyping').value), quizRounds: parseRounds($('#termQuiz').value), initialCount: $('#termInitial').value.trim() === '' ? null : Number($('#termInitial').value), active: true });
    Object.assign(term, { name: t.name, rounds: t.rounds, typing_rounds: t.typing_rounds, quiz_rounds: t.quiz_rounds, initial_count: t.initial_count });
    toast('年度の設定を保存しました');
  }
  function newTerm() {
    formDialog({
      title: '新しい年度を始める',
      note: '新しい年度を作って切り替えます。今の年度の受講生と記録は残りますが、画面には新しい年度だけが表示されるようになります。',
      fields: [{ name: 'name', label: '新しい年度の名前', required: true, maxLength: 60 }],
      okLabel: '作って切り替える',
      onSubmit: async v => {
        await api.post('/api/admin/terms', { name: v.name, active: true });
        location.reload();
      },
    });
  }
  let importText = '';
  async function previewImport() {
    importText = $('#importText').value;
    $('#importCommit').disabled = true;
    const p = await api.post('/api/admin/import/preview', { termId: term.id, text: importText });
    const s = p.summary;
    // replaceChildren は null を「null」という文字として出すので、h() で包んで空を飛ばす
    $('#importPreview').replaceChildren(
      h('p', {}, h('b', {}, `取り込む受講生：${s.students}人`), `　新しく作る GA：${s.newGa}人　新しく作る班：${s.newGroups}班　重複で飛ばす：${s.duplicates}人`),
      h('div', {}, p.errors.length ? h('div', { class: 'error' }, `取り込めない行が ${p.errors.length} 行あります。貼り付け欄を直して、もう一度「確認する」を押してください。\n` + p.errors.map(e => `　${e.line}行目：${e.reason}`).join('\n')) : null),
      table('importRows', ['行', 'コマ', 'GA', '名前', 'ヨミ', 'ニックネーム', ''], p.rows.slice(0, 500).map(r => h('tr', { style: r.duplicate ? 'opacity:.5' : null }, td(r.line), td(r.slotCode), td(r.gaName, r.newGa ? h('span', { class: 'chip info', style: 'margin-left:6px' }, '新しい GA') : ''), td(r.name), td(r.kana || ''), td(r.nickname || ''), td(r.duplicate ? h('span', { class: 'chip none' }, '重複・飛ばす') : r.newGroup ? h('span', { class: 'chip info' }, '新しい班') : ''))), '取り込める行がありません'),
    );
    $('#importCommit').disabled = p.errors.length > 0 || s.students === 0;
  }
  async function commitImport() {
    $('#importCommit').disabled = true;
    const r = await api.post('/api/admin/import/commit', { termId: term.id, text: importText, requestId: newId() });
    toast(`${r.imported}人を取り込みました${r.skipped ? `（重複 ${r.skipped}人は飛ばしました）` : ''}`);
    $('#importText').value = '';
    $('#importPreview').replaceChildren();
    await tabs.master();
  }

  // ---------- スタッフ ----------
  tabs.staff = async () => {
    const root = $('#tab-staff');
    if (!root.firstChild) {
      root.append(
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'スタッフ'),
          h('div', { class: 'bar' }, h('label', { class: 'inline' }, '名前 ', h('input', { id: 'staffName', maxLength: 40 })), h('label', { class: 'inline' }, '役割 ', h('select', { id: 'staffRole' }, h('option', { value: 'ga' }, 'GA'), h('option', { value: 'admin' }, '管理者'))), btn('スタッフを追加', addStaff, 'primary')),
          h('p', { class: 'note' }, 'GA は名前を選ぶだけでログインします。管理者は暗証番号が必要です（追加したあと「暗証番号を設定」を押してください）。辞めた人は削除せず「無効にする」を押すと、ログイン画面に出なくなります（過去の記録は残ります）。'),
          h('div', { id: 'staffBox' }),
        ),
      );
    }
    const staff = await api.get('/api/admin/staff');
    const update = (s, patch) => api.post('/api/admin/staff', { id: s.id, name: s.name, role: s.role, active: s.active, ...patch }).then(() => tabs.staff());
    $('#staffBox').replaceChildren(
      table(
        'staffList',
        ['名前', '役割', '状態', ''],
        staff.map(s =>
          h(
            'tr',
            { style: s.active ? null : 'opacity:.55' },
            td(s.name),
            td(s.role === 'admin' ? '管理者' : 'GA'),
            td(s.active ? h('span', { class: 'chip done' }, '有効') : h('span', { class: 'chip none' }, '無効'), s.role === 'admin' ? h('span', { class: `chip ${s.hasPin ? 'info' : 'plan'}`, style: 'margin-left:6px' }, s.hasPin ? '暗証番号 設定済み' : '暗証番号 未設定') : '', s.locked ? h('span', { class: 'chip fail', style: 'margin-left:6px' }, 'ロック中') : ''),
            td(
              h(
                'div',
                { style: 'display:flex;gap:4px;flex-wrap:wrap' },
                btn('名前を変える', () => formDialog({ title: '名前を変える', fields: [{ name: 'name', label: '新しい名前', value: s.name, required: true, maxLength: 40 }], onSubmit: v => update(s, { name: v.name }) })),
                s.role === 'admin' ? btn('暗証番号を設定', () => formDialog({ title: `${s.name} さんの暗証番号`, fields: [{ name: 'pin', label: '新しい暗証番号（数字4〜8桁）', type: 'password', required: true, pattern: '[0-9]{4,8}', maxLength: 8, inputMode: 'numeric' }], onSubmit: async v => { await api.post(`/api/admin/staff/${s.id}/pin`, { pin: v.pin }); toast('暗証番号を設定しました'); await tabs.staff(); } })) : null,
                s.locked ? btn('ロック解除', async () => { await api.post(`/api/admin/staff/${s.id}/unlock`); await tabs.staff(); }) : null,
                s.id === me.id ? null : s.active ? btn('無効にする', () => update(s, { active: false }), 'small danger') : btn('有効に戻す', () => update(s, { active: true })),
              ),
            ),
          ),
        ),
      ),
    );
  };
  async function addStaff() {
    await api.post('/api/admin/staff', { name: $('#staffName').value, role: $('#staffRole').value });
    $('#staffName').value = '';
    toast('追加しました');
    await tabs.staff();
  }

  // ---------- 操作履歴 ----------
  const HIDE = new Set(['id', 'version', 'updated_at', 'updated_by', 'created_at', 'created_by', 'pin_hash', 'failed_logins', 'locked_until', 'studentId', 'student_id', 'term_id']);
  const show = v => (v == null || v === '' ? '（空）' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  function changeText(before, after) {
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(k => !HIDE.has(k));
    let parts;
    if (before && after) parts = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => `${k}: ${show(before[k])} → ${show(after[k])}`);
    else if (after) parts = keys.filter(k => after[k] != null).map(k => `${k}: ${show(after[k])}`);
    else if (before) parts = ['削除：' + keys.filter(k => before[k] != null).map(k => `${k}: ${show(before[k])}`).join('、')];
    else parts = [];
    const text = parts.join('、');
    return text.length > 260 ? text.slice(0, 260) + '…' : text;
  }
  let auditRows = [];
  tabs.audit = async (more = false) => {
    const root = $('#tab-audit');
    if (!root.firstChild) root.append(h('p', { class: 'note' }, 'すべての変更を、新しい順に表示しています。'), h('div', { id: 'auditBox' }), h('p', {}, btn('さらに前を見る', () => tabs.audit(true), '')));
    const beforeId = more && auditRows.length ? `&beforeId=${auditRows[auditRows.length - 1].id}` : '';
    const page = await api.get(`/api/admin/audit?limit=100${beforeId}`);
    auditRows = more ? [...auditRows, ...page] : page;
    $('#auditBox').replaceChildren(table('auditList', ['日時', '操作した人', '操作', '対象', '内容'], auditRows.map(a => h('tr', {}, td(when(a.at)), td(a.operatorName || '—'), td(a.action), td(a.targetTable ? `${a.targetTable} #${a.targetId ?? ''}` : ''), h('td', { class: 'sub' }, changeText(a.before, a.after)))), '履歴はまだありません'));
  };

  // ---------- データ・バックアップ ----------
  tabs.data = async () => {
    const root = $('#tab-data');
    if (!root.firstChild) {
      const confirmInput = h('input', { id: 'resetConfirm', placeholder: '初期化', autocomplete: 'off', style: 'width:120px', 'aria-label': '確認のため「初期化」と入力' });
      const resetBtn = h('button', { type: 'button', class: 'danger', disabled: true, onclick: guard(doReset) }, '初期化する');
      confirmInput.addEventListener('input', () => (resetBtn.disabled = confirmInput.value !== '初期化'));
      root.append(
        h('section', { class: 'card' }, h('h2', {}, 'バックアップ'), h('p', { class: 'note' }, '毎日 3:00 に自動で保存し、30日分を残します。「この状態に戻す」を押すと、その時点の内容に全体が戻ります（戻す直前の状態も自動で保存されます）。'), h('div', { class: 'bar' }, btn('今すぐバックアップ', async () => { await api.post('/api/admin/backups'); toast('バックアップしました'); await tabs.data(); }, 'primary')), h('div', { id: 'backupBox' })),
        h('section', { class: 'card' }, h('h2', {}, 'CSV で保存'), h('div', { class: 'bar' }, h('a', { class: 'button', href: `/api/export/records.csv?termId=${term.id}` }, '全記録'), h('a', { class: 'button', href: `/api/export/stats.csv?termId=${term.id}` }, '集計'), h('span', { class: 'note' }, '回ごとの名簿の CSV は「名簿」タブにあります。'))),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, '初期化'),
          h('p', { class: 'note' }, '試しに入れた記録を消して、本番の運用を始めるときに使います。消す直前の状態は自動でバックアップされ、上の一覧の「初期化前」から戻せます。'),
          h('p', { id: 'resetPreview' }),
          h('p', {}, h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 'resetRoster' }), ' 受講生名簿と班も消す（年度替わり用。スタッフは残ります）')),
          h('div', { class: 'bar' }, h('span', {}, '確認のため「初期化」と入力：'), confirmInput, resetBtn),
        ),
      );
    }
    const [backups, pv] = await Promise.all([api.get('/api/admin/backups'), api.get('/api/admin/reset')]);
    $('#resetPreview').textContent = `消えるもの：記録 ${pv.records}件、補講 ${pv.makeups}件、解約 ${pv.withdrawals}件、コマ移動 ${pv.transfers}件、操作履歴 ${pv.audit_log}件。　残るもの：スタッフ、年度とコマ、受講生 ${pv.students}人、班 ${pv.groups}班。`;
    $('#backupBox').replaceChildren(
      table(
        'backupList',
        ['日時', '種類', { num: '大きさ' }, ''],
        backups.map(b =>
          h(
            'tr',
            {},
            td(when(b.at)),
            td(b.kind),
            h('td', { class: 'num' }, `${Math.max(1, Math.round(b.size / 1024))} KB`),
            td(
              h('a', { class: 'button small', href: `/api/admin/backups/download?key=${encodeURIComponent(b.key)}` }, 'ダウンロード'),
              ' ',
              btn('この状態に戻す', () =>
                formDialog({
                  title: `${when(b.at)}（${b.kind}）の状態に戻す`,
                  note: 'このあとに入力された記録は、すべてこの時点の内容に置き換わります。今の状態は「復元前」として自動で保存されます。',
                  fields: [{ name: 'confirm', label: '確認のため「復元」と入力してください', required: true }],
                  okLabel: '復元する',
                  onSubmit: async v => {
                    await api.post('/api/admin/backups/restore', { key: b.key, confirm: v.confirm });
                    toast('復元しました');
                    await tabs.data();
                  },
                }),
              ),
            ),
          ),
        ),
        'バックアップはまだありません',
      ),
    );
  };
  async function doReset() {
    await api.post('/api/admin/reset', { confirm: $('#resetConfirm').value, includeRoster: $('#resetRoster').checked });
    $('#resetConfirm').value = '';
    $('#resetRoster').checked = false;
    $('#resetConfirm').dispatchEvent(new Event('input'));
    toast('初期化しました');
    await tabs.data();
  }

  openTab('roster');
})();
