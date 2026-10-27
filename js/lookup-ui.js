// バーコード登録フォーム(app.js の barcodeForm)の「商品名を調べる」部分の画面処理。
//  - 番号から商品名を検索(barcode.js の lookupProduct)し、見つかれば名前欄に入れる
//  - 見つからないときは理由を表示し、「パッケージの文字から名前を読み取る」(端末内OCR。画像は保存も送信もしない)と「もう一度調べる」を出す
//  - OCR の結果は、商品名らしい行を最大3つ、ボタンで出す(タップで名前欄へ)
import { lookupProduct } from './barcode.js';
import { reasonText } from './lookup-code.js';
import { nameCandidates } from './lookup-ocr.js';

const SRC = { rakuten: '楽天市場', off: 'Open Food Facts', obf: 'Open Beauty Facts', opf: 'Open Products Facts', opff: 'Open Pet Food Facts', openbd: 'openBD', gbooks: 'Google Books' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const READY_KEY = 'hs-ocr-ready'; // レシート読み取り(app.js)と同じ印。OCRのデータを端末に保存済みか
const flag = (v) => { try { if (v) localStorage.setItem(READY_KEY, '1'); else return localStorage.getItem(READY_KEY) === '1'; } catch { /* 保存できない環境 */ } return false; };

// OCR のデータ(IndexedDB 'ocr-models')が端末にあるか。印があればそれを信じ、なければ中身を見る
export async function ocrModelsReady() {
  if (flag()) return true;
  try {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ocr-models', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const keys = await new Promise((res) => { const q = db.transaction('m').objectStore('m').getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
    db.close();
    const ok = keys.some((k) => /rec_onnx/.test(k)) && keys.some((k) => /det_onnx/.test(k));
    if (ok) flag(true);
    return ok;
  } catch { return false; }
}

// d: ダイアログ。input: 名前欄。apply(name): 名前を入れる(カテゴリの推定は呼び出し側)。isTyped(): 利用者が名前欄を直接入力したか
export function mountLookup(d, { code, input, apply, isTyped }) {
  const note = d.querySelector('#b-note'), help = d.querySelector('#b-help');
  let alive = true, ocrAbort = null;
  const gone = () => !alive || !input.isConnected;
  const say = (t) => { note.textContent = t; };

  async function search(force) {
    say('商品名を検索中…'); help.hidden = true; input.placeholder = '商品名を検索中…';
    let r; try { r = await lookupProduct(code, { force }); } catch { r = { name: '', reason: 'error' }; }
    if (gone()) return;
    if (r.name) {
      if (!isTyped()) apply(r.name);
      const approx = r.from?.endsWith('~'), src = SRC[String(r.from).replace('~', '')] || '';
      say(approx ? `近い商品名です(${src}の複数の出品に共通する部分)。違っていたら直してください` : `${src ? `「${src}」で見つかりました。` : ''}違っていたら直してください`);
      return;
    }
    input.placeholder = '商品名を入力';
    say(reasonText(r.reason));
    showHelp(r.reason);
  }

  function showHelp(reason) {
    if (reason === 'bookprice' || reason === 'coupon') { help.hidden = true; return; } // 別のバーコードを読み直す案内だけ
    help.hidden = false;
    const retry = reason === 'error' || reason === 'offline';
    help.innerHTML = `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">${retry ? '<button type="button" class="b grow" id="b-retry">もう一度調べる</button>' : ''}<button type="button" class="b grow" id="b-ocr">パッケージの文字から名前を読み取る</button><input type="file" id="b-ph" accept="image/*" capture="environment" class="vh" tabindex="-1" aria-label="商品パッケージの写真"></div><div id="b-ocr-st" class="sub" role="status" style="margin-top:6px"></div><div id="b-cands" style="display:flex;flex-direction:column;gap:6px;margin-top:6px"></div>`;
    const $ = (s) => help.querySelector(s), st = $('#b-ocr-st'), ph = $('#b-ph'), ob = $('#b-ocr');
    if ($('#b-retry')) $('#b-retry').onclick = () => search(true);
    let agreed = false;
    ob.onclick = async () => {
      if (ocrAbort) return;
      if (!agreed && !(await ocrModelsReady())) { // 初回だけ約34MBのダウンロードが要る: 確認してから進む
        agreed = true; ob.textContent = 'ダウンロードして読み取る(約34MB)';
        st.textContent = '初回だけ、読み取り用のデータ(約34MB)をダウンロードします。Wi-Fiでの利用をおすすめします。よければもう一度押して、商品の正面を撮影してください。';
        return;
      }
      ph.click();
    };
    ph.onchange = async () => {
      const f = ph.files[0]; ph.value = ''; if (!f) return;
      await runOcr(f, st, $('#b-cands'), ob);
    };
  }

  async function runOcr(file, st, box, ob) {
    const first = !(await ocrModelsReady()), ac = (ocrAbort = new AbortController()), t0 = Date.now();
    box.innerHTML = ''; ob.disabled = true;
    st.innerHTML = '<span class="p">文字を読み取り中…</span> <button type="button" class="b" id="b-ocr-x" style="min-height:44px">やめる</button>';
    d.querySelector('#b-ocr-x').onclick = () => ac.abort();
    const to = setTimeout(() => ac.abort(), first ? 300e3 : 60e3);
    const prog = (p) => { const e = st.querySelector('.p'); if (e && !gone()) e.textContent = `文字を読み取り中… ${Math.round(p * 100)}%${first && Date.now() - t0 > 4000 && p < 0.35 ? '(初回はデータをダウンロード中)' : ''}`; };
    let lines = [], size = [0, 0], failed = '';
    try {
      const m = await import('./ocr.js');
      try { const r = await m.ocrDetailed(file, prog, ac.signal); lines = r.lines; size = r.size; flag(true); }
      catch (e) {
        if (e?.name === 'AbortError') throw e;
        const text = await m.ocr(file, prog, { signal: ac.signal }); // 深層学習OCRが使えない端末は従来方式(位置の情報なし)
        lines = String(text || '').split('\n').map((t, i) => ({ text: t, conf: 0.8, x0: 0, x1: 100, y0: i * 20, y1: i * 20 + 16 })); size = [100, lines.length * 20 + 20]; flag(true);
      }
    } catch (e) { failed = e?.name === 'AbortError' ? (Date.now() - t0 > 55e3 ? '時間がかかりすぎたため中断しました。' : '中断しました。') : `読み取れませんでした(${e?.message || '不明'})。`; }
    clearTimeout(to); ocrAbort = null; ob.disabled = false; ob.textContent = 'もう一度撮影して読み取る';
    if (gone()) return;
    if (failed) { st.textContent = `${failed}名前を入力するか、もう一度撮影してください`; return; }
    const cands = nameCandidates(lines, size, 3);
    if (!cands.length) { st.textContent = '商品名らしい文字を読み取れませんでした。商品名の部分を大きく、明るい所で正面から撮り直すか、名前を入力してください'; return; }
    st.textContent = '名前に近いものをタップしてください(違えば名前欄で直せます)';
    box.innerHTML = cands.map((c, i) => `<button type="button" class="b" data-c="${i}" style="text-align:left">${esc(c)}</button>`).join('');
    box.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { apply(cands[+b.dataset.c], true); say('文字から読み取った名前です。違っていたら直してください'); input.focus({ preventScroll: true }); }; });
  }

  search(false);
  return () => { alive = false; ocrAbort?.abort(); };
}
