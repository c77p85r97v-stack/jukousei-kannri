// 画面操作の自動テスト（ブラウザで実際に操作して確かめる）
//   node test/ui/e2e.mjs [スクリーンショット保存先]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/dev-server.mjs';
import { newEnv, seed, memoryBlob } from '../helpers.mjs';
import { hashPin } from '../../src/lib/crypto.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] || '/tmp/e2e';
mkdirSync(out, { recursive: true });

const env = await newEnv({ blob: memoryBlob() });
const f = await seed(env);
await env.db.query('update staff set pin_hash=$1 where id=$2', [await hashPin(env, '1234'), f.admin.id]);
const server = await startServer(env, 0);
const BASE = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();

const results = [];
async function check(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  ctx.setDefaultTimeout(8000);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  ctx.on('console', m => m.type() === 'error' && /Content Security Policy/i.test(m.text()) && errors.push(m.text()));
  try {
    await Promise.race([fn(page, ctx), new Promise((_, rej) => setTimeout(() => rej(new Error("時間切れ（20秒）")), 20000))]);
    assert.deepEqual(errors, [], '画面でエラーが出ている');
    results.push(['ok', name]);
  } catch (e) {
    results.push(['NG', name, String(e && e.message ? e.message : e).split('\n').slice(0, 6).join('\n   ')]);
    await page.screenshot({ path: `${out}/FAIL-${results.length}.png`, fullPage: true }).catch(() => {});
  } finally {
    await ctx.close();
  }
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

export async function loginGaUi(page, name = 'A') {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'GA', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForURL('**/ga.html');
}
export async function loginAdminUi(page) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: '管理者', exact: true }).click();
  await page.getByLabel('名前', { exact: true }).selectOption({ label: '管理者' });
  await page.getByLabel('暗証番号', { exact: true }).fill('1234');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL('**/admin.html');
}

// ---------- ログイン ----------
await check('GA を押して名前を選ぶと ga.html に移る', async page => {
  await page.goto(BASE + '/');
  await shot(page, 'login');
  await page.getByRole('button', { name: 'GA', exact: true }).click();
  await shot(page, 'login-ga');
  await page.getByRole('button', { name: 'A', exact: true }).click();
  await page.waitForURL('**/ga.html');
});

await check('管理者で暗証番号を間違えるとエラー文が出る', async page => {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: '管理者', exact: true }).click();
  await page.getByLabel('名前', { exact: true }).selectOption({ label: '管理者' });
  await page.getByLabel('暗証番号', { exact: true }).fill('9999');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.getByText('名前または暗証番号が違います').waitFor();
  await shot(page, 'login-admin-error');
});

await check('管理者は正しい暗証番号で admin.html に移る', async page => {
  await loginAdminUi(page);
});

await check('ヘッダーの背景色が薄紫', async page => {
  await page.goto(BASE + '/');
  const bg = await page.locator('header.top').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.equal(bg, 'rgb(233, 226, 247)');
});

await check('robots noindex がある', async page => {
  for (const p of ['/', '/ga.html', '/admin.html']) {
    const res = await page.goto(BASE + p);
    assert.equal(res.status(), 200, p);
    assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex', p);
  }
});

const more = await import('./e2e-more.mjs').catch(e => (e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e)));
if (more) await more.run({ check, shot, BASE, env, f, loginGaUi, loginAdminUi, assert, out });

await browser.close();
server.close();
for (const r of results) console.log(r[0], r[1], r[2] ? `\n   ${r[2]}` : '');
const ng = results.filter(r => r[0] !== 'ok').length;
console.log(`\n${results.length - ng}/${results.length} passed`);
process.exit(ng ? 1 : 0);
