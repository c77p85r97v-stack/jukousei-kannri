-- 第0回は自由参加：タイピング・クイズの回から外す（古い既定値 {0,8} で作られた年度を直す）
update terms set quiz_rounds = '{1,8}' where quiz_rounds = '{0,8}';
update terms set quiz_rounds = array_remove(quiz_rounds, 0) where 0 = any(quiz_rounds);
update terms set typing_rounds = array_remove(typing_rounds, 0) where 0 = any(typing_rounds);
