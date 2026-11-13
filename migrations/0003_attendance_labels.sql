-- 出欠「出席・記録なし（前の〇）」はやめて「記録なし」にまとめる（前年度のシートでは〇は使われていなかった）。
-- 古いバックアップを戻せるよう、CHECK 制約の値はそのまま残す。
update records set attendance = '記録なし' where attendance = '出席・記録なし';
