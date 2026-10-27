// node js/category.test.mjs  (依存なし)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guessClass, guessCategory, cleanName, DICT_KEYS } from './category.js';
import { TAXONOMY, CATS, LOCS, LOCATIONS, COLOR_TOKENS, SUB_LOC, CAT_LOC, LEGACY_CATEGORY, LEGACY_LOCATION, canonCategory, canonLocation, fitLocation,
  catInfo, locInfo, colorOf, categoryOptions, subOptions, locationOptions, matchCategory, matchLocation, classFields } from './taxonomy.js';
import { autoClassify } from './optimize.js';
import { EVAL, TRAIN, VALID, evaluate } from './category.eval.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`NG  ${name}\n    ${e.message.split('\n').join('\n    ')}`); } };
const g = (n) => guessClass(n);
const cs = (n) => { const r = g(n); return `${r.category}/${r.sub}`; };
const subsOf = (c) => TAXONOMY.find((x) => x.name === c)?.subs || [];

// ---- 分類体系の整合 ----
t('taxonomy: 大分類は重複なし・色トークンが定義済み・アイコンあり', () => {
  assert.equal(new Set(CATS).size, CATS.length);
  for (const c of TAXONOMY) { assert.ok(COLOR_TOKENS[c.color], c.name); assert.ok(c.icon, c.name); assert.equal(new Set(c.subs).size, c.subs.length, c.name); }
  assert.equal(new Set(LOCS).size, LOCS.length); for (const l of LOCATIONS) assert.ok(l.icon, l.name);
});
t('taxonomy: 互換の配列(CATS/LOCS)は文字列の配列で .map/.includes/.indexOf が使える', () => {
  assert.ok(Array.isArray(CATS) && CATS.every((x) => typeof x === 'string') && Array.isArray(LOCS) && LOCS.every((x) => typeof x === 'string'));
  assert.equal(CATS.map((x) => x).length, TAXONOMY.length); assert.ok(LOCS.includes('冷蔵庫') && LOCS.indexOf('その他') >= 0);
});
t('taxonomy: 置き場所は要望の12種(冷蔵庫/冷凍庫/パントリー/キッチン/洗面所/お風呂/トイレ/押入れ・収納/玄関/ベランダ/車/その他)', () => {
  assert.deepEqual(LOCS, ['冷蔵庫', '冷凍庫', 'パントリー', 'キッチン', '洗面所', 'お風呂', 'トイレ', '押入れ・収納', '玄関', 'ベランダ', '車', 'その他']);
});
t('taxonomy: 既定の置き場所表は実在する大分類・小分類・置き場所だけを指す(確信度は 0〜1)', () => {
  for (const [c, m] of Object.entries(SUB_LOC)) for (const [s, [l, p]] of Object.entries(m)) { assert.ok(subsOf(c).includes(s), `${c}/${s}`); assert.ok(LOCS.includes(l), l); assert.ok(p > 0 && p <= 1); }
  for (const [c, [l]] of Object.entries(CAT_LOC)) { assert.ok(CATS.includes(c)); assert.ok(LOCS.includes(l)); }
});
t('taxonomy: 色トークンはライト/ダークとも文字と背景のコントラスト比が 4.5 以上(WCAG AA)', () => {
  const lum = (hex) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, m] of Object.entries(COLOR_TOKENS)) for (const mode of ['light', 'dark']) assert.ok(cr(m[mode].bg, m[mode].fg) >= 4.5, `${name} ${mode} ${cr(m[mode].bg, m[mode].fg).toFixed(2)}`);
});
t('辞書のキーはすべて実在する 大分類/小分類', () => {
  for (const k of DICT_KEYS) { const [c, s = ''] = k.split('/'); assert.ok(CATS.includes(c), k); assert.ok(!s || subsOf(c).includes(s), k); }
});
t('辞書のサイズは 30KB 以内(モバイルで読み込める程度)', () => assert.ok(fs.statSync(new URL('./category.js', import.meta.url)).size <= 30 * 1024));

// ---- 評価セット ----
t('評価セット: 300件以上で、正解ラベルは体系に存在する(? は空)', () => {
  assert.ok(EVAL.length >= 300, `${EVAL.length}`); assert.ok(TRAIN.length > VALID.length && VALID.length >= 100);
  for (const e of EVAL) { assert.ok(!e.category || CATS.includes(e.category), `${e.name} ${e.category}`); assert.ok(!e.sub || subsOf(e.category).includes(e.sub), `${e.name} ${e.category}/${e.sub}`); }
});
// 目標: 検証用で 確信ありの適合率 大分類90%・小分類85%以上、空の率25%以下。回帰検出のため実測に近い値でも縛る
const RV = evaluate(g, VALID), RT = evaluate(g, TRAIN);
const pct = (x) => (x * 100).toFixed(1);
console.log(`評価 ${EVAL.length}件 学習${TRAIN.length}/検証${VALID.length}  検証: 大分類 正解${pct(RV.catAcc)}% 適合${pct(RV.catPrec)}% 空${pct(RV.catBlank)}% / 小分類 正解${pct(RV.subAcc)}% 適合${pct(RV.subPrec)}% 空${pct(RV.subBlank)}%`);
t('検証用: 大分類の適合率 90%以上(目標) かつ 95%以上(回帰線)', () => { assert.ok(RV.catPrec >= 0.9); assert.ok(RV.catPrec >= 0.95, pct(RV.catPrec)); });
t('検証用: 小分類の適合率 85%以上(目標) かつ 93%以上(回帰線)', () => { assert.ok(RV.subPrec >= 0.85); assert.ok(RV.subPrec >= 0.93, pct(RV.subPrec)); });
t('検証用: 空にする率 25%以下(目標)・12%以下(回帰線)', () => { assert.ok(RV.catBlank <= 0.25 && RV.subBlank <= 0.25); assert.ok(RV.catBlank <= 0.12 && RV.subBlank <= 0.12, `${pct(RV.catBlank)} ${pct(RV.subBlank)}`); });
t('検証用: 大分類・小分類の正解率(全件に対して)', () => { assert.ok(RV.catAcc >= 0.88, pct(RV.catAcc)); assert.ok(RV.subAcc >= 0.85, pct(RV.subAcc)); });
t('学習用でも目標を満たす', () => { assert.ok(RT.catPrec >= 0.9 && RT.subPrec >= 0.85 && RT.catBlank <= 0.25); });
t('分類しようがない品(正解が空)に確信を持って答えない', () => {
  const unk = EVAL.filter((e) => !e.category); assert.ok(unk.length >= 8);
  const bad = unk.filter((e) => g(e.name).category); assert.ok(bad.length <= 1, bad.map((e) => e.name).join());
});
t('返す小分類は必ず返した大分類の小分類(整合)', () => {
  for (const e of EVAL) { const r = g(e.name); if (r.sub) assert.ok(subsOf(r.category).includes(r.sub), `${e.name} ${r.category}/${r.sub}`); if (!r.category) assert.equal(r.sub, ''); }
});

// ---- 優先順位・除外・表記ゆれ ----
t('優先順位: フライパンはパンではない/パンツ・ベビーリーフ・ペットボトルの取り違えなし', () => {
  assert.equal(cs('フライパン'), '日用品/キッチン用品'); assert.equal(cs('ﾌﾗｲﾊﾟﾝ 26cm'), '日用品/キッチン用品');
  assert.equal(cs('食パン'), '食品/米・パン'); assert.equal(cs('メロンパン'), '食品/米・パン'); assert.equal(cs('パンツ'), '日用品/生活雑貨');
  assert.equal(cs('ベビーリーフ'), '食品/野菜・果物'); assert.equal(cs('ベビースター'), '食品/お菓子');
  assert.equal(cs('サントリー 天然水 ペットボトル'), '飲料/水・炭酸水'); assert.equal(cs('ペットボトル'), '/'); assert.equal(g('烏龍茶 ﾍﾟｯﾄ').category, '飲料');
});
t('優先順位: トイレ用洗剤はトイレ・洗剤、トイレットペーパーは紙、麦茶はお茶', () => {
  assert.equal(cs('トイレ用洗剤'), '洗剤・掃除/トイレ'); assert.equal(cs('トイレットペーパー 12ロール'), '日用品/ティッシュ・ペーパー');
  assert.equal(cs('麦茶'), '飲料/お茶'); assert.equal(cs('ほうじ茶'), '飲料/お茶'); assert.equal(cs('食器用洗剤'), '洗剤・掃除/食器'); assert.equal(cs('お風呂用洗剤'), '洗剤・掃除/お風呂');
});
t('優先順位: 製品名の語が素材・味の語に勝つ(〜ジャム/〜ジュース/〜アイス/冷凍〜)', () => {
  assert.equal(cs('ブルーベリージャム'), '食品/朝食・シリアル'); assert.equal(cs('りんごジュース'), '飲料/ジュース・炭酸');
  assert.equal(cs('チョコアイス'), '食品/冷凍食品'); assert.equal(cs('冷凍ブロッコリー'), '食品/冷凍食品'); assert.equal(cs('牛乳プリン'), '食品/お菓子');
  assert.equal(cs('牛乳石鹸'), '美容・ケア/シャンプー・ボディ'); assert.equal(cs('コーヒー牛乳'), '飲料/乳飲料'); assert.equal(cs('ミルクティー'), '飲料/コーヒー・紅茶');
  assert.equal(cs('ｱｲｽｺｰﾋｰ'), '飲料/コーヒー・紅茶'); assert.equal(cs('チューハイ グレープフルーツ'), '飲料/お酒'); assert.equal(cs('缶ビール'), '飲料/お酒'); assert.equal(cs('アサリ水煮缶'), '食品/缶詰・レトルト');
});
t('除外: 1文字語・短い語の暴発を防ぐ(ブリーチ/マッチャ/ナンバー/ペットボトル)', () => {
  assert.equal(g('ブリーチ').category, ''); assert.notEqual(g('抹茶ラテ').sub, '生活雑貨'); assert.equal(g('ナンバー').category, ''); assert.equal(g('水素').category, '');
});
t('大分類だけ確かなら小分類は空(洗剤)', () => { const r = g('洗剤'); assert.equal(r.category, '洗剤・掃除'); assert.equal(r.sub, ''); assert.ok(r.conf >= 0.6); });
t('正規化: 容量・数量・単位を無視する(牛乳 1L / 500ml×24本 / 12ロール / 6枚切り)', () => {
  assert.equal(cs('牛乳 1L'), '飲料/乳飲料'); assert.equal(cs('牛乳1000ml'), cs('牛乳')); assert.equal(cs('水 500ml×24本'), '飲料/水・炭酸水');
  assert.equal(cs('食パン 6枚切り'), '食品/米・パン'); assert.equal(g('500ml×24本').category, ''); assert.equal(g('1L').category, '');
  assert.equal(cleanName('牛乳 1L'), cleanName('牛乳')); assert.equal(cleanName('ティッシュ 5箱×12パック'), cleanName('ティッシュ'));
});
t('正規化: 全角・半角カナ・ひらがな/カタカナ・大文字小文字・記号', () => {
  assert.equal(cs('ｷｬﾍﾞﾂ'), cs('キャベツ')); assert.equal(cs('きゃべつ'), cs('キャベツ')); assert.equal(cs('ＬＥＤ電球'), '日用品/電池・電球'); assert.equal(cs('ｾﾝﾊﾟｲ?'), '/');
  assert.equal(cs('ﾄｲﾚｯﾄﾍﾟｰﾊﾟｰ'), '日用品/ティッシュ・ペーパー'); assert.equal(cs('ﾚﾄﾙﾄ ｶﾚｰ'), '食品/缶詰・レトルト'); assert.equal(cs('お～いお茶'), '飲料/お茶'); assert.equal(cs('ほんだし'), cs('ホンダシ'));
});
t('宣伝文句入りの長い名前(楽天風)', () => {
  assert.equal(cs('【送料無料】 サントリー 天然水 2L×9本 ミネラルウォーター 水 ペットボトル 軟水 ケース販売 まとめ買い'), '飲料/水・炭酸水');
  assert.equal(cs('【ポイント10倍】アタックZERO 洗濯洗剤 液体 詰め替え 超特大 1620g 花王 送料無料'), '洗剤・掃除/洗濯');
  assert.equal(cs('訳あり 国産 じゃがいも 10kg 送料無料 北海道産 野菜'), '食品/野菜・果物');
  assert.equal(cs('【あす楽】 キッコーマン しょうゆ 特選丸大豆 醤油 1L ペットボトル 送料無料'), '食品/調味料・粉');
});
t('PB商品名・ブランド名に含まれる語で誤分類しない(トップバリュ→トップではない)', () => {
  assert.equal(cs('トップバリュ 牛乳'), '飲料/乳飲料'); assert.equal(cs('トップバリュ 食パン'), '食品/米・パン'); assert.equal(cs('みなさまのお墨付き 麦茶'), '飲料/お茶');
});
t('分からない名前・空・変な入力は空で落ちない', () => {
  for (const n of ['謎の品', '', '  ', null, undefined, 0, 123, {}, [], '🍎', '\u0000', 'a'.repeat(5000), '。。。', '／／／']) { const r = g(n); assert.ok(typeof r.category === 'string' && typeof r.sub === 'string' && typeof r.conf === 'number', String(n)); }
  assert.deepEqual(g('謎の品'), { category: '', sub: '', conf: 0 }); assert.equal(guessCategory(undefined), ''); assert.equal(guessClass(undefined).category, '');
});
t('確信度は 0.6〜1(答えるとき)・答えないとき 0。結果を書き換えてもキャッシュは汚れない', () => {
  const r = g('牛乳'); assert.ok(r.conf >= 0.6 && r.conf <= 1); r.category = 'x'; assert.equal(g('牛乳').category, '飲料');
});
t('guessCategory は互換: 旧7分類の文字列を従来どおり返し(parse.js が使う)、canonCategory で新体系に読み替えられる', () => {
  assert.equal(guessCategory('キャベツ'), '食品'); assert.equal(typeof guessCategory('x'), 'string'); assert.equal(guessCategory('謎の品'), '');
  assert.equal(guessCategory('単3電池'), '消耗品'); assert.equal(canonCategory(guessCategory('単3電池')), '日用品'); assert.equal(canonCategory(guessCategory('ロキソニン')), '薬・健康');
  for (const n of ['牛乳', 'シャンプー', 'ティッシュ', '緑茶']) assert.ok([...CATS, ...Object.keys(LEGACY_CATEGORY)].includes(guessCategory(n)), n);
});
t('速度: 1000回の推定が 500ms 以内(キャッシュ無しの別名でも)', () => {
  const t0 = Date.now(); for (let i = 0; i < 1000; i++) g(`商品${i} 牛乳 ${i}個`); assert.ok(Date.now() - t0 < 500, `${Date.now() - t0}ms`);
});

// ---- 置き場所の既定 ----
const NEWLOCS = LOCS;
const loc = (name, extra = {}) => { const r = autoClassify({ name, category: '', location: '', ...extra }, [], { locs: NEWLOCS }); return r.location; };
t('置き場所の既定: 冷凍食品→冷凍庫、乳製品・卵・肉・魚→冷蔵庫、洗剤→置き場所', () => {
  assert.equal(loc('冷凍餃子'), '冷凍庫'); assert.equal(loc('ハーゲンダッツ'), '冷凍庫'); assert.equal(loc('卵 10個入'), '冷蔵庫'); assert.equal(loc('ヨーグルト'), '冷蔵庫'); assert.equal(loc('鶏むね肉'), '冷蔵庫'); assert.equal(loc('牛乳'), '冷蔵庫');
  assert.equal(loc('お米 5kg'), 'パントリー'); assert.equal(loc('食器用洗剤'), 'キッチン'); assert.equal(loc('トイレ用洗剤'), 'トイレ'); assert.equal(loc('お風呂用洗剤'), 'お風呂'); assert.equal(loc('シャンプー'), '洗面所'); assert.equal(loc('歯ブラシ'), '洗面所');
});
t('置き場所の既定: 家ごとに違う物(電池・薬・文具・ティッシュ)は決めない', () => { for (const n of ['単3電池', 'ロキソニン', 'ボールペン', 'ティッシュ', 'トイレットペーパー']) assert.equal(loc(n), '', n); });
t('置き場所: ユーザー指定は上書きしない', () => assert.equal(autoClassify({ name: '牛乳', category: '', location: '玄関' }, [], { locs: NEWLOCS }).location, ''));
t('置き場所: 一覧に無い場所は返さない / 古い一覧なら代替名', () => {
  assert.equal(autoClassify({ name: '牛乳', category: '', location: '' }, [], { locs: ['玄関'] }).location, '');
  assert.equal(autoClassify({ name: '冷凍餃子', category: '', location: '' }, [], { locs: ['キッチン', 'その他'] }).location, 'キッチン');
});

// ---- 古い文字列の移行 ----
t('移行表: 古い大分類は新体系へ(品名から振り分け)、新しい名前・自由文字列はそのまま', () => {
  assert.equal(canonCategory('洗剤・衛生'), '洗剤・掃除'); assert.equal(canonCategory('洗剤・衛生', '美容・ケア'), '美容・ケア'); assert.equal(canonCategory('洗剤・衛生', '飲料'), '洗剤・掃除');
  assert.equal(canonCategory('薬'), '薬・健康'); assert.equal(canonCategory('消耗品'), '日用品'); assert.equal(canonCategory('食品'), '食品'); assert.equal(canonCategory('ガレージ用品'), 'ガレージ用品');
  assert.equal(canonCategory(undefined), ''); assert.equal(canonCategory(null), ''); assert.equal(canonCategory(5), '');
  for (const [, v] of Object.entries(LEGACY_CATEGORY)) for (const c of v) assert.ok(CATS.includes(c), c);
});
t('移行表: 古い置き場所(風呂・トイレ/押入れ)は新体系へ。品名にトイレがあればトイレ', () => {
  assert.equal(canonLocation('風呂・トイレ'), 'お風呂'); assert.equal(canonLocation('風呂・トイレ', 'トイレクリーナー'), 'トイレ'); assert.equal(canonLocation('風呂・トイレ', 'お風呂用洗剤'), 'お風呂');
  assert.equal(canonLocation('押入れ'), '押入れ・収納'); assert.equal(canonLocation('キッチン'), 'キッチン'); assert.equal(canonLocation('2階の納戸'), '2階の納戸'); assert.equal(canonLocation(undefined), '');
  for (const [, v] of Object.entries(LEGACY_LOCATION)) for (const c of v) assert.ok(LOCS.includes(c), c);
});
t('移行表: fitLocation(新→古い一覧への読み替え)', () => {
  assert.equal(fitLocation('冷蔵庫', ['キッチン']), 'キッチン'); assert.equal(fitLocation('トイレ', ['風呂・トイレ']), '風呂・トイレ'); assert.equal(fitLocation('押入れ・収納', ['押入れ']), '押入れ');
  assert.equal(fitLocation('車', ['キッチン']), ''); assert.equal(fitLocation('車', undefined), '車'); assert.equal(fitLocation('', LOCS), '');
});
t('絞り込み: 古い値の品が新しいチップで見つかる(洗剤・衛生→洗剤・掃除/風呂・トイレ→お風呂)', () => {
  assert.ok(matchCategory({ category: '洗剤・衛生', name: 'ハイター' }, '洗剤・掃除')); assert.ok(matchCategory({ category: '洗剤・衛生' }, '洗剤・衛生')); assert.ok(!matchCategory({ category: '食品' }, '飲料')); assert.ok(matchCategory({ category: '食品' }, ''));
  assert.ok(matchLocation({ location: '風呂・トイレ', name: 'カビキラー' }, 'お風呂')); assert.ok(matchLocation({ location: '押入れ' }, '押入れ・収納')); assert.ok(matchLocation({ location: '風呂・トイレ' }, '風呂・トイレ')); assert.ok(!matchLocation({ location: 'キッチン' }, '玄関'));
});
t('catInfo/locInfo/colorOf: 古い値・自由文字列でも壊れない(自由文字列は灰色のタグ)', () => {
  assert.equal(catInfo('薬').name, '薬・健康'); assert.equal(catInfo('薬').color, 'red'); assert.equal(catInfo('ガレージ用品').custom, true); assert.ok(colorOf('ガレージ用品').light.bg); assert.ok(colorOf('').light.bg);
  assert.equal(locInfo('風呂・トイレ', 'トイレ').name, 'トイレ'); assert.equal(locInfo('2階の納戸').custom, true); assert.ok(locInfo('冷蔵庫').icon);
});

// ---- 自由文字列(独自の小分類・置き場所) ----
t('一覧の合成: 既定 + 品目で使われているもの(自由文字列)。既定の順→使用中は多い順、重複なし', () => {
  const items = [{ category: '食品', sub: '手作りパン' }, { category: '食品', sub: '手作りパン' }, { category: '食品', sub: '米・パン' }, { category: '食品', sub: '自家製みそ' }, { category: '飲料', sub: 'ワイン' }, { category: '食品' }, null, {}];
  assert.deepEqual(subOptions('食品', items), [...subsOf('食品'), '手作りパン', '自家製みそ']); assert.deepEqual(subOptions('飲料', items), [...subsOf('飲料'), 'ワイン']);
  assert.deepEqual(subOptions('ペット', []), subsOf('ペット')); assert.deepEqual(subOptions('旅行用品', [{ category: '旅行用品', sub: '変換プラグ' }]), ['変換プラグ']);
  assert.deepEqual(categoryOptions([{ category: 'ガレージ用品' }, { category: '洗剤・衛生' }, { category: '食品' }]), [...CATS, 'ガレージ用品']);
  assert.deepEqual(locationOptions([{ location: '2階の納戸' }, { location: '2階の納戸' }, { location: 'ガレージ' }, { location: '風呂・トイレ', name: 'カビキラー' }, { location: '押入れ' }]), [...LOCS, '2階の納戸', 'ガレージ']);
  assert.deepEqual(locationOptions([]), LOCS); assert.deepEqual(categoryOptions(), CATS);
});
t('一覧の合成: 古い大分類の品の小分類は新しい大分類の一覧に出る / 重複しない', () => {
  const o = subOptions('洗剤・衛生', [{ category: '洗剤・衛生', sub: '洗濯' }]); assert.equal(o.length, new Set(o).size); assert.deepEqual(o, subsOf('洗剤・掃除'));
});
t('classFields: 空の値は含めない(Firestore に undefined / 空文字を入れない)', () => {
  assert.deepEqual(classFields('食品', '米・パン'), { category: '食品', sub: '米・パン' }); assert.deepEqual(classFields('食品', ''), { category: '食品' }); assert.deepEqual(classFields('', undefined), {});
  assert.deepEqual(classFields(' 食品 ', ' 手作り '), { category: '食品', sub: '手作り' }); assert.equal(JSON.stringify(classFields(undefined, null)).includes('undefined'), false); assert.ok(!('sub' in classFields('食品', null)));
});
t('自動分類: 自由な小分類・置き場所を学習し(auto は学習しない)、結果に undefined を含めない', () => {
  const teacher = { id: 'a', name: '自家製味噌', category: '食品', sub: '自家製みそ', location: '床下収納', qty: 1 };
  const r = autoClassify({ name: '自家製味噌 2kg', category: '', location: '' }, [teacher], { locs: [...LOCS, '床下収納'] });
  assert.deepEqual([r.category, r.sub, r.location], ['食品', '自家製みそ', '床下収納']);
  const r2 = autoClassify({ name: '自家製味噌 2kg', category: '', location: '' }, [{ ...teacher, auto: true }], { locs: LOCS }); assert.notEqual(r2.sub, '自家製みそ');
  for (const x of [r, r2, autoClassify({ name: '謎', category: '', location: '' }, [], {})]) assert.equal(JSON.stringify(x).includes('undefined'), false);
  assert.equal(autoClassify({ name: '自家製味噌', category: '', location: '' }, [teacher], { locs: LOCS }).location !== '床下収納', true, 'locs に無い置き場所は返さない');
});

console.log(`${pass} passed, ${fail} failed (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
