// 管理者画面の操作テスト（e2e-more.mjs から呼ばれる）
import { writeFileSync } from 'node:fs';

export async function run({ check, shot, BASE, env, f, loginGaUi, loginAdminUi, assert, pick, row }) {
  const tab = (page, name) => page.locator('#tabs').getByRole('button', { name, exact: true }).click();
  const count = async t => (await env.db.query(`select count(*)::int as n from ${t}`))[0].n;
  const choose = async (page, boxId, query, name) => {
    await page.locator(`#${boxId} input[type=search]`).fill(query);
    await page.locator(`#${boxId}`).getByRole('button', { name: new RegExp(name) }).click();
  };

  await check('GA でログインして admin.html を開くとログイン画面に戻る', async page => {
    await loginGaUi(page, 'A');
    await page.goto(BASE + '/admin.html');
    await page.waitForURL(BASE + '/');
  });

  await check('一括取り込み：エラー行が出る → 直して取り込み → 受講生に出る', async page => {
    await loginAdminUi(page);
    await tab(page, '受講生・班');
    await page.locator('#importText').fill('コマ\tGA\t名前\tヨミ\tニックネーム\n月\tA\t新規 太郎\tシンキ タロウ\tたろ\n土\tA\t誤り 花子\tアヤマリ ハナコ\tはな');
    await page.getByRole('button', { name: '確認する' }).click();
    await page.locator('#importPreview').getByText('コマ「土」が見つかりません').waitFor();
    assert.equal(await page.getByRole('button', { name: 'この内容で取り込む' }).isDisabled(), true);
    await shot(page, 'admin-import-error');
    await page.locator('#importText').fill('月\tA\t新規 太郎\tシンキ タロウ\tたろ\n火２\tしんじん\t追加 花子\tツイカ ハナコ\tはな');
    await page.getByRole('button', { name: '確認する' }).click();
    await page.locator('#importPreview').getByText('新しく作る GA：1人').waitFor();
    assert.doesNotMatch(await page.locator('#importPreview').innerText(), /null|undefined/);
    await shot(page, 'admin-import-preview');
    await page.getByRole('button', { name: 'この内容で取り込む' }).click();
    await page.getByText('2人を取り込みました').waitFor();
    await page.locator('#studentFilter').fill('ツイカ');
    await page.locator('#studentList tr', { hasText: '追加 花子' }).waitFor();
    assert.match(await page.locator('#studentList tr', { hasText: '追加 花子' }).innerText(), /火2/);
  });

  await check('受講生の追加と編集', async page => {
    await loginAdminUi(page);
    await tab(page, '受講生・班');
    await page.getByRole('button', { name: '受講生を1人追加' }).click();
    await page.getByLabel('名前', { exact: true }).fill('手動 次郎');
    await page.getByLabel('ヨミ').fill('シュドウ ジロウ');
    await page.getByLabel('班', { exact: true }).selectOption({ label: '月 B' });
    await page.locator('#formDialog').getByRole('button', { name: '保存' }).click();
    await page.locator('#studentFilter').fill('シュドウ');
    await page.locator('#studentList tr', { hasText: '手動 次郎' }).getByRole('button', { name: '編集' }).click();
    await page.getByLabel('ニックネーム').fill('じろ');
    await page.locator('#formDialog').getByRole('button', { name: '保存' }).click();
    await page.locator('#studentList tr', { hasText: 'じろ' }).waitFor();
  });

  await check('解約を登録 → 確認 → GA 画面の次の回の名簿から消える', async page => {
    await loginAdminUi(page);
    await tab(page, '解約・移動');
    await choose(page, 'wdPick', 'カトウ', '加藤 六');
    await page.locator('#wdRound').selectOption({ label: '第4回' });
    await page.locator('#wdReason').fill('多忙のため');
    await page.getByRole('button', { name: '解約を登録' }).click();
    const r = page.locator('#wdList tr', { hasText: '加藤 六' });
    await r.waitFor();
    await r.getByRole('button', { name: '確認する' }).click();
    await r.getByText('確認：管理者').waitFor();
    await r.getByRole('button', { name: 'OK を付ける' }).click();
    await r.getByText('職員 OK').waitFor();
    await shot(page, 'admin-changes');
    await page.goto(BASE + '/ga.html');
    await pick(page, '火1', 4);
    assert.equal(await row(page, '加藤 六').count(), 0);
    await pick(page, '火1', 3);
    assert.equal(await row(page, '加藤 六').count(), 1);
  });

  await check('コマ移動を登録 → 移動後の回から新しい班に出る', async page => {
    await loginAdminUi(page);
    await tab(page, '解約・移動');
    await choose(page, 'trPick', 'イノウエ', '井上 二');
    await page.locator('#trGroup').selectOption({ label: '月 B' });
    await page.locator('#trRound').selectOption({ label: '第6回' });
    await page.getByRole('button', { name: '移動を登録' }).click();
    await page.locator('#trList tr', { hasText: '井上 二' }).getByText('月 A → 月 B').waitFor();
    await page.locator('#trList tr', { hasText: '井上 二' }).getByRole('button', { name: 'LINE文' }).click();
    await page.waitForFunction(() => document.querySelector('#lineText').value.includes('曜日移動'));
    assert.match(await page.locator('#lineText').inputValue(), /月曜 A班のイノウエ ジさんが曜日移動を希望されたため、第6回から月曜 B班に移動を行いました。/);
    await page.locator('#lineDialog').getByRole('button', { name: '閉じる' }).click();
    await page.goto(BASE + '/ga.html');
    await pick(page, '月', 6);
    await page.locator('#entry section.group', { hasText: 'B の班' }).locator('tr[data-student]', { hasText: '井上 二' }).waitFor();
    await pick(page, '月', 5);
    await page.locator('#entry section.group', { hasText: 'A の班' }).locator('tr[data-student]', { hasText: '井上 二' }).waitFor();
  });

  await check('集計タブに継続率と解約者数が出る', async page => {
    await loginAdminUi(page);
    await tab(page, '集計');
    await page.locator('#statsView').getByText('継続率').first().waitFor();
    assert.equal(await page.locator('#statsView .kpi', { hasText: '解約者数' }).locator('b').innerText(), '1');
    await shot(page, 'admin-stats');
  });

  await check('補講タブ：未定の人の場所を変えられる', async page => {
    const ueda = f.students.find(s => s.name.startsWith('上田'));
    await env.db.query(`insert into makeups(student_id, round, place) values ($1, 7, '未定')`, [ueda.id]);
    await env.db.query(`insert into records(student_id, round, attendance) values ($1, 7, '欠席・補講予定')`, [ueda.id]);
    await loginAdminUi(page);
    await tab(page, '補講');
    await page.locator('#mkStatus').selectOption('未定');
    const r = page.locator('#mkList tr', { hasText: '上田 三' });
    await r.waitFor();
    await r.locator('select.place').selectOption({ label: '個別補講' });
    await r.waitFor({ state: 'detached' }); // 「未定」で絞り込んでいるので一覧から消える
    await page.locator('#mkStatus').selectOption('');
    await r.locator('.chip', { hasText: '予定' }).waitFor();
    await page.locator('#mkList tr', { hasText: '江藤 四' }).locator('.chip', { hasText: '済' }).waitFor();
    await shot(page, 'admin-makeups');
  });

  await check('スタッフ：追加・無効化・暗証番号の設定', async page => {
    await loginAdminUi(page);
    await tab(page, 'スタッフ');
    await page.locator('#staffName').fill('でぃー');
    await page.locator('#staffRole').selectOption('ga');
    await page.getByRole('button', { name: 'スタッフを追加' }).click();
    const d = page.locator('#staffList tr', { hasText: 'でぃー' });
    await d.waitFor();
    await d.getByRole('button', { name: '無効にする' }).click();
    await d.getByText('無効').first().waitFor();
    await page.locator('#staffName').fill('副チーフ');
    await page.locator('#staffRole').selectOption('admin');
    await page.getByRole('button', { name: 'スタッフを追加' }).click();
    const s = page.locator('#staffList tr', { hasText: '副チーフ' });
    await s.getByText('暗証番号 未設定').waitFor();
    await s.getByRole('button', { name: '暗証番号を設定' }).click();
    await page.getByLabel('新しい暗証番号（数字4〜8桁）').fill('5678');
    await page.locator('#formDialog').getByRole('button', { name: '保存' }).click();
    await s.getByText('暗証番号 設定済み').waitFor();
    await shot(page, 'admin-staff');
  });

  await check('班の追加と年度の設定', async page => {
    await loginAdminUi(page);
    await tab(page, '受講生・班');
    await page.locator('#groupSlot').selectOption({ label: '金2' });
    await page.locator('#groupGa').selectOption({ label: 'B' });
    await page.getByRole('button', { name: '班を追加' }).click();
    await page.locator('#groupList tr', { hasText: '金2' }).waitFor();
    await page.locator('#termInitial').fill('10');
    await page.getByRole('button', { name: '年度の設定を保存' }).click();
    await page.getByText('年度の設定を保存しました').waitFor();
    assert.equal((await env.db.query('select initial_count from terms where id=$1', [f.term.id]))[0].initial_count, 10);
    await shot(page, 'admin-roster-settings');
  });

  await check('操作履歴に解約の登録が残っている', async page => {
    await loginAdminUi(page);
    await tab(page, '操作履歴');
    await page.locator('#auditList tr', { hasText: '解約の登録' }).first().waitFor();
    await shot(page, 'admin-audit');
  });

  await check('名簿（印刷）：前の「第N回」シートの形で、1コマが A4 横 1枚に収まる／すべてはコマごとに1枚', async page => {
    await loginAdminUi(page);
    await tab(page, '名簿（印刷）');
    await page.locator('#rvSlotSeg').getByRole('button', { name: '月', exact: true }).click();
    const sh = page.locator('#rosterView .rsheet');
    await sh.first().waitFor();
    assert.equal(await sh.count(), 1);
    assert.match(await sh.innerText(), /補講で来る人（振替）/);
    assert.ok((await sh.locator('td.ga').allInnerTexts()).includes('A'));
    await shot(page, 'admin-roster');
    const pages = pdf => {
      const t = pdf.toString('latin1');
      const n = (t.match(/\/Type\s*\/Page[^s]/g) || []).length;
      const box = t.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/);
      return { n, landscape: box && Number(box[1]) > Number(box[2]) };
    };
    const one = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    writeFileSync('/tmp/e2e/roster.pdf', one);
    assert.deepEqual(pages(one), { n: 1, landscape: true });
    let calls = 0;
    page.on('request', r => r.url().includes('/api/roster') && calls++);
    await page.locator('#rvSlotSeg').getByRole('button', { name: '火1', exact: true }).click();
    await page.locator('#rosterView .rhead', { hasText: '火1' }).waitFor();
    await page.locator('#rvSlotSeg').getByRole('button', { name: 'すべて', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#rosterView .rsheet').length === 9);
    assert.equal(calls, 0, 'コマの切り替えは通信なしで表示する');
    const all = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    writeFileSync('/tmp/e2e/roster-all.pdf', all);
    assert.deepEqual(pages(all), { n: 9, landscape: true });
  });

  await check('管理者の記録閲覧タブ', async page => {
    await loginAdminUi(page);
    await tab(page, '記録閲覧');
    await page.locator('#rcSlotSeg').getByRole('button', { name: '月', exact: true }).click();
    await page.locator('#rcBody tr', { hasText: '青木 一' }).waitFor();
    await tab(page, '補講');
    await page.locator('#mkRound option').first().waitFor({ state: 'attached' });
    const opts = await page.locator('#mkRound option').allInnerTexts();
    assert.equal(opts[0], 'すべて');
    assert.ok(!opts.includes('第0回'));
    assert.ok(opts.includes('第1回') && opts.includes('第8回'));
  });

  await check('初期化：入力するまで押せない → 実行 → 記録が消え受講生は残る → 初期化前に戻せる', async page => {
    const recordsBefore = await count('records');
    const studentsBefore = await count('students');
    assert.ok(recordsBefore > 0);
    await loginAdminUi(page);
    await tab(page, 'データ・バックアップ');
    const btn = page.getByRole('button', { name: '初期化する' });
    assert.equal(await btn.isDisabled(), true);
    await page.locator('#resetConfirm').fill('初期化');
    assert.equal(await btn.isDisabled(), false);
    await shot(page, 'admin-backup');
    await btn.click();
    await page.getByText('初期化しました').waitFor();
    assert.equal(await count('records'), 0);
    assert.equal(await count('withdrawals'), 0);
    assert.equal(await count('students'), studentsBefore);
    const pre = page.locator('#backupList tr', { hasText: '初期化前' });
    await pre.waitFor();
    await pre.getByRole('button', { name: 'この状態に戻す' }).click();
    await page.getByLabel('確認のため「復元」と入力してください').fill('復元');
    await page.locator('#formDialog').getByRole('button', { name: '復元する' }).click();
    await page.getByText('復元しました').waitFor();
    assert.equal(await count('records'), recordsBefore);
    assert.equal(await count('withdrawals'), 1);
  });

  await check('個別補講タブ：ある回の①を「実施なし」に、②の時間を変える → GA の補講の枠で選べない', async page => {
    await loginAdminUi(page);
    await tab(page, '個別補講');
    await page.locator('#ivRoundSeg').getByRole('button', { name: '第5回' }).click();
    await page.locator('#ivBody section[data-no="1"]').getByRole('button', { name: '変更' }).click();
    await page.locator('#fd_closed').selectOption('1');
    await page.getByRole('button', { name: '保存' }).click();
    await page.locator('#ivBody section[data-no="1"]').getByText('実施なし').waitFor();
    await page.locator('#ivBody section[data-no="2"]').getByRole('button', { name: '変更' }).click();
    await page.locator('#fd_label').fill('木曜 15:00');
    await page.locator('#fd_host').fill('たくゆき');
    await page.getByRole('button', { name: '保存' }).click();
    await page.locator('#ivBody section[data-no="2"]').getByText('第5回　② 木曜 15:00').waitFor();
    await page.locator('#ivBody section[data-no="2"]').getByText('担当：たくゆき').waitFor();
    await shot(page, 'admin-indiv');
    await page.goto(BASE + '/ga.html');
    await pick(page, '月', 5);
    await row(page, '上田 三').getByRole('button', { name: '補講', exact: true }).click();
    await page.locator('#mkIndivNo option', { hasText: '①' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#mkIndivNo option', { hasText: '①' }).evaluate(o => o.disabled), true);
    assert.ok((await page.locator('#mkIndivNo').innerText()).includes('② 木曜 15:00'));
  });
}
