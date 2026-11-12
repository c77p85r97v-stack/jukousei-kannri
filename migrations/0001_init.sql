-- PC講習会 受講生管理システム 初期スキーマ
-- 名簿・補講の状態・集計は表に持たず、表示のたびに計算する。

create table terms (
  id serial primary key,
  name text not null,
  rounds int[] not null default '{0,1,2,3,4,5,6,7,8}',
  typing_rounds int[] not null default '{1,2,3,4,5,6,7,8}',
  quiz_rounds int[] not null default '{0,8}',
  initial_count int check (initial_count is null or initial_count >= 0),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index terms_one_active on terms (active) where active;

create table slots (
  id serial primary key,
  term_id int not null references terms(id) on delete cascade,
  code text not null check (code in ('月','火1','火2','水1','水2','木1','木2','金1','金2')),
  sort int not null default 0,
  unique (term_id, code)
);

create table staff (
  id serial primary key,
  name text not null unique,
  role text not null check (role in ('ga','admin')),
  pin_hash text,
  failed_logins int not null default 0,
  locked_until timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table groups (
  id serial primary key,
  slot_id int not null references slots(id) on delete cascade,
  ga_id int not null references staff(id),
  sort int not null default 0,
  unique (slot_id, ga_id)
);

create table students (
  id serial primary key,
  term_id int not null references terms(id) on delete cascade,
  name text not null,
  kana text,
  nickname text,
  group_id int not null references groups(id),
  created_at timestamptz not null default now()
);
create index students_group on students (group_id);
create index students_term on students (term_id);

create table records (
  id serial primary key,
  student_id int not null references students(id) on delete cascade,
  round int not null,
  attendance text check (attendance in ('出席','出席・記録なし','記録なし','時間切れ','欠席','欠席・補講予定','欠席・補講できず')),
  typing numeric(6,1) check (typing >= 0),
  quiz int check (quiz >= 0),
  note text,
  version int not null default 1,
  updated_by int references staff(id),
  updated_at timestamptz not null default now(),
  unique (student_id, round)
);

create table makeups (
  id serial primary key,
  student_id int not null references students(id) on delete cascade,
  round int not null,
  place text not null check (place in ('他班','個別','未定')),
  host_group_id int references groups(id),
  failed boolean not null default false,
  version int not null default 1,
  created_by int references staff(id),
  created_at timestamptz not null default now(),
  unique (student_id, round),
  check (place <> '他班' or host_group_id is not null)
);
create index makeups_host on makeups (host_group_id, round);

create table withdrawals (
  id serial primary key,
  student_id int not null references students(id) on delete cascade,
  from_round int not null,
  reason text,
  manager_checked_by int references staff(id),
  staff_confirmed boolean not null default false,
  created_by int references staff(id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);
create unique index withdrawals_one_active on withdrawals (student_id) where cancelled_at is null;

create table transfers (
  id serial primary key,
  student_id int not null references students(id) on delete cascade,
  from_group_id int not null references groups(id),
  to_group_id int not null references groups(id),
  from_round int not null,
  manager_checked_by int references staff(id),
  created_by int references staff(id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (from_group_id <> to_group_id)
);
create index transfers_student on transfers (student_id);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  operator_id int,
  action text not null,
  target_table text,
  target_id text,
  before_json jsonb,
  after_json jsonb
);

create table backups_meta (
  id serial primary key,
  at timestamptz not null default now(),
  blob_key text not null,
  size int not null default 0,
  kind text not null check (kind in ('自動','手動','復元前','初期化前'))
);

create table request_ids (
  id text primary key,
  at timestamptz not null default now(),
  response jsonb
);
