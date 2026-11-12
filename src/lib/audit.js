// 操作履歴：書き込みと同じトランザクションの中で呼ぶ。
export async function audit(t, operatorId, action, table, id, before, after) {
  await t.query(
    'insert into audit_log(operator_id, action, target_table, target_id, before_json, after_json) values ($1,$2,$3,$4,$5,$6)',
    [operatorId ?? null, action, table ?? null, id == null ? null : String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}
