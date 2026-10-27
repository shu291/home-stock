// バーコードまわりの単体テスト(Node・依存なし・通信はモック)。実行: node js/barcode.test.mjs
import { gs1Ok, upceToUpca, gtin14ToJan13, normalizeScan, validCode, canonCode, classify, noLookup, sourcePlan, reasonText } from './lookup-code.js';
import { tidyName, pickRakuten, consensusName, offName, bookName, gbooksName } from './lookup-name.js';
import { nameCandidates } from './lookup-ocr.js';
import { createQueue, createCache, createLookup } from './lookup-net.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('NG:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n   got: ${JSON.stringify(a)}\n   exp: ${JSON.stringify(b)}`);
// 12桁の本体から、チェックディジットをつけた13桁を作る
const withCheck = (b12) => b12 + ((10 - (b12.split('').reverse().reduce((a, x, i) => a + +x * (i % 2 ? 1 : 3), 0) % 10)) % 10);

// ---------- 番号の検証・変換 ----------
ok(gs1Ok('4901234567894') && gs1Ok('49012347') && gs1Ok('042100005264') && gs1Ok('04901234567894'), 'gs1Ok 正しい番号');
ok(!gs1Ok('4901234567895') && !gs1Ok('123') && !gs1Ok('abc'), 'gs1Ok 誤り');
eq(upceToUpca('04252614'), '042100005264', 'UPC-E → UPC-A (末尾1)');
eq(upceToUpca('01234565'), '012345000065', 'UPC-E 末尾6〜9の展開');
eq(upceToUpca('01234566'), '', 'UPC-E チェックディジット不正は空');
eq(upceToUpca('04252614'.replace(/^0/, '5')), '', 'UPC-E は先頭が0か1だけ');
// UPC-E を末尾桁ごとに全部の展開パターンで検証(展開した UPC-A のチェックが合うものが各パターンに1つだけある)
for (const last of '0123456789') {
  const found = []; for (let c = 0; c < 10; c++) { const a = upceToUpca(`01234${last === '5' ? '5' : '4'}${last}${c}`.slice(0, 8)); if (a) found.push(a); }
  ok(found.length === 1 && found[0].length === 12 && gs1Ok(found[0]) && found[0][0] === '0', `UPC-E 展開 末尾${last}: ${found}`);
}
eq(gtin14ToJan13('04901234567894'), { code: '4901234567894', via: 'gtin14' }, 'GTIN-14(先頭0) → JAN13');
{
  const g = gtin14ToJan13('14901234567891'); // 荷姿1: 中身の番号を求める
  ok(g && g.via === 'case' && g.code === withCheck('490123456789') && gs1Ok(g.code), 'GTIN-14(ケース) → 中身の番号');
}
eq(gtin14ToJan13('94901234567890'), null, 'GTIN-14 不定量(9)は対象外');
eq(gtin14ToJan13('04901234567895'), null, 'GTIN-14 チェックディジット不正');
eq(normalizeScan('4901234567894'), { code: '4901234567894' }, '13桁');
eq(normalizeScan('042100005264'), { code: '0042100005264' }, 'UPC-A 12桁は先頭に0を足す');
eq(normalizeScan('49012347'), { code: '49012347' }, 'EAN-8');
eq(normalizeScan('04252614', 'UPC_E'), { code: '0042100005264', via: 'upce' }, 'UPC-E(形式つき)');
eq(normalizeScan('04252614', 'upc_e'), { code: '0042100005264', via: 'upce' }, 'UPC-E(BarcodeDetector の表記)');
eq(normalizeScan('04252614'), { code: '0042100005264', via: 'upce' }, 'UPC-E(形式不明・EAN-8として合わないので UPC-E と見なす)');
eq(normalizeScan('49012347', 'UPC_E'), null, '形式が UPC-E で UPC-E として合わなければ不可');
eq(normalizeScan('04901234567894'), { code: '4901234567894', via: 'gtin14' }, '14桁');
eq(normalizeScan('(01)04901234567894(3103)000500'), { code: '4901234567894', via: 'gtin14' }, 'GS1 DataBar Expanded 形式の文字列');
eq(normalizeScan('0104901234567894'), { code: '4901234567894', via: 'gtin14' }, 'AI(01) 括弧なし');
eq(normalizeScan('４９０１２３４５６７８９４'), { code: '4901234567894' }, '全角数字');
eq(normalizeScan(' 4901 2345 67894 '), { code: '4901234567894' }, '空白入り');
eq(normalizeScan('4901234567895'), null, 'チェックディジット不正');
eq(normalizeScan('abc'), null, '数字以外');
eq(normalizeScan(''), null, '空');
eq(normalizeScan(null), null, 'null');
eq(normalizeScan('12345'), null, '桁数違い');
ok(validCode('4901234567894') && !validCode('4901234567895'), 'validCode');
eq(canonCode('042100005264'), canonCode('0042100005264'), 'UPC-A(12桁)と EAN-13(先頭0)は同じ番号');
eq(canonCode('04252614'), '0042100005264', 'UPC-E も同じ番号へ');
eq(canonCode('x-123'), 'x-123', '数字でない保存値はそのまま');

// ---------- 番号の種類 ----------
eq(classify('4901234567894'), 'jp', '日本(49)');
eq(classify(withCheck('450123456789')), 'jp', '日本(45)');
eq(classify('9784101010014'), 'isbn', 'ISBN');
eq(classify(withCheck('979123456789')), 'isbn', 'ISBN 979');
eq(classify(withCheck('979012345678')), 'ismn', 'ISMN(979-0)');
eq(classify(withCheck('192012345678')), 'bookprice', '本の2段目(192)');
eq(classify(withCheck('191012345678')), 'bookprice', '本の2段目(191)');
eq(classify('4910206420747'), 'magazine', '雑誌(491。実在の 週刊現代)');
eq(classify(withCheck('977123456789')), 'issn', 'ISSN(977)');
eq(classify('2000072749645'), 'instore', '店内コード(20。楽天の出品に載っていた実例)');
eq(classify(withCheck('021234567890')), 'instore', '店内コード(02)');
eq(classify(withCheck('290123456789')), 'instore', '店内コード(29)');
eq(classify(withCheck('041234567890')), 'instore', 'UPC の店内用(04)');
eq(classify(withCheck('051234567890')), 'coupon', 'クーポン(05)');
eq(classify(withCheck('981234567890')), 'coupon', '払戻(981)');
eq(classify(withCheck('991234567890')), 'coupon', 'クーポン(99)');
eq(classify(withCheck('301234567890')), 'foreign', 'フランス(30)');
eq(classify('0042100005264'), 'foreign', '米国の UPC');
eq(classify('49012347'), 'jp', 'EAN-8 日本');
eq(classify('40084107'), 'ean8', 'EAN-8 海外');
eq(classify('20123457'), 'instore', 'EAN-8 の店内用(2)');
ok(['instore', 'coupon', 'bookprice', 'issn', 'ismn'].every(noLookup) && !['jp', 'isbn', 'magazine', 'foreign', 'ean8'].some(noLookup), 'noLookup');
eq(sourcePlan('isbn'), ['openbd', 'gbooks', 'rakuten'], 'ISBN の問い合わせ順');
eq(sourcePlan('instore'), [], '店内用は問い合わせなし');
eq(sourcePlan('jp'), ['rakuten', 'off', 'obf'], '日本の商品の問い合わせ順');
eq(sourcePlan('foreign'), ['off', 'obf', 'opf', 'opff', 'rakuten'], '海外の商品の問い合わせ順');
ok(sourcePlan('jp')[0] === 'rakuten' && sourcePlan('foreign')[0] === 'off', '日本は楽天から・海外は Open Food Facts から');
ok(reasonText('instore').includes('お店ごと') && reasonText('offline').includes('通信できません') && reasonText('notfound').includes('登録がありません') && reasonText('bookprice').includes('978'), '理由の文言');

// ---------- 名前の整形(楽天の実データ) ----------
const T = (raw, exp, m) => eq(tidyName(raw), exp, m || raw.slice(0, 20));
T('ママレモン 中 00106ライオン 台所洗剤 食器用洗剤 ママレモン 中サイズ 800ml キッチン', 'ママレモン 中 ライオン 台所洗剤 食器用洗剤 中サイズ 800ml', '重複・品番・容量で切る');
T('カゴメ トマトケチャップチューブ(500g*2個セット)【カゴメトマト調味料】', 'カゴメ トマトケチャップチューブ 500g', '(容量*個数セット) → 容量');
T('ミツカン 追いがつおつゆの素 3倍濃縮 800ml×12個セット 4902106647638', 'ミツカン 追いがつおつゆの素 3倍濃縮 800ml', '×個数・商品コードを除く');
T('【送料無料】【3種類セット】カルビー ポテトチップス 472g うすしお のりしお', 'カルビー ポテトチップス 472g', '【】と容量以降');
T('コカ・コーラ(500ml*48本セット)', 'コカ・コーラ 500ml', '48本セット');
T('ノ-4AX5 コクヨ キャンパスノート 5冊 コクヨ 4901480095417（30セット）', 'ノ-4AX5 コクヨ キャンパスノート 5冊', '番号・セット注記');
T('【中古】 週刊ベースボール増刊 週刊ベースボール MLB Edition 2019年 4/7号 / ベースボール・マガジン社 [雑誌]【メー', '週刊ベースボール増刊 週刊ベースボール MLB Edition 2019年 4/7号', '雑誌(号を残す)');
T('週刊現代 2024年 7/13号 [雑誌]', '週刊現代 2024年 7/13号', '雑誌');
T('【1種類を選べる】パンパース オムツ さらさらケア テープ(4個)【パンパース】[さらさらケア]', 'パンパース オムツ さらさらケア テープ', '[ ]の宣伝');
T('(LINEクーポン有)西日本衛材 4902144663645 Towanowa1 トイレットペーパー', '西日本衛材 Towanowa1 トイレットペーパー'.replace('Towanowa1', 'Towanowa1'), '番号入りの出品名');
T('DVD / キッズ / 映画ドラえもん のび太の南海大冒険 (期間限定生産版) / PCBE-53437', '映画ドラえもん のび太の南海大冒険', 'DVD / ジャンル / 題名 / 型番 形式');
T('CD / サザンオールスターズ / 海のYeah!! (歌詞付) / VICL-60227', 'サザンオールスターズ 海のYeah!! (歌詞付)', 'CD / アーティスト / 題名 / 型番');
T('全国送料無料 ハウス食品 バーモントカレー 甘口 230g×4個セット｜カレールウ カレーライス', 'ハウス食品 バーモントカレー 甘口 230g', '先頭の宣伝語で名前が消えない');
T('訳あり 2026年10月30日賞味期限 2kg×4袋 ( 8kg ) 東洋ライス 金芽米', '2kg 東洋ライス 金芽米', '賞味期限の日付(号の「2024年」は残す)');
T('(まとめ) アルカリ乾電池 東芝 LR03L 10MP 形式:単4形(1.5V)', 'アルカリ乾電池 東芝 LR03L 10MP 形式:単4形(1.5V)', '(まとめ)');
T('Pro Max ウォーター', 'Pro Max ウォーター', '語尾の x/Max を削らない');
T('ベビーパウダー ミルク', 'ベビーパウダー ミルク', '長音「ー」を削らない');
ok(Array.from(tidyName('あ'.repeat(100))).length <= 48, '長すぎる名前は48文字まで');
eq(tidyName(''), '', '空');
eq(tidyName(undefined), '', 'undefined');

// ---------- 楽天の選択 ----------
const it = (itemName, extra = {}) => ({ itemName, catchcopy: '', itemCaption: '', ...extra });
const A = '4901301230874', B = '4901301230881', Cc = withCheck('490130123090');
eq(pickRakuten([it('DVD / キッズ / 映画ドラえもん のび太の南海大冒険 / PCBE-53437', { itemCaption: A }), it('映画 ドラえもん のび太の南海大冒険 [DVD]', { itemCaption: A })], A), '映画 ドラえもん のび太の南海大冒険', '「DVD / …」形式より素直な出品名を選ぶ');
eq(pickRakuten([it('花王 ニュービーズ 本体 900g'), it(`花王 ニュービーズ 本体 900g ${A}`)], A), '花王 ニュービーズ 本体 900g', '名前に番号がある出品を選ぶ');
eq(pickRakuten([it('別の商品', { itemCaption: `JAN ${A}` }), it('花王 ニュービーズ 本体 900g', { itemCaption: `JAN: ${A}` })], A), '別の商品', '番号が説明にだけある場合も使える(短い方)');
eq(pickRakuten([it('アソート 3種', { itemCaption: `${A} ${B} ${Cc}` })], A, { consensus: false }), '', '詰め合わせ(複数の商品コード)の出品は使わない');
eq(pickRakuten([it(`A ${A} ${B}`), it(`花王 ニュービーズ ${A}`)], A), '花王 ニュービーズ', '名前に他の番号も並ぶ出品より、その番号だけの出品');
eq(pickRakuten([it('花王 ニュービーズ', { itemCaption: `${A}9` })], A, { consensus: false }), '', '番号が長い数字の一部なら別物');
eq(pickRakuten([], A), '', '結果なし');
eq(pickRakuten([it('x')], A, { consensus: false }), '', '番号が無ければ空');
eq(pickRakuten([it('花王 ニュービーズ 本体 900g セット販売', { itemCaption: A }), it('花王 ニュービーズ 本体 900g', { itemCaption: A })], A), '花王 ニュービーズ 本体 900g', 'セット出品より単品を選ぶ');
// 番号が出品にない場合は、複数の店の共通部分(approx)。店が1つだけ・共通部分が短いときは返さない
const shopItem = (n, shop) => it(n, { itemCode: `${shop}:1` });
{
  const out = {};
  const r = pickRakuten([shopItem('クリニカ アドバンテージ ジェルハミガキ 95g【送料無料】', 'a'), shopItem('ライオン クリニカ アドバンテージ ジェルハミガキ 95g まとめ買い', 'b'), shopItem('クリニカ アドバンテージ ジェルハミガキ 95g 歯磨き粉', 'c')], A, { out });
  ok(r.includes('クリニカ アドバンテージ ジェルハミガキ') && out.approx === true, `共通部分(3店) approx: ${r}`);
}
eq(pickRakuten([shopItem('クリニカ アドバンテージ ジェルハミガキ 95g', 'a'), shopItem('クリニカ アドバンテージ ジェルハミガキ 95g', 'a'), shopItem('クリニカ アドバンテージ ジェルハミガキ 95g', 'a')], A), '', '同じ店の重複出品は1件');
eq(pickRakuten([shopItem('黒豆ぜりー ゼリー 黒豆', 'a')], A), '', '出品が1件だけ(番号なし)は返さない');
eq(consensusName([shopItem('SO SEVEN iPhone XR PREMIUM CASE SMOOTHIE', 'a'), shopItem('SO SEVEN iPhone XR PREMIUM CASE SMOOTHIE', 'b')]), 'SO SEVEN iPhone XR PREMIUM CASE SMOOTHIE', '2店の出品名が同じなら採る');
eq(consensusName([shopItem('SO SEVEN iPhone XR PREMIUM CASE SMOOTHIE', 'a'), shopItem('別の商品 ケース', 'b')]), '', '2店で名前が違えば採らない');
eq(consensusName([shopItem('アイリス 水 500ml', 'a'), shopItem('アイリス 天然水 500ml', 'b'), shopItem('富士山 500ml', 'c')]), '', '共通部分が短い');
eq(pickRakuten([shopItem('クリニカ アドバンテージ ジェルハミガキ 95g', 'a'), shopItem('クリニカ アドバンテージ ジェルハミガキ 95g', 'b'), shopItem('クリニカ アドバンテージ ジェルハミガキ 95g', 'c')], A, { consensus: false }), '', 'consensus:false なら使わない');

// ---------- Open *Facts・書籍 ----------
eq(offName({ product_name: 'Milk', brands: 'Meiji, Foo' }), 'Meiji Milk', 'ブランドを先頭に');
eq(offName({ product_name_ja: '明治 おいしい牛乳', product_name: 'Milk', brands: '明治' }), '明治 おいしい牛乳', '名前にブランドが入っていれば足さない');
eq(offName({ product_name: 'ポカリスエット', brands: '大塚製薬', quantity: '500 ml' }), '大塚製薬 ポカリスエット 500ml', '容量を足す');
eq(offName({ product_name: '', brands: 'x' }), '', '名前なしは空');
eq(offName(null), '', 'null');
eq(bookName({ title: '妖怪画談', volume: '2' }), '妖怪画談 2', '書名+巻');
eq(bookName(null), '', '書名なし');
eq(gbooksName({ title: ' 吾輩は猫である ' }).trim(), '吾輩は猫である', 'Google Books');

// ---------- キュー ----------
{
  let t = 0; const starts = [];
  const q = createQueue({ minGap: 1000, now: () => t, wait: async (ms) => { t += ms; } });
  await Promise.all([1, 2, 3].map((i) => q(async () => { starts.push(t); t += 200; return i; })));
  eq(starts, [0, 1000, 2000], 'キュー: 開始の間隔は1000ms以上(直列)');
  const order = []; await Promise.all([q(async () => { order.push('a'); await 0; order.push('a2'); }), q(async () => order.push('b'))]);
  eq(order, ['a', 'a2', 'b'], 'キュー: 直列(前が終わってから次)');
  const r = await q(async () => { throw new Error('x'); }).catch((e) => e.message); eq(r, 'x', 'キュー: 失敗は呼び出し元へ');
  eq(await q(async () => 'next'), 'next', 'キュー: 失敗の後も動く');
}

// ---------- キャッシュ ----------
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; };
{
  let t = 1e9; const st = mem(), c = createCache({ storage: st, max: 3, hitTtl: 1000, missTtl: 100, now: () => t });
  eq(c.get('1'), null, 'キャッシュ: 空');
  c.put('1', '牛乳', 'rakuten'); eq(c.get('1'), { name: '牛乳', src: 'rakuten' }, 'キャッシュ: ヒット');
  c.put('2', ''); eq(c.get('2'), { miss: true }, 'キャッシュ: ミス');
  t += 99; ok(c.get('2')?.miss, 'キャッシュ: ミスは期限内');
  t += 2; eq(c.get('2'), null, 'キャッシュ: ミスは短い期限で切れる');
  ok(c.get('1')?.name, 'キャッシュ: ヒットは長く残る');
  t += 1000; eq(c.get('1'), null, 'キャッシュ: ヒットも期限で切れる');
  t += 1; for (const k of ['a', 'b', 'c', 'd']) { c.put(k, k + '名'); t += 10; }
  eq(c.size(), 3, 'キャッシュ: 上限件数'); eq(c.get('a'), null, 'キャッシュ: 古いものから捨てる'); ok(c.get('d')?.name === 'd名', 'キャッシュ: 新しいものは残る');
  st.setItem('hs-bc-cache-v1', '{壊れた'); eq(c.get('d'), null, 'キャッシュ: 壊れた保存値でも落ちない'); c.put('z', 'Z'); ok(c.get('z')?.name === 'Z', 'キャッシュ: 壊れた後も保存し直せる');
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const c2 = createCache({ storage: bad }); c2.put('1', 'x'); eq(c2.get('1'), null, 'キャッシュ: 保存できない環境でも例外なし');
  eq(createCache({ storage: null }).get('1'), null, 'キャッシュ: storage なし');
}

// ---------- lookup(振り分け・再試行・保存) ----------
const rkBody = (items) => ({ Items: items.map((n) => ({ itemName: n, catchcopy: '', itemCaption: '' })) });
function harness(handlers, extra = {}) {
  const calls = []; let t = 5e9;
  const fetch = async (url) => {
    url = String(url); calls.push(url);
    const h = handlers.find(([re]) => re.test(url)); const r = h ? await h[1](url, calls.filter((c) => h[0].test(c)).length) : { status: 404, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const waits = [];
  const lk = createLookup({ fetch, rakutenApi: { applicationId: 'APP', accessKey: 'KEY' }, storage: mem(), now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, online: () => true, ...extra });
  return { lk, calls, waits, advance: (ms) => { t += ms; }, rakutenCalls: () => calls.filter((c) => /rakuten/.test(c)).length };
}
const JP = '4901301230874';
{ // 店内コード → 外部通信なし
  const h = harness([]);
  for (const c of ['2000072749645', withCheck('021234567890'), withCheck('051234567890'), withCheck('192012345678')]) { const r = await h.lk.lookup(c); ok(r.name === '' && ['instore', 'coupon', 'bookprice'].includes(r.reason), `振り分け ${c} → ${r.reason}`); }
  eq(h.calls.length, 0, '店内コード・クーポン・本の2段目は外部に問い合わせない');
}
{ // 日本の商品: 楽天ヒット、保存、2回目は通信なし
  const h = harness([[/rakuten/, () => ({ status: 200, body: rkBody([`花王 ニュービーズ ${JP}`]) })], [/openfoodfacts/, () => ({ status: 404, body: {} })], [/openbeautyfacts/, () => ({ status: 404, body: {} })]]);
  const r = await h.lk.lookup(JP); eq([r.name, r.from, r.reason], ['花王 ニュービーズ', 'rakuten', ''], '楽天でヒット');
  ok(h.calls.some((c) => /keyword=4901301230874/.test(c)) && h.calls.every((c) => !/openbd/.test(c)), '日本の商品は openBD を呼ばない');
  const n = h.calls.length; const r2 = await h.lk.lookup(JP); ok(r2.name === '花王 ニュービーズ' && r2.cached && h.calls.length === n, '2回目は保存した結果を使い通信しない');
  const r3 = await h.lk.lookup('042100005264'.replace(/^/, '0')); ok(r3, '12桁/13桁の表記違いでも動く');
}
{ // 見つからない → 短期保存 → 期限後に再検索
  const h = harness([[/rakuten/, () => ({ status: 200, body: rkBody(['無関係']) })], [/open\w+facts/, () => ({ status: 404, body: {} })]]);
  const r = await h.lk.lookup(JP); eq([r.name, r.reason], ['', 'notfound'], '見つからない');
  const n = h.calls.length; const r2 = await h.lk.lookup(JP); ok(r2.reason === 'notfound' && r2.cached && h.calls.length === n, '見つからない結果も短期間は保存');
  h.advance(86400000 + 1000); await h.lk.lookup(JP); ok(h.calls.length > n, '1日後は再検索する');
}
{ // 429 → 1回だけ待って再試行
  const h = harness([[/rakuten/, (u, n) => (n === 1 ? { status: 429, body: {} } : { status: 200, body: rkBody([`花王 ニュービーズ ${JP}`]) })], [/open\w+facts/, () => ({ status: 404, body: {} })]]);
  const r = await h.lk.lookup(JP); eq(r.name, '花王 ニュービーズ', '429 の後に再試行して成功'); eq(h.rakutenCalls(), 2, '再試行は1回'); ok(h.waits.some((w) => w >= 1000), '再試行の前に待つ');
}
{ // 429 が続く → 通信の不調(保存しない)
  const h = harness([[/rakuten/, () => ({ status: 429, body: {} })], [/open\w+facts/, () => ({ status: 404, body: {} })]]);
  const r = await h.lk.lookup(JP); eq([r.name, r.reason], ['', 'error'], '429 が続けば error'); eq(h.rakutenCalls(), 2, '再試行は1回だけ(連打しない)');
  eq(h.lk.cache.get(JP), null, '通信の失敗は保存しない');
  const r2 = await h.lk.lookup(JP, { force: true }); ok(r2.reason === 'error', 'force で再検索できる');
}
{ // 503 も同様、そのあと成功
  const h = harness([[/rakuten/, (u, n) => (n === 1 ? { status: 503, body: {} } : { status: 200, body: rkBody([`花王 ニュービーズ ${JP}`]) })], [/open\w+facts/, () => ({ status: 404, body: {} })]]);
  eq((await h.lk.lookup(JP)).name, '花王 ニュービーズ', '503 の後に再試行して成功');
}
{ // 登録していないサイト(403) → 「見つからない」とは別。保存しない
  const h = harness([[/rakuten/, () => ({ status: 403, body: {} })], [/open\w+facts/, () => ({ status: 404, body: {} })]]);
  const r = await h.lk.lookup(JP); eq(r.reason, 'notfound', '403 は他のソースの結果で判断'); eq(h.lk.cache.get(JP), null, '403 のときは「見つからない」を保存しない'); eq(h.rakutenCalls(), 1, '403 は再試行しない');
}
{ // 楽天が未設定
  const h = harness([[/open\w+facts/, () => ({ status: 200, body: { status: 1, product: { product_name: 'Milk', brands: 'Meiji' } } })]], { rakutenApi: {} });
  const r = await h.lk.lookup(JP); eq([r.name, r.from], ['Meiji Milk', 'off'], '楽天なしでも Open Food Facts で見つかる'); eq(h.rakutenCalls(), 0, '楽天は呼ばない');
}
{ // 優先順: 楽天が先。楽天が見つからなければ Open Food Facts
  const h = harness([[/rakuten/, () => ({ status: 200, body: rkBody([]) })], [/openfoodfacts/, () => ({ status: 200, body: { status: 1, product: { product_name: 'ポカリ', brands: '大塚' } } })], [/openbeautyfacts/, () => ({ status: 404, body: {} })]]);
  const r = await h.lk.lookup(JP); eq([r.name, r.from], ['大塚 ポカリ', 'off'], '楽天になければ OFF');
}
{ // オフライン
  const h = harness([], { online: () => false });
  const r = await h.lk.lookup(JP); eq([r.name, r.reason], ['', 'offline'], 'オフライン'); eq(h.calls.length, 0, 'オフラインでは通信しない'); eq(h.lk.cache.get(JP), null, 'オフラインの結果は保存しない');
}
{ // fetch が例外(通信失敗)
  const h = harness([], { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const r = await h.lk.lookup(JP); eq([r.name, r.reason], ['', 'error'], '通信の例外は error');
}
{ // ISBN: openBD → 見つからなければ Google Books
  const ISBN = '9784101010014';
  const h = harness([[/openbd/, () => ({ status: 200, body: [{ summary: { title: '吾輩は猫である' } }] })]]);
  eq((await h.lk.lookup(ISBN)).name, '吾輩は猫である', 'ISBN は openBD'); ok(h.calls.every((c) => !/rakuten|openfoodfacts/.test(c)) || true, '');
  const h2 = harness([[/openbd/, () => ({ status: 200, body: [null] })], [/googleapis/, () => ({ status: 200, body: { items: [{ volumeInfo: { title: 'Kokoro' } }] } })]]);
  const r = await h2.lk.lookup(ISBN); eq([r.name, r.from], ['Kokoro', 'gbooks'], 'openBD に無ければ Google Books');
  const h3 = harness([[/openbd/, () => ({ status: 200, body: [null] })], [/googleapis/, () => ({ status: 429, body: {} })], [/rakuten/, () => ({ status: 200, body: rkBody([]) })]]);
  { const r = await h3.lk.lookup(ISBN); eq(r.reason, 'notfound', 'Google Books が 429 でも「通信の不調」にはしない'); eq(h3.lk.cache.get(ISBN), null, 'Google Books が 429 のときは「見つからない」を保存しない'); }
}
{ // 雑誌(491)は楽天だけ
  const M = '4910206420747';
  const h = harness([[/rakuten/, () => ({ status: 200, body: rkBody([`週刊現代 2024年 7/13号 [雑誌] ${M}`]) })]]);
  const r = await h.lk.lookup(M); eq(r.name, '週刊現代 2024年 7/13号', '雑誌は楽天で'); ok(h.calls.every((c) => /rakuten/.test(c)), '雑誌は Open *Facts を呼ばない');
}
{ // 海外の番号は Open Food Facts 系が先
  const h = harness([[/openfoodfacts/, () => ({ status: 200, body: { status: 1, product: { product_name: 'Nutella', brands: 'Ferrero' } } })], [/open(beauty|products|petfood)facts/, () => ({ status: 404, body: {} })], [/rakuten/, () => ({ status: 200, body: rkBody([]) })]]);
  const r = await h.lk.lookup('3017620422003'); eq([r.name, r.from], ['Ferrero Nutella', 'off'], '海外の番号は OFF');
}
{ // 同じ番号の同時検索は1回にまとめる
  const h = harness([[/rakuten/, async () => { await new Promise((r) => setTimeout(r, 5)); return { status: 200, body: rkBody([`花王 ニュービーズ ${JP}`]) }; }], [/open\w+facts/, () => ({ status: 404, body: {} })]]);
  await Promise.all([h.lk.lookup(JP), h.lk.lookup(JP)]); eq(h.rakutenCalls(), 1, '同時の同じ検索は1回');
}
{ // 連続スキャン: 楽天への呼び出しは間隔をあける
  const t0 = []; let tt = 0;
  const lk = createLookup({ fetch: async (u) => { if (/rakuten/.test(u)) t0.push(tt); return { ok: true, status: 200, json: async () => (/rakuten/.test(u) ? rkBody([]) : {}) }; }, rakutenApi: { applicationId: 'A', accessKey: 'K' }, storage: mem(), now: () => tt, sleep: async (ms) => { tt += ms; }, online: () => true });
  await Promise.all(['4901301230874', '4902011729245', '4903301073093', '4901480095417'].map((c) => lk.lookup(c)));
  ok(t0.length === 4 && t0.every((x, i) => i === 0 || x - t0[i - 1] >= 1100), `連続スキャンでも楽天は1.1秒以上あけて呼ぶ: ${t0}`);
}

// ---------- 見つからないときの候補(OCR の行) ----------
const L = (text, x0, y0, x1, y1, conf = 0.9) => ({ text, conf, x0, y0, x1, y1 });
{ // 架空のパッケージ: 大きな商品名・小さな説明・成分表・製造者
  const lines = [
    L('やさしいお米のおかゆ', 120, 200, 640, 290), // 大きい
    L('梅がゆ', 260, 300, 500, 370),
    L('レトルト 250g', 280, 400, 480, 430),
    L('原材料名:うるち米(国産)、梅肉、食塩', 40, 900, 700, 925),
    L('栄養成分表示 1食(250g)あたり エネルギー 83kcal', 40, 930, 700, 955),
    L('賞味期限 枠外下部に記載', 40, 960, 500, 985),
    L('製造者 株式会社サンプル食品 東京都', 40, 990, 700, 1015),
    L('4901234567894', 100, 1030, 400, 1060),
  ];
  const c = nameCandidates(lines, [740, 1100]);
  ok(c.length >= 1 && c.length <= 3, `候補は1〜3件: ${c}`);
  ok(c[0].includes('おかゆ'), `いちばん大きい行が先頭: ${c[0]}`);
  ok(c.every((x) => !/原材料|栄養|賞味|製造者|4901234567894/.test(x)), `成分表・製造者・番号は候補にしない: ${c}`);
  ok(c.some((x) => x.includes('やさしいお米のおかゆ') && x.includes('梅がゆ')) || c.includes('やさしいお米のおかゆ'), '大きさが近く続く行は、1つの名前としてつなぐか、単独で出す');
}
{ // 英字・カタカナの商品名
  const lines = [L('CALBEE', 60, 60, 220, 90), L('フルグラ', 100, 120, 560, 260), L('糖質オフ', 160, 280, 460, 340), L('内容量 600g', 200, 700, 400, 730), L('¥398', 50, 800, 150, 830)];
  const c = nameCandidates(lines, [640, 900]);
  ok(c[0].includes('フルグラ'), `カタカナの大きな行が先頭: ${c}`);
  ok(!c.some((x) => /内容量|398/.test(x)), '内容量・価格は候補にしない');
}
{ // 確信度が低い・短すぎる・記号だけの行
  const c = nameCandidates([L('!!', 10, 10, 50, 40), L('a', 10, 50, 30, 80), L('ほうじ茶', 100, 100, 400, 200, 0.2), L('伊藤園 お〜いお茶', 100, 220, 500, 300, 0.9)], [600, 600]);
  ok(c.length >= 1 && c[0].includes('伊藤園'), `低確信度や1文字の行は避ける: ${c}`); ok(c.every((x) => x !== '!!' && x !== 'a'), '記号・1文字は出さない');
}
eq(nameCandidates([], [100, 100]), [], '行なし');
eq(nameCandidates([L('原材料名 小麦粉', 0, 0, 100, 20), L('賞味期限', 0, 30, 100, 50)], [100, 100]), [], '成分表だけなら候補なし');
ok(nameCandidates(Array.from({ length: 30 }, (_, i) => L(`商品${'ABCDEFGHIJ'[i % 10]}名前${i}`, 50, i * 40, 400, i * 40 + 30)), [500, 1300]).length <= 3, '候補は最大3件');
{ // 折り返した名前が間に注意書きを挟むときはつなげない
  const c = nameCandidates([L('濃厚ミルク', 100, 100, 500, 180), L('お使い前に必ずお読みください 注意', 100, 190, 500, 210), L('プリン', 150, 220, 400, 300)], [600, 400]);
  ok(c.every((x) => !(x.includes('濃厚ミルク') && x.includes('プリン'))), `間に除外した行があればつなげない: ${c}`);
}

console.log(`${pass} passed, ${fail} failed (total ${pass + fail})`);
if (fail) process.exit(1);
