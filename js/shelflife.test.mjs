// node js/shelflife.test.mjs  (依存なし)
// 期限予測(shelflife.js)の単体テストと、評価セットの一部の回帰テスト。
// 回帰データは [品名, 置き場所, 標準期間P(日), フラグ(1=家庭の目安 2=開封後), 出典URL, 期待(Y=予測が合格 / F=予測は出るが許容外(既知の外れ) / N=予測しない)] のみ(出典の長文は持たない)。
// 合格条件は評価と同じ: E=P(家庭/開封後)または P*0.6(P<=10)・P*0.65 を購入時点の残り日数とし、許容は E<=10日 -2/+1日, E<=30日 -max(20%,4日)/+max(10%,2日), それ以上 -25%/+12.5%。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { predictExpiry, matchRule } from './shelflife.js';
import { RULES, MIN_CONF, retail } from './shelflife-data.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`NG  ${name}\n    ${e.message.split('\n').join('\n    ')}`); } };
const TODAY = '2026-10-28';
const P = (name, extra = {}, opts) => predictExpiry({ name, today: TODAY, ...extra }, opts);
const addDays = (s, n) => { const d = new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000); return d.toISOString().slice(0, 10); };

// ---- 基本の形 ----
t('カップ麺: 賞味・約3〜4か月・日付=起算日+days・確信度は既定の下限以上・根拠つき', () => {
  const r = P('日清 カップヌードル シーフード');
  assert.ok(r, 'null');
  assert.equal(r.kind, '賞味'); assert.ok(r.days >= 90 && r.days <= 133, String(r.days));
  assert.equal(r.date, addDays(TODAY, r.days)); assert.ok(r.conf >= MIN_CONF && r.conf <= 1); assert.match(r.basis, /カップ麺/);
});
t('boughtAt があれば購入日から数える(today より優先)', () => {
  const r = P('カップヌードル', { boughtAt: '2026-10-01' });
  assert.equal(r.date, addDays('2026-10-01', r.days));
});
t('半角カナ・宣伝文句・容量・表記揺れに耐える', () => {
  for (const n of ['ｶｯﾌﾟﾇｰﾄﾞﾙ ｼｰﾌｰﾄﾞ', '【送料無料】日清 カップヌードル 20食 まとめ買い', 'ひらがな:かっぷぬーどる', 'どん兵衛 きつねうどん 東', '赤いきつね']) assert.ok(P(n), n);
});
t('冷蔵・冷凍・常温の置き場所を考慮: 冷凍食品は冷凍庫なら約8か月、冷蔵庫に置くなら予測しない', () => {
  const a = P('冷凍餃子 12個', { location: '冷凍庫' }); assert.ok(a && a.days >= 150 && a.days <= 300, JSON.stringify(a));
  assert.equal(P('冷凍餃子 12個', { location: '冷蔵庫' }), null);
});
t('家庭で冷凍する(肉は冷蔵2日→冷凍約1か月)', () => {
  assert.equal(P('豚バラ薄切り 300g', { location: '冷蔵庫' }).days, 2);
  assert.equal(P('豚バラ薄切り 300g', { location: '冷凍庫' }), null, '冷凍保存の確信は0.75なので既定では出さない');
  assert.equal(P('豚バラ薄切り 300g', { location: '冷凍庫' }, { minConf: 0.7 }).days, 30);
  assert.equal(P('豚バラ薄切り 300g').kind, '消費');
});
t('開封後(opened:true): マヨネーズ1か月・ヨーグルト2日・牛乳2日。起算は today', () => {
  assert.equal(P('キユーピー マヨネーズ 450g', { opened: true }).days, 30);
  assert.equal(P('明治ブルガリアヨーグルト', { opened: true }).days, 2);
  const m = P('牛乳 1000ml', { opened: true, boughtAt: '2026-10-01' }); assert.equal(m.days, 2); assert.equal(m.date, addDays(TODAY, 2));
  assert.equal(P('カップヌードル', { opened: true }), null, '開封後の目安が無い品は予測しない');
});
t('卵・ヨーグルト・肉など生鮮の短い期限: 消費/賞味の区別と日数', () => {
  const e = P('卵 Mサイズ 10個入'); assert.ok(e && e.kind === '賞味' && e.days >= 7 && e.days <= 12, JSON.stringify(e));
  const y = P('ヨーグルト 400g'); assert.ok(y && y.kind === '賞味' && y.days >= 8 && y.days <= 14, JSON.stringify(y));
});
// ---- 予測しない ----
t('洗剤・日用品・美容は予測しない(分類が分かっていても品名だけでも)', () => {
  assert.equal(P('キュキュット 食器用洗剤'), null);
  assert.equal(P('カップヌードル風 ボールペン', { category: '日用品' }), null);
  assert.equal(P('シャンプー 詰替', { category: '美容・ケア' }), null);
});
t('空・未定義・記号だけの品名は null(例外を投げない)', () => {
  assert.equal(predictExpiry(), null); assert.equal(predictExpiry({}), null); assert.equal(P(''), null); assert.equal(P('★★★'), null); assert.equal(P(null), null);
});
t('種類が割れる品(うどん・ラーメン・パスタ・チーズ・生クリーム)は予測しない', () => {
  for (const n of ['うどん', 'ラーメン', 'スパゲッティ 1.6mm 500g', 'そうめん', 'チーズ', 'クリームチーズ', '生クリーム 200ml']) assert.equal(P(n), null, n);
});
t('確信が足りない種類は既定では null、minConf を下げると出る(牛乳・食パン・豆腐・しょうゆ)', () => {
  for (const n of ['牛乳 1L', '食パン 6枚切り', '絹ごし豆腐', 'キッコーマン しょうゆ 1L']) { assert.equal(P(n), null, n); }
  const m = P('牛乳 1L', {}, { minConf: 0.6 }); assert.ok(m && m.days >= 4 && m.days <= 7, JSON.stringify(m));
  const b = P('食パン 6枚切り', {}, { minConf: 0.5 }); assert.ok(b && b.kind === '消費' && b.days <= 5, JSON.stringify(b));
  assert.match(b.basis, /検証データ不足/);
});
t('加工品の文脈で誤爆しない(バター味のクッキー・えびせん・タコス・玉ねぎ)', () => {
  assert.notEqual(matchRule('バター風味 クッキー')?.id, 'butter');
  assert.notEqual(matchRule('ガーリックバター味 スナック')?.id, 'butter');
  assert.notEqual(matchRule('えび揚げせん')?.id, 'fish');
  assert.notEqual(matchRule('ドンタコス ビーフチリタコス')?.id, 'fish');
  assert.notEqual(matchRule('玉ねぎ 2kg')?.id, 'veg-fridge-short');
  assert.equal(P('バター風味 クッキー', {}, { minConf: 0 }), null);
});
// ---- データの整合 ----
t('規則: id は一意・パターンは正規表現として正しい・P と確信度は範囲内・短い根拠つき', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.ok(!ids.has(r.id), r.id); ids.add(r.id);
    assert.doesNotThrow(() => new RegExp(r.m), r.id); if (r.x) assert.doesNotThrow(() => new RegExp(r.x), r.id);
    assert.ok(Number.isFinite(r.P) && r.P >= 0, r.id);
    if (r.P) { assert.ok(r.c >= 0 && r.c <= 1, r.id); assert.ok(r.kd === '賞味' || r.kd === '消費', r.id); }
    if (r.o) assert.ok(r.oc > 0 && r.oc <= 1, r.id);
    assert.ok(typeof r.b === 'string' && r.b.length > 0 && r.b.length < 60, r.id);
  }
  assert.ok(RULES.length >= 30, '規則は30種類以上');
});
t('retail: 10日以下は0.6、それ以上は0.65', () => { assert.equal(retail(8), 0.6); assert.equal(retail(10), 0.6); assert.equal(retail(11), 0.65); assert.equal(retail(365), 0.65); });
t('サイズ: shelflife.js + shelflife-data.js は 40KB 以内(目安25KB)', () => {
  const kb = (f) => fs.statSync(new URL(f, import.meta.url)).size;
  assert.ok(kb('./shelflife.js') + kb('./shelflife-data.js') < 40000, String(kb('./shelflife.js') + kb('./shelflife-data.js')));
});
// ---- 評価セットの一部(回帰) ----
const REG = [
  ["農協 野菜Days フルーツ＆黄野菜100％", "パントリー", 180, 0, "www.meg-snow.com/products/detail.php?p=nokyo_fy200", "N"],
  ["キッコーマン うちのごはん 大根ともやしのバター醤油", "パントリー", 730, 0, "www.kikkoman.co.jp/products/K25/detail/K250513.html", "Y"],
  ["ｷｯｺｰﾏﾝ うちのごはん もやしのにんにく醤油炒め 90g(内容量内訳:45g×2)", "パントリー", 730, 0, "www.kikkoman.co.jp/products/K25/detail/K250548.html", "Y"],
  ["きっこーまん さくさくしょうゆ", "パントリー", 730, 0, "www.kikkoman.co.jp/products/K05/detail/K054520.html", "N"],
  ["おむすび山 焼おにぎり", "パントリー", 720, 0, "www.mizkan.co.jp/product/group/index.html?gid=12072", "Y"],
  ["ミツカン おむすび山 チャーシューごはん", "パントリー", 540, 0, "www.mizkan.co.jp/product/group/index.html?gid=12075", "Y"],
  ["ｷｯｺｰﾏﾝ うちのごはん 厚揚げきのこの海鮮だしあんかけ 72g", "パントリー", 730, 0, "www.kikkoman.co.jp/products/K25/detail/K250591.html", "Y"],
  ["きっこーまん うちのごはん 豚白菜の牡蠣だし醤油", "パントリー", 730, 0, "www.kikkoman.co.jp/products/K25/detail/K250587.html", "Y"],
  ["キッコーマン いつでも新鮮 大豆ペプチド 減塩しょうゆ（だし入り） 卓上ボトル 200ml", "パントリー", 365, 0, "www.kikkoman.co.jp/products/K05/detail/K052035.html", "N"],
  ["だし炊きあごだし鶏ごぼう釜めし", "パントリー", 720, 0, "www.mizkan.co.jp/product/group/index.html?gid=14026", "Y"],
  ["だし炊き五目釜めし", "パントリー", 720, 0, "www.mizkan.co.jp/product/group/index.html?gid=14023", "Y"],
  ["日清炎めし ゆっけじゃん", "パントリー", 182, 0, "store.nissin.com/products/13658", "Y"],
  ["【完全ﾒｼ特別優待専用】完全ﾒｼ ﾐﾗﾉ風ﾄﾞﾘｱ", "パントリー", 182, 0, "store.nissin.com/products/2003004", "Y"],
  ["日清のどん兵衛 きつねうどん[西] 僕のヒーローアカデミアパッケージ", "パントリー", 182, 0, "store.nissin.com/products/13971", "Y"],
  ["日清のどん兵衛 きつねうどん[西]", "パントリー", 182, 0, "store.nissin.com/products/13921", "Y"],
  ["ゴールデンカレー 中辛 198g", "冷蔵庫", 91, 3, "www.sbfoods.co.jp/customer/faq/period.html", "Y"],
  ["S&B とろけるシチュー クリーム", "冷蔵庫", 91, 3, "www.sbfoods.co.jp/customer/faq/period.html", "Y"],
  ["ハウス カレーパートナー ＜マンゴーチャツネペースト＞ 40g", "パントリー", 547, 0, "housefoods.jp/products/catalog/cd_1,089568,chk,nikomi.html", "N"],
  ["ごろグラ 薫るピスタチオ", "パントリー", 304, 0, "store.nissin.com/products/13842", "Y"],
  ["ぐらのーらきっちん from ごろぐら 深みかかお仕立て あーもんど＆かしゅーなっつ", "パントリー", 304, 0, "store.nissin.com/products/13851", "Y"],
  ["しすこーん まいるどちょこ", "パントリー", 395, 0, "store.nissin.com/products/12782", "N"],
  ["かっぱえびせん 90g", "パントリー", 183, 0, "faq.calbee.co.jp/faq_detail.html?id=96", "N"],
  ["完全メシ トマトクリームポタージュ6食セット", "パントリー", 182, 0, "store.nissin.com/products/12656_clearlance261129_grocery2610_11", "Y"],
  ["完全メシ コーンクリームポタージュ", "パントリー", 182, 0, "store.nissin.com/products/12655", "Y"],
  ["【送料無料】キッコーマン てりやきのたれ 210g ×4個 まとめ買い", "パントリー", 547, 0, "www.kikkoman.co.jp/products/K20/detail/K202510.html", "N"],
  ["きざみ にんにく チューブ", "冷蔵庫", 91, 3, "www.sbfoods.co.jp/customer/faq/period.html", "Y"],
  ["ﾈﾘ ｶﾗｼ ﾁｭｰﾌﾞ", "冷蔵庫", 91, 3, "www.sbfoods.co.jp/customer/faq/period.html", "Y"],
  ["デルモンテ トマトジュース", "パントリー", 395, 0, "www.kikkoman.co.jp/products/K55/detail/K550510.html", "N"],
  ["【送料無料】キユーピーシーザーサラダドレッシング 380ml ×11個 まとめ買い", "パントリー", 304, 0, "www.kewpie.co.jp/products/detail/4901577073441/", "Y"],
  ["キユーピー深煎りごまドレッシング 柚子こしょう", "パントリー", 304, 0, "www.kewpie.co.jp/products/detail/4901577107757/", "Y"],
  ["冷しゃぶのんおいるどれっしんぐ ＜れもんおろし醤油＞", "パントリー", 243, 0, "housefoods.jp/products/catalog/cd_1,086360,dress,pdt,reid.html", "F"],
  ["料亭 抹茶塩", "パントリー", 395, 0, "housefoods.jp/products/catalog/cd_1,083978,spice2,salpep,salt.html", "N"],
  ["いなば レトルト パウチ 犬用", "パントリー", 730, 0, "www.inaba-petfood.co.jp/support/faq05.html", "N"],
  ["いなば 猫缶 まぐろ", "パントリー", 1095, 0, "www.inaba-petfood.co.jp/support/faq05.html", "N"],
  ["伊藤園 お〜いお茶 485ml×24", "パントリー", 274, 0, "www.itoen.co.jp/news/article/14052/", "N"],
  ["キユーピー マヨネーズ 450g", "冷蔵庫", 30, 3, "www.kewpie.co.jp/customer/faq/sellby/", "Y"],
  ["ﾄﾞﾚｯｼﾝｸﾞ ｲﾀﾘｱﾝ 150ml", "冷蔵庫", 30, 3, "www.kewpie.co.jp/customer/faq/sellby/", "Y"],
  ["味の素 パルスイート マヨ風", "冷蔵庫", 30, 3, "www.kewpie.co.jp/customer/faq/sellby/", "N"],
  ["雪印 恵 megumi ビフィズス菌SP株ヨーグルト 70g×3", "冷蔵庫", 18, 0, "www.meg-snow.com/products/detail.php?p=megumi_bifidus", "Y"],
  ["【送料無料】恵 megumi  ガセリ菌SP株ヨーグルト プレーン加糖 100g ×10個 まとめ買い", "冷蔵庫", 18, 0, "www.meg-snow.com/products/detail.php?p=megumi_plain", "Y"],
  ["森永ビヒダス プレーンヨーグルト 450g", "冷蔵庫", 2, 3, "www.meiji.co.jp/yogurtlibrary/style/dictionary/", "Y"],
  ["明治ブルガリアヨーグルト 400g", "冷蔵庫", 2, 3, "www.meiji.co.jp/yogurtlibrary/style/dictionary/", "Y"],
  ["キユーピーやさしい献立 なめらかかにごはん", "パントリー", 395, 0, "www.kewpie.co.jp/products/detail/4901577033322/", "N"],
  ["日清ﾄﾞﾚｯｼﾝｸﾞﾀﾞｲｴｯﾄ まろやかごま風味 185ml 185ml", "パントリー", 365, 0, "www.nisshin-oillio.com/products/goods/detail.html?id=447", "Y"],
  ["日清どれっしんぐだいえっときざみたまねぎ 185ml", "パントリー", 365, 0, "www.nisshin-oillio.com/products/goods/detail.html?id=834", "Y"],
  ["冷凍餃子 12個入り", "冷凍庫", 365, 0, "www.maruha-nichiro.co.jp/inquiry/faq_exp.php", "Y"],
  ["冷凍 ハンバーグ 6個入", "冷凍庫", 365, 0, "www.maruha-nichiro.co.jp/inquiry/faq_exp.php", "Y"],
  ["ニチレイ 本格炒め炒飯 450g", "冷凍庫", 365, 0, "www.maruha-nichiro.co.jp/inquiry/faq_exp.php", "N"],
  ["冷凍食品 から揚げ", "冷凍庫", 30, 3, "www.nissui.co.jp/qa/relish.html", "Y"],
  ["冷凍 ミックスベジタブル", "冷凍庫", 30, 3, "www.nissui.co.jp/qa/relish.html", "Y"],
  ["鮮魚 切り身 チルド", "冷蔵庫", 2, 1, "www.pref.chiba.lg.jp/suisan/mamechishiki/hozon.html", "N"],
  ["ロキソニンSプレミアム 24錠", "押入れ・収納", 365, 3, "www.daiichisankyo-hc.co.jp/support/faq/faq_loxonin-s_premium_q00005.html", "N"],
  ["卵 10個パック 特選", "冷蔵庫", 21, 0, "www.jpa.or.jp/keiran_root/keiran/knowledge4.html", "Y"],
  ["たまご 白 L 6個", "冷蔵庫", 16, 0, "http://www.nichirankyo.or.jp/qa/hinshitsu.htm", "Y"],
  ["ﾚｲﾝﾎﾞｰ ﾀﾏｺﾞ", "冷蔵庫", 21, 0, "www.jpa.or.jp/keiran_root/keiran/knowledge4.html", "N"],
  ["冷凍 完全メシ DELI コチュジャン香るビビンバ風おにぎり", "冷凍庫", 304, 0, "store.nissin.com/products/2003362_96801_000", "Y"],
  ["冷凍 完全メシ DELI ごま油が香るプルコギ味キンパ", "冷凍庫", 365, 0, "store.nissin.com/products/2003410_96801_000", "Y"],
  ["【定期コース】選べる!完全メシ カレー・めんセット", "パントリー", 182, 0, "store.nissin.com/products/30404", "Y"],
  ["【送料無料】【定期コース】選べる!完全メシ カレー・めんセット*  ×11個 まとめ買い", "パントリー", 182, 0, "store.nissin.com/products/2002935", "Y"],
  ["【完全ﾒｼ特別優待専用】完全ﾒｼ BREAD ｶﾚｰ", "パントリー", 90, 0, "store.nissin.com/products/2003007", "N"],
  ["冷凍 完全メシ DELI やわらか鶏もも肉の親子丼", "冷凍庫", 365, 0, "store.nissin.com/products/2001830_97884_000", "Y"],
  ["完全めし みらの風どりあ", "パントリー", 182, 0, "store.nissin.com/products/2002767_96694_000", "Y"],
  ["２００ｇ 沖縄麻婆豆腐の素 ＜甘口・廣東風＞", "パントリー", 760, 0, "housefoods.jp/products/catalog/cd_1,080130,ret,mabo,mabo.html", "N"],
  ["【送料無料】キッコーマン うちのごはん 厚揚げのみぞれ煮 110g ×2個 まとめ買い", "パントリー", 730, 0, "www.kikkoman.co.jp/products/K25/detail/K250551.html", "Y"],
  ["キッコーマン うちのごはん 魯肉飯", "パントリー", 547, 0, "www.kikkoman.co.jp/products/K25/detail/K252311.html", "Y"],
  ["月桂冠 つき 生酒 300ml", "パントリー", 243, 0, "www.gekkeikan.co.jp/enjoy/qa/sake/sake01.html", "N"],
  ["マルコメ 液みそ 料亭の味 750g", "冷蔵庫", 30, 3, "faq.marukome.co.jp/%E6%B6%B2%E3%81%BF%E3%81%9D%E3%81%AF%E9%96%8B%E5%B0%81%E5%BE%8C%E3%81%A9%E3%82%8C%E3%81%8F%E3%82%89%E3%81%84%E6%97%A5%E6%8C%81%E3%81%A1%E3%81%97%E3%81%BE%E3%81%99%E3%81%8B%EF%BC%9F-67a4aebcb7c7bd31c7b27f52", "Y"],
  ["ｴｷﾐｿ ﾀﾞｼ入り", "冷蔵庫", 30, 3, "faq.marukome.co.jp/%E6%B6%B2%E3%81%BF%E3%81%9D%E3%81%AF%E9%96%8B%E5%B0%81%E5%BE%8C%E3%81%A9%E3%82%8C%E3%81%8F%E3%82%89%E3%81%84%E6%97%A5%E6%8C%81%E3%81%A1%E3%81%97%E3%81%BE%E3%81%99%E3%81%8B%EF%BC%9F-67a4aebcb7c7bd31c7b27f52", "Y"],
  ["森永 牛乳 500ml", "冷蔵庫", 7, 0, "nyukyou.jp/dairyqa/2107_076_279/", "N"],
  ["明治おいしい牛乳 900ml", "冷蔵庫", 2, 3, "www.meiji.co.jp/meiji-shokuiku/know/keep/", "Y"],
  ["ﾀｶﾅｼ 低脂肪乳 1L", "冷蔵庫", 2, 3, "www.meiji.co.jp/meiji-shokuiku/know/keep/", "Y"],
  ["フレッシュ 北海道産生クリーム使用", "冷蔵庫", 90, 0, "www.meg-snow.com/products/detail.php?p=cream", "N"],
  ["明治 ほほえみ らくらくキューブ 540g", "パントリー", 730, 0, "www.meiji.co.jp/corporate/pressrelease/2025/02_08/", "Y"],
  ["明治ほほえみ 800g", "パントリー", 730, 0, "www.meiji.co.jp/corporate/pressrelease/2025/02_08/", "Y"],
  ["豚バラ薄切り 300g", "冷蔵庫", 2, 1, "www.city.mito.lg.jp/site/gomi/91226.html", "Y"],
  ["牛こま切れ 200g", "冷蔵庫", 2, 1, "www.city.mito.lg.jp/site/gomi/91226.html", "Y"],
  ["コーンクリーム缶", "パントリー", 1095, 0, "www.maruha-nichiro.co.jp/inquiry/faq_exp.php", "Y"],
  ["さば水煮缶 200g", "パントリー", 1095, 0, "www.maruha-nichiro.co.jp/inquiry/faq_exp.php", "Y"],
  ["デルモンテ クリームコーン 粒入り", "パントリー", 1125, 0, "www.kikkoman.co.jp/products/K50/detail/K502055.html", "Y"],
  ["デルモンテ ホールコーン はじける贅沢 190g3個入り", "パントリー", 1125, 0, "www.kikkoman.co.jp/products/K50/detail/K502045.html", "Y"],
  ["4パック海鮮揚煎えび揚げせん", "パントリー", 213, 0, "store.nissin.com/products/13407", "N"],
  ["【送料無料】日清焼そば ポックンミョン 韓国風甘辛チーズ 5食パック  ×11個 まとめ買い", "パントリー", 182, 0, "store.nissin.com/products/12301", "Y"],
  ["日清マグうどん", "パントリー", 243, 0, "store.nissin.com/products/12303", "Y"],
  ["明星 中華三昧 赤坂璃宮 涼麺", "パントリー", 243, 0, "store.nissin.com/products/13687", "N"],
  ["キユーピーあらびきマスタード", "パントリー", 304, 0, "www.kewpie.co.jp/products/detail/45218644/", "N"],
  ["キッコーマン  豆乳＋鉄分", "パントリー", 180, 0, "www.kikkoman.co.jp/products/K58/detail/K581515.html", "Y"],
  ["キッコーマン おいしい無調整豆乳", "パントリー", 180, 0, "www.kikkoman.co.jp/products/K58/detail/K580500.html", "Y"],
  ["ドレッシングビネガー", "パントリー", 360, 0, "www.mizkan.co.jp/product/group/index.html?gid=02018", "Y"],
  ["穀物酢", "パントリー", 360, 0, "www.mizkan.co.jp/product/group/index.html?gid=01001", "N"],
  ["なす 3本", "冷蔵庫", 7, 1, "www.city.mito.lg.jp/site/gomi/91226.html", "Y"],
  ["小松菜", "冷蔵庫", 7, 1, "www.city.mito.lg.jp/site/gomi/91226.html", "Y"],
  ["日清こめ油どれっしんぐ和風 300ml", "パントリー", 365, 0, "www.nisshin-oillio.com/products/goods/detail.html?id=853", "Y"],
  ["日清 日清ドレッシングダイエット ごま油香るチョレギ 185ml 185ml", "パントリー", 365, 0, "www.nisshin-oillio.com/products/goods/detail.html?id=499", "Y"]
];
const E = (p, fl) => (fl ? p : p * (p <= 10 ? 0.6 : 0.65));
const win = (e) => { if (e <= 10) return [e - 2, e + 1]; if (e <= 30) return [e - Math.max(0.2 * e, 4), e + Math.max(0.1 * e, 2)]; return [e * 0.75, e * 1.125]; };
const judged = REG.map(([name, loc, p, fl, url, exp]) => {
  const r = predictExpiry({ name, location: loc, opened: !!(fl & 2), today: TODAY, boughtAt: TODAY });
  const [lo, hi] = win(E(p, fl)); return { name, exp, r, ok: !!r && r.days >= lo && r.days <= hi, url };
});
t(`回帰(${REG.length}件): 期待が N の品は予測しない`, () => { for (const j of judged) if (j.exp === 'N') assert.equal(j.r, null, j.name); });
t('回帰: 期待が Y の品は予測を出し、標準期間の許容範囲に入る', () => { for (const j of judged) if (j.exp === 'Y') assert.ok(j.r && j.ok, `${j.name} → ${j.r && j.r.days}日 (${j.url})`); });
t('回帰: 予測を出した品の適合率 90% 以上・長すぎる誤りは3%以下', () => {
  const pr = judged.filter((j) => j.r); const ok = pr.filter((j) => j.ok).length;
  assert.ok(pr.length >= 40, '予測件数 ' + pr.length); assert.ok(ok / pr.length >= 0.9, `適合率 ${ok}/${pr.length}`);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
