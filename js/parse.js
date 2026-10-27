import { guessCategory } from './category.js';

// 商品名の正規化(重複判定用)
export const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

const CJK = 'ぁ-んァ-ヶー一-龠々';
const UNIT = '個コこ点本袋枚ケ';
const num = (s) => +String(s).replace(/[,\s¥]/g, '');
const lastNum = (s) => { const m = s.match(/(\d[\d,]*)\s*$/); return m ? num(m[1]) : 0; };
const validAmt = (s) => /^-?(\d{1,3}(,\d{3})+|\d+)$/.test(s);

// 品目ではない行(合計・支払・ポイント・電話番号・登録番号など)。割引・値引は別途拾う。
const SKIP = /合計|小計|総計|税|お預|預り|預かり|お釣|釣|おつり|現金|現計|ポイント|TEL|電話|登録番号|領収|クレジット|カード|レジ(?!袋)|担当|様|お買上|点数|対象|支払|交通系|PayPay|ありがとう|いらっしゃい|またお越し|ご来店|取引|伝票|責任者|番号|レシート|返品|電子マネー|Suica|nanaco|WAON|QUICPay|楽天Edy|バーコード|商品代金|値引合計|税率|課税|決済|利用額|ご利用|引換券|メルペイ|楽天ペイ|人数|テーブル|店番|POSNO|\bNo\.?\s*\d|https?:|www\./i;
// 日付・時刻・電話番号・登録番号T+13桁など
const NOISE = /\d{4}\s*[\/年.\-]\s*\d{1,2}\s*[\/月.\-]\s*\d{1,2}|\d{1,2}:\d{2}|令和|[RＲ]\d{1,2}[.\/]\d{1,2}[.\/]\d{1,2}|\d{2,4}-\d{2,4}-\d{3,4}|T\s?\d{13}|^No\.?\s*\d|^〒/;
const TOTAL = /合計|総計|お会計|現計|お買上(?!点数)|ご請求|TOTAL/i;
const NOT_TOTAL = /小計|点数|対象|ポイント|消費税|内税|外税|税額/;
const TAX = /外税|消費税|税額|税金/;
const PAY = /クレジット|カード決済|PayPay|ペイ|コード決済|電子マネー|交通系|Suica|nanaco|WAON|QUICPay|楽天Edy|現金|お預|預り|預かり|お釣|おつり|釣/i;
const DISC = /値引|割引|値下|クーポン|\d\s*%\s*(?:OFF|引)|\d割/i;
const STORE_KW = /店|ストア|マート|スーパー|ドラッグ|薬局|薬店|市場|マーケット|ローソン|セブン|ファミリーマート|ファミマ|イオン|コープ|生協|ミニストップ|ドン・キホーテ|ダイソー|ホームセンター|百貨店|モール|ココカラ|マツモトキヨシ|ウエルシア|サンドラッグ|ツルハ|コスモス|西友|ヨークベニマル|カスミ|ヤオコー|マルエツ|サミット|ベルク|いなげや/;
const NOT_STORE = /領収|レシート|いらっしゃい|ありがとう|ご利用|責任者|担当|レジ|様|TEL|電話|登録番号|[都道府県].*[市区町村郡]|https?:|www\./i;

// 日付(西暦 / 令和 / R6.10.26 / 24/10/26 時刻付き)→ YYYY-MM-DD。見つからなければ ''
export function findDate(text) {
  const t = String(text ?? '').normalize('NFKC');
  const ymd = (y, m, d) => (y >= 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '');
  // 「年」が % や記号に化けたもの・区切りの前の余計なカンマ(「2026,/08/27」)も許す
  let m = t.match(/(\d{4})\s*,?\s*[\/年.\-%]\s*(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})/);
  if (m && ymd(+m[1], +m[2], +m[3])) return ymd(+m[1], +m[2], +m[3]);
  m = t.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/) || t.match(/[RＲ]\s*(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{1,2})/);
  if (m && ymd(2018 + +m[1], +m[2], +m[3])) return ymd(2018 + +m[1], +m[2], +m[3]);
  m = t.match(/(?:^|\D)(\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\s*(?:\([月火水木金土日]\))?\s*\d{1,2}:\d{2}/);
  if (m && ymd(2000 + +m[1], +m[2], +m[3])) return ymd(2000 + +m[1], +m[2], +m[3]);
  // 千の位が読めない「<026年 09月 22日」: 下2桁だけ使う
  m = t.match(/\D{1,2}0?(\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m && ymd(2000 + +m[1], +m[2], +m[3])) return ymd(2000 + +m[1], +m[2], +m[3]);
  // 最後の手段: 取引番号などに埋め込まれた YYYYMMDD(12桁以上の数字列の中)
  for (const run of t.match(/\d{12,}/g) || []) {
    const r = run.match(/(20[1-4]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
    if (r) return `${r[1]}-${r[2]}-${r[3]}`;
  }
  return '';
}

// 「牛 乳」「お 預 り」のような1文字ずつの空白だけ詰める(「ハンドソープ ポンプ」のような単語間は残す)
const joinSpaced = (s) => {
  const out = []; let prevLen = 0;
  for (const tk of s.split(' ')) {
    const n = Math.min(prevLen, tk.length);
    if (out.length && n === 1 && prevLen + tk.length <= 3 && new RegExp(`[${CJK}]$`).test(out[out.length - 1]) && new RegExp(`^[${CJK}]`).test(tk)) out[out.length - 1] += tk;
    else out.push(tk);
    prevLen = tk.length;
  }
  return out.join(' ');
};

// OCR特有の崩れを1行ずつ補正する(全角半角・「¥」誤認識・桁区切り・符号・税マーク)
function cleanLine(raw) {
  let s = raw.normalize('NFKC').replace(/[\u200b\t]/g, ' ');
  s = s.replace(/^[※*◆●]+\s*/, '').replace(/^\(?軽\)?\s+/, ''); // 軽減税率マーク(前置き)
  s = s.replace(/[−―—–]/g, '-').replace(/[▲△▼]\s*/g, '-').replace(/(^|[\s¥])ー(?=\s*¥?\d)/g, '$1-');
  s = s.replace(/\\\s*(?=[\d-])/g, '¥');
  // 行末の金額の前の Y / 羊 / 半 は ¥ の誤認識
  const tail = String.raw`(?=\s?-?\d[\d,.\s]*(?:[※*軽外内]|円)?\s*$)`;
  s = s.replace(new RegExp(`(^|[\\s.…・]|[${CJK}])[Y羊]${tail}`, 'g'), '$1¥');
  s = s.replace(new RegExp(`(^|[\\s.…・])半${tail}`, 'g'), '$1¥');
  s = joinSpaced(s.replace(/\s+/g, ' '));
  s = s.replace(/-\s*¥/g, '¥-').replace(/¥\s+/g, '¥');
  s = s.replace(/¥\s?[\]|!lI](?=[\d,])/g, '¥1'); // 「¥],579」(1が ] に化ける)
  s = s.replace(/(\d)\s*[,.]\s(?=\d{3}(?!\d))/g, '$1,'); // 「¥3. 534」「1, 280」
  s = s.replace(/(\d)\s*,\s*(?=\d{3}(?!\d))/g, '$1,'); // 「1, 280」
  s = s.replace(/(¥-?)([1-9]\d{0,2})\.(\d{3})(?!\d)/g, '$1$2,$3').replace(/(\s)([1-9]\d{0,2})\.(\d{3})\s*$/, '$1$2,$3'); // 「1.280」(カンマがピリオドに)
  s = s.replace(/(\d[\d,]*)\s*-\s*$/, '-$1'); // 「50-」
  s = s.replace(/\s[*※◆](?=¥?\d)/g, ' '); // 金額の前に付く軽減税率マーク「*1,020」
  s = s.replace(/([\d,])\s*[(（]?[軽外内][)）]?\s*$/, '$1').replace(/([\d,])\s*[※*◆]+\s*$/, '$1'); // 軽減税率マーク(後置き)
  s = s.replace(/(\d)\s+\d{1,2}%\s*$/, '$1').replace(/([\d,])\s*円\s*$/, '$1');
  s = s.replace(/(¥-?[\d,]+)\s*[^\s\d,.¥)）]{1,2}$/, '$1'); // 「¥630%」「¥198 電」(軽マークが記号や別の字に化ける)
  return s.replace(/\s+/g, ' ').trim();
}

// 「2コ x 198 396」「198×2」「@198 x 2」→ { qty, unit(単価), total }
const QT = new RegExp(`^[(（]?\\s*(@|単価?)?\\s*¥?(\\d[\\d,]*)\\s*([${UNIT}])?\\s*[x×*@]\\s*(@|単価?)?\\s*¥?(\\d[\\d,]*)\\s*([${UNIT}]|[^\\s\\d)）]{1,2})?\\s*[)）]?(?:\\s+¥?(\\d[\\d,]*))?$`, 'i');
const QONLY = new RegExp(`^[(（]?\\s*(?:数量\\s*[:：]?\\s*(\\d{1,2})|(\\d{1,2})\\s*[${UNIT}]|[x×]\\s*(\\d{1,2}))\\s*[)）]?(?:\\s+¥?(\\d[\\d,]*))?$`, 'i');
const QTAIL = new RegExp(`\\s+([(（]?\\s*(?:@|単価?)?\\s*¥?\\d[\\d,]*\\s*(?:[${UNIT}])?\\s*[x×*@]\\s*(?:@|単価?)?\\s*¥?\\d[\\d,]*\\s*(?:[${UNIT}]|[^\\s\\d)）]{1,2})?\\s*[)）]?)$`, 'i');
function qtyLine(s) {
  let m = s.match(QT);
  if (m) {
    const [, pa, a, ua, pb, b, ub, t] = m;
    const A = num(a), B = num(b), T = t ? num(t) : null;
    let qty, unit;
    if (pa) [unit, qty] = [A, B];
    else if (pb || ua) [qty, unit] = [A, B];
    else if (ub) [qty, unit] = [B, A];
    else [qty, unit] = [Math.min(A, B), Math.max(A, B)];
    if (qty < 1 || qty > 99) return null;
    return { qty, unit, total: T };
  }
  m = s.match(QONLY);
  if (m) {
    const qty = +(m[1] || m[2] || m[3]);
    return qty >= 1 && qty <= 99 ? { qty, unit: 0, total: m[4] ? num(m[4]) : null } : null;
  }
  return null;
}

function cleanName(n) {
  return n.replace(/^[※*◆●・\-\s]+/, '').replace(/^\d{8,14}\s*/, '').replace(/^0\d{1,2}\s+/, '')
    .replace(/[¥|_]+/g, ' ').replace(/[\s.…・:]+$/, '').replace(/\s+/g, ' ').trim();
}
const hasWord = (s) => /[ぁ-んァ-ヶ一-龠]/.test(s) || /[A-Za-z]{2}/.test(s); // 記号と1文字の英字だけ(「= =t」)は品名ではない

// 店名: 先頭付近で「店」などを含む行を優先。無ければ先頭の文字行
function findStore(lines) {
  const cand = lines.slice(0, 10).filter((s) => s && !NOISE.test(s) && !NOT_STORE.test(s) && !/\d\s*$/.test(s) && hasWord(s) && s.length >= 2);
  const s = cand.find((x) => STORE_KW.test(x)) || (lines.slice(0, 5).includes(cand[0]) ? cand[0] : '');
  return (s || '').replace(/^[*=\-_#\s]+|[*=\-_#\s]+$/g, '').slice(0, 30);
}

// 解析本体。品目と、店名・日付・合計(・外税・全体値引)を返す
function analyze(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/).map(cleanLine);
  const meta = { store: findStore(lines), date: findDate(src), total: 0, tax: 0, adjust: 0 };
  const items = [];
  let last = null, pend = null, seq = 0, sub = false; // last: 直前の品目 {it, seq} / pend: 品名だけの行
  const subs = [], pays = []; // 小計の金額(複数税率なら複数) / 支払行 {kind, amt}
  let closed = false; // 「合計」を読んだ後は、支払・ポイント・広告の行(品目は合計の前に並ぶ)

  const push = (name, qty, price, s) => {
    const it = { name, qty, price, boughtAt: meta.date, source: 'receipt', category: guessCategory(name) };
    items.push(it); last = { it, seq: s };
  };
  const discount = (d) => {
    if (!(d > 0) || meta.total) return;
    if (last) { last.it.price = Math.max(0, last.it.price - d); last.it.discount = (last.it.discount || 0) + d; }
    else if (sub) meta.adjust += d; // 小計のあとの値引は全体値引
  };
  const applyQty = (r, ql) => {
    r.it.qty = ql.qty;
    if (ql.total) r.it.price = ql.total;
    else if (ql.unit && r.it.price === ql.unit && ql.qty > 1) r.it.price = ql.unit * ql.qty; // 品名行が単価だった
  };

  for (const s of lines) {
    if (!s) continue;
    seq++;
    const p = pend && pend.seq === seq - 1 ? pend : null; pend = null;
    if (NOISE.test(s) || /^[(（]?\s*\d{1,2}\s*%\s*\S{0,6}\s*¥?[\d,]+\)?$/.test(s)) continue; // 日付・電話・「8%対象 ¥1,579」などの税率行
    if (TOTAL.test(s) && !NOT_TOTAL.test(s)) { const a = lastNum(s); if (a) { meta.total = a; closed = true; } last = null; sub = true; continue; }
    if (/小計|(?:^|\s)計\s*¥?\d/.test(s) && !/合計|総計/.test(s)) { const a = lastNum(s); if (a && !meta.total) subs.push(a); last = null; sub = true; continue; } // 「小計」の「小」が落ちた「計 ¥1,579」も
    if (sub && !meta.total && subs.length) { // 「合計」が化けた行(「=E ¥3,000」など): 文字がほぼ無く、金額が 小計(+税)と合うなら合計とみなす
      const jm = s.match(/^[^\dぁ-んァ-ヶ一-龠]{0,4}[A-Za-z=＝~ー\-]{0,3}\s*¥?\s*(\d[\d,]*)$/);
      if (jm && validAmt(jm[1])) { const a = num(jm[1]), base = subs.reduce((x, y) => x + y, 0), tx = meta.tax; if (a === base || a === subs[subs.length - 1] || (tx && a === base + tx)) { meta.total = a; last = null; continue; } }
    }
    if (closed && !TAX.test(s)) { if (PAY.test(s)) { const a = lastNum(s); if (a) pays.push({ kind: /現金|お預|預り|預かり/.test(s) ? 'cash' : /釣/.test(s) ? 'change' : 'pay', amt: a }); } continue; }
    if (PAY.test(s)) { const a = lastNum(s); if (a) pays.push({ kind: /現金|お預|預り|預かり/.test(s) ? 'cash' : /釣/.test(s) ? 'change' : 'pay', amt: a }); }
    if (TAX.test(s) && !/内/.test(s)) { meta.tax += lastNum(s.replace(/\d+(?:\.\d+)?\s*%/g, '')); continue; }
    if (/[都道府県].{1,12}[市区町村郡]/.test(s)) continue; // 住所の行(丁目・番地が金額に見える)
    if (SKIP.test(s) && !(DISC.test(s) && !/ポイント/.test(s))) continue; // 「会員カード割引」などは値引として拾う

    const ql = qtyLine(s);
    if (ql) {
      if (p) { const price = ql.total || ql.unit * ql.qty; if (price > 0) push(p.name, ql.qty, price, seq); }
      else if (last && last.seq === seq - 1) { applyQty(last, ql); last.seq = seq; }
      continue;
    }
    const neg = s.match(/^¥?-\s*¥?(\d[\d,]*)$/);
    if (DISC.test(s) || neg) { discount(neg ? num(neg[1]) : Math.abs(lastNum(s))); continue; }
    const only = s.match(/^¥?(\d[\d,]*)$/);
    if (only) { // 長い品名が折り返され、金額だけが次の行に来た形
      if (p && validAmt(only[1]) && num(only[1]) > 0) push(p.name, 1, num(only[1]), seq);
      continue;
    }

    const m = s.match(/^(.+?)(?:[\s.…・]*¥|[\s.…・]+)(-?\d[\d,]*)$/);
    if (m) {
      let name = cleanName(m[1]), price = num(m[2]), qty = 1, unit = 0, t;
      if (!validAmt(m[2]) || /^0\d/.test(m[2]) || price >= 1e6 || (!/¥/.test(s) && m[2].replace(/\D/g, '').length < 2)) continue;
      if (price < 0) { discount(-price); continue; }
      if ((t = name.match(QTAIL)) && qtyLine(t[1])) { const q = qtyLine(t[1]); name = name.slice(0, t.index); qty = q.qty; unit = q.unit; }
      else if ((t = name.match(/\s+(?:@|単価?)\s*¥?(\d[\d,]*)$/))) { name = name.slice(0, t.index); unit = num(t[1]); if (unit && price % unit === 0 && price / unit <= 99) qty = price / unit; }
      else if ((t = name.match(new RegExp(`\\s*[(（]?(\\d{1,2})\\s*[${UNIT}]?\\s*[x×*@]$`, 'i')))) { name = name.slice(0, t.index); qty = +t[1]; unit = price; price = unit * qty; } // 「2コ x」+ 単価だけ
      else if ((t = name.match(new RegExp(`(?:[x×*]\\s*(\\d{1,2})|(\\d{1,2})\\s*[${UNIT}])\\s*$`, 'i')))) { qty = +(t[1] || t[2]); name = name.replace(t[0], ''); }
      name = cleanName(name);
      if (!name || price <= 0 || !hasWord(name) || /\d\s*-\s*$/.test(name)) continue; // 「…45 6-」は電話番号の断片
      if (unit && price === unit && qty > 1) price = unit * qty;
      push(name, qty, price, seq);
      continue;
    }
    if (hasWord(s) && s.length >= 2 && !/\d{4,}/.test(s)) pend = { name: cleanName(s), seq }; // 次行が数量行なら品名として使う
  }
  // 合計が見つからなかったら、支払行から推定する(キャッシュレス → その金額 / 現金 → お預り − お釣り)
  if (!meta.total) {
    const pay = pays.find((x) => x.kind === 'pay'), cash = pays.find((x) => x.kind === 'cash'), chg = pays.find((x) => x.kind === 'change');
    if (pay) meta.total = pay.amt;
    else if (cash) meta.total = cash.amt - (chg && chg.amt < cash.amt ? chg.amt : 0);
  }
  repairAmounts(items, meta, subs);
  return { items, meta };
}

// 検算が合わないとき、桁が化けた金額(軽減税率マークが数字に化けた「¥10982」など)を、小計/合計との一致を手がかりに直す。
// 合わせられる組み合わせが見つかった場合だけ書き換える(見つからなければ何もしない)
function repairAmounts(items, meta, subs) {
  const sum = items.reduce((a, i) => a + i.price, 0);
  const targets = [];
  if (subs.length === 1) targets.push(subs[0]);
  else if (subs.length > 1) targets.push(subs.reduce((a, b) => a + b, 0));
  if (meta.total) { targets.push(meta.total - (meta.tax || 0) + (meta.adjust || 0)); targets.push(meta.total + (meta.adjust || 0)); }
  if (!targets.length || targets.includes(sum)) return;
  // 品目の金額が小計/合計を超えることはない: 超えていたら、軽減税率マークが数字に化けた(下2桁が余分)とみて落とす
  const bound = Math.max(...subs, meta.total || 0);
  const mark = (it) => Object.defineProperty(it, 'repaired', { value: true, enumerable: false }); // 補正した行の印(保存データには出さない)
  if (bound) for (const it of items) if (it.price > bound && it.qty === 1) { it.price = Math.floor(it.price / 100) || it.price; mark(it); }
  const sum2 = items.reduce((a, i) => a + i.price, 0);
  if (targets.includes(sum2)) return;
  const sus = items.map((it, i) => ({ it, i })).filter(({ it }) => it.price >= 1000 && it.qty === 1).sort((a, b) => b.it.price - a.it.price).slice(0, 5); // 4桁以上で数量1の行だけが疑わしい(桁の多い順)
  if (!sus.length) return;
  const alts = (p) => [p, Math.floor(p / 10), Math.floor(p / 100)].filter((x, k, arr) => x > 0 && arr.indexOf(x) === k);
  for (const t of targets) {
    const rest = sum - sus.reduce((a, { it }) => a + it.price, 0);
    const pick = (k, acc, cur) => { // 全探索(最大3^5通り)
      if (k === sus.length) return acc === t ? cur : null;
      for (const v of alts(sus[k].it.price)) { const r = pick(k + 1, acc + v, [...cur, v]); if (r) return r; }
      return null;
    };
    const r = pick(0, rest, []);
    if (r) { sus.forEach(({ it }, k) => { if (it.price !== r[k]) mark(it); it.price = r[k]; }); return; }
  }
}

// レシートOCR結果 → 品目候補。OCRは崩れるので、取り込み前に必ず人が確認・修正する画面を挟む。
// price は行の金額(数量ぶんの合計・値引後)。
export function parseReceipt(text) { return analyze(text).items; }

// 店名・日付・合計(+ 外税額 tax / 全体値引 adjust)。取れなかった項目は ''/0
export function parseReceiptMeta(text) { return analyze(text).meta; }

// 品目の合計とレシートの合計の検算。ok: true 一致 / false 不一致 / null 合計不明。diff = 品目側 − レシート側
export function checkTotal(items, meta) {
  const sum = items.reduce((a, i) => a + (+i.price || 0), 0);
  const total = meta?.total || 0;
  if (!total) return { ok: null, sum, total: 0, diff: 0 };
  const base = sum - (meta.adjust || 0) - total;
  const withTax = base + (meta.tax || 0); // 外税レシート
  const diff = Math.abs(withTax) < Math.abs(base) ? withTax : base;
  return { ok: diff === 0, sum, total, diff };
}

// 注文確認メール(Amazon.co.jp等の本文テキスト) → 品目候補
// 「商品名の行 → 数量: N → 価格」という並びを前提に、ゆるく拾う。
export function parseOrderMail(text, { date = '', key = '', source = 'amazon' } = {}) {
  const lines = text.normalize('NFKC').split(/\r?\n/).map((l) => l.trim());
  const out = [];
  const HEAD = /^(ご注文|注文|商品名|数量|配送|お届け|合計|小計|ご請求|お支払|http|\*+$|-+$|=+$|\[)/;
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i].match(/^数量\s*[:：]\s*(\d+)/);
    if (!q) continue;
    let j = i - 1;
    while (j >= 0 && (!lines[j] || HEAD.test(lines[j]))) j--;
    if (j < 0) continue;
    const name = lines[j].replace(/^[*・\-\s]+/, '');
    let price = 0;
    for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
      const p = lines[k].match(/(?:[¥￥]\s*([\d,]+)|([\d,]+)\s*(?:JPY|円))/);
      if (p) { price = +(p[1] || p[2]).replace(/,/g, ''); break; }
    }
    out.push({ name, qty: +q[1], price, boughtAt: date, source, srcKey: `${key}:${norm(name)}` });
  }
  return out;
}
