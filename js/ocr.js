import { parseReceipt, parseReceiptMeta, checkTotal } from './parse.js';

let worker;
const LONG_SIDE = 3000; // 紙の検出用に一旦このサイズへ収める(iPhoneの大きな写真でもメモリを食わない)
const TARGET_W = 1400; // 紙を切り出したあと、紙の幅をこのサイズへ揃える(文字の大きさをOCRに適した大きさに)
const MAX_PIXELS = 10e6; // 縦長レシートでも canvas がこの画素数を超えないようにする

// JPEGのEXIF向き(1-8)と実ピクセル寸法(SOF)を先頭だけ読んで取る。読めなければ null
async function readExif(file) {
  try {
    const v = new DataView(await file.slice(0, 262144).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2, orient = 1, w = 0, h = 0;
    while (o + 4 < v.byteLength) {
      const mk = v.getUint16(o), len = v.getUint16(o + 2);
      if (mk === 0xffe1 && v.getUint32(o + 4) === 0x45786966) { // "Exif"
        const t = o + 10, le = v.getUint16(t) === 0x4949, ifd = t + v.getUint32(t + 4, le);
        for (let i = 0, n = v.getUint16(ifd, le); i < n; i++) if (v.getUint16(ifd + 2 + i * 12, le) === 0x0112) orient = v.getUint16(ifd + 10 + i * 12, le);
      } else if (mk >= 0xffc0 && mk <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(mk)) { h = v.getUint16(o + 5); w = v.getUint16(o + 7); break; }
      o += 2 + len;
    }
    return { orient, w, h };
  } catch { return null; }
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

// 画像 → OCR向けcanvas: EXIF向き補正 → 紙(レシート)の領域を検出して切り出し → 紙の幅を揃えて拡縮 → グレースケール → 局所しきい値の簡易二値化
export async function preprocess(file, opt = {}) {
  const [img, ex] = await Promise.all([loadImage(file), readExif(file)]);
  const w = img.naturalWidth, h = img.naturalHeight;
  // 最近のブラウザは <img> をEXIFどおり自動で回転する。縦横入れ替わりの向き(5-8)で寸法が生のままなら、自分で回す
  const o = ex && ex.orient >= 5 && ex.w !== ex.h && w === ex.w && h === ex.h ? ex.orient : 1;
  const sw = o >= 5 ? h : w, sh = o >= 5 ? w : h; // 回転後の寸法
  const k = Math.min(1, LONG_SIDE / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
  const base = document.createElement('canvas'); base.width = cw; base.height = ch;
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, cw, ch);
  if (o === 5) bctx.transform(0, 1, 1, 0, 0, 0);
  else if (o === 6) bctx.transform(0, 1, -1, 0, cw, 0);
  else if (o === 7) bctx.transform(0, -1, -1, 0, cw, ch);
  else if (o === 8) bctx.transform(0, -1, 1, 0, 0, ch);
  bctx.drawImage(img, 0, 0, o >= 5 ? ch : cw, o >= 5 ? cw : ch);
  img.src = '';
  const r = findPaper(base); // {x,y,w,h}(base座標)。見つからなければ全体
  const s = Math.min(3, (opt.width || TARGET_W) / r.w, Math.sqrt(MAX_PIXELS / (r.w * r.h)));
  const ow = Math.max(1, Math.round(r.w * s)), oh = Math.max(1, Math.round(r.h * s));
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ow, oh);
  ctx.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, ow, oh);
  if (r.outside) { ctx.drawImage(r.outside, 0, 0, ow, oh); r.outside.width = 0; } // 紙の外側(机など)は白く塗る
  base.width = base.height = 0;
  enhance(ctx, ow, oh, !!opt.gray);
  const ang = estimateSkew(cv);
  if (!ang) return cv;
  const rt = document.createElement('canvas'); rt.width = ow; rt.height = oh; // 傾きを戻す(はみ出す所は白)
  const rx = rt.getContext('2d', { willReadFrequently: true });
  rx.fillStyle = '#fff'; rx.fillRect(0, 0, ow, oh); rx.translate(ow / 2, oh / 2); rx.rotate(ang); rx.drawImage(cv, -ow / 2, -oh / 2);
  cv.width = cv.height = 0;
  return rt;
}

// 紙(レシート)の領域を探す: 縮小画像の「RGBの最小値」(白い紙は高く、色付きの机や影は低い)をぼかして大津の方法で二値化 →
// 収縮して細い橋渡し(机の粒状ノイズ)を切り → 最大の明るい連結成分を紙とみなす。
// 返り値: 紙の外接矩形(+余白) {x,y,w,h} と、矩形内で紙の外側を白く塗るための canvas(outside)。小さすぎる/ほぼ全面なら切り出さず全体を返す
function findPaper(cv) {
  const full = { x: 0, y: 0, w: cv.width, h: cv.height, outside: null };
  try {
    const k = 320 / Math.max(cv.width, cv.height), w = Math.max(8, Math.round(cv.width * k)), h = Math.max(8, Math.round(cv.height * k));
    const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
    const sx = sm.getContext('2d', { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(cv, 0, 0, w, h);
    const d = sx.getImageData(0, 0, w, h).data, n = w * h;
    let g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const bl = new Uint8Array(n); // 3x3 平均
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0, c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { a += g[yy * w + xx]; c++; } } bl[y * w + x] = a / c; }
    g = bl;
    const hist = new Uint32Array(256); let sum = 0;
    for (let i = 0; i < n; i++) { hist[g[i]]++; sum += g[i]; }
    let wB = 0, sB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = t; } }
    let acc = 0, p95 = 255; for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= n * 0.05) { p95 = t; break; } }
    thr += Math.max(0, p95 - thr) * 0.15; // 紙の明るさ寄りに少し厳しく(机の明るい粒を拾いにくくする)
    let m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = g[i] > thr ? 1 : 0;
    const E = 3; // 収縮の回数(4近傍)
    const morph = (src, on) => { const o = new Uint8Array(n); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, c = src[i], l = x > 0 ? src[i - 1] : 0, r = x < w - 1 ? src[i + 1] : 0, u = y > 0 ? src[i - w] : 0, dn = y < h - 1 ? src[i + w] : 0; o[i] = on ? (c | l | r | u | dn) : (c & l & r & u & dn); } return o; };
    let er = m; for (let i = 0; i < E; i++) er = morph(er, false);
    const lab = new Int32Array(n), stack = new Int32Array(n);
    let bestA = 0, bestId = 0, id = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (!er[s0] || lab[s0]) continue;
      id++; let sp = 0, a = 0; stack[sp++] = s0; lab[s0] = id;
      while (sp) {
        const p = stack[--sp], x = p % w; a++;
        if (x > 0 && er[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && er[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= w && er[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (p < n - w && er[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      if (a > bestA) { bestA = a; bestId = id; }
    }
    if (!bestId) return full;
    let comp = new Uint8Array(n); for (let i = 0; i < n; i++) comp[i] = lab[i] === bestId ? 1 : 0;
    for (let i = 0; i < E + 1; i++) comp = morph(comp, true); // 収縮ぶん+αを戻す
    // 紙の内側 = 成分の凸包(紙は凸。文字が密で欠けた部分も内側に入る)
    const pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (comp[y * w + x] && (x === 0 || !comp[y * w + x - 1] || x === w - 1 || !comp[y * w + x + 1] || y === 0 || !comp[(y - 1) * w + x] || y === h - 1 || !comp[(y + 1) * w + x])) pts.push([x, y]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const hull = [];
    for (const half of [0, 1]) {
      const st = [];
      for (const q of (half ? pts.slice().reverse() : pts)) { while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], q) <= 0) st.pop(); st.push(q); }
      st.pop(); hull.push(...st);
    }
    let inner = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      let L = Infinity, R = -Infinity;
      for (let i = 0; i < hull.length; i++) { // 走査線と凸包の辺の交点
        const A = hull[i], B = hull[(i + 1) % hull.length];
        if (A[1] === B[1]) { if (A[1] === y) { L = Math.min(L, A[0], B[0]); R = Math.max(R, A[0], B[0]); } continue; }
        if ((y - A[1]) * (y - B[1]) > 0) continue;
        const x = A[0] + ((y - A[1]) * (B[0] - A[0])) / (B[1] - A[1]); L = Math.min(L, x); R = Math.max(R, x);
      }
      if (R < L) continue;
      for (let x = Math.max(0, Math.ceil(L)); x <= Math.min(w - 1, Math.floor(R)); x++) inner[y * w + x] = 1;
    }
    for (let i = 0; i < 5; i++) inner = morph(inner, true); // 凸包は紙の縁を少し削るので外へ広げる(約3%)
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inner[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (x1 < 0 || bestA < n * 0.03 || bw * bh < n * 0.1 || bw * bh > n * 0.92) return full;
    const mx = Math.round(Math.max(bw, bh) * 0.02) + 1;
    const cx0 = Math.max(0, x0 - mx), cy0 = Math.max(0, y0 - mx), cx1 = Math.min(w, x1 + 1 + mx), cy1 = Math.min(h, y1 + 1 + mx);
    const ow = cx1 - cx0, oh = cy1 - cy0, out = document.createElement('canvas'); out.width = ow; out.height = oh;
    const oc = out.getContext('2d'), im = oc.createImageData(ow, oh);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const yy = y + cy0, xx = x + cx0, inside = yy < h && xx < w && inner[yy * w + xx] === 1;
      const p = (y * ow + x) * 4; im.data[p] = im.data[p + 1] = im.data[p + 2] = 255; im.data[p + 3] = inside ? 0 : 255;
    }
    oc.putImageData(im, 0, 0);
    const X = Math.floor(cx0 / k), Y = Math.floor(cy0 / k);
    return { x: X, y: Y, w: Math.min(cv.width - X, Math.ceil(ow / k)), h: Math.min(cv.height - Y, Math.ceil(oh / k)), outside: out };
  } catch { return full; }
}

// グレースケール化 → 明るさの分布を伸ばす → 周囲の平均より暗い所を黒く(影・ムラに強い簡易二値化)
function enhance(ctx, w, h, gray) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data, n = w * h;
  const g = new Uint8ClampedArray(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; g[i] = v; hist[v]++; }
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.001) lo++; // 黒側は文字が少なくても拾えるよう 0.1% 点
  acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.1) hi--; // 白側は紙の明るさ(上位10%の下端)
  const span = Math.max(32, hi - lo);
  for (let i = 0; i < n; i++) g[i] = ((g[i] - lo) * 255) / span;
  if (gray) { // 二値化せず、明るさを伸ばしたグレースケールのまま渡す(二値化が合わない画像向け)
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, g[i])); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    ctx.putImageData(im, 0, 0); return;
  }
  // 積分画像で局所平均(窓は短辺の約1/16)
  const W = w + 1, ii = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; ii[(y + 1) * W + x + 1] = ii[y * W + x + 1] + row; } }
  const r = Math.max(8, Math.round(Math.min(w, h) / 32));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      const v = Math.max(0, Math.min(255, 255 + (g[y * w + x] - mean + 6) * 10)); // 平らな所は白、周囲より暗いほど黒へ(階調は少し残す)
      const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
  }
  ctx.putImageData(im, 0, 0);
}

// 傾き(±12°)の推定: 黒画素を傾けて水平方向に投影し、行の縞が最も濃くなる(分散が最大の)角度を選ぶ。戻り値はラジアン(0なら補正なし)
function estimateSkew(cv) {
  const k = 360 / cv.width, w = Math.round(cv.width * k), h = Math.round(cv.height * k);
  const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
  const sx = sm.getContext('2d', { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(cv, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data, xs = [], ys = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] < 150) { xs.push(x - w / 2); ys.push(y - h / 2); }
  sm.width = sm.height = 0;
  if (xs.length < 200) return 0;
  const score = (t) => { const hist = new Float64Array(h + Math.ceil(w * Math.abs(t)) * 2 + 4), off = Math.ceil(w * Math.abs(t)) + h / 2 + 2; for (let i = 0; i < xs.length; i++) hist[Math.round(ys[i] + xs[i] * t + off)]++; let v = 0; for (let i = 0; i < hist.length; i++) v += hist[i] * hist[i]; return v; };
  const base = score(0); let best = 0, bv = base;
  for (let deg = -12; deg <= 12; deg += 0.5) { const v = score(Math.tan((deg * Math.PI) / 180)); if (v > bv) { bv = v; best = deg; } }
  return bv > base * 1.05 && Math.abs(best) >= 0.5 ? (best * Math.PI) / 180 : 0;
}

// OCRの結果は言語モデルや拡大率・二値化のわずかな違いで大きく変わる。そこで設定を変えて最大6回読み、
// 「検算が合う → 合計が複数の行に現れる → 合計が取れている → 差が小さい → 品名らしい行が多い」の順で最も整合した結果を採る(正解は使わない)。
// 検算が合えば打ち切る。言語モデル(Worker)の切り替えは1回だけ(メモリのため、切り替え時に前のWorkerを閉じる)
const PASSES = [
  { lang: 'jpn', width: 1400 }, { lang: 'jpn', width: 1400, gray: true }, { lang: 'jpn', width: 1800 },
  { lang: 'jpn+eng', width: 1400 }, { lang: 'jpn+eng', width: 1400, gray: true }, { lang: 'jpn+eng', width: 1800 },
];
// 合計の金額が、テキストの何行に現れるか(合計行と支払行など。誤読した金額はたまたま複数行に現れにくい)
function support(text, total) {
  if (!total) return 0;
  const re = new RegExp('(^|[^\\d])' + String(total).replace(/(\d)(?=(\d{3})+$)/g, '$1,?') + '(?!\\d)');
  return text.normalize('NFKC').split(/\r?\n/).map((l) => l.replace(/(\d)[.,]\s+(?=\d{3})/g, '$1,')).filter((l) => re.test(l)).length;
}
function judge(text) {
  const items = parseReceipt(text), meta = parseReceiptMeta(text), c = checkTotal(items, meta);
  const named = items.filter((i) => /[ぁ-んァ-ヶ一-龠]{2,}/.test(i.name)).length;
  return [c.ok === true && !items.some((i) => i.repaired) ? 1 : 0, support(text, meta.total) >= 2 ? 1 : 0, meta.total ? 1 : 0, c.ok === false ? -Math.abs(c.diff) / (c.total || 1) : 0, named, items.length];
}
const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

let workerLang = '', progressCb = null;
async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) { const old = worker; worker = null; await old.terminate(); }
  worker = await Tesseract.createWorker(lang, 1, { logger: (m) => m.status === 'recognizing text' && progressCb?.(m.progress) });
  workerLang = lang;
  await worker.setParameters({ tessedit_pageseg_mode: '4' }); // レシートは可変サイズの1カラム文書として読む
  return worker;
}

// レシート画像 → テキスト(端末内で処理。画像は外部に送られない)
export async function ocr(file, onProgress) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('OCRの読み込みに失敗'));
      document.head.appendChild(s);
    });
  }
  let best = null;
  for (let pass = 0; pass < PASSES.length; pass++) {
    progressCb = (p) => onProgress?.((pass + p) / PASSES.length);
    const w = await getWorker(PASSES[pass].lang);
    let src = file;
    try { src = await preprocess(file, PASSES[pass]); } catch { /* 前処理に失敗したら元画像のまま読む */ }
    try {
      const { data } = await w.recognize(src);
      const key = judge(data.text);
      if (!best || better(key, best.key)) best = { text: data.text, key };
      if ((key[0] && key[5] >= 2) || src === file) break; // 検算が合った / 前処理できず設定を変えても同じ
    } finally { if (src !== file) src.width = src.height = 0; } // canvasのメモリを早めに手放す
  }
  onProgress?.(1);
  return best.text;
}
