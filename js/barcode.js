// バーコード読み取り。BarcodeDetector(Android/Chrome)があれば使い、なければ ZXing(iPhone Safari など)
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let zxingP;
const loadZxing = () => (zxingP ||= new Promise((res, rej) => {
  if (window.ZXing) return res(window.ZXing);
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  s.onload = () => res(window.ZXing); s.onerror = () => rej(new Error('バーコード読み取りの読み込みに失敗'));
  document.head.appendChild(s);
}));

// ダイアログ d の中でカメラを開き、番号を1つ読む。やめたら null
export function scan(d) {
  return new Promise((resolve) => {
    d.innerHTML = `<h3>バーコードを読み取る</h3><video id="bv" playsinline muted style="width:100%;border-radius:12px;background:#000;min-height:160px"></video>
    <div class="sub" id="bs">カメラを起動中…</div>
    <label>読めないときは番号を入力</label><div class="row"><input id="bn" inputmode="numeric" placeholder="13桁の番号"><button class="b" id="bg">決定</button></div>
    <div class="row" style="margin-top:12px"><button class="b grow" id="bx">やめる</button></div>`;
    const $ = (s) => d.querySelector(s);
    let done = false, stop = () => {};
    const finish = (code) => { if (done) return; done = true; stop(); resolve(code); };
    $('#bx').onclick = () => finish(null);
    d.addEventListener('close', () => finish(null), { once: true });
    $('#bg').onclick = () => { const v = $('#bn').value.normalize('NFKC').trim(); /^\d{8,14}$/.test(v) ? finish(v) : ($('#bs').textContent = '8〜14桁の数字を入れてください'); };
    (async () => {
      const v = $('#bv'); let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch { $('#bs').textContent = 'カメラを使えません。下の欄に番号を入力できます'; return; }
      stop = () => stream.getTracks().forEach((t) => t.stop());
      if (done) return stop();
      v.srcObject = stream; await v.play().catch(() => {});
      $('#bs').textContent = 'バーコードを枠いっぱいに映してください';
      try {
        if ('BarcodeDetector' in window) {
          const det = new BarcodeDetector({ formats: FORMATS });
          const tick = async () => { if (done) return; try { const r = await det.detect(v); if (r[0]) return finish(r[0].rawValue); } catch {} setTimeout(tick, 200); };
          tick();
        } else {
          const Z = await loadZxing();
          const reader = new Z.BrowserMultiFormatReader();
          stop = () => { reader.reset(); stream.getTracks().forEach((t) => t.stop()); };
          reader.decodeFromVideoElement(v, (r) => { if (r) finish(r.getText()); });
        }
      } catch (e) { $('#bs').textContent = `${e.message}。番号を入力できます`; }
    })();
  });
}

// 商品名の検索(Open Food Facts。食品中心で、無い商品は手入力)
export async function lookupName(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_ja,brands`, { signal: AbortSignal.timeout(5000) });
    const p = (await r.json()).product; if (!p) return '';
    const name = p.product_name_ja || p.product_name || ''; if (!name) return '';
    const brand = (p.brands || '').split(',')[0].trim();
    return brand && !name.includes(brand) ? `${brand} ${name}` : name;
  } catch { return ''; }
}
