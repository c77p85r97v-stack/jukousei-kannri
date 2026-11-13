-- 第0回は自由参加（出席のみ）。確認テストは第1回と第8回。
alter table terms alter column quiz_rounds set default '{1,8}';
update terms set quiz_rounds = '{1,8}' where quiz_rounds = '{0,8}';

-- 個別補講の枠：①〜⑦は年度ごとの基本（曜日と時間）、⑧は指定時間外（日時を自由に書く）
alter table terms add column indiv_labels text[] not null
  default '{水曜 13:00,木曜 13:00,金曜 13:00,月曜 13:00,月曜 16:30,火曜 13:00,火曜 16:30}'
  check (array_length(indiv_labels, 1) = 7);

-- 回ごとの書き換え（時間の変更・実施なし・担当・場所）。行がなければ基本のまま。
create table indiv_slots (
  id serial primary key,
  term_id int not null references terms(id) on delete cascade,
  round int not null,
  no int not null check (no between 1 and 7),
  label text,
  host text,
  room text,
  closed boolean not null default false,
  unique (term_id, round, no)
);

alter table makeups add column indiv_no int check (indiv_no between 1 and 8);
alter table makeups add column indiv_when text;
alter table makeups add column indiv_by int references staff(id);
alter table makeups add constraint makeups_indiv_only check (indiv_no is null or place = '個別');
