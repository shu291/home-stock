import { rakutenApi } from './config.js';
// バーコード読み取り。BarcodeDetector(Android/Chrome)があれば使い、なければ(または読めないときの保険に) ZXing(iPhone Safari など)で、
// 映像から1コマずつ取り出して読む。画像は外部に送られない。
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let zxingP;
const loadZxing = () => (zxingP ||= new Promise((res, rej) => {
  if (window.ZXing) return res(window.ZXing);
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  s.onload = () => res(window.ZXing); s.onerror = () => { zxingP = null; rej(new Error('読み取り部品を読み込めませんでした(通信を確認してください)')); };
  document.head.appendChild(s);
}));

// 桁数とチェックディジットが正しい番号だけ受け付ける(読み間違いを防ぐ)
export function validCode(c) {
  if (!/^\d{8}$|^\d{12,13}$/.test(c)) return false;
  const d = c.split('').map(Number), last = d.pop();
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === last;
}

// ZXing で canvas(または画像)から1つ読む。読めなければ null
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
    return zxReader.decodeWithState(bmp).getText();
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
  if (det) { try { const r = await det.detect(im); const c = r.map((x) => x.rawValue).find(validCode); if (c) return c; } catch { /* ZXing に任せる */ } }
  for (const maxW of [1600, 1000, 2400, 700]) {
    const k = Math.min(1, maxW / Math.max(W, H)), cv = document.createElement('canvas');
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    const c = await zxDecode(cv);
    if (c && validCode(c)) return c;
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
    let done = false, stop = () => {};
    const finish = (code) => { if (done) return; done = true; stop(); resolve(code); };
    $('#bx').onclick = () => finish(null);
    d.addEventListener('close', () => finish(null), { once: true });
    $('#bg').onclick = () => { const v = $('#bn').value.normalize('NFKC').replace(/\s/g, ''); validCode(v) ? finish(v) : ($('#bs').textContent = '番号が正しくありません(8桁または13桁の数字。入力ミスがないか確認してください)'); };
    $('#bn').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bg').click(); } };
    $('#bp').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      $('#bs').textContent = '写真を読み取り中…';
      try { const c = await decodePhoto(f); c ? finish(c) : ($('#bs').textContent = '写真から読み取れませんでした。バーコードを大きく、ピントを合わせて撮り直すか、番号を入力してください'); }
      catch (err) { $('#bs').textContent = `写真を読み取れませんでした(${err?.message || '不明'})`; }
    };
    (async () => {
      const v = $('#bv'); let stream;
      v.muted = true; v.setAttribute('playsinline', '');
      try {
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
        catch (e) { if (e?.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); else throw e; }
      } catch (e) { $('#bs').textContent = `${camError(e)}。「写真で読み取る」か、番号の入力が使えます`; return; }
      stop = () => stream.getTracks().forEach((t) => t.stop());
      if (done) return stop();
      v.srcObject = stream; await v.play().catch(() => {});
      $('#bs').textContent = 'バーコードを枠いっぱいに映してください';
      const det = nativeDetector(), cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
      const t0 = Date.now(); let last = '', lastAt = 0, zxFail = 0;
      const accept = (c) => { // 同じ番号を連続2回読めたら確定(読み間違い防止)
        if (!validCode(c)) return false;
        if (c === last && Date.now() - lastAt < 2000) { finish(c); return true; }
        last = c; lastAt = Date.now(); return false;
      };
      const tick = async () => {
        if (done) return;
        try {
          if (v.videoWidth) {
            if (det) { try { const r = await det.detect(v); if (r.some((x) => accept(x.rawValue))) return; } catch { /* 次へ */ } }
            // ZXing: 標準では使わないが、BarcodeDetector が無い/3秒読めないときに使う
            if (!det || Date.now() - t0 > 3000) {
              const k = Math.min(1, 1280 / v.videoWidth); cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
              ctx.drawImage(v, 0, 0, cv.width, cv.height);
              const c = await zxDecode(cv); if (c && accept(c)) return;
            }
          }
        } catch (e) {
          if (++zxFail >= 3 && !det) { $('#bs').textContent = `${e.message || '読み取り部品の起動に失敗しました'}。「写真で読み取る」か、番号の入力が使えます`; return; }
        }
        setTimeout(tick, 120);
      };
      tick();
    })();
  });
}

// 商品名の検索。楽天(設定時・日用品に強い)→ Open Food Facts(食品)の順に試す。見つからなければ空
export async function lookupName(code) {
  return (await openBD(code)) || (await rakuten(code)) || (await openFoodFacts(code));
}

// 本(ISBN: 978/979 で始まる)は openBD で書名を取る。キー不要・無料
async function openBD(code) {
  if (!/^97[89]\d{10}$/.test(code)) return '';
  try {
    const r = await fetch(`https://api.openbd.jp/v1/get?isbn=${code}`, { signal: AbortSignal.timeout(5000) });
    const m = (await r.json())?.[0]?.summary; if (!m?.title) return '';
    return [m.title, m.volume].filter(Boolean).join(' ').slice(0, 60);
  } catch { return ''; }
}

// 楽天の商品名は宣伝文句が長いので、【…】などを除いて短くする
const tidy = (n) => n.replace(/【[^】]*】|［[^］]*］|\[[^\]]*\]|★[^★]*★|[☆★♪]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

async function rakuten(code) {
  const { applicationId, accessKey } = rakutenApi;
  if (!applicationId || !accessKey) return '';
  try {
    const u = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601?applicationId=${applicationId}&accessKey=${accessKey}&format=json&hits=1&keyword=${code}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return '';
    const it = (await r.json()).Items?.[0];
    return tidy(it?.Item?.itemName ?? it?.itemName ?? '');
  } catch { return ''; }
}

async function openFoodFacts(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_ja,brands`, { signal: AbortSignal.timeout(5000) });
    const p = (await r.json()).product; if (!p) return '';
    const name = p.product_name_ja || p.product_name || ''; if (!name) return '';
    const brand = (p.brands || '').split(',')[0].trim();
    return brand && !name.includes(brand) ? `${brand} ${name}` : name;
  } catch { return ''; }
}
