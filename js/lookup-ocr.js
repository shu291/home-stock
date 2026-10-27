// 商品パッケージの写真を OCR(js/ocr.js の ocrDetailed)で読んだ行から、「商品名らしい行」を最大3つ選ぶ(純関数。単体テスト: barcode.test.mjs)。
// 入力 lines: [{ text, conf(0〜1), x0, y0, x1, y1 }]、size: [画像の幅, 高さ]。
// 手がかり: 文字の大きさ(行の高さ)・位置(上寄り・中央寄り)・文字種(かな・漢字・カタカナ・英字が主)・長さ。
// 成分表や注意書き・製造者・価格などの行は除く。大きさが近く縦に続く行は、折り返した1つの名前としてつなぐ。

const NOISE = /内容量|内容総量|賞味期限|消費期限|原材料|原産国|栄養成分|エネルギー|たんぱく質|蛋白質|脂質|炭水化物|食塩相当量|ナトリウム|製造者|製造所|販売者|輸入者|発売元|新発売|加工者|保存方法|使用方法|お召し上がり|ご使用|成分|注意|警告|用法|用量|効能|JAN|株式会社|有限会社|\(株\)|（株）|TEL|電話|フリーダイヤル|お客様|www\.|https?:|\.com|\.jp|@|リサイクル|容器包装|分別|ご確認|お問い合わせ|開封|お願い|カロリー|kcal|税込|税抜|本体価格|希望小売|メーカー/i;
const UNIT_ONLY = /^[\s\d.,/×xX*+()（）%％～~\-gGkKmMlLcCmMＬ個枚本袋包錠粒入mgμ]+$/; // 数量・単位だけの行
const HAS_JA = /[぀-ヿ一-鿿]/, HAS_LATIN = /[A-Za-z]/;

// 全角英数を半角にして、前後の空白・記号を除く
const clean = (s) => String(s || '').normalize('NFKC').replace(/[|｜_=~^`<>{}\\]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-・.,:;'"!！?？]+|[\s\-・.,:;'"]+$/g, '').trim();

const kindRatio = (s) => { const t = s.replace(/\s/g, ''); if (!t) return 0; return (t.match(/[぀-ヿ一-鿿A-Za-z]/g) || []).length / t.length; };

// 1行が名前の候補になれるか
function eligible(text) {
  const t = clean(text), n = Array.from(t).length;
  if (n < 2 || n > 40) return false;
  if (kindRatio(t) < 0.6) return false;
  if (NOISE.test(t)) return false;
  if (UNIT_ONLY.test(t)) return false;
  if (!HAS_JA.test(t) && !(HAS_LATIN.test(t) && n >= 4)) return false;
  if (!HAS_JA.test(t) && /^[A-Za-z]{1,3}$/.test(t)) return false;
  return true;
}

export function nameCandidates(lines, size = [0, 0], max = 3) {
  const W = size[0] || Math.max(1, ...lines.map((l) => l.x1 || 0)), H = size[1] || Math.max(1, ...lines.map((l) => l.y1 || 0));
  const L = (lines || []).map((l) => ({ text: clean(l.text), conf: l.conf ?? 0.8, x0: l.x0 ?? 0, x1: l.x1 ?? W, y0: l.y0 ?? 0, y1: l.y1 ?? 0 }))
    .map((l) => ({ ...l, h: Math.max(1, l.y1 - l.y0), cy: (l.y0 + l.y1) / 2, ok: eligible(l.text) && (l.conf ?? 1) >= 0.35 }))
    .sort((a, b) => a.cy - b.cy);
  const okLines = L.filter((l) => l.ok); if (!okLines.length) return [];
  const maxH = Math.max(...okLines.map((l) => l.h));
  // 大きさが近く(0.7〜1.4倍)、縦に続く(隙間が行の高さの1.3倍以内)で、候補になれる行どうしは1つの名前にまとめる
  const groups = [];
  for (const l of L) {
    if (!l.ok) continue;
    const g = groups[groups.length - 1], p = g?.at(-1);
    if (p && p.ok && l.h / p.h > 0.7 && l.h / p.h < 1.43 && l.y0 - p.y1 < 1.3 * Math.max(l.h, p.h) && Math.abs((l.x0 + l.x1) / 2 - (p.x0 + p.x1) / 2) < 0.35 * W && Array.from(g.map((x) => x.text).join(' ')).length + l.text.length < 40
      && !L.some((m) => !m.ok && m.cy > p.cy && m.cy < l.cy)) g.push(l); // 間に除外した行(注意書きなど)があればつなげない
    else groups.push([l]);
  }
  const score = (g) => {
    const text = g.map((x) => x.text).join(' '), n = Array.from(text).length;
    const h = g.reduce((a, x) => a + x.h, 0) / g.length / maxH; // 最大の行に対する大きさ(0〜1)
    const cy = g.reduce((a, x) => a + x.cy, 0) / g.length / H, cx = g.reduce((a, x) => a + (x.x0 + x.x1) / 2, 0) / g.length / W;
    const conf = g.reduce((a, x) => a + x.conf, 0) / g.length;
    let s = 0.55 * h + 0.14 * (1 - Math.min(1, Math.abs(cy - 0.35) / 0.65)) + 0.06 * (1 - Math.min(1, Math.abs(cx - 0.5) / 0.5)) + 0.1 * conf;
    s += HAS_JA.test(text) ? 0.1 : 0;
    s += n >= 4 && n <= 24 ? 0.08 : n > 30 ? -0.1 : 0;
    s += g.length > 1 ? 0.03 : 0;
    return s;
  };
  const ranked = groups.map((g) => ({ g, s: score(g) })).sort((a, b) => b.s - a.s);
  const out = [], push = (t) => { if (t && !out.includes(t) && out.length < max) out.push(t); };
  for (const { g } of ranked) {
    push(g.map((x) => x.text).join(' '));
    if (g.length > 1) push(g.slice().sort((a, b) => b.h - a.h)[0].text); // つないだ名前のほか、いちばん大きい1行だけの候補も
  }
  return out;
}
