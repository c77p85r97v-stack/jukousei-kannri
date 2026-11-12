// 本番データベースに migrations を適用する（通常は API の起動時に自動で行われる）。
//   DATABASE_URL=... npm run migrate
import { createNeonDb, migrate } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL を設定してください');
  process.exit(1);
}
const db = await createNeonDb(process.env.DATABASE_URL);
await migrate(db);
console.log('migrations を適用しました');
await db.close();
