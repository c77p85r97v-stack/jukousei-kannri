-- 出欠と補講の食い違いを直す（画面の操作でもこの形を保つ）
-- 補講予定なのに当日欠席・未入力 → △
update records r set attendance = '欠席・補講予定'
  from makeups m
 where m.student_id = r.student_id and m.round = r.round and not m.failed
   and (r.attendance is null or r.attendance = '欠席');
-- 補講できずなのに当日欠席・未入力・△ → ×
update records r set attendance = '欠席・補講できず'
  from makeups m
 where m.student_id = r.student_id and m.round = r.round and m.failed
   and (r.attendance is null or r.attendance in ('欠席', '欠席・補講予定'));
-- 補講済みなのに「できなかった」の印が残っている → 印を外す
update makeups m set failed = false
  from records r
 where r.student_id = m.student_id and r.round = m.round and m.failed and r.attendance = '欠席・補講済み';
-- 補講があるのに記録がない → △（できなかったなら ×）
insert into records(student_id, round, attendance)
select m.student_id, m.round, case when m.failed then '欠席・補講できず' else '欠席・補講予定' end
  from makeups m
 where not exists (select 1 from records r where r.student_id = m.student_id and r.round = m.round);
