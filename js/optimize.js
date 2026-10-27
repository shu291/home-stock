// 端末内だけで動く軽量な統計・ヒューリスティクス(外部AI・通信なし)。DOM/Firestore 非依存の純粋関数。
// 推定なので、履歴が少ないうちは当たらない。使うほど正確になる。
import { guessCategory } from './category.js';

const DAY = 86400000;

// ---- 定数(根拠つき) ----
export const LOG_MAX = 40;          // 品目ドキュメントに持つ履歴の上限。1件約30B → 約1.2KB で、Firestoreの1MB上限に対して十分小さい
const CANCEL_MS = 60 * 1000;        // 1分以内の逆符号は誤タップの打ち消しとみなして相殺
export const MIN_EVENTS = 3;        // 消費ペースの推定に必要な「減った」回数。2回以下だと偶然の影響が大きすぎる
export const MIN_SPAN_DAYS = 7;     // 観察期間の下限。1週間未満だと曜日の偏り(週末まとめ買い等)を拾う
const MIN_USE_DAYS = 2;             // 減った日が2日以上に分かれていること(1日にまとめて数回タップした場合を除く)
const HALF_LIFE_DAYS = 30;          // 直近重みの半減期。1か月前の消費は半分の重み(季節・家族構成の変化に追随しつつ安定)
const OUTLIER_MULT = 3;             // 1回の減少量は「中央値の3倍」で頭打ち(まとめて処分などの外れ値対策)
const LEAD_DAYS = 3;                // 買いに行くまでの猶予
const SAFETY_DAYS = 4;              // 余裕日数。猶予と合わせて最低在庫=約1週間分
const BUY_DAYS = 14;                // 1回に買う量=約2週間分(買い物の頻度を下げすぎず、置き場所も圧迫しない)
const MIN_MAX = [1, 30], BUY_MAX = [1, 50]; // おすすめ値の丸め(極端な値を避ける)
const PAR_DIFF_ABS = 2, PAR_DIFF_REL = 0.5; // 現設定との差が2以上かつ大きい方の5割以上のときだけ「ずれ」と呼ぶ
export const SOON_DAYS = 7;         // 「もうすぐ切れそう」=予測7日以内
export const EXPIRY_DAYS = 7;       // 期限が7日以内
const DUP_SIM = 0.8;                // 重複候補の文字バイグラム(Dice)類似度。「牛乳1L」/「牛乳 1L」=1.0、容量違いは数字の不一致で除外
const LEARN_SIM = 0.8;              // 自動分類で、手で付けた分類を引き継ぐ類似度(単位・数量を除いた名前で比較)
const MIN_CONF = 0.6;               // 自動分類の確信度がこれ未満なら空のまま(誤分類より未分類)
const IDLE_DAYS = 90;               // 長期間動いていない=90日以上変化なし
const OVER_DAYS = 180;              // 消費ペースで半年分以上
const OVER_MIN_QTY = 3;             // 1〜2個は「多い」と言わない
const OVER_NORATE_QTY = 5;          // ペース不明で90日動かず5個以上

// ---- 履歴 ----
// log は [{t: 時刻ms, d: 増減}, ...](古い順)。Firestore は配列の入れ子を保存できないのでオブジェクトの配列にしている。
export function cleanLog(log, now = Infinity) {
  if (!Array.isArray(log)) return [];
  return log.filter((e) => e && Number.isFinite(e.t) && Number.isFinite(e.d) && e.d !== 0 && e.t <= now)
    .map((e) => ({ t: Math.round(e.t), d: Math.round(e.d) })).sort((a, b) => a.t - b.t).slice(-LOG_MAX);
}

// 数量が変わる保存はすべてここを通す。next に使用履歴 log を足して返す(old=null は新規)。
// opts.skip: 処分など「消費ではない」変更は履歴に残さない
export function withLog(old, next, now = Date.now(), opts = {}) {
  const log = cleanLog(old ? old.log : next.log);
  const delta = (+next.qty || 0) - (old ? +old.qty || 0 : 0);
  if (delta && !opts.skip) {
    const last = log[log.length - 1];
    if (last && Math.sign(last.d) !== Math.sign(delta) && now - last.t <= CANCEL_MS) {
      const sum = last.d + delta; // 逆符号は相殺(+1→−1 なら何も残らない)
      log.pop(); if (sum) log.push({ t: Math.round(now), d: sum });
    } else log.push({ t: Math.round(now), d: delta });
  }
  const out = { ...next }; delete out.log;
  const kept = log.slice(-LOG_MAX);
  return kept.length ? { ...out, log: kept } : out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// 学習状況。最初の記録は「観察の起点」(それ以前の消費は不明)なので、減少は2件目以降だけ数える
export function learnState(item, now = Date.now()) {
  const log = cleanLog(item?.log, now);
  if (log.length < 2) return { ready: false, events: 0, spanDays: 0, dec: [] };
  const dec = log.slice(1).filter((e) => e.d < 0).map((e) => ({ t: e.t, n: -e.d }));
  const spanDays = (now - log[0].t) / DAY;
  const days = new Set(dec.map((e) => Math.floor(e.t / DAY))).size;
  return { ready: dec.length >= MIN_EVENTS && spanDays >= MIN_SPAN_DAYS && days >= MIN_USE_DAYS, events: dec.length, spanDays, dec, t0: log[0].t };
}

// 1日あたりの消費ペース(個/日)。データ不足なら null(=学習中)。
// 指数重み付きの消費率: rate = Σ n_i·w(t_i) / ∫w(s)ds,  w(s)=0.5^((now−s)/半減期)。
// 分母は観察期間(起点〜今)の重みの積分なので、最近使っていなければペースは自然に下がる。
export function usageRate(item, now = Date.now()) {
  const s = learnState(item, now);
  if (!s.ready) return null;
  const cap = OUTLIER_MULT * median(s.dec.map((e) => e.n));
  const k = Math.LN2 / HALF_LIFE_DAYS;
  const num = s.dec.reduce((a, e) => a + Math.min(e.n, cap) * Math.exp(-k * (now - e.t) / DAY), 0);
  const den = (1 - Math.exp(-k * s.spanDays)) / k;
  const r = num / den;
  return r > 0 && Number.isFinite(r) ? r : null;
}

// 残り日数の予測(ペース不明なら null)。在庫0は0
export function daysLeft(item, now = Date.now()) {
  const r = usageRate(item, now);
  if (r === null) return null;
  return (+item.qty || 0) <= 0 ? 0 : item.qty / r;
}

const ceil6 = (x) => Math.ceil(+x.toFixed(6)); // 0.3*10 のような誤差で切り上がらないように
const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

// おすすめの最低在庫(猶予+余裕=約1週間分)と1回に買う数(約2週間分)
export function suggestPar(item, now = Date.now()) {
  const r = usageRate(item, now);
  if (r === null) return null;
  return { minQty: clamp(ceil6(r * (LEAD_DAYS + SAFETY_DAYS)), MIN_MAX), buyQty: clamp(ceil6(r * BUY_DAYS), BUY_MAX), rate: r };
}

// ---- 期限 ----
// 今日から期限までの日数(今日=0、期限切れは負)。期限なし/不正は null
export function expiryDays(item, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item?.expiry || '');
  if (!m) return null;
  const e = new Date(+m[1], +m[2] - 1, +m[3]);
  if (e.getMonth() !== +m[2] - 1) return null;
  const n = new Date(now), today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((e - today) / DAY);
}

// ---- 名前の類似 ----
const KATA = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const key = (name) => KATA(String(name || '').normalize('NFKC').toLowerCase()).replace(/[\s\-_()[\],./\\!?~*・、。【】「」『』※☆★〜]+/g, '');
// 単位・数量を除いた商品名(「牛乳1L」と「牛乳500ml」を同じ商品として学習するため)
const base = (k) => k.replace(/\d+(?:\.\d+)?(?:ml|kg|mg|cm|mm|l|g|個|枚|本|袋|パック|入り?|コ|ロール|p)?/g, '') || k;
const grams = (k) => { const s = new Set(); if (k.length < 2) s.add(k); for (let i = 0; i < k.length - 1; i++) s.add(k.slice(i, i + 2)); return s; };
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = grams(a), y = grams(b); let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}
// 重複判定用の類似度。数字が両方にあって食い違えば別商品(500mlと900ml)として 0
export function nameSim(a, b) {
  const ka = key(a), kb = key(b);
  const na = (ka.match(/\d+/g) || []).sort().join(','), nb = (kb.match(/\d+/g) || []).sort().join(',');
  if (na && nb && na !== nb) return 0;
  return dice(ka, kb);
}

// 同じ商品としてまとめた品目(keep に others を統合)。数量は合算、barcode/srcKeys/履歴は引き継ぐ
export function mergeItems(keep, others, now = Date.now()) {
  const all = [keep, ...others];
  const out = { ...keep };
  out.qty = all.reduce((a, x) => a + (+x.qty || 0), 0);
  for (const f of ['barcode', 'category', 'location', 'price']) if (!out[f]) { const v = all.map((x) => x[f]).find(Boolean); if (v) out[f] = v; }
  out.minQty = Math.max(...all.map((x) => +x.minQty || 0));
  out.buyQty = Math.max(1, ...all.map((x) => +x.buyQty || 0));
  const ex = all.map((x) => x.expiry).filter(Boolean).sort()[0]; if (ex) out.expiry = ex;
  const bt = all.map((x) => x.boughtAt).filter(Boolean).sort().pop(); if (bt) out.boughtAt = bt;
  const keys = [...new Set(all.flatMap((x) => x.srcKeys || []))]; if (keys.length) out.srcKeys = keys;
  const log = cleanLog(all.flatMap((x) => cleanLog(x.log, now))); delete out.log; if (log.length) out.log = log;
  return out;
}

function findDuplicates(items, now) {
  const ks = items.map((i) => key(i.name)), par = items.map((_, i) => i), sims = new Map();
  const find = (x) => (par[x] === x ? x : (par[x] = find(par[x])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (!ks[i] || !ks[j]) continue;
    if (a.barcode && b.barcode && a.barcode !== b.barcode) continue; // 別バーコード=別の商品として登録されている
    const s = nameSim(a.name, b.name);
    if (s >= DUP_SIM) { par[find(i)] = find(j); sims.set(i + ',' + j, s); }
  }
  const groups = new Map();
  items.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) || []), i]); });
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const list = g.map((i) => items[i]);
    // 残す側: バーコードあり > 履歴が長い > 先に登録された方
    const keep = [...list].sort((a, b) => !!b.barcode - !!a.barcode || cleanLog(b.log).length - cleanLog(a.log).length)[0];
    const others = list.filter((x) => x !== keep);
    const sim = Math.min(...[...sims].filter(([k]) => k.split(',').every((n) => g.includes(+n))).map(([, v]) => v));
    out.push({ items: list, keep, merged: mergeItems(keep, others, now), sim });
  }
  return out;
}

// ---- 自動分類 ----
// 名前に当たったら置き場所を決める(カテゴリより細かい)
const NAME_LOC = [
  [/食器|キュキュット|ジョイ|スポンジ|たわし|ラップ|ホイル|キッチン|ふきん|布巾|ゴミ袋|ごみ袋|保存袋|割り?箸/, 'キッチン'],
  [/トイレ(?!ット)|カビ取|バス用|お?風呂/, '風呂・トイレ'],
  [/シャンプー|リンス|コンディショナー|トリートメント|ボディソープ|ハンドソープ|歯磨|歯ブラシ|洗顔|洗口|マウスウォッシュ|化粧水|乳液|洗濯|柔軟剤|漂白/, '洗面所'],
];
// カテゴリごとの既定の置き場所(確信度つき。日用品・薬・消耗品は家ごとに違うので既定なし=空のまま)
const CAT_LOC = { 食品: ['キッチン', 0.7], 飲料: ['キッチン', 0.7], '洗剤・衛生': ['洗面所', 0.65] };

// 品目の category / location が空のとき、埋める値を推定して返す(埋めない項目は '')。
// 優先: 1 学習(手で付けた分類を持つ類似名の品目) 2 辞書(guessCategory) 3 置き場所の既定。確信度が低ければ空。
// 戻り値 {category, location, conf:{category, location}, from:{category, location}}
// opts.locs: 有効な置き場所の一覧(これ以外は返さない)
export function autoClassify(item, items = [], opts = {}) {
  const res = { category: '', location: '', conf: { category: 0, location: 0 }, from: { category: '', location: '' } };
  const bk = base(key(item?.name));
  if (!bk) return res;
  const needCat = !item.category, needLoc = !item.location;
  const okLoc = (l) => l && (!opts.locs || opts.locs.includes(l));
  const teachers = (items || []).filter((x) => x !== item && x.id !== item.id && !x.auto && x.name)
    .map((x) => ({ x, s: dice(bk, base(key(x.name))) })).filter((t) => t.s >= LEARN_SIM);
  const vote = (field, valid) => {
    const m = new Map();
    for (const { x, s } of teachers) if (valid(x[field])) { const v = m.get(x[field]) || { sum: 0, best: 0 }; v.sum += s; v.best = Math.max(v.best, s); m.set(x[field], v); }
    return [...m].sort((a, b) => b[1].sum - a[1].sum)[0];
  };
  if (needCat) {
    const v = vote('category', Boolean);
    if (v) Object.assign(res, { category: v[0] }), (res.conf.category = v[1].best, res.from.category = 'learned');
    else {
      const g = guessCategory(item.name);
      if (g) { res.category = g; res.conf.category = 0.7; res.from.category = 'dict'; }
    }
    if (res.conf.category < MIN_CONF) Object.assign(res, { category: '' }), (res.conf.category = 0, res.from.category = '');
  }
  if (needLoc) {
    const v = vote('location', okLoc);
    if (v) { res.location = v[0]; res.conf.location = v[1].best; res.from.location = 'learned'; }
    else {
      const nm = NAME_LOC.find(([re]) => re.test(String(item.name).normalize('NFKC')));
      const cat = item.category || res.category, cl = CAT_LOC[cat];
      if (nm && okLoc(nm[1])) { res.location = nm[1]; res.conf.location = 0.8; res.from.location = 'name'; }
      else if (cl && okLoc(cl[0])) { res.location = cl[0]; res.conf.location = cl[1]; res.from.location = 'category'; }
    }
    if (res.conf.location < MIN_CONF) Object.assign(res, { location: '' }), (res.conf.location = 0, res.from.location = '');
  }
  return res;
}

// ---- まとめ分析 ----
// opts.locs: 自動分類で使う置き場所の一覧
export function plan(items, now = Date.now(), opts = {}) {
  const list = (items || []).filter((i) => i && i.name);
  const soonOut = [], expiring = [], parSuggestions = [], uncategorized = [], autoFill = [], overstock = [];
  let ready = 0, tracking = 0, eta = null;
  for (const i of list) {
    const qty = +i.qty || 0, dl = daysLeft(i, now);
    const ls = learnState(i, now);
    if (ls.ready) ready++;
    else if (cleanLog(i.log, now).length) { tracking++; const e = Math.max(1, Math.ceil(MIN_SPAN_DAYS - ls.spanDays)); eta = eta === null ? e : Math.min(eta, e); }
    if (dl !== null && dl <= SOON_DAYS) soonOut.push({ item: i, days: dl });
    const ed = expiryDays(i, now);
    if (qty > 0 && ed !== null && ed <= EXPIRY_DAYS) expiring.push({ item: i, days: ed, expired: ed < 0 });
    const sug = suggestPar(i, now);
    if (sug) {
      const cur = { minQty: +i.minQty || 0, buyQty: +i.buyQty || 1 };
      const far = (a, b) => Math.abs(a - b) >= PAR_DIFF_ABS && Math.abs(a - b) >= PAR_DIFF_REL * Math.max(a, b);
      if (far(cur.minQty, sug.minQty) || far(cur.buyQty, sug.buyQty)) parSuggestions.push({ item: i, cur, sug: { minQty: sug.minQty, buyQty: sug.buyQty }, rate: sug.rate });
    }
    if (!i.category || !i.location) {
      const r = autoClassify(i, list, opts);
      if (!i.category) uncategorized.push({ item: i, guess: r.category });
      if (r.category || r.location) autoFill.push({ item: i, ...r });
    }
    if (qty > 0) {
      const last = cleanLog(i.log, now).pop()?.t ?? (Number.isFinite(i.updatedAt) ? i.updatedAt : null);
      const idle = last === null ? 0 : (now - last) / DAY;
      if (idle >= IDLE_DAYS && qty >= OVER_MIN_QTY && (dl === null ? qty >= OVER_NORATE_QTY : dl >= OVER_DAYS)) overstock.push({ item: i, idleDays: Math.floor(idle), days: dl });
    }
  }
  soonOut.sort((a, b) => a.days - b.days);
  expiring.sort((a, b) => a.days - b.days);
  overstock.sort((a, b) => b.idleDays - a.idleDays);
  return { soonOut, expiring, parSuggestions, duplicates: findDuplicates(list, now), uncategorized, autoFill, overstock,
    learning: { ready, tracking, total: list.length, etaDays: eta ?? MIN_SPAN_DAYS } };
}
