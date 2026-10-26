// 商品名の正規化(重複判定用)
export const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

const SKIP = /合計|小計|総計|税|お預|お釣|釣銭|現金|ポイント|TEL|電話|登録番号|領収|クレジット|カード|割引|値引|レジ|担当|様|お買上|点数|対象|支払|交通系|PayPay|ありがとう/i;
const DATE = /(\d{4})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})/;

export function findDate(text) {
  const m = text.normalize('NFKC').match(DATE);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

// レシートOCR結果 → 品目候補。OCRは崩れるので、取り込み前に必ず人が確認・修正する画面を挟む。
export function parseReceipt(text) {
  const date = findDate(text);
  const out = [];
  for (const raw of text.normalize('NFKC').split(/\n/)) {
    const line = raw.trim();
    if (line.length < 3 || SKIP.test(line)) continue;
    const m = line.match(/^(.+?)[\s.…・]+[¥\\]?\s*(-?[\d,]{2,7})\s*(円|[※*軽])?\s*$/);
    if (!m) continue;
    let name = m[1].replace(/[¥\\|_]+/g, ' ').trim();
    let qty = 1;
    const q = name.match(/(?:[x×*]\s*(\d{1,2})|(\d{1,2})\s*[個点コ本袋])\s*$/i);
    if (q) { qty = +(q[1] || q[2]); name = name.replace(q[0], '').trim(); }
    const price = +m[2].replace(/,/g, '');
    if (!name || price <= 0 || /^\d+$/.test(name)) continue;
    out.push({ name, qty, price, boughtAt: date, source: 'receipt' });
  }
  return out;
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
