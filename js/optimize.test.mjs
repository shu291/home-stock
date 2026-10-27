// node js/optimize.test.mjs  (依存なし)
import assert from 'node:assert/strict';
import { usageRate, daysLeft, suggestPar, plan, withLog, cleanLog, mergeItems, nameSim, expiryDays, autoClassify, learnState, LOG_MAX } from './optimize.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`NG  ${name}\n    ${e.message.split('\n').join('\n    ')}`); } };
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m || ''} ${a} !≈ ${b} (±${tol})`);

const DAY = 86400000;
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();
const ago = (d) => NOW - d * DAY;
const ymd = (offset) => { const d = new Date(NOW + offset * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// 履歴つき品目。events: [何日前, 増減]
const it = (name, qty, events = [], extra = {}) => ({ id: name + Math.random(), name, qty, minQty: 0, buyQty: 1, category: '食品', location: 'キッチン', log: events.map(([d, n]) => ({ t: ago(d), d: n })), ...extra });
// 一定ペース: start日前に+買い足し、以後 毎日 -per
const steady = (days, per = 1) => [[days, 20], ...Array.from({ length: days }, (_, k) => [days - 1 - k, -per])];

// ---- 使用ペース ----
t('一定ペース(1個/日・14日)で約1', () => near(usageRate(it('米', 6, steady(14)), NOW), 1, 0.1));
t('一定ペース(0.5個/日=2日に1個)で約0.5', () => {
  const ev = [[20, 20], ...Array.from({ length: 10 }, (_, k) => [18 - 2 * k, -1])];
  near(usageRate(it('卵', 5, ev), NOW), 0.5, 0.08);
});
t('履歴なし(既存データ)は null / 残り日数も null / おすすめも null', () => {
  const x = { id: 'a', name: '牛乳', qty: 3 };
  assert.equal(usageRate(x, NOW), null); assert.equal(daysLeft(x, NOW), null); assert.equal(suggestPar(x, NOW), null);
});
t('log が壊れていても落ちない', () => {
  for (const log of [null, 'x', 5, [null, 1, [1, 2], { t: 'a', d: 1 }, { t: NaN, d: 1 }]]) assert.equal(usageRate({ qty: 1, log }, NOW), null);
});
t('データ不足: 減少2回では null(境界 MIN_EVENTS=3 で推定可)', () => {
  assert.equal(usageRate(it('a', 5, [[10, 10], [5, -1], [2, -1]]), NOW), null);
  assert.notEqual(usageRate(it('a', 5, [[10, 10], [5, -1], [3, -1], [2, -1]]), NOW), null);
});
t('データ不足: 観察期間が7日未満なら null、ちょうど7日で推定可', () => {
  assert.equal(usageRate(it('a', 5, [[6.9, 10], [5, -1], [3, -1], [1, -1]]), NOW), null);
  assert.notEqual(usageRate(it('a', 5, [[7, 10], [5, -1], [3, -1], [1, -1]]), NOW), null);
});
t('同じ日に3回タップしただけ(使用日1日)は学習しない', () => {
  assert.equal(usageRate(it('a', 5, [[10, 10], [2, -1], [2.01, -1], [2.02, -1]].sort((a, b) => b[0] - a[0])), NOW), null);
});
t('最初の記録が減少なら起点として扱い、消費に数えない', () => {
  const s = learnState(it('a', 5, [[10, -4], [6, -1], [4, -1], [2, -1]]), NOW);
  assert.equal(s.events, 3); assert.equal(s.ready, true);
});
t('不規則(週末にまとめて消費)でも平均ペースに近い', () => {
  // 28日で 14個消費(0.5/日)。週1回2個ずつ+週末にさらに...ではなく 2日おきに1個だが時刻はばらつく
  const ev = [[30, 30], [27.2, -2], [24.1, -1], [20.5, -2], [17.9, -1], [13.2, -2], [10.8, -1], [6.4, -2], [3.1, -1], [0.7, -2]];
  const r = usageRate(it('洗剤', 10, ev), NOW);
  assert.ok(r > 0.3 && r < 0.8, `r=${r}`);
});
t('外れ値(1回で10個減)に引きずられない', () => {
  const base = steady(14); // 1個/日
  const spike = [...base.slice(0, 8), [6.5, -10], ...base.slice(8)].sort((a, b) => b[0] - a[0]);
  const r0 = usageRate(it('a', 5, base), NOW), r1 = usageRate(it('a', 5, spike), NOW);
  assert.ok(r1 < r0 * 1.5, `spike rate ${r1} vs ${r0}`); // 頭打ちが無ければ約1.7倍以上
  assert.ok(r1 > r0, 'それでも少しは増える');
});
t('直近を重みづけ: 同じ消費回数でも、最近に偏った品の方が高く(古い方に偏った品は低く)出る', () => {
  // どちらも40日で16回(平均0.4/日)。recent は前半0.2/日→直近10日1/日、old はその逆
  const mk = (recentHeavy) => {
    const ev = [[40, 30]], sparse = [], dense = [];
    for (let k = 38; k > 10; k -= 5) sparse.push(k);
    for (let k = 9; k >= 0; k--) dense.push(k);
    // old は時間を反転: 古い30日に密、直近は疎
    const days = recentHeavy ? [...sparse, ...dense] : [...dense.map((k) => 39 - k).reverse(), ...sparse.map((k) => 39 - k + 0).reverse().map((k) => k)].sort((a, b) => b - a);
    return it('a', 5, [...ev, ...days.map((k) => [k, -1])]);
  };
  const rr = usageRate(mk(true), NOW), ro = usageRate(mk(false), NOW);
  assert.ok(rr > 0.4 * 1.1, `recent ${rr}`); assert.ok(ro < rr, `old ${ro} < recent ${rr}`);
});
t('最近使っていない品はペースが下がる', () => {
  const a = usageRate(it('a', 5, steady(14)), NOW);
  const b = usageRate(it('a', 5, steady(14)), NOW + 30 * DAY);
  assert.ok(b < a / 2, `${a} -> ${b}`);
});
t('買い足し(増加)を挟んでも消費は減少分だけで推定', () => {
  const ev = [[20, 5], ...Array.from({ length: 6 }, (_, k) => [18 - 3 * k, -1]), [9, 12], [1, 12]];
  const r = usageRate(it('a', 20, ev), NOW);
  assert.ok(r > 0.2 && r < 0.5, `r=${r}`); // 6個/20日=0.3 付近。増加は無視
});
t('未来の履歴(端末時計ずれ)は無視', () => {
  assert.equal(cleanLog([{ t: NOW + DAY, d: 1 }], NOW).length, 0);
});

// ---- 残り日数 / おすすめ ----
t('daysLeft = 数量/ペース、在庫0は0', () => {
  near(daysLeft(it('a', 7, steady(14)), NOW), 7, 0.8);
  assert.equal(daysLeft(it('a', 0, steady(14)), NOW), 0);
});
t('suggestPar: 1個/日 → 最低在庫7・買う14', () => {
  const p = suggestPar(it('a', 5, steady(14)), NOW);
  assert.ok(p.minQty >= 7 && p.minQty <= 8, `min ${p.minQty}`); assert.ok(p.buyQty >= 14 && p.buyQty <= 16, `buy ${p.buyQty}`);
});
t('suggestPar: 極端に遅いペースでも最低1', () => {
  const ev = [[60, 3], [50, -1], [30, -1], [10, -1]];
  const p = suggestPar(it('a', 2, ev), NOW); assert.deepEqual([p.minQty, p.buyQty], [1, 1]);
});
t('suggestPar: 極端に速いペースは上限に丸める(最低30・買う50)', () => {
  const p = suggestPar(it('a', 5, steady(14, 20)), NOW); assert.deepEqual([p.minQty, p.buyQty], [30, 50]);
});

// ---- 履歴の記録(withLog) ----
t('増減が log に追記される / 新規は+数量', () => {
  const a = withLog(null, { name: 'a', qty: 3 }, NOW);
  assert.deepEqual(a.log, [{ t: NOW, d: 3 }]);
  const b = withLog(a, { ...a, qty: 2 }, NOW + 5 * 60000);
  assert.deepEqual(b.log.map((e) => e.d), [3, -1]);
});
t('1分以内の+1→−1は相殺され履歴に残らない', () => {
  const a = { name: 'a', qty: 2, log: [{ t: ago(3), d: 2 }] };
  const b = withLog(a, { ...a, qty: 3 }, NOW), c = withLog(b, { ...b, qty: 2 }, NOW + 30000);
  assert.deepEqual(c.log, [{ t: ago(3), d: 2 }]);
});
t('相殺: +3の直後の−1は+2に、逆転は差分で残る', () => {
  const a = { name: 'a', qty: 0 };
  const b = withLog(a, { ...a, qty: 3 }, NOW), c = withLog(b, { ...b, qty: 2 }, NOW + 1000);
  assert.deepEqual(c.log, [{ t: NOW + 1000, d: 2 }]);
  const d = withLog(b, { ...b, qty: 0 }, NOW + 2000); // +3 のあと −3 → 空 → log キーなし
  assert.equal('log' in d, false);
  const e = withLog({ ...a, qty: 1, log: [{ t: NOW, d: 1 }] }, { ...a, qty: -1 }, NOW + 1000); // +1 のあと -2 → 差し引き -1
  assert.deepEqual(e.log, [{ t: NOW + 1000, d: -1 }]);
});
t('相殺の境界: ちょうど60秒は相殺、61秒は別エントリ', () => {
  const a = { qty: 1, log: [{ t: ago(2), d: 1 }, { t: NOW, d: 1 }] };
  assert.equal(withLog(a, { ...a, qty: 0 }, NOW + 60000).log.length, 1);
  assert.equal(withLog(a, { ...a, qty: 0 }, NOW + 61000).log.length, 3);
});
t('同方向の連打は相殺しない', () => {
  const a = { qty: 3, log: [{ t: NOW, d: -1 }] };
  assert.equal(withLog(a, { ...a, qty: 2 }, NOW + 1000).log.length, 2);
});
t('数量が変わらない保存は log を変えず、log が無ければキーも作らない(既存データ)', () => {
  const a = { name: 'a', qty: 2 };
  assert.equal('log' in withLog(a, { ...a, name: 'b' }, NOW), false);
  const b = { ...a, log: [{ t: NOW, d: -1 }] };
  assert.deepEqual(withLog(b, { ...b, name: 'c' }, NOW + 1e6).log, b.log);
});
t('skip: 処分は履歴に残さない', () => {
  const a = { qty: 2, log: [] };
  assert.equal('log' in withLog(a, { ...a, qty: 0 }, NOW, { skip: true }), false);
});
t(`履歴は直近${LOG_MAX}件まで`, () => {
  let x = { name: 'a', qty: 100 };
  for (let k = 0; k < 60; k++) x = withLog(x, { ...x, qty: x.qty - 1 }, NOW + k * 120000);
  assert.equal(x.log.length, LOG_MAX); assert.equal(x.log[LOG_MAX - 1].t, NOW + 59 * 120000);
});
t('withLog の結果に undefined が入らない(Firestore 対策)', () => {
  const x = withLog(null, { name: 'a', qty: 2, category: '' }, NOW);
  assert.equal(JSON.stringify(x).includes('undefined'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(x)), x);
  assert.ok(!x.log.some(Array.isArray), 'ネスト配列を使わない');
});

// ---- plan: soonOut ----
t('soonOut: 予測7日ちょうどは含み、8日は含まない / 最低在庫より上でも含む', () => {
  const a = it('a', 7, steady(14)), b = it('b', 9, steady(14));
  const r = plan([a, b], NOW);
  const names = r.soonOut.map((x) => x.item.name);
  assert.ok(names.includes('a')); assert.ok(!names.includes('b'));
  assert.equal(a.minQty, 0); // 最低在庫未設定でも出る
});
t('soonOut: 予測日数の昇順', () => {
  const r = plan([it('x', 6, steady(14)), it('y', 2, steady(14)), it('z', 4, steady(14))], NOW);
  assert.deepEqual(r.soonOut.map((x) => x.item.name), ['y', 'z', 'x']);
});
t('soonOut: 履歴なしの品は出ない', () => assert.equal(plan([{ id: '1', name: 'a', qty: 0 }], NOW).soonOut.length, 0));

// ---- expiring ----
t('expiring: 7日以内/当日/期限切れ。8日後は含まない。在庫0は含まない', () => {
  const r = plan([it('a', 1, [], { expiry: ymd(7) }), it('b', 1, [], { expiry: ymd(8) }), it('c', 1, [], { expiry: ymd(-1) }),
    it('d', 1, [], { expiry: ymd(0) }), it('e', 0, [], { expiry: ymd(-3) }), it('f', 1, [], { expiry: '' }), it('g', 1, [], { expiry: 'xx' })], NOW);
  assert.deepEqual(r.expiring.map((x) => [x.item.name, x.days, x.expired]), [['c', -1, true], ['d', 0, false], ['a', 7, false]]);
});
t('expiryDays: 存在しない日付は null', () => assert.equal(expiryDays({ expiry: '2026-02-31' }, NOW), null));

// ---- parSuggestions ----
t('parSuggestions: 設定が近ければ出さず、大きくずれていれば出す', () => {
  const near_ = it('a', 5, steady(14), { minQty: 7, buyQty: 14 });
  const far_ = it('b', 5, steady(14), { minQty: 1, buyQty: 1 });
  const r = plan([near_, far_], NOW).parSuggestions;
  assert.deepEqual(r.map((x) => x.item.name), ['b']);
  assert.ok(r[0].sug.minQty >= 7);
});
t('parSuggestions: 差が1だけなら出さない', () => {
  const x = it('a', 5, steady(14), { minQty: 6, buyQty: 13 });
  assert.equal(plan([x], NOW).parSuggestions.length, 0);
});

// ---- duplicates ----
t('nameSim: 全角/半角・空白・かな差は同一視', () => {
  assert.equal(nameSim('牛乳 1L', '牛乳1L'), 1); assert.equal(nameSim('牛乳１Ｌ', '牛乳1l'), 1); assert.equal(nameSim('ぎゅうにゅう', 'ギュウニュウ'), 1);
});
t('nameSim: 容量違いは別商品', () => { assert.equal(nameSim('ポカリスエット500ml', 'ポカリスエット900ml'), 0); assert.ok(nameSim('牛乳', 'トイレットペーパー') < 0.3); });
t('duplicates: 「牛乳 1L」と「牛乳1L」を検出し、統合案は数量合算・barcode/srcKeys引き継ぎ', () => {
  const a = it('牛乳 1L', 2, [], { srcKeys: ['k1'], barcode: '4900', minQty: 1 }), b = it('牛乳1L', 3, [], { srcKeys: ['k2'], buyQty: 2 });
  const d = plan([a, b, it('卵', 1)], NOW).duplicates;
  assert.equal(d.length, 1); assert.equal(d[0].items.length, 2);
  assert.equal(d[0].keep, a); assert.equal(d[0].merged.qty, 5); assert.equal(d[0].merged.barcode, '4900');
  assert.deepEqual(d[0].merged.srcKeys, ['k1', 'k2']); assert.equal(d[0].merged.buyQty, 2);
});
t('duplicates: 別バーコードの同名は統合候補にしない / 別の品は出さない', () => {
  assert.equal(plan([it('牛乳', 1, [], { barcode: '1' }), it('牛乳', 1, [], { barcode: '2' })], NOW).duplicates.length, 0);
  assert.equal(plan([it('牛乳', 1), it('豆乳', 1), it('米', 1)], NOW).duplicates.length, 0);
});
t('duplicates: 3件が同じ商品なら1グループ', () => assert.deepEqual(plan([it('食パン', 1), it('食パン ', 1), it('食パン\u3000', 1)], NOW).duplicates.map((g) => g.items.length), [3]));
t('mergeItems: 履歴を合流し、undefined を作らない', () => {
  const m = mergeItems(it('a', 1, [[5, -1]]), [it('a', 2, [[3, -1], [2, 4]])], NOW);
  assert.deepEqual(m.log.map((e) => e.d), [-1, -1, 4]); assert.equal(JSON.stringify(m).includes('undefined'), false);
});

// ---- 未分類 / overstock ----
t('uncategorized: guessCategory の候補つき・分類済みは出ない', () => {
  const r = plan([it('牛乳', 1, [], { category: '', location: 'キッチン' }), it('謎の品', 1, [], { category: '' }), it('米', 1)], NOW).uncategorized;
  assert.deepEqual(r.map((x) => [x.item.name, x.guess]), [['牛乳', '食品'], ['謎の品', '']]);
});
t('overstock: 90日変化なし+半年分以上で出る(89日は出ない)', () => {
  const mk = (idle) => it('a', 10, [[idle + 30, 20], [idle + 20, -1], [idle + 10, -1], [idle, -1]]);
  assert.equal(plan([mk(90)], NOW).overstock.length, 1);
  assert.equal(plan([mk(89)], NOW).overstock.length, 0);
});
t('overstock: 1〜2個は多いと言わない / 半年分の境界(179日分は出ず181日分は出る)', () => {
  const ev = [[135, 40], ...Array.from({ length: 14 }, (_, k) => [105 - k, -3])]; // 最後の消費は92日前
  const r = usageRate(it('a', 1, ev), NOW), lo = Math.floor(r * 179), hi = Math.ceil(r * 181);
  assert.ok(lo >= 3, `lo=${lo}`);
  assert.equal(plan([it('a', lo, ev)], NOW).overstock.length, 0);
  assert.equal(plan([it('a', hi, ev)], NOW).overstock.length, 1);
  assert.equal(plan([it('a', 2, ev)], NOW).overstock.length, 0);
});
t('overstock: 履歴なし(既存データ)は updatedAt で判定、5個以上のみ', () => {
  const old = (q) => ({ id: q + 'x', name: 'o', qty: q, category: '食品', location: 'キッチン', updatedAt: ago(120) });
  assert.equal(plan([old(5)], NOW).overstock.length, 1); assert.equal(plan([old(4)], NOW).overstock.length, 0);
  assert.equal(plan([{ id: 'n', name: 'n', qty: 9, category: 'x', location: 'y' }], NOW).overstock.length, 0, '時刻不明は出さない');
});
t('plan: 空配列・全部 log なしでも壊れない', () => {
  const r = plan([], NOW); assert.deepEqual([r.soonOut, r.expiring, r.parSuggestions, r.duplicates, r.uncategorized, r.overstock].map((x) => x.length), [0, 0, 0, 0, 0, 0]);
  assert.doesNotThrow(() => plan([{ id: '1', name: 'x', qty: 1 }, { id: '2', name: '', qty: 1 }, null], NOW));
});
t('learning: 学習済み/追跡中の件数と目安日数', () => {
  const r = plan([it('a', 5, steady(14)), it('b', 5, [[3, 5], [1, -1]]), { id: 'c', name: 'c', qty: 1 }], NOW).learning;
  assert.deepEqual([r.ready, r.tracking, r.total, r.etaDays], [1, 1, 3, 4]);
});

// ---- 自動分類 ----
const LOCS = ['キッチン', '洗面所', '風呂・トイレ', '押入れ', '玄関', 'その他'];
const raw = (name, extra = {}) => ({ name, qty: 1, category: '', location: '', ...extra });
t('autoClassify: 学習が辞書より優先(家族が「牛乳」を飲料にしていればそれに従う)', () => {
  const r = autoClassify(raw('牛乳'), [it('牛乳 1L', 1, [], { category: '飲料', location: '押入れ' })], { locs: LOCS });
  assert.deepEqual([r.category, r.location, r.from.category, r.from.location], ['飲料', '押入れ', 'learned', 'learned']);
});
t('autoClassify: 辞書へのフォールバック+置き場所の既定', () => {
  const r = autoClassify(raw('キャベツ'), [], { locs: LOCS });
  assert.deepEqual([r.category, r.location, r.from.category, r.from.location], ['食品', 'キッチン', 'dict', 'category']);
  const s = autoClassify(raw('シャンプー'), [], { locs: LOCS }); assert.deepEqual([s.category, s.location], ['洗剤・衛生', '洗面所']);
});
t('autoClassify: 名前による置き場所(食器用洗剤→キッチン、トイレ用→風呂・トイレ)', () => {
  assert.equal(autoClassify(raw('食器用洗剤'), [], { locs: LOCS }).location, 'キッチン');
  assert.equal(autoClassify(raw('トイレクリーナー'), [], { locs: LOCS }).location, '風呂・トイレ');
});
t('autoClassify: トイレットペーパーはトイレ用品(風呂・トイレ)にしない', () => {
  const r = autoClassify(raw('トイレットペーパー'), [], { locs: LOCS }); assert.deepEqual([r.category, r.location], ['日用品', '']);
});
t('autoClassify: 低確信は空のまま(辞書に無い・既定のないカテゴリ)', () => {
  const r = autoClassify(raw('謎の品'), [], { locs: LOCS }); assert.deepEqual([r.category, r.location], ['', '']);
  const k = autoClassify(raw('単3電池'), [], { locs: LOCS }); assert.deepEqual([k.category, k.location], ['消耗品', '']);
});
t('autoClassify: 置き場所は locs に無い値を返さない', () => assert.equal(autoClassify(raw('キャベツ'), [], { locs: ['玄関'] }).location, ''));
t('autoClassify: ユーザー指定は上書きしない(返さない)', () => {
  const r = autoClassify(raw('牛乳', { category: '飲料', location: '玄関' }), [it('牛乳', 1, [], { category: '食品', location: 'キッチン' })], { locs: LOCS });
  assert.deepEqual([r.category, r.location], ['', '']);
  const p = autoClassify(raw('牛乳', { category: '飲料' }), [], { locs: LOCS }); assert.equal(p.category, ''); assert.equal(p.location, 'キッチン');
});
t('autoClassify: 類似名(容量違い・表記ゆれ)から引き継ぐ', () => {
  const r = autoClassify(raw('ポカリスエット 500ml'), [it('ポカリスエット900ml', 1, [], { category: '飲料', location: '玄関' })], { locs: LOCS });
  assert.deepEqual([r.category, r.location], ['飲料', '玄関']);
  assert.ok(r.conf.category >= 0.8);
});
t('autoClassify: 似ていない名前からは学習しない', () => {
  const r = autoClassify(raw('謎の品'), [it('牛乳', 1, [], { category: '飲料', location: '玄関' })], { locs: LOCS }); assert.equal(r.category, '');
});
t('autoClassify: 自動分類済み(auto)の品は学習元にしない(誤りの連鎖を防ぐ)', () => {
  const r = autoClassify(raw('牛乳'), [it('牛乳', 1, [], { category: '飲料', location: '玄関', auto: true })], { locs: LOCS });
  assert.equal(r.category, '食品');
});
t('autoClassify: 複数の教師は類似度の合計で多数決', () => {
  const r = autoClassify(raw('卵'), [it('卵', 1, [], { category: '飲料' }), it('卵 ', 1, [], { category: '食品' }), it('卵\u3000', 1, [], { category: '食品' })], { locs: LOCS });
  assert.equal(r.category, '食品');
});
t('autoClassify: 自分自身は教師にしない / 名前が空なら何もしない', () => {
  const me = it('牛乳', 1, [], { category: '飲料' }); me.category = '';
  assert.equal(autoClassify(me, [me], { locs: LOCS }).category, '食品');
  assert.deepEqual([autoClassify(raw(''), [], {}).category, autoClassify(raw('  '), [], {}).location], ['', '']);
});
t('autoClassify: 学習で得た location が既定より優先、カテゴリだけ学習なら置き場所は既定', () => {
  const a = autoClassify(raw('食パン'), [it('食パン', 1, [], { category: '食品', location: '玄関' })], { locs: LOCS }); assert.equal(a.location, '玄関');
  const b = autoClassify(raw('食パン'), [it('食パン', 1, [], { category: '食品', location: '' })], { locs: LOCS }); assert.equal(b.location, 'キッチン');
});
t('plan.autoFill: 未分類の一括適用候補(埋める値があるものだけ)', () => {
  const r = plan([raw('キャベツ'), raw('謎の品'), raw('米', { category: '食品', location: 'キッチン' })], NOW, { locs: LOCS }).autoFill;
  assert.deepEqual(r.map((x) => [x.item.name, x.category, x.location]), [['キャベツ', '食品', 'キッチン']]);
});

console.log(`${pass} passed, ${fail} failed (total ${pass + fail})`);
process.exit(fail ? 1 : 0);
