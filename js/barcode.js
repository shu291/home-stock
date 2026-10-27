import { rakutenApi } from './config.js';
import { normalizeScan, validCode, canonCode, classify } from './lookup-code.js';
import { createLookup } from './lookup-net.js';
export { normalizeScan, validCode, canonCode, classify };
// バーコード読み取り。BarcodeDetector(Android/Chrome)があれば使い、なければ(または読めないときの保険に) ZXing(iPhone Safari など)で、
// 映像から1コマずつ取り出して読む。画像は外部に送られない。
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
// ZXing(読み取り部品)は CDN から読む。Service Worker は他サイトのファイルを保存しないので、読めた後に IndexedDB へ写しを残し、
// 電波のない所(CDN に届かないとき)はその写しから起動する(オフラインでも、登録済みの商品を読み取って数量を足せる)
const ZX_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const zxDb = () => new Promise((res, rej) => { const r = indexedDB.open('hs-lib', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const zxGet = async () => { try { const db = await zxDb(); return await new Promise((res) => { const q = db.transaction('s').objectStore('s').get(ZX_URL); q.onsuccess = () => res(q.result || ''); q.onerror = () => res(''); }); } catch { return ''; } };
const zxPut = async () => { try { if (await zxGet()) return; const t = await (await fetch(ZX_URL)).text(); if (t.length < 1e4) return; const db = await zxDb(); db.transaction('s', 'readwrite').objectStore('s').put(t, ZX_URL); } catch { /* 保存できなくても動く */ } };
const addScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
let zxingP;
const loadZxing = () => (zxingP ||= (async () => {
  if (window.ZXing) return window.ZXing;
  try { await addScript(ZX_URL); zxPut(); }
  catch {
    const t = await zxGet(); // CDN に届かない: 前に保存した写しで起動
    if (!t) { zxingP = null; throw new Error('読み取り部品を読み込めませんでした(通信を確認してください)'); }
    const u = URL.createObjectURL(new Blob([t], { type: 'text/javascript' }));
    try { await addScript(u); } catch { zxingP = null; throw new Error('読み取り部品を読み込めませんでした(通信を確認してください)'); } finally { URL.revokeObjectURL(u); }
  }
  if (!window.ZXing) { zxingP = null; throw new Error('読み取り部品を読み込めませんでした'); }
  return window.ZXing;
})());

// ZXing で canvas(または画像)から1つ読む。戻り値 { text, format } 。読めなければ null
let zxReader;
async function zxDecode(canvas) {
  const Z = await loadZxing();
  if (!zxReader) {
    zxReader = new Z.MultiFormatReader();
    zxReader.setHints(new Map([
      [Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]],
      [Z.DecodeHintType.TRY_HARDER, true],
    ]));
  }
  try {
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
    const r = zxReader.decodeWithState(bmp);
    return { text: r.getText(), format: Z.BarcodeFormat[r.getBarcodeFormat()] || '' };
  } catch { return null; }
}

const nativeDetector = () => { try { return 'BarcodeDetector' in window ? new BarcodeDetector({ formats: FORMATS }) : null; } catch { return null; } };

// 写真1枚から番号を読む。大きい写真は縮小して、大きさを変えながら試す
export async function decodePhoto(file) {
  let im;
  try { im = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const W = im.width, H = im.height;
  const det = nativeDetector();
  if (det) { try { const r = await det.detect(im); for (const x of r) { const n = normalizeScan(x.rawValue, x.format); if (n) return n.code; } } catch { /* ZXing に任せる */ } }
  for (const maxW of [1600, 1000, 2400, 700]) {
    const k = Math.min(1, maxW / Math.max(W, H)), cv = document.createElement('canvas');
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    const z = await zxDecode(cv), n = z && normalizeScan(z.text, z.format);
    if (n) return n.code;
  }
  return null;
}

const camError = (e) => {
  const n = e?.name || '';
  if (!navigator.mediaDevices?.getUserMedia) return 'この画面ではカメラを使えません(https で開いているか確認してください)';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'カメラの許可がありません。端末の設定でこのアプリ(ブラウザ)にカメラを許可してください';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'カメラが見つかりません';
  if (n === 'NotReadableError' || n === 'AbortError') return 'カメラを使えません(ほかのアプリが使用中かもしれません)';
  return `カメラを開けませんでした(${n || e?.message || '不明'})`;
};

// ダイアログ d の中でカメラを開き、番号を1つ読む。やめたら null
export function scan(d) {
  return new Promise((resolve) => {
    d.innerHTML = `<h3 id="dlg-h" tabindex="-1">バーコードを読み取る</h3><video id="bv" playsinline muted autoplay style="width:100%;border-radius:12px;background:#000;min-height:160px"></video>
    <div class="sub" id="bs" role="status">カメラを起動中…</div>
    <label for="bn">読めないときは番号を入力</label><div class="row"><input id="bn" inputmode="numeric" placeholder="13桁の番号"><button class="b" id="bg" style="white-space:nowrap;min-width:72px">決定</button></div>
    <div class="row" style="margin-top:12px"><label class="b filebtn grow" style="margin:0">写真で読み取る<input type="file" id="bp" accept="image/*" capture="environment" class="vh"></label><button class="b grow" id="bx">やめる</button></div>`;
    d.setAttribute('aria-labelledby', 'dlg-h');
    const $ = (s) => d.querySelector(s);
    const say = (t) => { const e = d.querySelector('#bs'); if (e) e.textContent = t; }; // 読み取りが終わって画面が変わった後は何もしない
    let done = false, stop = () => {};
    const finish = (code) => { if (done) return; done = true; stop(); resolve(code); };
    $('#bx').onclick = () => finish(null);
    d.addEventListener('close', () => finish(null), { once: true });
    $('#bg').onclick = () => { const n = normalizeScan($('#bn').value); n ? finish(n.code) : say('番号が正しくありません(8桁・12桁・13桁の数字。入力ミスがないか確認してください)'); };
    $('#bn').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bg').click(); } };
    $('#bp').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      say('写真を読み取り中…');
      try { const c = await decodePhoto(f); c ? finish(c) : say('写真から読み取れませんでした。バーコードを大きく、ピントを合わせて撮り直すか、番号を入力してください'); }
      catch (err) { say(`写真を読み取れませんでした(${err?.message || '不明'})`); }
    };
    (async () => {
      const v = $('#bv'); let stream;
      v.muted = true; v.setAttribute('playsinline', '');
      try {
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
        catch (e) { if (e?.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); else throw e; }
      } catch (e) { say(`${camError(e)}。「写真で読み取る」か、番号の入力が使えます`); return; }
      stop = () => stream.getTracks().forEach((t) => t.stop());
      if (done) return stop();
      v.srcObject = stream; await v.play().catch(() => {});
      if (done) return; // (待っている間に写真・番号入力で読み取りが終わっていた)
      say('バーコードを枠いっぱいに映してください');
      const det = nativeDetector(), cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
      const t0 = Date.now(); let last = '', lastAt = 0, zxFail = 0;
      const accept = (raw, fmt) => { // 同じ番号を連続2回読めたら確定(読み間違い防止)
        const c = normalizeScan(raw, fmt)?.code; if (!c) return false;
        if (c === last && Date.now() - lastAt < 2000) { finish(c); return true; }
        last = c; lastAt = Date.now(); return false;
      };
      const tick = async () => {
        if (done) return;
        try {
          if (v.videoWidth) {
            if (det) { try { const r = await det.detect(v); if (r.some((x) => accept(x.rawValue, x.format))) return; } catch { /* 次へ */ } }
            // ZXing: 標準では使わないが、BarcodeDetector が無い/3秒読めないときに使う
            if (!det || Date.now() - t0 > 3000) {
              const k = Math.min(1, 1280 / v.videoWidth); cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
              ctx.drawImage(v, 0, 0, cv.width, cv.height);
              const z = await zxDecode(cv); if (z && accept(z.text, z.format)) return;
            }
          }
        } catch (e) {
          if (++zxFail >= 3 && !det) { say(`${e.message || '読み取り部品の起動に失敗しました'}。「写真で読み取る」か、番号の入力が使えます`); return; }
        }
        setTimeout(tick, 120);
      };
      tick();
    })();
  });
}

// 商品名の検索。番号の種類で問い合わせ先を振り分け(lookup-code.js)、楽天は直列キューで間隔をあけ、結果は端末内に保存する(lookup-net.js)。
// lookupProduct: { code, kind, name, from, reason, cached }。name が空なら reason が理由('instore' など・'notfound'・'offline'・'error')
let lk;
export const lookupProduct = (code, opt) => (lk ||= createLookup({ rakutenApi })).lookup(code, opt);
// 従来の形(名前だけ。見つからなければ空)
export async function lookupName(code) { return (await lookupProduct(code)).name; }
