let worker;
const LONG_SIDE = 1800; // OCR前に長辺をこのサイズへ揃える(iPhoneの大きな写真でもメモリを食わない)

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

// 画像 → OCR向けcanvas: EXIF向き補正 → 長辺1800pxへ拡縮 → グレースケール → コントラスト強調(局所しきい値の簡易二値化)
export async function preprocess(file) {
  const [img, ex] = await Promise.all([loadImage(file), readExif(file)]);
  const w = img.naturalWidth, h = img.naturalHeight;
  // 最近のブラウザは <img> をEXIFどおり自動で回転する。縦横入れ替わりの向き(5-8)で寸法が生のままなら、自分で回す
  const o = ex && ex.orient >= 5 && ex.w !== ex.h && w === ex.w && h === ex.h ? ex.orient : 1;
  const sw = o >= 5 ? h : w, sh = o >= 5 ? w : h; // 回転後の寸法
  const k = Math.min(3, LONG_SIDE / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  if (o === 5) ctx.transform(0, 1, 1, 0, 0, 0);
  else if (o === 6) ctx.transform(0, 1, -1, 0, cw, 0);
  else if (o === 7) ctx.transform(0, -1, -1, 0, cw, ch);
  else if (o === 8) ctx.transform(0, -1, 1, 0, 0, ch);
  ctx.drawImage(img, 0, 0, o >= 5 ? ch : cw, o >= 5 ? cw : ch);
  img.src = '';
  enhance(ctx, cw, ch);
  return cv;
}

// グレースケール化 → 明るさの分布を伸ばす → 周囲の平均より暗い所を黒く(影・ムラに強い簡易二値化)
function enhance(ctx, w, h) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data, n = w * h;
  const g = new Uint8ClampedArray(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; g[i] = v; hist[v]++; }
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.001) lo++; // 黒側は文字が少なくても拾えるよう 0.1% 点
  acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.1) hi--; // 白側は紙の明るさ(上位10%の下端)
  const span = Math.max(32, hi - lo);
  for (let i = 0; i < n; i++) g[i] = ((g[i] - lo) * 255) / span;
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

// レシート画像 → テキスト(端末内で処理。画像は外部に送られない)
export async function ocr(file, onProgress) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('OCRの読み込みに失敗'));
      document.head.appendChild(s);
    });
  }
  worker ||= await Tesseract.createWorker('jpn+eng', 1, { logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress) });
  let src = file;
  try { src = await preprocess(file); } catch { /* 前処理に失敗したら元画像のまま読む */ }
  try {
    const { data } = await worker.recognize(src);
    return data.text;
  } finally { if (src !== file) src.width = src.height = 0; } // canvasのメモリを早めに手放す
}
