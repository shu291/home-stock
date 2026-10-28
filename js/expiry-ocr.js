// パッケージの賞味期限・消費期限の印字を写真から読む(端末内。画像は保存も送信もしない)。
// readExpiryFromPhoto(file, { onProgress, signal, today, boughtAt }) → { candidates, best, text, usedFallback, notes }
//  1. js/ocr.js の ocrDetailed(PP-OCR)で全体を読み、parseExpiry で日付を取る。確信が高ければここで終わり
//  2. 読めない/確信が低いときは、写真を日付の印字向けに整えて(明るさのムラ取り・白抜き文字の反転・ドットのつなぎ合わせ)、
//     写真全体と(大きな写真では)拡大した区画ごとにもう一度、文字の検出と認識をやり直す。複数の読みで同じ日付が出れば確信を上げる
//  3. 深層学習OCRが使えない端末は js/ocr.js の ocr()(Tesseract.js)で読む(usedFallback: true)
import { ocrDetailed, ocr, openImage, cropPaper } from './ocr.js';
import { paddleDetect, paddleRecognize, dropNoise } from './ocr-paddle.js';
import { fixName } from './ocr-post.js';
import { parseExpiry, combineExpiry } from './expiry-parse.js';

export { warmupOcr as warmupExpiryOcr } from './ocr.js'; // モデル(約34MB)を先にダウンロードしておく: await warmupExpiryOcr(進捗コールバック)

// 深層学習OCRのモデルが端末に保存済みか(true なら初回のダウンロード待ちなしで読める)。判定できなければ false
export async function isExpiryOcrReady() {
  try {
    if (!globalThis.indexedDB?.databases) return false;
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'ocr-models')) return false; // 無いデータベースを開くと空のものができて、モデル保存を妨げるので開かない
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ocr-models', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    try {
      if (!db.objectStoreNames.contains('m')) return false;
      const keys = await new Promise((res) => { const q = db.transaction('m').objectStore('m').getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
      return keys.filter((k) => /inference\.onnx|_onnx\.onnx/.test(String(k))).length >= 2;
    } finally { db.close(); }
  } catch { return false; }
}

const CFG = () => ({
  fast: 0.8, // 1回目の読みでこの確信度以上なら、やり直さない
  tileMin: 2400, // 写真の長辺がこれ以上なら、区画に分けても読む
  variants: [{ flat: 1, merge: 0 }, { flat: 1, merge: 2 }, { flat: 1, merge: 4 }],
  width: 1800,
  agree: 2, // この数の読みで同じ日付が出たら打ち切る
  maxBoxes: 48, // 1回の再認識で読む枠の数の上限(模様や雑音から枠が大量に出ても止まらないように)
  budgetMs: 20000, // 再認識にかけてよい時間の目安(これを超えたら、すでに日付が1つでも取れていれば打ち切る)
  maxMs: 45000, // 再認識の時間の上限
  detW: 1280, // 文字の検出に渡す幅(既定の960より大きくして、小さな印字を拾う)
  ...(globalThis.EXPIRY_CFG || {}),
});

const stop = (signal) => { if (signal?.aborted) throw new DOMException('読み取りを中断しました', 'AbortError'); };

// ---------- 画像の整え方 ----------
// 灰色にして、明るさのムラ(背景の光沢・影)を引き、暗い背景なら白黒を反転し、ドットの印字は ぼかしてつなげる
function boxBlur(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) { let a = 0; const o = y * w; for (let x = -r; x <= r; x++) a += src[o + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[o + x] = a / n; a += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let a = 0; for (let y = -r; y <= r; y++) a += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = a / n; a += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  return out;
}
export function enhanceForDate(cv, v) {
  const w = cv.width, h = cv.height, ctx = cv.getContext('2d', { willReadFrequently: true }), im = ctx.getImageData(0, 0, w, h), d = im.data, n = w * h;
  let g = new Float32Array(n), mean = 0;
  for (let i = 0; i < n; i++) { const x = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) / 256; g[i] = x; mean += x; }
  mean /= n;
  if (v.merge) { g = boxBlur(g, w, h, v.merge); g = boxBlur(g, w, h, v.merge); } // 2回で ほぼガウスぼかし(ドットがつながる)
  if (v.flat) { // 大きな窓の平均を引いてムラを取る
    const bg = boxBlur(boxBlur(g, w, h, Math.max(8, Math.round(Math.min(w, h) / 12))), w, h, Math.max(8, Math.round(Math.min(w, h) / 12)));
    const inv = mean < 118; // 暗い背景(白い文字)は反転
    for (let i = 0; i < n; i++) { const x = g[i] - bg[i]; g[i] = 128 + (inv ? -x : x); }
  }
  const hist = new Uint32Array(256); for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, Math.round(g[i])))]++;
  let lo = 0, hi = 255, acc = 0; while (lo < 254 && (acc += hist[lo]) < n * 0.005) lo++; acc = 0; while (hi > lo + 8 && (acc += hist[hi]) < n * 0.02) hi--;
  const sp = Math.max(24, hi - lo);
  for (let i = 0; i < n; i++) { const x = Math.max(0, Math.min(255, ((g[i] - lo) * 255) / sp)); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = x; d[i * 4 + 3] = 255; }
  ctx.putImageData(im, 0, 0);
  return cv;
}

// 文字行の傾き(ラジアン。右下がりが正)の推定: 暗い画素を小さくして、傾きごとに行方向の投影の濃淡(分散)が最大になる角度を探す。無ければ 0
export function estimateTilt(cv) {
  const k = 420 / Math.max(cv.width, cv.height), w = Math.max(16, Math.round(cv.width * k)), h = Math.max(16, Math.round(cv.height * k));
  const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
  const sx = sm.getContext('2d', { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(cv, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data, xs = [], ys = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] < 110) { xs.push(x - w / 2); ys.push(y - h / 2); }
  sm.width = sm.height = 0;
  if (xs.length < 60 || xs.length > w * h * 0.5) return 0;
  const score = (t) => { const off = Math.ceil(w * Math.abs(t)) + h / 2 + 3, hist = new Float64Array(h + 2 * off + 6); for (let i = 0; i < xs.length; i++) hist[Math.round(ys[i] - xs[i] * t + off)]++; let v = 0; for (let i = 0; i < hist.length; i++) v += hist[i] * hist[i]; return v; };
  const base = score(0); let best = 0, bv = base;
  for (let deg = -18; deg <= 18; deg += 0.5) { const v = score(Math.tan((deg * Math.PI) / 180)); if (v > bv) { bv = v; best = deg; } }
  return bv > base * 1.08 && Math.abs(best) >= 1 ? (best * Math.PI) / 180 : 0;
}

// 写真を区画に分ける(src座標)。1つ目は全体。大きな写真は 2x2 の重なる区画も
function regions(im, c) {
  const W = im.w, H = im.h, out = [{ cx: W / 2, cy: H / 2, w: W, h: H }];
  if (Math.max(W, H) >= c.tileMin) {
    const tw = W * 0.58, th = H * 0.58;
    for (const fx of [0.29, 0.71]) for (const fy of [0.29, 0.71]) out.push({ cx: W * fx, cy: H * fy, w: tw, h: th });
  }
  return out;
}

export async function readExpiryFromPhoto(file, opt = {}) {
  const { onProgress, signal, today, boughtAt } = opt, c = CFG();
  const pe = (t) => parseExpiry(t, { today, boughtAt });
  const prog = (a, b) => (p) => onProgress?.(a + (b - a) * p);
  stop(signal);
  let text = '', usedFallback = false, first = null, res1 = null;
  try {
    res1 = await ocrDetailed(file, prog(0, 0.45), signal);
    text = res1.text; first = pe(text);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    usedFallback = true; // 深層学習OCRが動かない端末: Tesseract.js で読む
    text = await ocr(file, prog(0, 1), { signal });
    first = pe(text);
    return finish([first], text, usedFallback);
  }
  if (first.best && first.best.conf >= c.fast) { onProgress?.(1); return finish([first], text, false); }

  // 2回目: 日付の印字向けに整えて、区画ごとにやり直す
  const parsed = [first], texts = [text], tStart = Date.now();
  let im = null;
  try {
    im = await openImage(file);
    const regs = regions(im, c), total = regs.length * c.variants.length; let k = 0;
    const tilt = [];
    outer: for (let ri = 0; ri < regs.length; ri++) {
      const r = regs[ri];
      const W = Math.min(c.width, r.w * 3);
      for (const v of c.variants) {
        stop(signal);
        const el = Date.now() - tStart;
        if (el > c.maxMs || (el > c.budgetMs && parsed.some((p) => p.best))) break outer;
        let cv = null;
        try {
          if (tilt[ri] === undefined) { // 区画ごとに傾きを一度だけ推定する
            const t0 = cropPaper(im, { color: true, width: Math.min(W, 1000), orient: { cx: r.cx, cy: r.cy, w: r.w, h: r.h, rot: 0 } });
            enhanceForDate(t0, { flat: 1, merge: 2 }); tilt[ri] = estimateTilt(t0); t0.width = t0.height = 0;
          }
          cv = cropPaper(im, { color: true, width: W, orient: { cx: r.cx, cy: r.cy, w: r.w, h: r.h, rot: c.noTilt ? 0 : -tilt[ri] } });
          enhanceForDate(cv, v);
          const all = await paddleDetect(cv, null, c.detW);
          const area = (b) => (b.t.x1 - b.t.x0) * (b.t.y1 - b.t.y0);
          const boxes = all.filter((b) => b.score >= 0.5 && b.t.x1 - b.t.x0 >= 1.3 * (b.t.y1 - b.t.y0)).sort((a, b) => b.score * area(b) - a.score * area(a)).slice(0, c.maxBoxes);
          const rr = await paddleRecognize(cv, boxes, null, fixName);
          const t = rr.lines.map((l) => dropNoise(l.parts || [l]).map((q) => q.text).join(' ')).join('\n');
          texts.push(t); parsed.push(pe(t));
          const cb = combineExpiry(parsed).best; // 2つ以上の読みで同じ日付が出て確信も高ければ、残りは読まない
          if (cb && cb.votes >= c.agree && cb.conf >= 0.75) { k = total; break outer; }
        } catch (e) { if (e?.name === 'AbortError') throw e; } finally { if (cv) cv.width = cv.height = 0; }
        onProgress?.(0.45 + 0.55 * (++k / total));
      }
    }
  } catch (e) { if (e?.name === 'AbortError') throw e; } finally { im?.close(); }
  onProgress?.(1);
  return finish(parsed, texts.join('\n---\n'), false);
}

function finish(parsed, text, usedFallback) {
  const r = combineExpiry(parsed);
  return { candidates: r.candidates, best: r.best, text, usedFallback, notes: { note: r.note, mfg: r.mfg, opened: r.opened } };
}
