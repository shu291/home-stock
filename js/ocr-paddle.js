// 端末内OCR(PP-OCR系の文字検出+文字認識を onnxruntime-web で動かす)。画像は外部に送られない。
// 流れ: 紙を切り出した画像 → 文字検出(DB: 文字の行・かたまりの位置)→ 各かたまりを高さ48pxに揃えて文字認識(CTC)→ 行にまとめてテキスト化
// モデルは初回だけダウンロードして IndexedDB に保存する(2回目以降は通信なし)。
import { DICT } from './ocr-dict.js';

const CFG = () => ({
  ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
  hf: 'https://huggingface.co/PaddlePaddle/',
  tier: 'small', // 認識モデル(文字を読む)の大きさ: small(21MB)。tinyは4MBだが日本語の精度が足りない
  detTier: 'tiny', // 検出モデル(文字の位置を探す)の大きさ: tiny(1.8MB)。smallにしても精度はほぼ同じ
  detW: 960, // 検出に渡す画像の幅(px)
  ...(globalThis.OCR_PADDLE_CFG || {}),
});

// モデルの版を固定する(Hugging Faceのコミット。mainを指すと、後でモデルが更新されて文字表と合わなくなるおそれがある)
const REV = { 'PP-OCRv6_tiny_det_onnx': '2ba1506c0380b8f0b03dd142459aac66d4421f6c', 'PP-OCRv6_small_det_onnx': '28fe5895c24fd108c19eb3e8479f4ab385fbfc62', 'PP-OCRv6_small_rec_onnx': 'b8f84f0b80c529de40b4fbb3544b84fa7233a513' };

let ortP, sessP;

async function loadScript(src) {
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('OCRの読み込みに失敗')); document.head.appendChild(s); });
}

// モデルファイルの保存先は IndexedDB(Service Worker のキャッシュ整理に巻き込まれず、アプリの更新後も残る)
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('ocr-models', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbGet(k) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('m').objectStore('m').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } }
async function idbPut(k, v) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('m', 'readwrite'); t.objectStore('m').put(v, k); t.oncomplete = res; t.onerror = res; t.onabort = res; }); } catch { /* 容量不足・プライベートモードなど。保存できなくても動く */ } }

// モデルファイルを取得(保存済みならそれを使う)。進捗は onBytes(受信バイト, 総バイト)
async function fetchModel(url, onBytes) {
  const hit = await idbGet(url);
  if (hit && hit.byteLength) { onBytes?.(hit.byteLength, hit.byteLength); return new Uint8Array(hit); }
  const r = await fetch(url);
  if (!r.ok) throw new Error('モデルの取得に失敗 ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  const rd = r.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; onBytes?.(got, total); }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (total && !r.headers.get('content-encoding') && got !== total) throw new Error('モデルの取得が途中で切れました'); // (圧縮して送られるファイルは長さが合わないので確かめない)
  await idbPut(url, buf.buffer);
  return buf;
}

// 実行エンジン(onnxruntime-web)もモデルと同じく初回だけダウンロードして IndexedDB に保存し、2回目以降は通信なしで動かす
async function blobUrl(url, type, onBytes) {
  const buf = await fetchModel(url, onBytes);
  return URL.createObjectURL(new Blob([buf], { type }));
}

// エンジンを端末内に保存したファイル(blob URL)から起動する方式が、その端末のブラウザで動かなかったときは、次回から CDN のURLを直接使う
// (起動の失敗はそのページの間は直らないので、今回は読み取りを諦めて Tesseract に回り、次回から別の方式にする)
const flag = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } return null; };

export async function loadPaddle(onProgress) {
  if (sessP) return sessP;
  sessP = (async () => {
    const c = CFG(), cdn = flag('ocr-ort') === 'cdn';
    const names = [`PP-OCRv6_${c.detTier || c.tier}_det_onnx`, `PP-OCRv6_${c.tier}_rec_onnx`];
    const urls = names.map((n) => (c.hf.startsWith('http') ? `${c.hf}${n}/resolve/${REV[n] || 'main'}/inference.onnx` : `${c.hf}${n}.onnx`));
    // ダウンロードの進捗は、エンジン(wasm 約11MB)と2つのモデルの合計バイト数で出す
    const files = cdn ? urls : [c.ort + 'ort-wasm-simd-threaded.wasm', c.ort + 'ort-wasm-simd-threaded.mjs', c.ort + 'ort.wasm.min.js', ...urls], got = files.map(() => 0), tot = files.map(() => 0);
    const prog = (i) => (g, t) => { got[i] = g; tot[i] = Math.max(t, g); onProgress?.((got.reduce((a, b) => a + b, 0) / Math.max(1, tot.reduce((a, b) => a + b, 0))) * 0.9); };
    let ort, bufs;
    if (cdn) {
      if (!globalThis.ort) await loadScript(c.ort + 'ort.wasm.min.js');
      ort = globalThis.ort; ort.env.wasm.wasmPaths = c.ort;
      bufs = await Promise.all(urls.map((u, i) => fetchModel(u, prog(i))));
    } else {
      if (!ortP) ortP = (async () => { if (!globalThis.ort) await loadScript(await blobUrl(files[2], 'text/javascript', prog(2))); return globalThis.ort; })();
      let wasm, mjs;
      [ort, wasm, mjs, ...bufs] = await Promise.all([ortP, blobUrl(files[0], 'application/wasm', prog(0)), blobUrl(files[1], 'text/javascript', prog(1)), ...urls.map((u, i) => fetchModel(u, prog(i + 3)))]);
      ort.env.wasm.wasmPaths = { wasm, mjs };
    }
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.wasm.proxy = true; // 推論を別スレッド(Worker)で行い、読み取り中も画面が固まらないようにする
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    try {
      const det = await ort.InferenceSession.create(bufs[0], opt);
      const rec = await ort.InferenceSession.create(bufs[1], opt);
      return { ort, det, rec };
    } catch (e) { if (!cdn) flag('ocr-ort', 'cdn'); throw e; }
  })().catch((e) => { sessP = null; throw e; });
  return sessP;
}

// 検出: 画像を幅 detW(32の倍数)へ揃えて推論 → 確率マップを二値化 → 連結成分ごとの外接矩形(少し広げる)を返す。
// 縦に長いレシートは、メモリを食わないよう縦に分けて(少し重ねて)推論し、確率マップをつなぐ
const BAND = 1024, OVERLAP = 128;
async function detect(S, cv, detW) {
  const { ort, det } = S;
  const sc = Math.min(detW / cv.width, 3), W = Math.max(32, Math.round((cv.width * sc) / 32) * 32);
  const H = Math.max(32, Math.round((cv.height * (W / cv.width)) / 32) * 32);
  const rc = document.createElement('canvas'); rc.width = W; rc.height = H;
  const rx = rc.getContext('2d', { willReadFrequently: true }); rx.imageSmoothingQuality = 'high'; rx.drawImage(cv, 0, 0, W, H);
  const d = rx.getImageData(0, 0, W, H).data, n = W * H;
  rc.width = rc.height = 0;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]; // PaddleOCR はBGR順の配列にそのまま適用する
  const P = new Float32Array(n);
  const bands = [];
  if (H <= BAND + BAND / 4) bands.push([0, H]);
  else for (let y = 0; ; y += BAND - OVERLAP) { const y1 = Math.min(H, y + BAND); bands.push([Math.max(0, y1 - BAND), y1]); if (y1 >= H) break; }
  for (let k = 0; k < bands.length; k++) {
    const [y0, y1] = bands[k];
    const bh = y1 - y0, bn = W * bh, X = new Float32Array(3 * bn), o = y0 * W;
    for (let i = 0; i < bn; i++) { const q = (o + i) * 4; X[i] = (d[q + 2] / 255 - mean[0]) / std[0]; X[bn + i] = (d[q + 1] / 255 - mean[1]) / std[1]; X[2 * bn + i] = (d[q] / 255 - mean[2]) / std[2]; }
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', X, [1, 3, bh, W]) });
    const Q = out[det.outputNames[0]].data;
    // 重なり部分は、帯の端から遠い側(中央寄り)の結果を使う(帯の端は周囲が見えず不安定)
    const from = (k ? OVERLAP / 2 : 0) * W, to = bn - (k < bands.length - 1 ? OVERLAP / 2 : 0) * W;
    for (let i = from; i < to; i++) P[o + i] = Q[i];
  }
  const THR = 0.3, BOX = 0.5, lab = new Uint8Array(n), stack = new Int32Array(n), boxes = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (lab[s0] || P[s0] <= THR) continue;
    let sp = 0, a = 0, sum = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; stack[sp++] = s0; lab[s0] = 1;
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p - x) / W; a++; sum += P[p]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !lab[p - 1] && P[p - 1] > THR) { lab[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && !lab[p + 1] && P[p + 1] > THR) { lab[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - W] && P[p - W] > THR) { lab[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && !lab[p + W] && P[p + W] > THR) { lab[p + W] = 1; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (a < 12 || Math.min(w, h) < 3 || sum / a < BOX) continue;
    const dd = (w * h * 1.5) / (2 * (w + h)); // DBのunclip: 面積×比率÷周長 だけ外へ広げる
    // 細長い枠は、画素の分布の主軸の向き(ラジアン)=文字行の傾き
    const mx = sx / a, my = sy / a, cxx = sxx / a - mx * mx, cyy = syy / a - my * my, cxy = sxy / a - mx * my;
    const ang = w >= 5 * h ? 0.5 * Math.atan2(2 * cxy, cxx - cyy) : null;
    boxes.push({ ang, t: { x0: x0 / sc, y0: y0 / sc, x1: (x1 + 1) / sc, y1: (y1 + 1) / sc }, x0: (x0 - dd) / sc, y0: (y0 - dd) / sc, x1: (x1 + 1 + dd) / sc, y1: (y1 + 1 + dd) / sc, score: sum / a });
  }
  return boxes;
}

// 認識: 高さ48pxに揃えた切り抜きを推論 → CTC貪欲デコード
async function recognize(S, crop, dict) {
  const { ort, rec } = S;
  const h = 48, w = Math.max(16, Math.min(3200, Math.ceil((h * crop.width) / crop.height)));
  const rc = document.createElement('canvas'); rc.width = w; rc.height = h;
  const rx = rc.getContext('2d', { willReadFrequently: true }); rx.imageSmoothingQuality = 'high'; rx.drawImage(crop, 0, 0, w, h);
  const d = rx.getImageData(0, 0, w, h).data, n = w * h, X = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { X[i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5; X[n + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5; X[2 * n + i] = (d[i * 4] / 255 - 0.5) / 0.5; }
  rc.width = rc.height = 0;
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', X, [1, 3, h, w]) });
  const o = out[rec.outputNames[0]], [, T, C] = o.dims, P = o.data;
  if (CFG().debug && !recognize.logged) { recognize.logged = 1; console.log('rec dims', o.dims.join('x'), 'dict', dict.length); }
  let text = '', prev = 0, conf = 0, k = 0;
  for (let t = 0; t < T; t++) {
    let bi = 0, bv = -1; for (let c = 0; c < C; c++) { const v = P[t * C + c]; if (v > bv) { bv = v; bi = c; } }
    if (bi !== 0 && bi !== prev) { text += bi - 1 < dict.length ? dict[bi - 1] : ' '; conf += bv; k++; }
    prev = bi;
  }
  return { text, conf: k ? conf / k : 0 };
}

// 文字のかたまりを行にまとめる。広げる前の「素の」枠の縦の中心が、行の中心から枠の高さの約0.6倍以内なら同じ行(行内は左から右)
export function toLines(items, k = 0.6) {
  const rows = [];
  items = items.map((it) => ({ it, cy: (it.t.y0 + it.t.y1) / 2 }));
  for (const { it, cy } of items.slice().sort((a, b) => a.cy - b.cy)) {
    const h = it.t.y1 - it.t.y0;
    let row = null, bd = Infinity;
    for (const r of rows) { const d = Math.abs(cy - r.cy); if (d < bd && d < k * Math.max(h, r.h)) { bd = d; row = r; } }
    if (row) { row.items.push(it); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; row.h = Math.max(row.h, h); } else rows.push({ items: [it], cy, h });
  }
  rows.sort((a, b) => a.cy - b.cy);
  // 紙のたわみや撮影角度で、右端の金額だけが左の品名より少し上/下にずれて別の行になることがある。
  // 「金額だけの行」と「金額で終わらない行」が縦にほぼ重なるとき(近い順に1対1で)同じ行にする
  const maxX = Math.max(...items.map((o) => o.it.x1), 1);
  const priceOnly = (r) => r.items.length === 1 && r.items[0].x0 > 0.5 * maxX && /^[¥￥\\]?\s*-?\d[\d,.]*\s*[軽輕※*]?$/.test(r.items[0].text.trim());
  const labelOnly = (r) => Math.max(...r.items.map((i) => i.x1)) < 0.8 * maxX && !/\d\s*[軽輕※*]?\s*$/.test(r.items[r.items.length - 1].text.trim()) && r.items.some((i) => /[ぁ-んァ-ヶ一-龠A-Za-z]/.test(i.text));
  const pairs = [];
  for (const p of rows) if (priceOnly(p)) for (const l of rows) if (l !== p && labelOnly(l)) { const dy = Math.abs(p.cy - l.cy); if (dy < 1.0 * Math.max(p.h, l.h)) pairs.push([dy, p, l]); }
  pairs.sort((a, b) => a[0] - b[0]);
  const gone = new Set(), taken = new Set();
  for (const [, p, l] of pairs) { if (gone.has(p) || taken.has(l)) continue; l.items.push(...p.items); gone.add(p); taken.add(l); }
  return rows.filter((r) => !gone.has(r)).map((r) => {
    r.items.sort((a, b) => a.x0 - b.x0);
    return { text: r.items.map((i) => i.text).join(' '), y0: Math.min(...r.items.map((i) => i.y0)), y1: Math.max(...r.items.map((i) => i.y1)), x0: r.items[0].x0, x1: r.items[r.items.length - 1].x1, conf: Math.min(...r.items.map((i) => i.conf)), parts: r.items };
  });
}

// 確信度がとても低い短い枠(模様や影を文字と読んだゴミ)を、ほかの枠もある行から除く
export function dropNoise(parts) {
  if (parts.length < 2) return parts;
  const keep = parts.filter((p) => !(p.conf < 0.5 && Array.from(p.text).length <= 8));
  return keep.length ? keep : parts;
}

// 文字の位置だけを調べる(切り出し範囲の判断用)。戻り値は枠の配列
export async function paddleDetect(cv, onProgress, detW) {
  const S = await loadPaddle(onProgress), t0 = performance.now();
  const boxes = await detect(S, cv, detW || CFG().detW);
  if (CFG().debug) console.log('detect', cv.width + 'x' + cv.height, 'detW', detW || CFG().detW, boxes.length, 'boxes', Math.round(performance.now() - t0) + 'ms');
  return boxes;
}

// 編集距離にもとづく類似度(0〜1)
function sim(a, b) {
  if (a === b) return 1;
  const A = Array.from(a), B = Array.from(b), m = A.length, n = B.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)); prev = cur; }
  return 1 - prev[n] / Math.max(m, n);
}

// 切り抜きの余白を変えた複数の読み(cands: [{text, conf, pad}])から1つ選ぶ。policy: 'conf' 確信度が最大 / 'medoid' ほかの読みと最も一致するもの(確信度で重み付け)
export function pick(cands, policy = 'medoid') {
  const ok = cands.filter((c) => c.text.trim());
  if (!ok.length) return cands[0] || { text: '', conf: 0 };
  if (policy === 'conf' || ok.length < 3) return ok.reduce((a, b) => (b.conf > a.conf ? b : a));
  let best = null, bs = -1;
  for (const c of ok) { let v = 0; for (const o of ok) if (o !== c) v += sim(c.text, o.text) * o.conf; v += 0.3 * c.conf; if (v > bs) { bs = v; best = c; } }
  return best;
}

// 文字行の傾き(ラジアン、時計回りが正)。細長い枠の向きの中央値。枠が少なければ 0
export function textTilt(boxes) {
  const a = boxes.filter((b) => b.ang !== null && b.ang !== undefined && b.score >= 0.6 && Math.abs(b.ang) < 0.35).map((b) => b.ang).sort((x, y) => x - y);
  return a.length >= 5 ? a[a.length >> 1] : 0;
}

// 検出済みの枠を1つずつ読む → { lines: [{text, conf, y0, y1, x0, x1, parts}], text }
// post: 文字列の後処理(候補ごとに適用してから選ぶ)
export async function paddleRecognize(cv, boxes, onProgress, post = (t) => t) {
  const S = await loadPaddle(), c = CFG();
  const items = [];
  let stopAt = Infinity;
  boxes = boxes.slice().sort((a, b) => a.t.y0 + a.t.y1 - (b.t.y0 + b.t.y1)); // 上から順に読む
  for (let i = 0; i < boxes.length; i++) {
    if (i >= stopAt) break;
    const b = boxes[i], cands = [];
    for (const r of c.pads || [1.5, 1.0, 2.2]) { // 切り抜きの余白(DBのunclip比)を変えて読み直す。最初の読みの確信度が高ければ読み直さない
      if (cands.length && Math.max(...cands.map((q) => q.conf)) >= (c.retry ?? 0.9)) break;
      const tw = b.t.x1 - b.t.x0, th = b.t.y1 - b.t.y0, dd = (tw * th * r) / (2 * (tw + th));
      const x0 = Math.max(0, Math.floor(b.t.x0 - dd)), y0 = Math.max(0, Math.floor(b.t.y0 - dd)), x1 = Math.min(cv.width, Math.ceil(b.t.x1 + dd)), y1 = Math.min(cv.height, Math.ceil(b.t.y1 + dd));
      const w = x1 - x0, h = y1 - y0; if (w < 4 || h < 4) continue;
      const crop = document.createElement('canvas'); crop.width = w; crop.height = h;
      crop.getContext('2d').drawImage(cv, x0, y0, w, h, 0, 0, w, h);
      const q = await recognize(S, crop, c.dict || DICT);
      cands.push({ text: post(q.text), conf: q.conf, pad: r });
      crop.width = crop.height = 0;
    }
    if (!cands.length) continue;
    const r = pick(cands, c.policy || 'conf');
    if (c.stopAfterTotal !== 0 && stopAt === Infinity && /合計|総計|現計|お買上計|お会計/.test(r.text.normalize('NFKC').replace(/\s/g, '')) && !/小計|点数/.test(r.text)) stopAt = i + 1 + (c.stopAfterTotal ?? 14); // 合計のあとは支払・ポイント・広告。数行だけ読んで打ち切る
    if (r.text.trim()) items.push({ x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1), t: b.t, ang: b.ang, text: r.text, conf: r.conf, cands });
    onProgress?.((i + 1) / boxes.length);
  }
  const lines = toLines(items);
  return { lines, text: lines.map((l) => l.text).join('\n') };
}
