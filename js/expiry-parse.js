// 賞味期限・消費期限の印字(OCRの文字列)から、期限の日付を取り出す純粋関数(DOM非依存)。
// parseExpiry(text, { today, boughtAt }) → { candidates:[{ date, kind, label, conf, raw }], best, mfg, opened, note }
//  - date: 'YYYY-MM-DD'。年月だけの印字は月末、年なしは today 以降で最も近い日に補う(label に「月末扱い」「年を補った」と書く)
//  - kind: '賞味' | '消費' | '不明'(ラベル語から決める。ラベルが無ければ不明)
//  - conf: 0〜1。best は conf が BEST_MIN 以上の最上位だけ(確信が低ければ null = 答えない)
//  - mfg: 製造日などとして除いた日付 [{ date, raw }](期限としては採らない)。製造日+「製造後◯日」は期限を計算して candidates に入れる
//  - opened: 「開封後は◯日以内」の目安 [{ days, raw }](期限ではないので candidates には入れない)
//  - note: 「枠外下部に記載」など、日付が別の場所にあるとき '枠外に記載' (日付が見つからない旨の案内に使う)
export const BEST_MIN = 0.5;

const pad = (n) => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const valid = (y, m, d) => y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= dim(y, m);
const dayNo = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 864e5);
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const fromDayNo = (n) => { const t = new Date(n * 864e5); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };

function parseDay(v) {
  if (v instanceof Date && !isNaN(v)) return [v.getFullYear(), v.getMonth() + 1, v.getDate()];
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v ?? ''));
  if (m && valid(+m[1], +m[2], +m[3])) return [+m[1], +m[2], +m[3]];
  return null;
}

// 空白に置き換える(改行は残す。長さは変えない)
const blank = (s, re, test) => s.replace(re, (m, ...a) => (test && !test(m, ...a) ? m : m.replace(/[^\n]/g, ' ')));

// ---------- ラベル語 ----------
const MON_RE = 'JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monNo = (s) => MONTHS.indexOf(s.slice(0, 3).toUpperCase()) + 1;

const LABELS = [
  // 賞味
  { re: /品[質食業廣]?保[持特港]?(?:期?[限隈眼服恨艮])?|ご?[賞黄黃営曹富愛寶童]味(?:期?[限隈眼服恨艮]|期間)?|(?<![A-Za-z])BEST[\s-]*(?:BEFORE|BEF[O0]RE|BY)|(?<![A-Za-z])BB[ED]?(?![A-Za-z])/i, type: 'exp', kind: '賞味' },
  // 消費
  { re: /消[費貴普麦]期?[限隈眼服恨艮煙明]?(?![者税量])|お召し上がり期限|(?<![A-Za-z])USE[\s-]*BY|(?<![A-Za-z])USE[\s-]*BEFORE/i, type: 'exp', kind: '消費' },
  // 期限だけ(種類不明)
  { re: /使用期限|期限表示|期[限隈眼服恨艮](?:日)?|(?<![A-Za-z])EXP(?:IRY|IRES|IRATION)?(?:[\s-]*DATE)?(?![A-Za-z])|(?<![A-Za-z])E\s?X\s?P(?![A-Za-z])|(?<![A-Za-z])EXPIRE?D?(?![A-Za-z])/i, type: 'exp', kind: '不明' },
  // 製造日など(期限として採らない)
  { re: /製造(?:年月日|年月|日)|製造(?![者所元業後から日年])|(?<![A-Za-z])(?:MFG|MFD|PKD|PROD)(?![A-Za-z])(?:[\s.-]*DATE)?|MANUFACTURED?(?:[\s-]*(?:ON|DATE))?|DATE\s*OF\s*MANUFACTURE|詰め?\s*日|加工(?:年月)?日|充填日|包装日|収穫日|採卵日|生産日|PACKED(?:[\s-]*ON)?|(?<![A-Za-z])PD(?![A-Za-z])|(?<![A-Za-z])DOM(?![A-Za-z])/i, type: 'mfg', kind: null },
];
const FRAME_RE = /(?:枠外|欄外|缶底|底面|底部|ふた|フタ|蓋|キャップ|袋|ラベル|側面|上部|下部|左側|右側|この面|首|胴|裏|表面|本体|容器|パッケージ|箱|別途|別の場所)[^\n]{0,14}?(?:記載|表示|印字|参照)|SEE\s+(?:THE\s+)?(?:LID|BASE|TOP|SIDE|BOTTOM|CAP|PACK|CAN|BOTTLE|NECK|LABEL|BACK|CODE|END)|(?:ON|ON\s+THE)\s+(?:LID|BASE|TOP|SIDE|BOTTOM|CAP|CAN)/i;

// OCRで数字と取り違えやすい文字
const CONF = { O: '0', o: '0', I: '1', l: '1', '|': '1', '!': '1', S: '5', B: '8' };

// ---------- 日付の解釈 ----------
// 候補1つ: { y, m, d, fmt, eom(月末扱い), yl(年を補った), rel(相対) }
function mk(y, m, d, fmt, extra) { return { y, m, d, fmt, ...extra }; }

export function parseExpiry(text, opt = {}) {
  const T = parseDay(opt.today) || parseDay(new Date());
  const B = parseDay(opt.boughtAt);
  const todayN = dayNo(...T), refN = B ? dayNo(...B) : todayN;
  const yyNow = T[0] - 2000;
  const yearlike = (yy) => yy >= yyNow - 1 && yy <= yyNow + 10;
  const nextFuture = (m, d) => { // today 以降で最も近い (m,d)
    for (let y = T[0]; y <= T[0] + 8; y++) if (valid(y, m, d) && dayNo(y, m, d) >= todayN) return y;
    return null;
  };

  // 1. 正規化(全角→半角、ダッシュ・アポストロフィ)
  let s = String(text ?? '').normalize('NFKC').replace(/\r/g, '').replace(/\t/g, ' ');
  s = s.replace(/(?<=[\dOolIS])[ー‐-―−]+(?=[\dOolISB])/g, '-');
  s = s.replace(/(?<![\d])['’‘`´](\d{2})(?!\d)/g, '20$1'); // '26 → 2026

  const result = { candidates: [], best: null, mfg: [], opened: [], note: '' };

  // 2. 相対表記(製造後◯日など)と、開封後の目安を取り出して空白にする
  const rels = [];
  s = blank(s, /製造(?:年月日|日)?\s*(?:を含[めむ]て?|から|より|後|日から|日より)\s*(\d{1,4})\s*(日|週間|ヶ月|か月|ケ月|カ月|ヵ月|年)\s*(?:以内|間|後)?/g, (m) => {
    const x = /(\d{1,4})\s*(日|週間|ヶ月|か月|ケ月|カ月|ヵ月|年)/.exec(m);
    rels.push({ n: +x[1], unit: x[2], incl: /含/.test(m), raw: m.trim(), at: 0 });
    return true;
  });
  // 位置を保つため、blank 後の位置を求め直す(開封後の処理の後で再計算する)
  s = s.replace(/開封後[^\n。]*/g, (m) => {
    const x = /(\d{1,3})\s*(日|週間|時間|ヶ月|か月|ケ月)\s*(?:以内|間|程度|を目安)/.exec(m);
    if (x) result.opened.push({ days: x[2] === '日' ? +x[1] : x[2] === '週間' ? +x[1] * 7 : x[2] === '時間' ? Math.max(1, Math.round(+x[1] / 24)) : +x[1] * 30, raw: m.trim() });
    else result.opened.push({ days: null, raw: m.trim() });
    return m.replace(/[^\n]/g, ' ');
  });

  // 3. 数字の誤検出を空白にする(電話・バーコード・価格・単位・時刻・ロット・郵便番号)
  s = blank(s, /(?<![\d.])0\d{1,4}[-\s)(]\d{1,4}[-\s)]\d{3,4}(?!\d)/g, (m) => m.replace(/\D/g, '').length >= 10);
  s = blank(s, /(?<!\d)\d[\s-]?\d{5,6}[\s-]?\d{5,6}(?!\d)/g);
  s = blank(s, /(?<![\d.\/-])\d{9,}(?![\d.\/-])/g);
  s = blank(s, /〒\s*\d{3}-?\d{4}/g);
  s = blank(s, /[¥\\]\s*\d[\d,.]*/g);
  s = blank(s, /\d[\d,.]*\s*円/g);
  s = blank(s, /(?<![\d.\/-])-?\d+(?:\.\d+)?\s*(?:kcal|kJ|mg|μg|µg|kg|ml|mL|cc|cl|dl|g|L|%|°C|°|度|個|枚|本|袋|包|粒|入|cm|mm|点|人前|食|杯|切)(?![A-Za-z\d])/g);
  s = blank(s, /(?<![\d.:\/-])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![\d:])/g);
  s = blank(s, /\d{1,2}時(?:\d{1,2}分)?/g);
  s = blank(s, /(?<![A-Za-z])(?:(?:LOT|Lot|ロット)\s*(?:NO|No|no|番号|#)?\.?\s*[:：]?\s*)+(?!LOT)[A-Z0-9][A-Z0-9.\-]{2,}/g);
  s = blank(s, /(?<![A-Za-z0-9])L[:.]?\s?\d{3,}[A-Z0-9]*/g);
  s = blank(s, /(?<![A-Za-z])No\.?\s*\d+/g);

  // 4. OCRの誤読を直す(数字に混じった O,l,I,S,B など)。chg[i] が 1 なら i 文字目を直した
  const chg = new Uint8Array(s.length);
  s = s.replace(/[0-9A-Za-z|!]+/g, (run, off) => {
    if (!/\d/.test(run) || run.length > 8) return run;
    const m = /^[0-9OolIS|!B]+$/.test(run);
    if (!m) return run;
    if (/^[OolIS|!B]{2}/.test(run)) return run; // 先頭の2文字が文字のもの(BB27 など)は触らない
    let out = '';
    for (let i = 0; i < run.length; i++) { const c = run[i]; if (CONF[c]) { out += CONF[c]; chg[off + i] = 1; } else out += c; }
    return out;
  });
  // 数字を含まない短い塊(l1 の l など)も、区切りで数字につながっていれば数字として読む
  s = s.replace(/(?<=\d\s?[.\-/,]\s?)[OolIS|!B]{1,2}(?![A-Za-z0-9])/g, (r, off) => { for (let i = 0; i < r.length; i++) chg[off + i] = 1; return Array.from(r, (c) => CONF[c]).join(''); });
  s = s.replace(/(?<![A-Za-z0-9])[OolIS|!B](?=\s?[.\-/,]\s?\d)/g, (r, off) => { chg[off] = 1; return CONF[r]; });
  // 先頭2桁が 20 でない4桁の年(2628.01 → 2028.01): 下2桁を年とみなす
  s = s.replace(/(?<![\d./-])2[1-9](\d{2})(?=\s?[./-]\s?\d{1,2}(?!\d))/g, (m, yy, off) => { if (+yy < yyNow - 1 || +yy > yyNow + 10) return m; for (let i = 0; i < 4; i++) chg[off + i] = 1; return '20' + yy; });
  // 区切りの崩れ(, ・ 。 : ; _ など)を . にそろえる
  s = s.replace(/(?<=\d)[,、。・･·:;_](?=\s?\d)/g, '.');
  s = s.replace(/(?<=\d)\s{1,2}(?=[.\-/]\s?\d)/g, (m) => m); // 空白はそのまま(後の正規表現で許す)

  // 月名の 0→O (N0V, 0CT)
  const FZ = ['UV', 'HN', 'MN', 'IL', 'CG', 'PR', 'EF', 'B8', 'OD', 'QO'];
  const fuzzyMon = (t) => { // 月名の1文字の取り違え(NOU→NOV、JUH→JUN)を、取り違えやすい字の組だけ直す。決まらなければそのまま
    if (MONTHS.includes(t)) return t;
    const c = MONTHS.filter((m) => { let bad = 0, ok = true; for (let i = 0; i < 3; i++) if (m[i] !== t[i]) { bad++; if (!FZ.some((p) => (p[0] === m[i] && p[1] === t[i]) || (p[1] === m[i] && p[0] === t[i]))) ok = false; } return bad === 1 && ok; });
    return c.length === 1 ? c[0] : t;
  };
  let nm = s.replace(/[A-Za-z0]{3,10}/g, (r, off) => { // 月名の 0→O(ただし数字の直後の 0 は数字のまま: 30DEC)
    if (!/[A-Za-z]/.test(r)) return r;
    let lead = 0; while (lead < r.length && r[lead] === '0' && off + lead > 0 && /\d/.test(s[off + lead - 1])) lead++;
    const keep = r.slice(0, lead) + r.slice(lead).replace(/0/g, 'O'), all = r.replace(/0/g, 'O'), isMon = (x) => MONTHS.includes(x.slice(0, 3));
    return lead && !isMon(keep.slice(lead)) && isMon(all) ? all : keep; // 040CT27 は 04 + OCT(先頭の 0 を数字と読むと月名にならないとき)
  });
  nm = nm.replace(/(?<=\d)[A-Z]{3}(?![A-Za-z])|(?<![A-Za-z])[A-Z]{3}(?=\d)/g, fuzzyMon);

  const plaus = (n) => { const df = n - refN; return df >= -7 && df <= 3650 ? 3 : df >= -60 && df < -7 ? 2 : df >= -3650 && df <= 3650 * 2 ? 1 : 0; };
  // 5. 日付の取り出し(位置が重なるものは先に見つけたものを採る)
  const items = [];
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const add = (m, interps, extra = {}) => {
    const a = m.index, b = a + m[0].length;
    if (!free(a, b)) return;
    taken.push([a, b]);
    const c = chg.slice(a, b).some((x) => x);
    items.push({ a, b, interps, raw: m[0].trim(), fixed: c, ...extra });
  };
  const each = (str, re, fn) => { re.lastIndex = 0; let m; while ((m = re.exec(str))) fn(m); };
  const y4 = (v) => (v.length === 4 ? +v : 2000 + +v);

  // 5-1. 西暦8桁 20261105
  each(s, /(?<![\d])(20\d{2})(\d{2})(\d{2})(?![\d])/g, (m) => { if (valid(+m[1], +m[2], +m[3])) add(m, [mk(+m[1], +m[2], +m[3], 'YMD')]); });
  // 5-2. 和暦
  each(s, /(令和|平成|(?<![A-Za-z])[RH])\s*(\d{1,2}|元)\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?(?![\d])/g, (m) => {
    const base = /令|R/.test(m[1]) ? 2018 : 1988, y = base + (m[2] === '元' ? 1 : +m[2]);
    if (valid(y, +m[3], +m[4])) add(m, [mk(y, +m[3], +m[4], 'YMD')]);
  });
  each(s, /(令和|平成|(?<![A-Za-z])[RH])\s*(\d{1,2}|元)\s*(?:年|[./-])\s*(\d{1,2})\s*月?(?![\d./-])/g, (m) => {
    const base = /令|R/.test(m[1]) ? 2018 : 1988, y = base + (m[2] === '元' ? 1 : +m[2]);
    if (valid(y, +m[3], 1)) add(m, [mk(y, +m[3], dim(y, +m[3]), 'YM', { eom: true })]);
  });
  // 5-3. 年月日
  each(s, /(?<![\d])(\d{4}|\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?![\d])/g, (m) => { const y = y4(m[1]); if (valid(y, +m[2], +m[3])) add(m, [mk(y, +m[2], +m[3], 'YMD')]); });
  each(s, /(?<![\d])(\d{4}|\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*\d)/g, (m) => { const y = y4(m[1]); if (valid(y, +m[2], 1)) add(m, [mk(y, +m[2], dim(y, +m[2]), 'YM', { eom: true })]); });
  each(s, /(?<![\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, (m) => { const y = nextFuture(+m[1], +m[2]); if (y) add(m, [mk(y, +m[1], +m[2], 'MD', { yl: true })]); });
  // 5-4. 英語の月名
  const R1 = new RegExp(`(?<![\\d])(\\d{1,2})(?:st|nd|rd|th)?[\\s.\\-/]*(${MON_RE})(?![A-Za-z])\\.?(?:[\\s.\\-/,]*(\\d{4}|\\d{2})(?![\\d]))?`, 'gi');
  each(nm, R1, (m) => {
    const mo = monNo(m[2]), d = +m[1];
    if (m[3]) { const y = y4(m[3]); if (valid(y, mo, d)) add(m, [mk(y, mo, d, 'DMY')]); return; }
    const y = nextFuture(mo, d); if (y) add(m, [mk(y, mo, d, 'DM', { yl: true })]);
  });
  const R2 = new RegExp(`(?<![A-Za-z])(${MON_RE})(?![A-Za-z])\\.?[\\s.\\-/]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,.\\-/]+(\\d{4}|\\d{2})(?![\\d])`, 'gi');
  each(nm, R2, (m) => { const mo = monNo(m[1]), d = +m[2], y = y4(m[3]); if (valid(y, mo, d)) add(m, [mk(y, mo, d, 'MDY')]); });
  const R3 = new RegExp(`(?<![A-Za-z])(${MON_RE})(?![A-Za-z])\\.?[\\s.\\-/]*(\\d{4}|\\d{2})(?![\\d])`, 'gi');
  each(nm, R3, (m) => {
    const mo = monNo(m[1]), v = m[2];
    if (v.length === 4) { if (valid(+v, mo, 1)) add(m, [mk(+v, mo, dim(+v, mo), 'MY', { eom: true })]); return; }
    if (yearlike(+v) && +v > 12) { const y = 2000 + +v; add(m, [mk(y, mo, dim(y, mo), 'MY', { eom: true })]); return; }
    const y = nextFuture(mo, +v); if (+v <= 31 && y) add(m, [mk(y, mo, +v, 'MD', { yl: true })]);
  });
  // 5-5. 数字3つ(年月日・日月年・月日年)
  const tri = (A, Bs, C) => {
    const Bm = +Bs, ints = [];
    if (A.length === 4) { if (C.length <= 2) ints.push(mk(+A, Bm, +C, 'YMD')); }
    else if (C.length === 4) { if (A.length <= 2) { ints.push(mk(+C, Bm, +A, 'DMY')); ints.push(mk(+C, +A, Bm, 'MDY')); } }
    else if (A.length <= 2 && C.length <= 2) {
      ints.push(mk(2000 + +A, Bm, +C, 'YMD')); ints.push(mk(2000 + +C, Bm, +A, 'DMY')); ints.push(mk(2000 + +C, +A, Bm, 'MDY'));
    }
    return ints.filter((x) => valid(x.y, x.m, x.d));
  };
  // ドット印字で 0 と 8、8 と 6 などを取り違えて日付にならないとき、1文字だけ直して(今日の前後で)ただ1つの日付になるなら採る
  const CD = { 8: ['0'], 0: ['8'], 6: ['8', '0'], 3: ['8'] };
  const vars = (tok) => { const o = []; for (let i = 0; i < tok.length; i++) for (const r of CD[tok[i]] || []) o.push(tok.slice(0, i) + r + tok.slice(i + 1)); return o; };
  // 直した読みの組(variants: 解釈の配列の配列)のうち、今日の前後で成り立つものがただ1組なら、その解釈を返す
  const repairOne = (groups) => { const good = groups.map((g) => g.filter((x) => plaus(dayNo(x.y, x.m, x.d)) === 3)).filter((g) => g.length); return good.length === 1 ? good[0] : []; };
  each(s, /(?<!\d)(?<!\d[./-])(\d{1,4})\s{0,2}([./-])\s{0,2}(\d{1,2})\s{0,2}[./-]\s{0,2}(\d{1,4})(?![\d])(?!\s?[./-]\s?\d)/g, (m) => {
    const A = m[1], Bs = m[3], C = m[4];
    let ok = tri(A, Bs, C), rep = false;
    if (!ok.length) {
      const groups = [...vars(Bs).map((b) => tri(A, b, C)), ...vars(C).map((c) => tri(A, Bs, c)), ...(A.length <= 2 ? vars(A).map((a) => tri(a, Bs, C)) : [])];
      ok = repairOne(groups); rep = ok.length > 0;
    }
    if (ok.length) add(m, ok, rep ? { fixed: true } : {});
  });
  // 5-6. 空白区切りの西暦(2026 11 05)
  each(s, /(?<!\d)(?<!\d[./-])(20\d{2})\s+(\d{1,2})\s+(\d{1,2})(?![\d./-])/g, (m) => { if (valid(+m[1], +m[2], +m[3])) add(m, [mk(+m[1], +m[2], +m[3], 'YMD')], { needLabel: true }); });
  each(s, /(?<!\d)(?<!\d[./-])(\d{1,2})\s+(\d{1,2})\s+(20\d{2})(?![\d./-])/g, (m) => {
    const ints = [mk(+m[3], +m[2], +m[1], 'DMY'), mk(+m[3], +m[1], +m[2], 'MDY')].filter((x) => valid(x.y, x.m, x.d));
    if (ints.length) add(m, ints, { needLabel: true });
  });
  each(s, /(?<!\d)(?<!\d[./-])(\d{2})\s+(\d{1,2})\s+(\d{1,2})(?![\d./-])/g, (m) => { if (valid(2000 + +m[1], +m[2], +m[3])) add(m, [mk(2000 + +m[1], +m[2], +m[3], 'YMD')], { needLabel: true }); });
  // 5-7. 年月・月年・月日(数字2つ)
  each(s, /(?<!\d)(?<!\d[./-])(\d{1,4})\s{0,2}[./-]\s{0,2}(\d{1,4})(?![\d])(?!\s?[./-]\s?\d)/g, (m) => {
    const A = m[1], Bv = m[2];
    if (A.length === 4 && Bv.length <= 2) {
      if (valid(+A, +Bv, 1)) add(m, [mk(+A, +Bv, dim(+A, +Bv), 'YM', { eom: true })]);
      else { const r = repairOne(vars(Bv).filter((b) => valid(+A, +b, 1)).map((b) => [mk(+A, +b, dim(+A, +b), 'YM', { eom: true })])); if (r.length) add(m, r, { fixed: true }); }
      return;
    }
    if (A.length <= 2 && Bv.length === 4) { if (valid(+Bv, +A, 1)) add(m, [mk(+Bv, +A, dim(+Bv, +A), 'MY', { eom: true })]); return; }
    if (A.length > 2 || Bv.length > 2) return;
    const a = +A, b = +Bv; // どちらも1〜2桁: ラベルが近くにあるときだけ採る
    if (a >= 13 && yearlike(a) && b >= 1 && b <= 12) { const y = 2000 + a; add(m, [mk(y, b, dim(y, b), 'YM', { eom: true })], { needLabel: true }); return; }
    if (a >= 1 && a <= 12 && b >= 13 && b <= 31 || a >= 1 && a <= 12 && b >= 1 && b <= 12) { const y = nextFuture(a, b); if (y) add(m, [mk(y, a, b, 'MD', { yl: true })], { needLabel: true }); return; }
    if (a >= 1 && a <= 12 && b > 31 && yearlike(b)) { const y = 2000 + b; add(m, [mk(y, a, dim(y, a), 'MY', { eom: true })], { needLabel: true }); return; }
    if (a >= 13 && a <= 31 && b >= 1 && b <= 12) { const y = nextFuture(b, a); if (y) add(m, [mk(y, b, a, 'DM', { yl: true })], { needLabel: true }); }
  });
  // 5-8. END 2027(年だけ)
  each(s, /(?<![A-Za-z])END(?:\s*OF)?\s*:?\s*(20\d{2})(?![\d./-])/gi, (m) => { if (valid(+m[1], 12, 31)) add(m, [mk(+m[1], 12, 31, 'Y', { eom: true })]); });
  // 5-9. 6桁 YYMMDD(ラベルが近くにあるときだけ)
  each(s, /(?<![A-Za-z\d])(\d{2})(\d{2})(\d{2})(?![A-Za-z\d])/g, (m) => { if (valid(2000 + +m[1], +m[2], +m[3])) add(m, [mk(2000 + +m[1], +m[2], +m[3], 'YMD')], { needLabel: true }); });

  // 日付が相対表記の語句に使われた/ない場合に備え、位置順に並べる
  items.sort((p, q) => p.a - q.a);

  // 6. ラベル語の位置
  const labs = [];
  for (const L of LABELS) {
    const re = new RegExp(L.re.source, L.re.flags.includes('g') ? L.re.flags : L.re.flags + 'g');
    each(s, re, (m) => { if (m[0] && free(m.index, m.index + m[0].length)) labs.push({ a: m.index, b: m.index + m[0].length, type: L.type, kind: L.kind, text: m[0] }); else if (m[0] === '') re.lastIndex++; });
  }
  // 重なるラベルは、長いものを優先(例: 賞味期限 の中の 期限)
  labs.sort((p, q) => p.a - q.a || (q.b - q.a) - (p.b - p.a));
  const lab2 = [];
  for (const l of labs) { const last = lab2[lab2.length - 1]; if (last && l.a < last.b) continue; lab2.push(l); }
  const labels = lab2;

  // 日付の種類(ラベルに紐づけ)
  const seq = [...items.map((x) => ({ ...x, cls: 'd', ref: x })), ...labels.map((x) => ({ ...x, cls: 'l', ref: x }))].sort((p, q) => p.a - q.a);
  const gapTxt = (p, q) => s.slice(p.b, q.a);
  const small = (g) => g.replace(/[\s:：.\-()（）【】\[\]「」・は]/g, '').length <= 2 && (g.match(/\n/g) || []).length <= 1;
  const assign = new Map(); // item → { label, via }
  // 6-1. ラベルが連続し、同数の日付が続く(2列の表)
  for (let i = 0; i < seq.length;) {
    if (seq[i].cls !== 'l') { i++; continue; }
    let j = i; while (j + 1 < seq.length && seq[j + 1].cls === 'l' && small(gapTxt(seq[j], seq[j + 1]))) j++;
    const k = j - i + 1;
    let e = j + 1, cnt = 0;
    if (k >= 2 && e < seq.length && seq[e].cls === 'd' && small(gapTxt(seq[j], seq[e]))) {
      let t = e; cnt = 1; while (t + 1 < seq.length && seq[t + 1].cls === 'd' && small(gapTxt(seq[t], seq[t + 1])) && cnt < k) { t++; cnt++; }
      if (cnt === k) { for (let x = 0; x < k; x++) assign.set(seq[e + x].ref, { label: seq[i + x].ref, via: 'col' }); }
    }
    i = j + 1;
  }
  // 6-2. 日付ごとに、直前のラベル(同じ行、または1行上の行末)→ なければ直後のラベル
  const used = new Set([...assign.values()].map((v) => v.label));
  for (let i = 0; i < seq.length; i++) {
    const it = seq[i]; if (it.cls !== 'd' || assign.has(it.ref)) continue;
    const prev = seq[i - 1];
    if (prev && prev.cls === 'l' && !used.has(prev.ref)) {
      const g = gapTxt(prev, it), nl = (g.match(/\n/g) || []).length;
      if (nl === 0 ? g.length <= 18 : nl === 1 && g.length <= 26 && !/[^\s]\s*\n/.test(g.slice(0, 0))) { assign.set(it.ref, { label: prev.ref, via: nl ? 'nl' : 'prev' }); used.add(prev.ref); continue; }
    }
    const next = seq[i + 1];
    if (next && next.cls === 'l' && !used.has(next.ref)) {
      const g = gapTxt(it, next);
      if (g.length <= 6 && (g.match(/\n/g) || []).length <= 1) { assign.set(it.ref, { label: next.ref, via: 'next' }); used.add(next.ref); }
    }
  }

  // 7. 解釈の選択 → 候補
  const prior = { YMD: 0, DMY: 1, MDY: 2 };
  const rawCands = [];
  // 解釈が1つに決まる日付の書式(YMD/DMY/MDY)を数え、曖昧な日付はその書式にそろえる(製造日が 20/10/26 なら 30/10/26 は日/月/年)
  const votes = { YMD: 0, DMY: 0, MDY: 0 };
  for (const it of items) { const v = it.interps.filter((x) => plaus(dayNo(x.y, x.m, x.d)) >= 2); if (v.length === 1 && votes[v[0].fmt] !== undefined && it.interps.length > 1) votes[v[0].fmt]++; }
  for (const it of items) {
    const asg = assign.get(it);
    const lab = asg?.label;
    if (lab?.type === 'mfg') {
      const ch = chooseInterp(it.interps);
      if (ch) result.mfg.push({ date: iso(ch.x.y, ch.x.m, ch.x.d), raw: it.raw, _n: dayNo(ch.x.y, ch.x.m, ch.x.d) });
      continue;
    }
    if (it.needLabel && !(lab && lab.type === 'exp')) continue;
    const ch = chooseInterp(it.interps);
    if (!ch) continue;
    rawCands.push({ it, asg, lab, x: ch.x, amb: ch.amb });
  }
  function chooseInterp(ints) {
    const sc = ints.map((x) => ({ x, t: plaus(dayNo(x.y, x.m, x.d)) }));
    const pr = (x) => (prior[x.fmt] ?? 0);
    sc.sort((p, q) => q.t - p.t || (votes[q.x.fmt] || 0) - (votes[p.x.fmt] || 0) || pr(p.x) - pr(q.x));
    if (!sc.length) return null;
    const top = sc[0], amb = sc.some((o) => o !== top && o.t >= top.t && (o.x.y !== top.x.y || o.x.m !== top.x.m || o.x.d !== top.x.d));
    return { x: top.x, amb };
  }

  const unlabeled = rawCands.filter((c) => !(c.lab && c.lab.type === 'exp'));
  const lastUnl = unlabeled.length ? Math.max(...unlabeled.map((c) => dayNo(c.x.y, c.x.m, c.x.d))) : 0;
  const labeledExists = rawCands.some((c) => c.lab && c.lab.type === 'exp');
  const cands = [];
  const pf = (n) => { // 今日・買った日との関係
    let f = 1;
    if (B && n < refN) f *= n < refN - 400 ? 0.4 : 0.5;
    else if (n < todayN - 60) f *= 0.4;
    else if (n < todayN) f *= 0.88;
    if (n > todayN + 3650) f *= 0.4; else if (n > todayN + 2200) f *= 0.7;
    return f;
  };
  for (const c of rawCands) {
    const { x, it, asg, lab } = c, n = dayNo(x.y, x.m, x.d);
    let conf, kind = '不明', lbl;
    if (lab && lab.type === 'exp') {
      kind = lab.kind;
      conf = lab.kind === '不明' ? 0.86 : 0.92;
      lbl = lab.text.replace(/\s+/g, ' ').trim();
      if (asg.via === 'next') conf *= 0.92;
    } else {
      const four = /^\d{4}/.test(it.raw) || /[A-Za-z]{3}/.test(it.raw) || /^[令平RH]/.test(it.raw) || it.raw.includes('年');
      conf = four ? 0.62 : 0.58;
      if (x.yl) conf = 0.35; // 年なしはラベルなしでは答えない
      if (x.fmt === 'YM' || x.fmt === 'MY') conf *= 0.9;
      if (unlabeled.length > 1 && n < lastUnl) conf *= 0.6; // 日付が複数でラベルなし: 製造日らしい古い方は下げる
      if (labeledExists) conf *= 0.5;
      lbl = 'ラベルなし';
    }
    if (it.fixed) conf *= 0.95;
    if (c.amb) conf *= 0.85;
    if (x.yl) conf *= 0.85;
    if (x.fmt === 'YM' || x.fmt === 'MY') conf *= 0.97;
    if (/\s/.test(it.raw.replace(/\s*[年月日]\s*/g, '').replace(/^\D+|\D+$/g, '').replace(/\s*[./-]\s*/g, '')) && !/年|月/.test(it.raw) && !/[A-Za-z]/.test(it.raw)) conf *= 0.93; // 数字の間の空白
    conf *= pf(n);
    const notes = [];
    if (x.eom) notes.push(x.fmt === 'Y' ? '年末扱い' : '月末扱い');
    if (x.yl) notes.push('年を補った');
    if (it.fixed) notes.push('誤読を補正');
    cands.push({ date: iso(x.y, x.m, x.d), kind, label: lbl + (notes.length ? `(${notes.join('・')})` : ''), conf: Math.round(conf * 100) / 100, raw: it.raw, _n: n });
  }

  // 相対表記: 製造日 + ◯日など
  if (rels.length && result.mfg.length) {
    const m0 = result.mfg[0], [my, mm, md] = fromDayNo(m0._n);
    for (const r of rels) {
      let ymd;
      if (r.unit === '日') ymd = fromDayNo(m0._n + r.n - (r.incl ? 1 : 0));
      else if (r.unit === '週間') ymd = fromDayNo(m0._n + r.n * 7 - (r.incl ? 1 : 0));
      else if (r.unit === '年') { const y = my + r.n; ymd = [y, mm, Math.min(md, dim(y, mm))]; }
      else { const t = mm - 1 + r.n, y = my + Math.floor(t / 12), mo = (t % 12) + 1; ymd = [y, mo, Math.min(md, dim(y, mo))]; }
      const before = s0(text, r.raw);
      const k = before.kind;
      const n = dayNo(...ymd);
      cands.push({ date: iso(...ymd), kind: k, label: `${m0.date}(製造日)+${r.raw}`, conf: Math.round(0.8 * pf(n) * 100) / 100, raw: r.raw, _n: n });
    }
  }
  // 同じ日付・種類の重複を1つに
  const seen = new Map();
  for (const c of cands.sort((p, q) => q.conf - p.conf)) { const key = c.date + c.kind; if (!seen.has(key)) seen.set(key, c); }
  result.candidates = [...seen.values()].sort((p, q) => q.conf - p.conf || p._n - q._n).map(({ _n, ...c }) => c);
  const top = result.candidates[0];
  result.best = top && top.conf >= BEST_MIN ? top : null;
  result.mfg = result.mfg.map(({ _n, ...c }) => c);

  // 日付が別の場所に書かれている旨
  const fm = FRAME_RE.exec(s);
  if (fm && (!result.best || /枠外|欄外|缶底|底|キャップ|SEE/i.test(fm[0]) && labels.some((l) => l.type === 'exp'))) result.note = '期限は別の場所(枠外など)に記載';
  if (result.best) result.note = '';
  return result;

  // 相対表記の直前にある期限ラベルから種類を決める(元の文章から探す)
  function s0(orig, raw) {
    const norm = String(orig ?? '').normalize('NFKC');
    const i = norm.indexOf(raw);
    const head = i >= 0 ? norm.slice(Math.max(0, i - 14), i) : '';
    if (/賞味|品質保持|BEST|BB/i.test(head)) return { kind: '賞味' };
    if (/消費|USE\s*BY/i.test(head)) return { kind: '消費' };
    return { kind: '不明' };
  }
}

// 複数の読み(parseExpiry の結果の配列)を1つにまとめる: 同じ日付が複数の読みで出たら確信を上げる
export function combineExpiry(parsed) {
  const by = new Map();
  for (const c of parsed.flatMap((p) => p.candidates)) {
    const p = by.get(c.date);
    if (!p) by.set(c.date, { ...c, votes: 1, kinds: new Set([c.kind]) });
    else { p.votes++; p.kinds.add(c.kind); if (c.conf > p.conf) { const v = p.votes, ks = p.kinds; Object.assign(p, c, { votes: v, kinds: ks }); } }
  }
  const candidates = [...by.values()].map((c) => {
    const known = [...c.kinds].filter((x) => x !== '不明');
    const kind = c.kind === '不明' && known.length === 1 ? known[0] : c.kind;
    return { date: c.date, kind, label: c.label, conf: Math.min(0.99, Math.round((c.conf + 0.08 * (c.votes - 1)) * 100) / 100), raw: c.raw, votes: c.votes };
  }).sort((a, b) => b.conf - a.conf);
  const best = candidates.length && candidates[0].conf >= BEST_MIN ? candidates[0] : null;
  const mfg = parsed.flatMap((p) => p.mfg).filter((m, i, a) => a.findIndex((x) => x.date === m.date) === i);
  return { candidates, best, mfg, opened: parsed.flatMap((p) => p.opened), note: best ? '' : parsed.find((p) => p.note)?.note || '' };
}
