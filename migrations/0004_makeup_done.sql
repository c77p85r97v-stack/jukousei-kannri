-- 当日欠席して補講を受けた人を「出席」にせず「欠席・補講済み」として残す（受講率には数え、内訳を出す）。
alter table records drop constraint if exists records_attendance_check;
alter table records add constraint records_attendance_check
  check (attendance in ('出席','出席・記録なし','記録なし','時間切れ','欠席','欠席・補講予定','欠席・補講できず','欠席・補講済み'));
-- すでに補講で受けて「出席」などになっている記録を「欠席・補講済み」に直す
update records r set attendance = '欠席・補講済み'
  from makeups m
 where m.student_id = r.student_id and m.round = r.round and not m.failed
   and r.attendance in ('出席','出席・記録なし','記録なし','時間切れ');
