// バーコードの番号まわりの純関数(ブラウザにも Node にも依存しない。単体テスト: barcode.test.mjs)。
// ・読み取った文字列 → 検索に使う正規の番号(13桁 / EAN-8 の8桁)への変換と検証
// ・番号の種類の判定(本・雑誌・店内用コード・クーポン・日本の商品・海外の商品)
// ・見つからなかったときの理由の文言

// GS1 のチェックディジット(最後の1桁。重みは右から 3,1,3,1…)。長さは8〜14桁
export function gs1Ok(c) {
  if (!/^\d{8,14}$/.test(c)) return false;
  const d = c.split('').map(Number), last = d.pop();
  return (10 - (d.reverse().reduce((a, x, i) => a + x * (i % 2 ? 1 : 3), 0) % 10)) % 10 === last;
}

// UPC-E(8桁。先頭は 0 か 1)を UPC-A(12桁)へ戻す。チェックディジットは戻した後の UPC-A のもの(EAN-8 の計算とは別)。不正なら ''
export function upceToUpca(e) {
  if (!/^[01]\d{7}$/.test(e)) return '';
  const ns = e[0], d = e.slice(1, 7), chk = e[7], l = d[5];
  const a = l <= '2' ? `${d[0]}${d[1]}${l}0000${d[2]}${d[3]}${d[4]}`
    : l === '3' ? `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`
      : l === '4' ? `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`
        : `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${l}`;
  const full = ns + a + chk;
  return gs1Ok(full) ? full : '';
}

// GTIN-14(GS1 DataBar や ITF-14 の14桁)→ 13桁。
// 先頭(荷姿区分)が 0 なら、そのまま JAN13(先頭の0を除くだけ)。1〜8 は「ケース」用の番号で、中身の番号は
// 先頭を除いた12桁+チェックディジットの再計算で求める(中身の番号がそう付けられているとは限らないので via:'case' を付ける)。9(不定量)は対象外
export function gtin14ToJan13(g) {
  if (!gs1Ok(g) || g.length !== 14) return null;
  if (g[0] === '0') return { code: g.slice(1), via: 'gtin14' };
  if (g[0] === '9') return null;
  const body = g.slice(1, 13), s = body.split('').reverse().reduce((a, x, i) => a + +x * (i % 2 ? 3 : 1), 0);
  return { code: body + ((10 - (s % 10)) % 10), via: 'case' };
}

// 読み取り結果(または手入力)の文字列 → { code, via } か null。
//   code: 13桁(UPC-A は先頭に0を足す)または EAN-8 の8桁。via: 変換した場合だけ 'upce' | 'gtin14' | 'case'
//   format: 読み取った形式('upc_e' / 'UPC_E' など。分かるときだけ)。8桁の UPC-E と EAN-8 の見分けに使う
export function normalizeScan(text, format = '') {
  let t = String(text ?? '').normalize('NFKC').trim();
  const ai = t.match(/^\(?01\)?\s*(\d{14})(?!\d)/); // GS1 DataBar Expanded: (01)GTIN(3103)重量 … → GTIN だけ使う
  if (ai) t = ai[1];
  t = t.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(t)) return null;
  const fmt = String(format).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t.length === 14) return gtin14ToJan13(t);
  if (t.length === 13) return gs1Ok(t) ? { code: t } : null;
  if (t.length === 12) return gs1Ok(t) ? { code: `0${t}` } : null;
  if (t.length === 8) {
    if (fmt === 'upce') { const a = upceToUpca(t); return a ? { code: `0${a}`, via: 'upce' } : null; }
    if (gs1Ok(t)) return { code: t };
    const a = upceToUpca(t); // 形式が分からない手入力: EAN-8 として合わなければ UPC-E と見なす
    return a ? { code: `0${a}`, via: 'upce' } : null;
  }
  return null;
}
export const validCode = (c) => !!normalizeScan(c);
// 保存済みの番号との照合用(UPC-A の12桁と EAN-13 の先頭0つき、UPC-E など、表記が違う同じ番号を同一に扱う)
export const canonCode = (c) => normalizeScan(c)?.code || String(c || '');

// 番号の種類。kind:
//   isbn(978/979 の本)・ismn(979-0 の楽譜)・bookprice(191/192: 日本の本の「2段目」。価格・分類で商品を特定しない)
//   magazine(491: 雑誌。楽天に号ごとの登録がある)・issn(977)
//   instore(02 / 20〜29 / 04: 店ごとの番号。外部では調べられない)・coupon(05 / 98x / 99x)
//   jp(45・49 の日本のJAN)・ean8・foreign(それ以外)
export function classify(code) {
  const c = String(code || '');
  if (c.length === 8) return /^(0|2)/.test(c) ? 'instore' : /^(45|49)/.test(c) ? 'jp' : 'ean8';
  if (/^9790/.test(c)) return 'ismn';
  if (/^97[89]/.test(c)) return 'isbn';
  if (/^19[12]/.test(c)) return 'bookprice';
  if (/^977/.test(c)) return 'issn';
  if (/^491/.test(c)) return 'magazine';
  if (/^(02|2\d|04)/.test(c)) return 'instore';
  if (/^(05|98[1-9]|99)/.test(c)) return 'coupon';
  if (/^(45|49)/.test(c)) return 'jp';
  return 'foreign';
}

// 外部に問い合わせても意味がない種類(誤ヒット防止と無駄な通信を避ける)
export const noLookup = (kind) => ['instore', 'coupon', 'bookprice', 'issn', 'ismn'].includes(kind);

// 問い合わせ先の順番(kind ごと)。openbd / gbooks / rakuten / off(Open Food Facts) / opf(Products) / obf(Beauty) / opff(Pet Food)
export function sourcePlan(kind) {
  switch (kind) {
    case 'isbn': return ['openbd', 'gbooks', 'rakuten'];
    case 'magazine': return ['rakuten'];
    case 'jp': return ['rakuten', 'off', 'obf']; // 日本の商品は Open Products / Pet Food Facts に事実上載っていない(実測0件)ので呼ばない
    case 'ean8': return ['off', 'rakuten'];
    case 'foreign': return ['off', 'obf', 'opf', 'opff', 'rakuten'];
    default: return [];
  }
}

// 見つからなかったときの案内(画面にそのまま出す)。reason: kind または 'notfound' / 'offline' / 'error'
export function reasonText(reason) {
  switch (reason) {
    case 'instore': return 'このバーコードはお店ごとのもの(量り売りや店内加工品など)で、商品名を調べられません。名前を入れると、次からこの番号で出ます';
    case 'coupon': return 'クーポンや値引き用のバーコードのようです。商品に付いているバーコード(13桁で、多くは 45 か 49 で始まる)を読み取ってください';
    case 'bookprice': return '本の「2段目」(価格などのバーコード)です。上の段(978 で始まる方)を読み取ってください';
    case 'issn': case 'ismn': return '雑誌・楽譜のコードで、商品名を調べられません。名前を入れると、次からこの番号で出ます';
    case 'offline': return '通信できません(オフラインのようです)。名前を入れて登録できます。次から、この番号で出ます';
    case 'error': return '商品名を調べられませんでした(通信の不調か混雑のようです)。もう一度調べるか、名前を入れてください';
    default: return 'データベースに登録がありません(日用品・スーパーの自社商品・化粧品などに多いです)。名前を入れると、次からこの番号で出ます';
  }
}
