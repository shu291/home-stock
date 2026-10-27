// node js/parse.test.mjs  (依存なし)
import assert from 'node:assert/strict';
import { parseReceipt, parseReceiptMeta, checkTotal, findDate, parseOrderMail } from './parse.js';
import { guessCategory } from './category.js';
import { fixName } from './ocr-post.js';
import { correctText, setVocabulary } from './ocr-vocab.js';
import { toLines, pick, dropNoise, textTilt } from './ocr-paddle.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`NG  ${name}\n    ${e.message.split('\n').join('\n    ')}`); } };
const brief = (items) => items.map((i) => `${i.name}|${i.qty}|${i.price}`);

// ---- 1. スーパー(内税・軽減税率マーク・複数行の数量・値引・OCRの崩れ) ----
const SUPER = `スーパー まるやま 港南店
〒233-0003 神奈川県横浜市港南区
TEL 045-123-4567
登録番号 T1234567890123
2024年10月26日(土) 18:32 レジ03 担当 山田
※印は軽減税率(8%)対象商品です
※牛 乳 1L          Y198
※たまご L 10コ入    羊258
※食パン 6枚切り    ¥ 128
※豆腐(絹)         ¥68
※トマト
   2コ x 98       196
洗濯用洗剤 詰替      398
  値引           -50
ボックスティッシュ 5箱   1.280
※バナナ 3コ×98 ¥294
小 計                 ¥2,770
8%対象              ¥1,142
10%対象             ¥1,628
(内消費税等 8%       ¥84)
(内消費税等 10%      ¥148)
合 計               ¥2,770
お預り              ¥3,000
お釣り                ¥230
ポイント 27P 付与
ありがとうございました`;
t('スーパー: 品目', () => {
  assert.deepEqual(brief(parseReceipt(SUPER)), [
    '牛乳 1L|1|198', 'たまご L 10コ入|1|258', '食パン 6枚切り|1|128', '豆腐(絹)|1|68', 'トマト|2|196',
    '洗濯用洗剤 詰替|1|348', 'ボックスティッシュ 5箱|1|1280', 'バナナ|3|294',
  ]);
});
t('スーパー: 値引が直前品目に反映される', () => {
  const it = parseReceipt(SUPER).find((i) => i.name.startsWith('洗濯'));
  assert.equal(it.discount, 50);
});
t('スーパー: メタ情報', () => {
  const m = parseReceiptMeta(SUPER);
  assert.equal(m.store, 'スーパー まるやま 港南店');
  assert.equal(m.date, '2024-10-26');
  assert.equal(m.total, 2770);
});
t('スーパー: 検算が一致', () => {
  const r = checkTotal(parseReceipt(SUPER), parseReceiptMeta(SUPER));
  assert.equal(r.ok, true); assert.equal(r.sum, 2770); assert.equal(r.diff, 0);
});
t('スーパー: カテゴリ・日付・source が付く', () => {
  const l = parseReceipt(SUPER);
  assert.deepEqual(l.map((i) => i.category), ['食品', '食品', '食品', '食品', '食品', '洗剤・衛生', '日用品', '食品']);
  assert.ok(l.every((i) => i.boughtAt === '2024-10-26' && i.source === 'receipt'));
});
t('スーパー: 電話・登録番号・日時・合計・お釣・ポイントは品目に入らない', () => {
  const names = parseReceipt(SUPER).map((i) => i.name).join(',');
  assert.ok(!/合計|小計|お預|お釣|ポイント|TEL|登録|2024|対象|消費税/.test(names), names);
});

// ---- 2. ドラッグストア(外税・半角カナ・JANコード・「@単価 x 数量」・割引) ----
const DRUG = `ドラッグストア さくら 本店
TEL 03-1234-5678
2024/10/26 10:15
レジ 02  No.0456
ﾊﾝﾄﾞｿｰﾌﾟ ﾎﾟﾝﾌﾟ 本体       Y 298
4901234567890  シャンプー詰替   Y458
ﾄｲﾚｯﾄﾍﾟｰﾊﾟｰ 12R
    @198 x 2          396
単3電池 4本パック      ¥598
   (2コ x 単299)
ビタミンC錠 90日分    ¥1,980
  会員カード割引      -120
ﾏｽｸ 7枚入          半 328
小計              ¥3,938
外税 10%            ¥394
合計              ¥4,332
お預り            ¥5,000
お釣り              ¥668`;
t('ドラッグ: 品目', () => {
  assert.deepEqual(brief(parseReceipt(DRUG)), [
    'ハンドソープ ポンプ 本体|1|298', 'シャンプー詰替|1|458', 'トイレットペーパー 12R|2|396',
    '単3電池 4本パック|2|598', 'ビタミンC錠 90日分|1|1860', 'マスク 7枚入|1|328',
  ]);
});
t('ドラッグ: 外税込みで検算が一致', () => {
  const items = parseReceipt(DRUG), m = parseReceiptMeta(DRUG);
  assert.equal(m.tax, 394); assert.equal(m.total, 4332);
  const r = checkTotal(items, m);
  assert.equal(r.ok, true); assert.equal(r.sum, 3938);
});
t('ドラッグ: メタ情報とカテゴリ', () => {
  const m = parseReceiptMeta(DRUG);
  assert.equal(m.store, 'ドラッグストア さくら 本店'); assert.equal(m.date, '2024-10-26');
  assert.deepEqual(parseReceipt(DRUG).map((i) => i.category), ['洗剤・衛生', '洗剤・衛生', '日用品', '消耗品', '薬', '日用品']);
});

// ---- 3. コンビニ(半角カナ・*マーク・令和表記・クーポン・レジ袋・内税) ----
const CVS = `ﾛｰｿﾝ 渋谷道玄坂店
TEL:03-9876-5432
R6.10.26 07:48
領収書
*おにぎり 鮭         Y 150
*おにぎり ﾂﾅﾏﾖ        ¥150
*ｻﾝﾄﾘｰ 天然水 555ml   ¥110
*ｶﾌｪﾗﾃ M          羊 180
 クーポン値引      -50
ﾚｼﾞ袋 小             ¥3
小計  (4点)         ¥543
合計              ¥543
(内消費税等 8%     ¥40)
お預り            ¥1,000
お釣り              ¥457
ﾅﾅｺﾎﾟｲﾝﾄ 5P`;
t('コンビニ: 品目とクーポン', () => {
  assert.deepEqual(brief(parseReceipt(CVS)), [
    'おにぎり 鮭|1|150', 'おにぎり ツナマヨ|1|150', 'サントリー 天然水 555ml|1|110', 'カフェラテ M|1|130', 'レジ袋 小|1|3',
  ]);
});
t('コンビニ: メタ・検算・カテゴリ', () => {
  const m = parseReceiptMeta(CVS), l = parseReceipt(CVS);
  assert.equal(m.store, 'ローソン 渋谷道玄坂店'); assert.equal(m.date, '2024-10-26'); assert.equal(m.total, 543);
  assert.equal(checkTotal(l, m).ok, true);
  assert.deepEqual(l.map((i) => i.category), ['食品', '食品', '飲料', '飲料', '日用品']);
});

// ---- 4. 崩れの多い例(¥→羊、1.128、行末マイナス、ごみ文字、読み落とし → 検算不一致) ----
const NOISY = `*** イオン スタイル 港南台 店 ***
令和6年10月26日 16:05
鶏むね肉 280g       Y348
豚ひき肉 300g      ¥ 298
ｷｬﾍﾞﾂ 1/2          ¥ 118
ごぼう            ｜ 98
牛乳 (成分無調整)    198 ※
値 引  30-
合 計    ¥ 1.128
お預り  羊 2,000
お釣    872`;
t('崩れ: 品目', () => {
  assert.deepEqual(brief(parseReceipt(NOISY)), [
    '鶏むね肉 280g|1|348', '豚ひき肉 300g|1|298', 'キャベツ 1/2|1|118', 'ごぼう|1|98', '牛乳 (成分無調整)|1|168',
  ]);
});
t('崩れ: メタ(令和・1.128→1,128)', () => {
  const m = parseReceiptMeta(NOISY);
  assert.equal(m.store, 'イオン スタイル 港南台 店'); assert.equal(m.date, '2024-10-26'); assert.equal(m.total, 1128);
});
t('崩れ: 読み落としで検算が不一致になり差額が出る', () => {
  const r = checkTotal(parseReceipt(NOISY), parseReceiptMeta(NOISY));
  assert.equal(r.ok, false); assert.equal(r.sum, 1030); assert.equal(r.diff, -98);
});

// ---- 5. 折り返し品名・数量の各種表記・小計後の全体値引 ----
const MISC = `まいばすけっと 弘明寺店
2024.10.26
ｺｰﾋｰ豆 ﾌﾞﾚﾝﾄﾞ 200g
            ¥ 698
ミネラルウォーター 2L
 6コ x 98   588
カップ麺 (3コ x 単価108)   324
ﾁｮｺﾚｰﾄ 198×2    396
小計         ¥2,006
割引          -6
合計         ¥2,000`;
t('各種: 折り返し・数量行・インライン数量', () => {
  assert.deepEqual(brief(parseReceipt(MISC)), [
    'コーヒー豆 ブレンド 200g|1|698', 'ミネラルウォーター 2L|6|588', 'カップ麺|3|324', 'チョコレート|2|396',
  ]);
});
t('各種: 小計後の値引は全体値引として検算に使う', () => {
  const m = parseReceiptMeta(MISC);
  assert.equal(m.adjust, 6); assert.equal(m.total, 2000);
  assert.equal(checkTotal(parseReceipt(MISC), m).ok, true);
});

// ---- 6. OCR補正の単体 ----
const one = (line) => parseReceipt(line)[0];
t('¥の誤認識: Y / 羊 / 半 / バックスラッシュ', () => {
  for (const sym of ['Y', '羊', '半', '\\', '¥', '￥']) assert.equal(one(`牛乳 ${sym}198`)?.price, 198, sym);
  assert.equal(one('牛乳羊198')?.price, 198);
});
t('金額: 全角・空白・カンマ崩れ', () => {
  assert.equal(one('牛乳  ￥１,２８０')?.price, 1280);
  assert.equal(one('牛乳 ¥ 1, 280')?.price, 1280);
  assert.equal(one('牛乳 ¥1.280')?.price, 1280);
  assert.equal(one('牛乳 1,280円')?.price, 1280);
  assert.equal(one('牛乳 198 軽')?.price, 198);
  assert.equal(one('牛乳 198 8%')?.price, 198);
  assert.equal(one('牛乳 ........ 198')?.price, 198);
});
t('品名: 前置きマーク・JAN・CJK間の空白', () => {
  assert.equal(one('※ 牛 乳 ¥198').name, '牛乳');
  assert.equal(one('4901234567890 牛乳 ¥198').name, '牛乳');
  assert.equal(one('軽 牛乳 198').name, '牛乳');
});
t('数量: x2 / 2個 / @単価', () => {
  assert.equal(one('牛乳 x2 396').qty, 2);
  assert.equal(one('卵 2個 396').qty, 2);
  const a = one('牛乳 @198 396'); assert.equal(a.qty, 2); assert.equal(a.name, '牛乳');
});
t('値引き: -50 だけの行・▲・△', () => {
  assert.equal(parseReceipt('牛乳 198\n-50')[0].price, 148);
  assert.equal(parseReceipt('牛乳 198\n▲50')[0].price, 148);
  assert.equal(parseReceipt('牛乳 198\n値引き △30')[0].price, 168);
  assert.equal(parseReceipt('牛乳 198\nポイント値引 -100')[0].price, 198);
});
t('除外: 合計・お預り・電話・登録番号・日時・点数', () => {
  const txt = '合計 ¥1,080\nお預り ¥2,000\nお釣り ¥920\nTEL 03-1234-5678\nT1234567890123\n2024/10/26 12:34\nお買上点数 3点\nポイント 10 ¥10\n現金 ¥2,000';
  assert.deepEqual(parseReceipt(txt), []);
});
t('品目でない文字列は空配列(例外を投げない)', () => {
  assert.deepEqual(parseReceipt(''), []);
  assert.deepEqual(parseReceipt('こんにちは'), []);
  assert.deepEqual(parseReceipt(undefined), []);
});
t('互換: 従来形式の戻り値(name,qty,price,boughtAt,source)', () => {
  const l = parseReceipt('2024-10-26\n牛乳 198\nパン 128');
  assert.equal(l.length, 2);
  assert.deepEqual({ name: l[0].name, qty: l[0].qty, price: l[0].price, boughtAt: l[0].boughtAt, source: l[0].source }, { name: '牛乳', qty: 1, price: 198, boughtAt: '2024-10-26', source: 'receipt' });
});

// ---- 7. 日付・検算・カテゴリ・メール解析 ----
t('findDate: 各種表記', () => {
  assert.equal(findDate('2024年1月5日'), '2024-01-05');
  assert.equal(findDate('2024/10/26 12:00'), '2024-10-26');
  assert.equal(findDate('令和6年10月26日'), '2024-10-26');
  assert.equal(findDate('R6.1.5'), '2024-01-05');
  assert.equal(findDate('24/10/26 12:34'), '2024-10-26');
  assert.equal(findDate('2024/13/45'), '');
  assert.equal(findDate('日付なし'), '');
});
t('checkTotal: 合計不明は ok=null、差額の符号', () => {
  assert.equal(checkTotal([{ price: 100 }], { total: 0 }).ok, null);
  assert.equal(checkTotal([{ price: 100 }], { total: 90 }).diff, 10);
  assert.equal(checkTotal([{ price: 100 }], { total: 110 }).diff, -10);
  assert.equal(checkTotal([{ price: 100 }], { total: 110, tax: 10 }).ok, true);
});
t('guessCategory: 例示のキーワード', () => {
  const c = { 牛乳: '食品', 卵: '食品', 食パン: '食品', 洗剤: '洗剤・衛生', シャンプー: '洗剤・衛生', ティッシュ: '日用品', トイレットペーパー: '日用品', 乾電池: '消耗品', 緑茶: '飲料', ロキソニン: '薬', フライパン: '日用品', 牛乳石鹸: '洗剤・衛生', おいしい水: '飲料', 化粧水: '洗剤・衛生', 謎の品: '' };
  for (const [k, v] of Object.entries(c)) assert.equal(guessCategory(k), v, k);
});
t('parseOrderMail は従来どおり', () => {
  const r = parseOrderMail('ご注文内容\nおいしい水 2L\n数量: 3\n¥1,200\n', { key: 'k' });
  assert.equal(r.length, 1); assert.equal(r[0].qty, 3); assert.equal(r[0].price, 1200);
});

// ---- 8. 実画像のOCRで見つかった崩れ方(匿名化した再現。店名・金額は架空) ----
t('OCR崩れ: 年が%に化ける・千の位が読めない・区切りにカンマ・取引IDの日付', () => {
  assert.equal(findDate('2026% 8 月 5 日 ( 水 ) 10:38'), '2026-08-05');
  assert.equal(findDate('<026 年 09 月 22 日 ( 火 ) 19:22'), '2026-09-22');
  assert.equal(findDate('2026,/08/27(A)19:51'), '2026-08-27');
  assert.equal(findDate('2026% 96 月 18 日\n取引 ID 2145520260618115622'), '2026-06-18'); // 月が読めなければ取引IDの YYYYMMDD
  assert.equal(findDate('電話 055-222-0031'), '');
});
const OCR_TAX = `ストア テスト 東店
2026 年 09 月 22 日 ( 火 ) 19:22
ダーススペシャル
        @340x 3     *1,020
メロン パン    *209
アメリカンドッグ    *139
( 商品 代金       ¥1,368)
小 計 ( 税 抜 8%)   ¥1,368
消費 税 等 ( 8%)    ¥109
= B                 ¥1. 477
PayPay 支 払       ¥1, 477`;
t('OCR崩れ: 「合計」が化けても、小計+外税と一致する行を合計とする', () => {
  const m = parseReceiptMeta(OCR_TAX), it = parseReceipt(OCR_TAX);
  assert.equal(m.total, 1477);
  assert.deepEqual(brief(it), ['ダーススペシャル|3|1020', 'メロン パン|1|209', 'アメリカンドッグ|1|139']);
  assert.equal(checkTotal(it, m).ok, true);
});
t('OCR崩れ: 合計行が読めなくても、支払行から合計を推定', () => {
  const x = 'ストア\nおにぎり 鮭   ¥150\nお茶   ¥140\nクレジット   ¥290\n';
  assert.equal(parseReceiptMeta(x).total, 290);
  const cash = 'ストア\nパン  ¥200\n牛乳  ¥180\n現金  ¥1,000\nお釣り  ¥620\n';
  assert.equal(parseReceiptMeta(cash).total, 380);
});
t('OCR崩れ: 軽減税率マークが数字・記号に化けた金額を、小計との一致で直す', () => {
  const x = `八百屋 テスト
2026年9月26日
えのき
  2個 X 単88    \\176 軽
おくら          ¥]0982
ミニ トマト     ¥198 電
計              ¥],579
8% 対象         ¥1,579
(うち 消費税   ¥126)`;
  const it = parseReceipt(x);
  assert.deepEqual(brief(it), ['えのき|2|176', 'おくら|1|109', 'ミニ トマト|1|198']);
});
t('OCR崩れ: 品目ではない行(決済・テーブル番号・住所・電話の断片・税率行)は拾わない', () => {
  const x = `ストア テスト
テーブルNo. 85   人数 3
埼玉県入間郡三芳町藤久保 3331
TEL 04-258- 1888
きゅうり (@315X2/%) ¥630%
8% 対象 ¥630
合計    ¥680
コード決済   ¥680
ご利用額     ¥680`;
  assert.deepEqual(brief(parseReceipt(x)), ['きゅうり|2|630']);
  assert.equal(parseReceiptMeta(x).total, 680);
});
t('OCR崩れ: 合計より後ろ(ポイント・広告)の行は品目にしない', () => {
  const x = 'ストア\nパン  ¥200\n合計  ¥200\nポイント対象金額  ¥200\nお得な クーポン配信中 300\n';
  assert.deepEqual(brief(parseReceipt(x)), ['パン|1|200']);
});

// ---- 深層学習OCR向けの補正(架空の店名・品名・金額だけで確かめる) ----
t('OCR: 先頭の商品コード・「(TO)」を品名から外し、軽減税率マークが「怪」に化けた金額も読む', () => {
  const x = `サンプル食堂 テスト店
C1234 サンプルバーガー ¥300
04567(TO)テストサラダ * ¥400
テスト飲料 120怪
合計 ¥820`;
  assert.deepEqual(brief(parseReceipt(x)), ['サンプルバーガー|1|300', 'テストサラダ|1|400', 'テスト飲料|1|120']);
});
t('OCR: 合計が小さく読めたときでも、3桁以下の品目の金額を100で割らない', () => {
  const x = 'ストア\nテスト牛乳 ¥198\nテスト卵 ¥258\n小計 ¥456\n合計 ¥45\n';
  assert.deepEqual(brief(parseReceipt(x)), ['テスト牛乳|1|198', 'テスト卵|1|258']);
});
t('合計: 「税合計」「お預り合計」「合計残高」や、合計の後ろの行で上書きしない', () => {
  const x = 'ストア テスト\nテストA ¥500\nテストB ¥300\n小計 ¥800\n税合計 ¥72\n合計 ¥800\nお預り合計 ¥1,000\nお客様の合計残高 29\n';
  assert.equal(parseReceiptMeta(x).total, 800);
  assert.deepEqual(brief(parseReceipt(x)), ['テストA|1|500', 'テストB|1|300']);
});
t('日付: 先に電話番号(0564-59-0770)のような日付でない並びがあっても、あとの日付を拾う', () => {
  assert.equal(findDate('電話：0564-59-0770\n登録番号：T6180302002596\n2026年9月20日（日）14:29\n'), '2026-09-20');
  assert.equal(findDate('TEL 055-236-6606\n2026年08月04日(火)16:04'), '2026-08-04');
});
t('OCR: 数量の「2コ」の「コ」が数字に化けた「23 × 単55 ¥110」は、金額と合う数量(2)に直す', () => {
  const x = 'ストア テスト\nテスト飲料\n23 × 単55 ¥110\nテスト牛乳\n43 × 単298 ¥1,192\n合計 ¥1,302\n';
  assert.deepEqual(brief(parseReceipt(x)), ['テスト飲料|2|110', 'テスト牛乳|4|1192']);
});
t('OCR後処理: 簡体字を日本の字体へ(単価・税抜・消費税・領収書・値引)', () => {
  assert.equal(fixName('单价 税拔 消费税 領收书 值引'), '単価 税抜 消費税 領収書 値引');
});
t('OCR後処理: 半角カナの濁点・半濁点が別の記号になったものを戻す', () => {
  assert.equal(fixName('テスト`'), 'テスド');
  assert.equal(fixName('サンフ°ル'), 'サンプル');
  assert.equal(fixName('ヘ゜ン'), 'ペン');
  assert.equal(fixName('プ°'), 'プ');
});
t('OCR後処理: 長音が「一」「-」になったものと、カナに似た字を戻す(数字や漢字の「一」は触らない)', () => {
  assert.equal(fixName('サンプル一'), 'サンプルー');
  assert.equal(fixName('テスト一メン'), 'テストーメン');
  assert.equal(fixName('コ-ンスープ'), 'コーンスープ');
  assert.equal(fixName('ラ1ス'), 'ライス');
  assert.equal(fixName('サ二ブル'), 'サニブル');
  assert.equal(fixName('1〇〇〇円'), '1000円');
  assert.equal(fixName('一個 二個 1個'), '一個 二個 1個');
  assert.equal(fixName('合言十 ¥100'), '合計 ¥100');
});
t('語彙補正: 濁点が落ちた/似た字に化けた語を直し、正しい語・語彙にない語はそのまま', () => {
  assert.equal(correctText('ミニアマト'), 'ミニトマト');
  assert.equal(correctText('なめご'), 'なめこ');
  assert.equal(correctText('ミニトマト'), 'ミニトマト');
  assert.equal(correctText('サンプルバーガー'), 'サンプルバーガー'); // 語彙にない語
  assert.equal(correctText('ダースプレミアム'), 'ダースプレミアム'); // 短い語(スープ)が長いカナの途中に埋まっていても直さない
  assert.equal(correctText('おてんとさん'), 'おてんとさん');
  assert.equal(correctText('ハンバーク定食 ¥500'), 'ハンバーグ定食 ¥500');
});
t('語彙補正: アプリ側の語彙(過去の品名)も使える', () => {
  assert.equal(correctText('ウチノマミムメト'), 'ウチノマミムメト');
  setVocabulary(['ウチノマミムメモ']);
  assert.equal(correctText('ウチノマミムメト'), 'ウチノマミムメモ');
  setVocabulary([]);
});
t('OCR行まとめ: 同じ高さの枠は1行に、右端の金額が少しずれて別の行になっても品名の行に付ける', () => {
  const box = (text, x0, y0, x1, y1) => ({ text, x0: x0 - 5, y0: y0 - 5, x1: x1 + 5, y1: y1 + 5, conf: 1, t: { x0, y0, x1, y1 } });
  const items = [box('品名A', 100, 100, 400, 140), box('¥300', 900, 96, 1000, 134), box('品名B', 100, 190, 400, 230), box('¥150', 900, 192, 1000, 232), box('品名C', 100, 280, 400, 320), box('¥200', 900, 260, 1000, 298)];
  assert.deepEqual(toLines(items).map((l) => l.text), ['品名A ¥300', '品名B ¥150', '品名C ¥200']);
  assert.deepEqual(toLines(items.slice(0, 4)).map((l) => l.text), ['品名A ¥300', '品名B ¥150']);
});
t('OCRのゴミ除去: ほかの枠もある行で、確信度が0.5未満の短い枠(模様を文字と読んだもの)だけ落とす', () => {
  const p = (text, conf) => ({ text, conf });
  assert.deepEqual(dropNoise([p('品名', 0.95), p('SARNAD', 0.44), p('品名B', 0.99)]).map((x) => x.text), ['品名', '品名B']);
  assert.deepEqual(dropNoise([p('SARNAD', 0.44)]).map((x) => x.text), ['SARNAD']); // 1つだけの行は残す
  assert.deepEqual(dropNoise([p('薄いが長い文字列です', 0.45), p('¥100', 0.9)]).map((x) => x.text), ['薄いが長い文字列です', '¥100']); // 長いものは残す
});
t('文字行の傾き: 細長い枠の向きの中央値(枠が少なければ0)', () => {
  const b = (ang) => ({ ang, score: 0.9 });
  assert.equal(textTilt([b(0.02), b(0.03), b(0.025), b(0.4), b(0.021), b(0.024), b(0.5), b(null)]), 0.024); // 0.35rad超とnullは数えない
  assert.equal(textTilt([b(0.1), b(0.1)]), 0);
});
t('OCR候補の選択: 確信度が最大のものを選ぶ', () => {
  assert.equal(pick([{ text: 'a', conf: 0.7 }, { text: 'b', conf: 0.95 }, { text: 'c', conf: 0.8 }], 'conf').text, 'b');
  assert.equal(pick([{ text: 'あいう', conf: 0.9 }, { text: 'あいう', conf: 0.8 }, { text: 'xyz', conf: 0.95 }], 'medoid').text, 'あいう');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
