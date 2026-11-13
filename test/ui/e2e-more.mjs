// GA 画面・管理者画面の操作テスト（e2e.mjs から呼ばれる）
export async function run({ check, shot, BASE, env, f, loginGaUi, loginAdminUi, assert }) {
  const pick = async (page, slot, round) => {
    await page.locator('#slotSeg').getByRole('button', { name: slot, exact: true }).click();
    await page.locator('#roundSeg').getByRole('button', { name: `第${round}回`, exact: true }).click();
    await page.locator(`#entry[data-loaded="${slot}:${round}"]`).waitFor();
  };
  const row = (page, name) => page.locator('#entry tr[data-student]', { hasText: name });
  const saved = (page, name) => row(page, name).and(page.locator('[data-state="saved"]')).waitFor();

  // ---------- GA 画面 ----------
  await check('タイピングを入力して Enter → 保存され、再読み込み後も残る', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 1);
    await row(page, '青木 一').locator('input.typing').fill('145.2');
    await row(page, '青木 一').locator('input.typing').press('Enter');
    await saved(page, '青木 一');
    assert.equal(await row(page, '井上 二').locator('input.typing').evaluate(el => el === document.activeElement), true, 'Enter で下の行へ移る');
    assert.equal(await row(page, '青木 一').locator('select.att').inputValue(), '出席');
    await shot(page, 'ga-entry');
    await page.reload();
    await page.locator('#entry[data-loaded="月:1"]').waitFor();
    assert.equal(await row(page, '青木 一').locator('input.typing').inputValue(), '145.2');
  });

  await check('自分の班が先頭に出る／第0回は自由参加（出席のみ・タイピングもクイズも補講もない）', async page => {
    await loginGaUi(page, 'B');
    await pick(page, '月', 0);
    assert.match(await page.locator('#entry .group-head').first().innerText(), /B/);
    assert.equal(await page.locator('#entry input.typing').count(), 0);
    assert.equal(await page.locator('#entry input.quiz').count(), 0);
    assert.equal(await page.locator('#entry').getByRole('button', { name: '補講' }).count(), 0);
    const opts = await row(page, '江藤 四').locator('select.att option').allInnerTexts();
    assert.deepEqual(opts, ['（来ていない）', '出席']);
    await row(page, '江藤 四').locator('select.att').selectOption('出席');
    await page.locator('#entry .group-head').first().getByText('参加 1人').waitFor();
  });

  await check('「当日欠席」を選ぶと班の見出しの欠席数が増える／ニックネームを書き換えられる', async page => {
    await loginGaUi(page, 'B');
    await pick(page, '月', 6);
    const opts = await row(page, '小川 五').locator('select.att option').allInnerTexts();
    assert.ok(opts.includes('当日欠席'));
    assert.ok(!opts.includes('欠席'));
    await row(page, '小川 五').locator('select.att').selectOption('欠席');
    await page.locator('#entry .group-head').first().getByText('欠席 1人・補講 0人').waitFor();
    await row(page, '小川 五').locator('input.nick').fill('おがっち');
    await row(page, '小川 五').locator('input.nick').press('Tab');
    await row(page, '小川 五').and(page.locator('[data-state=saved]')).waitFor();
    await page.reload();
    await pick(page, '月', 6);
    assert.equal(await row(page, '小川 五').locator('input.nick').inputValue(), 'おがっち');
  });

  await check('タイピングに文字を入れると行にエラーが出る', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 5);
    await row(page, '青木 一').locator('input.typing').fill('abc');
    await row(page, '青木 一').locator('input.typing').press('Enter');
    await row(page, '青木 一').getByText('数字で入力してください').waitFor();
    // 入力を消せば、赤い行は元に戻り、ほかの回へ切り替えられる
    await row(page, '青木 一').locator('input.typing').fill('');
    await row(page, '青木 一').locator('input.typing').press('Enter');
    await pick(page, '月', 6);
  });

  await check('補講で 火1 C を選ぶ → 行に△、火1 の名簿に「補講で来る人」として出る', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 2);
    await row(page, '江藤 四').getByRole('button', { name: '補講', exact: true }).click();
    await page.getByLabel('ほかの班で受ける').check();
    await page.locator('#mkSlot').selectOption({ label: '火1' });
    await page.locator('#mkGroup').selectOption({ label: 'C' });
    await shot(page, 'ga-makeup-dialog');
    await page.getByRole('button', { name: '決定' }).click();
    await row(page, '江藤 四').locator('.chip', { hasText: '△' }).waitFor();
    assert.match(await row(page, '江藤 四').innerText(), /火1 C/);
    await pick(page, '火1', 2);
    const guest = page.locator('#entry tr.guest', { hasText: '江藤 四' });
    await guest.waitFor();
    assert.match(await guest.innerText(), /月 B/);
    await shot(page, 'ga-guest');
  });

  await check('補講先でタイピングを入れる → 元の班の行に同じ値が出て「済」', async page => {
    await loginGaUi(page, 'C');
    await pick(page, '火1', 2);
    const guest = page.locator('#entry tr.guest', { hasText: '江藤 四' });
    await guest.locator('input.typing').fill('133.3');
    await guest.locator('input.typing').press('Enter');
    await guest.and(page.locator('[data-state="saved"]')).waitFor();
    await pick(page, '月', 2);
    assert.equal(await row(page, '江藤 四').locator('input.typing').inputValue(), '133.3');
    await row(page, '江藤 四').getByText('済').waitFor();
  });

  await check('場所未定で登録 → できなかった → ×', async page => {
    await loginGaUi(page, 'B');
    await pick(page, '月', 3);
    await row(page, '小川 五').getByRole('button', { name: '補講', exact: true }).click();
    await page.getByLabel('まだ決まっていない').check();
    await page.getByRole('button', { name: '決定' }).click();
    await row(page, '小川 五').getByText('未定').first().waitFor();
    await row(page, '小川 五').getByRole('button', { name: 'できなかった' }).click();
    await row(page, '小川 五').locator('.chip', { hasText: '×' }).waitFor();
    await row(page, '小川 五').getByRole('button', { name: '取り消し' }).click();
    await row(page, '小川 五').getByRole('button', { name: '補講', exact: true }).waitFor();
    assert.equal(await row(page, '小川 五').locator('select.att').inputValue(), '欠席');
  });

  await check('別のタブで先に保存 → 「ほかの人が先に更新しました」が出て最新値になる', async (page, ctx) => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 4);
    const page2 = await ctx.newPage();
    await page2.goto(BASE + '/ga.html');
    await pick(page2, '月', 4);
    await row(page, '上田 三').locator('input.typing').fill('100');
    await row(page, '上田 三').locator('input.typing').press('Enter');
    await saved(page, '上田 三');
    await row(page2, '上田 三').locator('input.typing').fill('90');
    await row(page2, '上田 三').locator('input.typing').press('Enter');
    await row(page2, '上田 三').getByText('ほかの人が先に更新しました').waitFor();
    assert.equal(await row(page2, '上田 三').locator('input.typing').inputValue(), '100');
  });

  await check('保存に失敗した行があるとき、回を切り替えても入力が消えない', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 8);
    await page.route('**/api/records', r => r.abort());
    await row(page, '青木 一').locator('input.typing').fill('111');
    await row(page, '青木 一').locator('input.typing').press('Enter');
    await row(page, '青木 一').and(page.locator('[data-state="failed"]')).waitFor();
    await page.locator('#roundSeg').getByRole('button', { name: '第7回', exact: true }).click();
    await page.getByText('保存できていない行があります').waitFor();
    assert.equal(await page.locator('#entry').getAttribute('data-loaded'), '月:8');
    assert.equal(await row(page, '青木 一').locator('input.typing').inputValue(), '111');
    assert.match(await page.locator('#roundSeg button.on').innerText(), /第8回/);
    await page.locator('#slotSeg').getByRole('button', { name: '火1', exact: true }).click();
    assert.equal(await row(page, '青木 一').locator('input.typing').inputValue(), '111');
    await page.getByRole('button', { name: '最新にする' }).click();
    assert.equal(await row(page, '青木 一').locator('input.typing').inputValue(), '111');
    await page.unroute('**/api/records');
    await row(page, '青木 一').getByRole('button', { name: '再送' }).click();
    await saved(page, '青木 一');
    await pick(page, '月', 7);
    await pick(page, '月', 8);
    assert.equal(await row(page, '青木 一').locator('input.typing').inputValue(), '111');
  });

  await check('保存の途中で出欠を選び直すと、あとから選んだほうが残る', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 8);
    await page.route('**/api/records', async r => {
      await new Promise(res => setTimeout(res, 500));
      await r.continue();
    });
    const att = row(page, '上田 三').locator('select.att');
    await att.selectOption('出席');
    await att.selectOption('欠席');
    await page.waitForTimeout(1800);
    assert.equal(await att.inputValue(), '欠席');
    await page.unroute('**/api/records');
    await page.reload();
    await page.locator('#entry[data-loaded="月:8"]').waitFor();
    assert.equal(await row(page, '上田 三').locator('select.att').inputValue(), '欠席');
  });

  await check('受講生を探す → 全回の記録が出る', async page => {
    await loginGaUi(page, 'A');
    await page.getByRole('button', { name: '受講生を探す' }).click();
    await page.getByLabel('名前・ヨミ・ニックネーム').fill('アオキ');
    await page.locator('#searchResults').getByRole('button', { name: /青木 一/ }).click();
    await page.locator('#historyBox').getByText('145.2').waitFor();
    await shot(page, 'ga-history');
  });

  await check('GA の名簿タブと集計タブ', async page => {
    await loginGaUi(page, 'A');
    await page.getByRole('button', { name: '名簿（印刷）' }).click();
    await page.locator('#rvSlotSeg').getByRole('button', { name: '月', exact: true }).click();
    await page.locator('#rosterView .sheet').first().waitFor();
    await page.locator('#rosterView').getByRole('button', { name: '印刷する' }).waitFor();
    await shot(page, 'ga-roster');
    await page.getByRole('button', { name: '集計', exact: true }).click();
    await page.locator('#statsView').getByText('継続率').first().waitFor();
    await shot(page, 'ga-stats');
  });

  await check('個別補講：②を選ぶ・⑧は日時つき → 個別補講タブに枠ごとに出る（ナマエはカタカナ）', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 3);
    await row(page, '青木 一').getByRole('button', { name: '補講', exact: true }).click();
    await page.locator('#mkIndivNo').selectOption({ label: '② 木曜 13:00' });
    assert.equal(await page.locator('#mkIndivRadio').isChecked(), true);
    await page.getByRole('button', { name: '決定' }).click();
    await row(page, '青木 一').getByText('個別 ②木曜 13:00').waitFor();
    await row(page, '井上 二').getByRole('button', { name: '補講', exact: true }).click();
    await page.locator('#mkIndivNo').selectOption('8');
    await page.getByRole('button', { name: '決定' }).click();
    await page.locator('#mkError').getByText('日時を入れてください').waitFor();
    await page.locator('#mkIndivWhen').fill('5/8 15:00〜');
    await page.getByRole('button', { name: '決定' }).click();
    await row(page, '井上 二').getByText('個別 ⑧5/8 15:00〜').waitFor();
    await page.locator('#tabs').getByRole('button', { name: '個別補講', exact: true }).click();
    await page.locator('#ivRoundSeg').getByRole('button', { name: '第3回' }).click();
    const two = page.locator('#ivBody section[data-no="2"]');
    await two.getByText('アオキ ハジメ').waitFor();
    const eight = page.locator('#ivBody section[data-no="8"]');
    assert.match(await eight.innerText(), /5\/8 15:00〜[\s\S]*A[\s\S]*イノウエ ジ/);
    await shot(page, 'ga-indiv');
  });

  await check('LINE報告文：自分の班の欠席者がカタカナで入り、コピーできる／補講のLINE文', async page => {
    await loginGaUi(page, 'A');
    await pick(page, '月', 3);
    await page.locator('#entry .group-head').first().getByRole('button', { name: 'LINE報告文' }).click();
    const area = page.locator('#lineText');
    await page.waitForFunction(() => !document.querySelector('#lineText').value.includes('読み込み中'));
    const text = await area.inputValue();
    assert.match(text, /^お疲れ様です。Aです。\n月曜 第3回の受講生管理が終わりました。/);
    assert.match(text, /アオキ ハジメさん（補講：個別補講②木曜 13:00）/);
    assert.match(text, /システム入力済みです。$/);
    await page.locator('#lineCopy').click();
    await page.locator('#lineMsg').getByText('コピーしました').waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    await shot(page, 'ga-line');
    await page.locator('#lineDialog').getByRole('button', { name: '閉じる' }).click();
    await row(page, '井上 二').getByRole('button', { name: 'LINE文' }).click();
    await page.waitForFunction(() => document.querySelector('#lineText').value.includes('決まりました'));
    assert.match(await page.locator('#lineText').inputValue(), /月曜 A班のイノウエ ジさん（第3回欠席）の補講が、個別補講⑧5\/8 15:00〜に決まりました。/);
  });

  const admin = await import('./e2e-admin.mjs').catch(e => (e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e)));
  if (admin) await admin.run({ check, shot, BASE, env, f, loginGaUi, loginAdminUi, assert, pick, row });

  await check('60人のコマの表示が1秒以内', async page => {
    await env.db.query(
      `insert into students(term_id, name, kana, nickname, group_id)
       select $1, '生徒 ' || i, 'セイト ' || lpad(i::text, 3, '0'), 'n' || i, case when i % 2 = 0 then $2::int else $3::int end from generate_series(1, 55) i`,
      [f.term.id, f.groups['月A'].id, f.groups['月B'].id],
    );
    await loginGaUi(page, 'A');
    await pick(page, '火1', 6);
    const t0 = Date.now();
    await pick(page, '月', 6);
    const ms = Date.now() - t0;
    assert.ok((await page.locator('#entry tr[data-student]').count()) >= 60);
    assert.ok(ms < 1000, `${ms}ms`);
    await shot(page, 'ga-entry-60');
  });
}
