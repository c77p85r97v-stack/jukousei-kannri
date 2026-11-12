// 手元確認用の架空データ（実在の人物ではありません）
import { hashPin } from '../src/lib/crypto.js';
import { SLOT_CODES } from '../src/lib/normalize.js';

const SEI = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '松本', '井上', '木村', '林', '清水', '山崎', '森'];
const SEI_K = ['サトウ', 'スズキ', 'タカハシ', 'タナカ', 'イトウ', 'ワタナベ', 'ヤマモト', 'ナカムラ', 'コバヤシ', 'カトウ', 'ヨシダ', 'ヤマダ', 'ササキ', 'マツモト', 'イノウエ', 'キムラ', 'ハヤシ', 'シミズ', 'ヤマザキ', 'モリ'];
const MEI = ['はると', 'ゆい', 'そうた', 'めい', 'りく', 'あおい', 'ゆうと', 'さくら', 'かいと', 'ひな'];
const MEI_K = ['ハルト', 'ユイ', 'ソウタ', 'メイ', 'リク', 'アオイ', 'ユウト', 'サクラ', 'カイト', 'ヒナ'];
const GA = ['いけ', 'すな', 'りょうつ', 'のり', 'ヨッシー', 'ヒロト', 'まる'];

export async function seedDemo(env, { perGroup = 8 } = {}) {
  const db = env.db;
  const [term] = await db.query(`insert into terms(name, active) values ('2027年度PC講習会（デモ）', true) returning *`);
  const slots = [];
  for (const [i, code] of SLOT_CODES.entries()) slots.push((await db.query('insert into slots(term_id, code, sort) values ($1,$2,$3) returning *', [term.id, code, i]))[0]);
  const gas = [];
  for (const name of GA) gas.push((await db.query(`insert into staff(name, role) values ($1,'ga') returning *`, [name]))[0]);
  await db.query(`insert into staff(name, role, pin_hash) values ('管理者','admin',$1)`, [await hashPin(env, '1234')]);
  let n = 0;
  for (const slot of slots) {
    for (const [gi, ga] of gas.entries()) {
      const [g] = await db.query('insert into groups(slot_id, ga_id, sort) values ($1,$2,$3) returning id', [slot.id, ga.id, gi]);
      for (let i = 0; i < perGroup; i++, n++) {
        const a = n % SEI.length;
        const b = (n * 7 + Math.floor(n / SEI.length)) % MEI.length;
        await db.query('insert into students(term_id, name, kana, nickname, group_id) values ($1,$2,$3,$4,$5)', [term.id, `${SEI[a]} ${MEI[b]}${n}`, `${SEI_K[a]} ${MEI_K[b]}`, MEI[b], g.id]);
      }
    }
  }
  return { term, slots, gas };
}
