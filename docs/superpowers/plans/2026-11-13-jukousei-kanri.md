# PC講習会 受講生管理システム 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** スプレッドシートの受講生管理を、Vercel ＋ Neon（Postgres）の Web システムに置き換える。GA が各回の記録と補講を入力し、管理者が名簿・解約・移動・集計・バックアップを扱う。

**Architecture:** API は Web 標準の `Request → Response` を返す1つの関数 `handle(request, env)`（`src/app.js`）に集約し、Vercel では1本の Node 関数から呼ぶ。データベースは `query / tx` だけを持つ薄い層（`src/db.js`）で包み、本番は `@neondatabase/serverless` の Pool、テストと手元の開発サーバーは PGlite を使う。名簿・補講の状態・集計は表に保存せず、毎回 SQL で計算する。画面は素の HTML / CSS / JS。

**Tech Stack:** Node.js 22（`node --test`）、`@neondatabase/serverless`、`@electric-sql/pglite`（開発・テスト用）、`@vercel/blob`、Playwright（グローバルにインストール済み。画面テストのみ）。

**Spec:** `docs/superpowers/specs/2026-11-13-jukousei-kanri-design.md`

**参考実装（読むだけ・コピー元）:** `https://github.com/c77p85r97v-stack/npas-attendance`（`src/lib/http.js`, `src/lib/auth.js`, `src/lib/crypto.js`, `src/routes/maintenance.js`, `public/css/admin.css`）

## Global Constraints

- 回：年度ごとの `rounds`（初期値 0〜8）。タイピングは `typing_rounds`（初期値 1〜8）、クイズは `quiz_rounds`（初期値 {0, 8}）でだけ入力できる。
- コマのコード：`月` `火1` `火2` `水1` `水2` `木1` `木2` `金1` `金2`（入力の全角数字・空白は半角に正規化）。
- 出欠区分は次の8つだけ：`出席` `出席・記録なし` `記録なし` `時間切れ` `欠席` `欠席・補講予定` `欠席・補講できず`、または NULL（未入力）。`欠席・補講予定` と `欠席・補講できず` は API が自動で付け、画面から直接は選べない。
- 出席系＝`出席` `出席・記録なし` `記録なし` `時間切れ`。
- 補講の場所：`他班` `個別` `未定`。
- GA はすべての班の記録・補講を編集できる。管理者専用：解約・移動、受講生・班・コマ・年度・スタッフの編集、取り込み、操作履歴、バックアップ・復元・初期化。
- GA ログインは名前を選ぶだけ（署名付き Cookie、8時間）。管理者は名前＋暗証番号（数字4〜8桁、5回失敗で15分ロック、ハッシュ保存）。
- 書き込みはすべてトランザクション内で行い、同じトランザクションで `audit_log` に変更前・変更後を残す。
- 書き込みの API は `X-Requested-With: koshu` ヘッダーと同一オリジンが必須（CSRF 対策）。
- 画面の色：薄紫基調（`--lav:#e9e2f7`、`--purple:#5b3f9e`、`--purple-dark:#3e2a73`）。勤怠の紺は使わない。全ページに `<meta name="robots" content="noindex">`。
- 環境は本番のみ。受講生の実名を含むファイル（`*.xlsx`、`private/`）はコミットしない。
- エラー文言は日本語。想定外のエラーは詳細を利用者に見せない。

## Review Focus

1. **補講先と元の班の GA が同じ受講生の同じ回を同時に保存** → 後の保存は 409「ほかの人が先に更新しました」と最新値を返し、上書きしない（Task 7 にテスト）。
2. **タイピング欄に全角数字や「記録なし」などの文字を入力** → 全角は半角に直して受け付け、それ以外の文字は 400 で弾く。「記録なし」「時間切れ」は出欠区分で選ぶよう案内する（Task 7 にテスト）。
3. **名簿の貼り付けに全角スペース・末尾タブ・「火１」などの表記ゆれ・空行が混じる** → 正規化して取り込み、空行は無視し、解釈できない行は確認画面に理由付きで出す（Task 5 にテスト）。
4. **補講を登録したあとに、その受講生が解約・コマ移動した** → 解約の回以降は補講先の名簿からも消える。移動しても補講で来る人の表示は補講登録どおり（Task 6 にテスト）。
5. **班を持つ GA を無効化した** → 名簿・記録は壊れず、ログイン候補から消えるだけ。スタッフは削除できず無効化のみ（Task 4 にテスト）。

---

## ファイル構成

```
package.json            scripts: test / test:ui / dev / migrate
vercel.json             /api/* を api/index.mjs へ、Cron（毎日 18:00 UTC = 3:00 JST）
api/index.mjs           Vercel の入口：env を組み立て handle() を呼ぶ
migrations/0001_init.sql
src/app.js              ルーティング表と handle(request, env)
src/db.js               createNeonDb(url) / createPgliteDb() / migrate(db)
src/lib/http.js         json, HttpError, readJson, assertSameOrigin, csv
src/lib/auth.js         GA・管理者のログインと requireStaff / requireAdmin
src/lib/crypto.js       hashPin, verifyPin, hmacSign, safeEqual
src/lib/audit.js        audit(tx, operatorId, action, table, id, before, after)
src/lib/normalize.js    normSlotCode, normNumber, normText
src/domain/roster.js    名簿の計算（SQL）
src/domain/makeup.js    補講の状態の計算
src/domain/stats.js     集計
src/routes/auth.js      ログイン・初期設定
src/routes/master.js    年度・コマ・班・スタッフ・受講生
src/routes/importer.js  名簿の一括取り込み
src/routes/records.js   記録入力
src/routes/makeups.js   補講
src/routes/changes.js   解約・コマ移動
src/routes/reports.js   集計・検索・操作履歴・CSV
src/routes/maintenance.js バックアップ・復元・初期化・Cron
public/index.html       ログイン（GA／管理者）
public/ga.html          GA 画面
public/admin.html       管理者画面
public/css/app.css      薄紫テーマ・印刷用
public/js/api.js        fetch ラッパー
public/js/ga.js, public/js/admin.js, public/js/views.js（名簿・集計の描画を共有）
tools/dev-server.mjs    PGlite で動く手元サーバー（Node http → handle）
tools/reconcile.mjs     実データ突き合わせ（手元専用。入力ファイルは private/）
test/helpers.mjs        newEnv(), seed(), call(env, method, path, body, cookie)
test/*.test.mjs
test/ui/e2e.mjs
```

---

### Task 1: 土台（パッケージ・DB 層・スキーマ）

**Files:**
- Create: `package.json`, `.gitignore`（既存に追記）, `src/db.js`, `migrations/0001_init.sql`, `test/helpers.mjs`, `test/schema.test.mjs`

**Interfaces:**
- Produces:
  - `createPgliteDb(): Promise<Db>`、`createNeonDb(connectionString: string): Db`
  - `Db = { query(sql: string, params?: any[]): Promise<Row[]>, tx<T>(fn: (t: Db) => Promise<T>): Promise<T> }`（`tx` の中で投げられた例外はロールバック）
  - `migrate(db: Db): Promise<void>`（`migrations/*.sql` を名前順に、未適用分だけ実行。`schema_migrations` 表で管理）
  - `test/helpers.mjs`：`newEnv(): Promise<Env>`（PGlite＋migrate 済み、`PIN_PEPPER` などテスト値入り）、`seed(env): Promise<Fixture>`（年度1・コマ9・GA 3人（A,B,C）・管理者1人（暗証番号 `1234`）・月の班 A と B、火1 の班 C・受講生 6人）

**スキーマ（`0001_init.sql`）で決める値:**
- `terms(id serial, name text not null, rounds int[] not null default '{0,1,2,3,4,5,6,7,8}', typing_rounds int[] not null default '{1,2,3,4,5,6,7,8}', quiz_rounds int[] not null default '{0,8}', initial_count int, active boolean not null default false)`＋ `active` が true の行は1つだけ（部分一意インデックス）
- `slots(id, term_id → terms, code text check in (9コード), sort int)`、unique(term_id, code)
- `staff(id, name text unique not null, role text check in ('ga','admin'), pin_hash text, failed_logins int default 0, locked_until timestamptz, active boolean default true)`
- `groups(id, slot_id → slots on delete cascade, ga_id → staff, sort int)`、unique(slot_id, ga_id)
- `students(id, term_id → terms, name, kana, nickname, group_id → groups, created_at)`
- `records(id, student_id → students on delete cascade, round int, attendance text check in（8区分）or null, typing numeric(6,1) check >= 0, quiz int check >= 0, note text, version int not null default 1, updated_by → staff, updated_at)`、unique(student_id, round)
- `makeups(id, student_id → students on delete cascade, round int, place text check in ('他班','個別','未定'), host_group_id → groups, failed boolean default false, version int default 1, created_by, created_at)`、unique(student_id, round)、check(place <> '他班' or host_group_id is not null)
- `withdrawals(id, student_id unique → students, from_round int, reason text, manager_checked_by → staff, staff_confirmed boolean default false, created_by, created_at, cancelled_at timestamptz)`。unique は `cancelled_at is null` の部分一意インデックスにする
- `transfers(id, student_id → students, from_group_id, to_group_id → groups, from_round int, manager_checked_by, created_by, created_at, cancelled_at)`
- `audit_log(id bigserial, at timestamptz default now(), operator_id, action text, target_table text, target_id text, before_json jsonb, after_json jsonb)`
- `backups_meta(id, at, blob_key text, size int, kind text check in ('自動','手動','復元前','初期化前'))`
- `request_ids(id text primary key, at timestamptz default now())`（二重送信防止）

- [ ] **Step 1: テストを書く** `test/schema.test.mjs`
  - `migrate twice is idempotent`：`migrate(db)` を2回呼んでも例外なし
  - `tx rolls back on throw`：`tx` 内で insert 後に throw → 行数 0
  - `records rejects negative typing`：typing = -1 の insert が失敗
  - `records rejects unknown attendance`：attendance = '補講' の insert が失敗
  - `makeup 他班 requires host`：place='他班', host_group_id=null が失敗
  - `only one active term`：active=true を2行入れると失敗
  - `seed builds fixture`：`seed()` 後、slots 9件・students 6件
- [ ] **Step 2: 実行して失敗を確認** `npm test` → `Cannot find module '../src/db.js'`
- [ ] **Step 3: 実装**。PGlite 版の `tx` は `pglite.transaction()`、Neon 版は `Pool` から `client` を取り `BEGIN/COMMIT/ROLLBACK`。
- [ ] **Step 4: 実行して成功を確認** `npm test` → 7 pass
- [ ] **Step 5: コミット** `git commit -m "feat: DB層とスキーマ"`

### Task 2: HTTP の共通処理とルーター

**Files:**
- Create: `src/lib/http.js`, `src/lib/audit.js`, `src/lib/normalize.js`, `src/app.js`, `test/http.test.mjs`, `test/normalize.test.mjs`

**Interfaces:**
- Consumes: `Db`（Task 1）
- Produces:
  - `HttpError(status, message, extra?)`、`json(data, status=200, headers={})`、`readJson(req)`、`assertSameOrigin(req)`（ヘッダー `X-Requested-With: koshu`）、`csvResponse(filename, rows: string[][])`（UTF-8 BOM 付き）
  - `audit(t: Db, operatorId: number|null, action: string, table: string, id: string|number, before: object|null, after: object|null)`
  - `normSlotCode(s): string|null`（「火１」「 火 1 」→「火1」、不明は null）、`normNumber(s): number|null|'invalid'`（「１２３．４」→123.4、空→null、文字→'invalid'）、`normText(s)`（全角スペース→半角、前後の空白除去、空→null）
  - `handle(request: Request, env: Env): Promise<Response>`、ルート表 `ROUTES: [method, RegExp, (env, req, match) => Promise<Response>][]`。`env.db` に Db が入る
- [ ] **Step 1: テストを書く**
  - `unknown api path → 404 {error}`
  - `POST without X-Requested-With → 403`
  - `POST with foreign Origin → 403`
  - `unexpected error → 500 で SQL を含まない日本語メッセージ`
  - `normSlotCode('火１') === '火1'`、`normSlotCode('土') === null`
  - `normNumber('１２３．４') === 123.4`、`normNumber('') === null`、`normNumber('記録なし') === 'invalid'`
  - `normText('　山田　太郎 ') === '山田 太郎'`
- [ ] **Step 2: 失敗を確認** `npm test`
- [ ] **Step 3: 実装**（npas の `src/lib/http.js` を参考に、ヘッダー名だけ変える）
- [ ] **Step 4: 成功を確認** `npm test`
- [ ] **Step 5: コミット**

### Task 3: ログインと権限

**Files:**
- Create: `src/lib/crypto.js`, `src/lib/auth.js`, `src/routes/auth.js`, `test/auth.test.mjs`
- Modify: `src/app.js`（ルート追加）

**Interfaces:**
- Consumes: `handle`, `json`, `HttpError`, `audit`
- Produces:
  - `requireStaff(env, req): Promise<{id, name, role}>`（GA・管理者どちらの Cookie でも可。無効なスタッフは 401）
  - `requireAdmin(env, req): Promise<{id, name}>`（管理者 Cookie のみ。それ以外 403）
  - API：`GET /api/bootstrap` → `{ staff: [{id,name,role}] (active のみ), term: {id,name,rounds,typing_rounds,quiz_rounds} | null, slots: [...] }`、`POST /api/login {staffId}`（GA のみ、管理者を指定したら 400「管理者は暗証番号でログインしてください」）、`POST /api/admin/login {staffId, pin}`、`POST /api/logout`、`GET /api/me`、`GET /api/admin/setup` → `{needed: boolean}`、`POST /api/admin/setup {token, name, pin}`（管理者が0人で `token === env.ADMIN_SETUP_TOKEN` のときだけ）
  - Cookie 名：`koshu_sid`（GA）、`koshu_admin`（管理者）。形式・署名は npas の `s1.` / `a1.` 方式に揃え、有効期限 8時間
- [ ] **Step 1: テストを書く**
  - `GA login by name sets cookie and /api/me returns role ga`
  - `GA cookie cannot call /api/admin/staff → 403`
  - `admin login with wrong pin 5 times locks for 15 minutes`（6回目は正しい暗証番号でも 423）
  - `admin pin must be 4-8 digits`（'12a4' → 400）
  - `deactivated staff cookie → 401`
  - `setup works once`（2回目は 409）
  - `tampered cookie → 401`
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**（暗証番号は PBKDF2-SHA256、10万回、`PIN_PEPPER` を混ぜる。npas の `crypto.js` 相当）
- [ ] **Step 4: 成功を確認**
- [ ] **Step 5: コミット**

### Task 4: 年度・コマ・班・スタッフ・受講生の管理 API

**Files:**
- Create: `src/routes/master.js`, `test/master.test.mjs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `requireAdmin`, `requireStaff`, `audit`, `normText`, `normSlotCode`
- Produces（すべて管理者のみ。GET /api/groups は GA も可）:
  - `GET/POST /api/admin/terms`（POST は作成・更新。作成時に9コマを自動作成。`active` を true にすると他は false）
  - `GET /api/groups?termId=` → `[{id, slotId, slotCode, gaId, gaName, sort}]`（コマ順→sort 順）
  - `POST /api/admin/groups {slotId, gaId}`、`POST /api/admin/groups/:id/delete`（受講生がいる班は 409）
  - `GET/POST /api/admin/staff`（`{id?, name, role, active}`）、`POST /api/admin/staff/:id/pin {pin}`、`POST /api/admin/staff/:id/unlock`。**削除 API は作らない**
  - `GET /api/admin/students?termId=&q=`、`POST /api/admin/students {id?, name, kana, nickname, groupId}`
- [ ] **Step 1: テストを書く**
  - `creating a term creates 9 slots in fixed order`
  - `activating a term deactivates others`
  - `deactivated GA disappears from bootstrap but group and records remain`（Review Focus 5：無効化後も `GET /api/groups` に班が残り gaName が返る）
  - `no endpoint deletes staff`（`POST /api/admin/staff/:id/delete` → 404）
  - `cannot delete group with students → 409`
  - `every write leaves an audit_log row with before/after`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 5: 名簿の一括取り込み

**Files:**
- Create: `src/routes/importer.js`, `test/importer.test.mjs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `normSlotCode`, `normText`, `requireAdmin`, `audit`
- Produces:
  - `parseRoster(text: string, ctx: {slots, staff, groups, students}): {rows: ImportRow[], errors: {line, reason}[]}`
    - 1行＝タブ区切り「コマ, GA, 名前, ヨミ, ニックネーム」。1行目が見出し（「コマ」を含む）なら飛ばす。空行・空白だけの行は無視
    - `ImportRow = {line, slotCode, gaName, name, kana, nickname, newGa: boolean, newGroup: boolean, duplicate: boolean}`（duplicate＝同じ年度に同じ名前＋ヨミがすでにいる、または貼り付け内で重複）
  - `POST /api/admin/import/preview {termId, text}` → `{rows, errors, summary:{students, newGa, newGroups, duplicates}}`
  - `POST /api/admin/import/commit {termId, text, requestId}` → 再度 `parseRoster` し、errors が1件でもあれば 400。duplicate は飛ばす。新しい GA（role 'ga'）と班を作り、受講生を登録。全体を1トランザクション
- [ ] **Step 1: テストを書く**（Review Focus 3）
  - `header row and blank lines are ignored`
  - `full-width spaces and trailing tabs are normalized`（`'火１\tA\t山田　太郎\tヤマダ タロウ\tたろう\t\t'` → slotCode '火1', name '山田 太郎'）
  - `unknown slot is reported with line number`（'土' → errors[0] = {line: 2, reason: 'コマ「土」が見つかりません'}）
  - `missing name is an error`、`5列未満でも名前まであれば取り込める（ヨミ・ニックネームは空）`
  - `duplicate within paste and against existing are flagged and skipped on commit`
  - `commit creates missing GA and group`
  - `commit with errors writes nothing`
  - `same requestId twice imports once`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 6: 名簿の計算

**Files:**
- Create: `src/domain/roster.js`, `test/roster.test.mjs`

**Interfaces:**
- Consumes: `Db`
- Produces:
  - `currentGroupSql`：受講生×回 → その回の班（`transfers` のうち `cancelled_at is null and from_round <= 回` で `from_round` が最大、同じなら `created_at` が最新の `to_group_id`。なければ `students.group_id`）
  - `rosterFor(db, {termId, slotId, round}): Promise<RosterGroup[]>`
    - `RosterGroup = {groupId, gaId, gaName, members: Member[], guests: Member[]}`
    - `Member = {studentId, name, kana, nickname, homeGroupId, homeLabel /* 例「月 A」 */, record: {attendance, typing, quiz, note, version} | null, makeup: {place, hostGroupId, hostLabel, failed, status, version} | null}`
    - members：その回の班がこの班で、解約していない（または `withdrawals.from_round > 回`、取り消し済みは無視）受講生。ヨミ順
    - guests：`makeups.round = 回 and place = '他班' and host_group_id = この班 and failed = false` で、その回に解約していない受講生
  - `isEnrolled(db, studentId, round): Promise<boolean>`
- [ ] **Step 1: テストを書く**
  - `members are students whose current group is this group`
  - `transfer from round 5 moves student only for rounds >= 5`
  - `cancelled transfer is ignored`
  - `withdrawal from round 4 removes student from round 4 onward only`
  - `guest appears in host roster with homeLabel`、`and stays in home roster with makeup.hostLabel`
  - `failed makeup removes guest from host roster`
  - `withdrawal after makeup registration removes the guest too`（Review Focus 4）
  - `transfer after makeup registration keeps guest as registered`（Review Focus 4）
  - `slot with 60 students returns within 300ms on PGlite`（速さの目安）
- [ ] **Step 2〜5:** 失敗確認 → 実装（SQL 1〜2本で取得し JS で組み立てる。N+1 にしない） → 成功確認 → コミット

### Task 7: 記録入力 API

**Files:**
- Create: `src/routes/records.js`, `test/records.test.mjs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `rosterFor`, `requireStaff`, `audit`, `normNumber`, `normText`
- Produces:
  - `GET /api/roster?slotId=&round=` → `{term, slot, round, isTypingRound, isQuizRound, groups: RosterGroup[]}`（ログイン中の GA の班を先頭に並べ替える）
  - `POST /api/records {studentId, round, attendance?, typing?, quiz?, note?, version, requestId}` → `{record}`
    - `version` は画面が持っている値。既存行がなければ 0 を送る
    - 不一致 → 409 `{error:'ほかの人が先に更新しました', latest: record}`
    - タイピングの回以外で typing、クイズの回以外で quiz → 400
    - `normNumber` が 'invalid' → 400 `{error:'タイピングは数字で入力してください。記録が取れないときは出欠で「記録なし」「時間切れ」を選んでください'}`
    - attendance に `欠席・補講予定` `欠席・補講できず` を直接指定 → 400
    - typing に数値が入り、attendance が未指定または NULL → `出席` を自動で付ける
    - 解約済みの回 → 409 `{error:'この受講生はこの回は解約済みです'}`
    - 同じ requestId の再送は2回目も同じ応答で、version を進めない
- [ ] **Step 1: テストを書く**
  - `save creates record with version 1`、`save with stale version → 409 with latest`（Review Focus 1：A と B が version 1 で同時に保存 → 片方だけ成功）
  - `typing on round 0 → 400`、`quiz on round 3 → 400`
  - `full-width typing is accepted`（'１４５．２' → 145.2）、`'記録なし' in typing → 400 with guidance`（Review Focus 2）
  - `typing auto-sets 出席`
  - `cannot set 欠席・補講予定 directly`
  - `withdrawn round → 409`
  - `requestId replay does not bump version`
  - `GA's own group comes first in /api/roster`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 8: 補講 API

**Files:**
- Create: `src/domain/makeup.js`, `src/routes/makeups.js`, `test/makeups.test.mjs`
- Modify: `src/app.js`, `src/domain/roster.js`（`makeup.status` を `makeupStatus` で埋める）

**Interfaces:**
- Consumes: `requireStaff`, `audit`, `isEnrolled`
- Produces:
  - `makeupStatus(makeup, record): '未定'|'予定'|'済'|'できず'`（record.attendance が出席系 → 済、failed → できず、place='未定' → 未定、それ以外 → 予定）
  - `POST /api/makeups {studentId, round, place, hostGroupId?, version, requestId}` → 補講を作成・変更し、同じトランザクションで記録の attendance を `欠席・補講予定` にする（記録がなければ作る）。補講先がその受講生のその回の班自身 → 400
  - `POST /api/makeups/fail {studentId, round, version}` → `failed=true`、attendance を `欠席・補講できず`
  - `POST /api/makeups/cancel {studentId, round, version}` → 補講を削除し、attendance を `欠席` に戻す
  - `GET /api/makeups?termId=&round=&status=` → 一覧（`[{studentId, name, nickname, homeLabel, place, hostLabel, status, record}]`）
- [ ] **Step 1: テストを書く**（spec 3章「補講の流れ」）
  - `choosing a place sets △ (欠席・補講予定) and puts student in host roster`
  - `host GA typing on the student's record marks status 済 and home roster shows the same record`
  - `fail sets × and removes from host roster`
  - `changing place moves the guest to the new host`
  - `place 未定 then 個別 then entering record → 済`
  - `cancel restores 欠席`
  - `host equal to own group → 400`
  - `makeupStatus truth table`（4通り）
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 9: 解約・コマ移動 API（管理者）

**Files:**
- Create: `src/routes/changes.js`, `test/changes.test.mjs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `requireAdmin`, `audit`
- Produces:
  - `GET /api/admin/withdrawals?termId=`、`POST /api/admin/withdrawals {studentId, fromRound, reason}`、`POST /api/admin/withdrawals/:id/check`（`manager_checked_by` に操作者）、`POST /api/admin/withdrawals/:id/confirm`（`staff_confirmed=true`）、`POST /api/admin/withdrawals/:id/cancel`（`cancelled_at=now()`）
  - `GET /api/admin/transfers?termId=`、`POST /api/admin/transfers {studentId, toGroupId, fromRound}`（`from_group_id` はその回時点の班をサーバーで決める）、`…/:id/check`、`…/:id/cancel`
- [ ] **Step 1: テストを書く**
  - `withdraw from round 4 → roster for 4 excludes, 3 includes`
  - `second active withdrawal for same student → 409`、`after cancel can withdraw again`
  - `transfer stores from_group_id automatically`
  - `transfer to the same group → 400`
  - `fromRound outside term.rounds → 400`
  - `GA cannot call → 403`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 10: 集計

**Files:**
- Create: `src/domain/stats.js`, `test/stats.test.mjs`
- Modify: `src/routes/reports.js`（新規作成）, `src/app.js`

**Interfaces:**
- Consumes: `currentGroupSql`, `Db`
- Produces:
  - `computeStats(db, termId): Promise<Stats>`
  - `Stats = { initialCount, withdrawn, retentionRate, withdrawalRate, withdrawnBySlot: {[code]: n}, withdrawnByRound: {[round]: n}, transfers: n, transfersBySlot: {[code]: {out, in}}, attendanceRate: {[round]: {enrolled, attended, rate}}, groups: [{groupId, slotCode, gaName, size, typingGainAvg, typingImprovedRatio, quizGainAvg}] }`
  - 定義は spec 3章「集計の定義」どおり：
    - `initialCount` は `terms.initial_count`、NULL なら第0回時点の在籍数
    - 受講率の分母はその回の在籍者、分子は出席系
    - タイピングの伸び＝（typing_rounds の中で数値がある最も早い回の値）−（最後のタイピングの回の値）。両方そろう受講生だけ
    - クイズの伸び＝最後のクイズの回の点 − 最初のクイズの回の点
    - 班は「最後の回の時点の班」で集計する
  - `GET /api/stats?termId=` → `Stats`（GA も可）
- [ ] **Step 1: テストを書く**（固定データで具体値）
  - 初期10人・解約2人 → `retentionRate === 0.8`、`withdrawalRate === 0.2`
  - 第3回：在籍8人、出席系6人 → `attendanceRate[3].rate === 0.75`
  - 受講生 X：第1回なし・第2回 200・第8回 150 → 伸び 50。Y：第1回 100・第8回 120 → −20。班平均 15、改善割合 0.5
  - クイズ：第0回 10・第8回 18 → 伸び 8
  - `initial_count null falls back to round-0 enrolled count`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 11: 検索・操作履歴・CSV

**Files:**
- Modify: `src/routes/reports.js`, `src/app.js`
- Test: `test/reports.test.mjs`

**Interfaces:**
- Produces:
  - `GET /api/students/search?q=` → 名前・ヨミ・ニックネームの部分一致、最大50件。`GET /api/students/:id/history` → `{student, records[], makeups[], transfers[], withdrawal}`（GA も可）
  - `GET /api/admin/audit?limit=100&beforeId=&operatorId=&action=` → 新しい順
  - `GET /api/admin/export/records.csv?termId=`（列：コマ, GA, 名前, ヨミ, ニックネーム, 第0回出欠, 第0回タイピング, 第0回クイズ, 第0回メモ, …第8回まで）、`/roster.csv?termId=&round=`、`/stats.csv?termId=`
- [ ] **Step 1: テストを書く**：`search matches kana partial`、`history returns all parts`、`audit pagination by beforeId`、`records.csv starts with BOM and has 5 + 4×9 columns`、`GA cannot read audit → 403`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 12: バックアップ・復元・初期化・Cron

**Files:**
- Create: `src/routes/maintenance.js`, `test/maintenance.test.mjs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `Db`, `requireAdmin`, `audit`
- Produces:
  - `env.blob = { put(key, body: string): Promise<void>, get(key): Promise<string>, list(prefix): Promise<{key, size, uploadedAt}[]>, del(key): Promise<void> }`（本番は `@vercel/blob` の非公開ストア、テストはメモリ実装 `memoryBlob()` を `test/helpers.mjs` に追加）
  - `dumpAll(db): Promise<{version: 1, at, tables: {[name]: Row[]}}>`、`restoreAll(db, dump)`（1トランザクションで全表を空にして入れ直し、シーケンスも合わせる）
  - `POST /api/admin/backups`（手動）、`GET /api/admin/backups`、`GET /api/admin/backups/download?key=`、`POST /api/admin/backups/restore {key, confirm:'復元'}`（直前に kind='復元前' を取る）
  - `GET /api/admin/reset` → 消える件数のプレビュー、`POST /api/admin/reset {confirm:'初期化', includeRoster: boolean}`：直前に kind='初期化前' を取り、records・makeups・withdrawals・transfers・audit_log・request_ids を消す。`includeRoster` なら students と groups も消す。staff・terms・slots・backups_meta は常に残す。実行後に audit_log へ「初期化」を1行残す
  - `GET /api/cron/backup`（`Authorization: Bearer ${CRON_SECRET}` 必須）→ kind='自動' を取り、30日より古い自動バックアップを削除
- [ ] **Step 1: テストを書く**
  - `backup then restore yields identical dump`（バックアップ後に記録を変更 → 復元 → `dumpAll` が一致）
  - `restore takes a 復元前 backup first`
  - `reset without confirm text → 400`
  - `reset keeps staff, terms, slots, groups, students; clears records, makeups, withdrawals, transfers`
  - `reset with includeRoster clears students and groups too`
  - `reset can be undone by restoring 初期化前 backup`
  - `cron without secret → 401`、`cron deletes 自動 backups older than 30 days only`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認 → コミット

### Task 13: 手元の開発サーバーとログイン画面・共通 CSS

**Files:**
- Create: `tools/dev-server.mjs`, `public/index.html`, `public/css/app.css`, `public/js/api.js`, `test/ui/e2e.mjs`（このタスクではログイン部分のみ）

**Interfaces:**
- Consumes: `handle`, `createPgliteDb`, `migrate`, `seed`
- Produces:
  - `createDevEnv(): Promise<Env>`、`startServer(env, port): Promise<http.Server>`（`public/` の静的配信＋ `/api/*` を `handle` へ）。`npm run dev` で `http://localhost:8787`、`DEV_SEED=1` でテスト用データ入り
  - `api.get(path)`、`api.post(path, body)`（`X-Requested-With: koshu` を付け、エラーは `{error}` を投げる）
  - ログイン画面：「GA」「管理者」の2つの大きなボタン → GA は名前の選択だけ／管理者は名前＋暗証番号 → それぞれ `ga.html` / `admin.html` へ。管理者が0人なら初期設定フォームを表示
- [ ] **Step 1: 画面テストを書く** `test/ui/e2e.mjs`（Playwright、`createDevEnv` + `seed`）
  - `GA を押して名前を選ぶと ga.html に移る`
  - `管理者で暗証番号を間違えるとエラー文が出る`
  - `ヘッダーの背景色が薄紫（rgb(233, 226, 247)）`
  - `robots noindex がある`
- [ ] **Step 2: 失敗を確認** `npm run test:ui`
- [ ] **Step 3: 実装**（レイアウトは npas の `admin.css` を下敷きに、色だけ Global Constraints の薄紫に置き換える）
- [ ] **Step 4: 成功を確認**、スクリーンショットを `/tmp/e2e/login.png` に保存して目視
- [ ] **Step 5: コミット**

### Task 14: GA 画面（記録入力・補講・検索）

**Files:**
- Create: `public/ga.html`, `public/js/ga.js`
- Modify: `test/ui/e2e.mjs`

**Interfaces:**
- Consumes: `GET /api/roster`, `POST /api/records`, `POST /api/makeups`, `/fail`, `/cancel`, `GET /api/groups`, `GET /api/students/search`, `GET /api/students/:id/history`
- Produces（画面の振る舞い）:
  - コマと回の選択（初期値：今日の曜日の最初のコマ、最後に選んだ回を `localStorage` に記憶。try/catch で包む）
  - 班ごとの表（自分の班が先頭）。列：ニックネーム・名前・ヨミ・出欠（`出席` `出席・記録なし` `記録なし` `時間切れ` `欠席` を選択。△×は表示のみ）・タイピング（タイピングの回だけ）・クイズ（クイズの回だけ）・メモ・補講
  - 入力欄で Enter → 同じ列の下の行へ移動し、変更があった行を保存。保存中は薄く、成功で通常、失敗で赤＋「再送」ボタン、409 は最新値に置き換えてメッセージを表示
  - 「補講」ボタン → 小さなダイアログで場所（コマ→班の2段の選択／個別／未定）を選ぶ → 保存で行に「△ 補講先：火1 C」。補講の行に「できなかった」「取り消し」
  - 補講で来る人は班の表の下に「補講で来る人」として区切って表示（元の班名つき）
  - 上部の検索欄 → 結果をクリックすると、その受講生の全回の記録を表示
  - 閲覧用のタブ「名簿（印刷）」「集計」：Task 15 の名簿・集計の描画関数（`public/js/views.js` に置き、admin.js と共有）を読み取り専用で使う
- [ ] **Step 1: 画面テストを書く**
  - `タイピングを入力して Enter → 保存され、再読み込み後も残る`
  - `補講で 火1 C を選ぶ → 行に△、火1 の名簿に「補講で来る人」として出る`
  - `補講先でタイピングを入れる → 元の班の行に同じ値が出て「済」`
  - `できなかった → ×`
  - `別のタブで先に保存 → 「ほかの人が先に更新しました」が出る`
  - `60人のコマの表示が1秒以内`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認（スクリーンショットを目視）→ コミット

### Task 15: 管理者画面

**Files:**
- Create: `public/admin.html`, `public/js/admin.js`
- Modify: `public/css/app.css`（印刷用 `@media print`）, `test/ui/e2e.mjs`

**Interfaces:**
- Consumes: Task 4, 5, 8〜12 の API
- Produces（タブ。spec 5章の表どおり）：名簿（印刷：出席チェック欄つき、班ごとに改ページ）／補講（回・状態で絞り込み）／解約・移動（登録 → 確認 → 職員確認 → 取り消し）／集計／受講生・班（年度設定・班・受講生編集・一括取り込み：貼り付け → プレビュー表 → 取り込み）／スタッフ（追加・無効化・暗証番号・ロック解除）／操作履歴／データ・バックアップ（一覧・手動・ダウンロード・復元・CSV・初期化：「初期化」と入力するまでボタンは押せない、「受講生名簿も消す」チェック）
- [ ] **Step 1: 画面テストを書く**
  - `一括取り込み：貼り付け → プレビューにエラー行が出る → 直して取り込み → 受講生タブに出る`
  - `解約を登録 → GA 画面の次の回の名簿から消える`
  - `集計タブに継続率が表示される`
  - `初期化：入力前はボタンが押せない → 実行 → 記録が消え、受講生は残る → 初期化前バックアップの「この状態に戻す」で戻る`
  - `GA でログインして admin.html を開くとログイン画面に戻る`
- [ ] **Step 2〜5:** 失敗確認 → 実装 → 成功確認（スクリーンショット目視、印刷プレビューの PDF を `page.pdf()` で確認）→ コミット

### Task 16: 実データでの突き合わせ（手元のみ）

**Files:**
- Create: `tools/reconcile.mjs`（入力は `private/2026.xlsx`。`private/` は .gitignore 済み）

**Interfaces:**
- Consumes: `createDevEnv`, `parseRoster` / import API, records API, `computeStats`
- Produces: 突き合わせ表（標準出力）：コマ×班ごとの「スプレッドシートの班人数（B列）」と「新システムの班人数」、コマ別解約者数、`補講等調整数` 相当（補講のある記録数）。不一致は行ごとに表示

- [ ] **Step 1:** xlsx を読む（`npm i -D xlsx` ではなく、Python の openpyxl で TSV に書き出す小さな手順を `tools/reconcile.md` に記載し、`reconcile.mjs` は TSV を読む）
- [ ] **Step 2:** 名簿を一括取り込み、解約・移動・各回の記録・備考の補講（`補講`/`振替` を含む備考 → 補講の他班または未定）を流し込む。第1〜9回は第0〜8回に読み替える
- [ ] **Step 3:** 実行して、班人数と解約者数が全コマで一致することを確認。一致しない場合は、スプレッドシート側の式の誤り（spec 1章の例）か新システムの誤りかを1件ずつ判定してメモに残す
- [ ] **Step 4:** スクリプトだけコミット（データ・結果はコミットしない）

### Task 17: 本番公開

**Files:**
- Create: `api/index.mjs`, `vercel.json`, `README.md`（運用手順：初期設定・名簿取り込み・初期化・バックアップ・復元）

**Interfaces:**
- Consumes: `handle`, `createNeonDb`, `migrate`
- Produces: 本番 URL。環境変数：`DATABASE_URL`（Neon 連携で自動設定）、`BLOB_READ_WRITE_TOKEN`（Blob 連携）、`PIN_PEPPER`（32文字以上のランダム）、`ADMIN_SETUP_TOKEN`、`CRON_SECRET`、`ENVIRONMENT=production`

- [ ] **Step 1:** GitHub に**非公開**リポジトリを作って送る（利用者の操作が必要なら手順を伝える）
- [ ] **Step 2:** Vercel プロジェクトを作成し、利用者に「Storage → Neon を追加（リージョン：Singapore）」「Storage → Blob を追加（非公開）」を依頼する
- [ ] **Step 3:** 環境変数を設定し、`npm run migrate`（`DATABASE_URL` を使う）でスキーマを作る
- [ ] **Step 4:** デプロイし、Deployment Protection をオフにする（spec 10章）
- [ ] **Step 5:** 本番で通しテスト：初期設定 → 名簿取り込み（テスト用の架空の名簿）→ GA 入力 → 補講 → 解約 → 集計 → バックアップ → 初期化。速さを計測（記録入力画面の表示 1秒以内、1行の保存 0.5秒以内）
- [ ] **Step 6:** 「初期化（受講生名簿も消す）」で試用データを消し、README をコミット
