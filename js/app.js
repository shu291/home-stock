import { createStore } from './store.js';
import { norm, parseReceipt, parseReceiptMeta, checkTotal } from './parse.js';
import { guessCategory } from './category.js';
import { ocr } from './ocr.js';
import { gmailAvailable, fetchOrders } from './gmail.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATS = ['食品', '飲料', '日用品', '洗剤・衛生', '薬', '消耗品', 'その他'];
const LOCS = ['キッチン', '洗面所', '風呂・トイレ', '押入れ', '玄関', 'その他'];
const SRC = { amazon: 'Amazon', rakuten: '楽天', receipt: 'レシート', paste: '貼り付け', manual: '手入力' };

let store, state = { user: null, household: null }, items = [], unsub = null;
let tab = 'stock', q = '', cat = '', loc = '';
let draft = []; // 取り込み確認中の候補
let receipts = []; // 確認中のレシートごとの {store, date, total, tax, adjust}。draft の rid が添字

const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2200); };
const isLow = (i) => i.minQty > 0 && i.qty <= i.minQty;

// ---------- 画面 ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#who').textContent = state.user ? `${state.household?.name ?? ''} / ${state.user.name}` : '';
  const v = $('#view');
  if (!state.user) return (v.innerHTML = `<div class="empty"><p>家族みんなで使う在庫管理</p><button class="b p" id="login">Googleでログイン</button></div>`, $('#login').onclick = () => store.signIn());
  if (!state.household) return renderSetup(v);
  ({ stock: renderStock, shop: renderShop, import: renderImport, family: renderFamily })[tab](v);
}

function renderSetup(v) {
  v.innerHTML = `<div class="card"><h3>はじめに</h3><p class="sub">家族のだれか1人が「新しく作る」、ほかの人は「家族コード」で参加します。</p>
  <label>家の名前</label><input id="hn" value="うちの家"><button class="b p" id="mk" style="margin-top:8px">新しく作る</button></div>
  <div class="card"><label>家族コードで参加</label><input id="jc" placeholder="10文字のコード" autocapitalize="characters"><button class="b" id="jn" style="margin-top:8px">参加する</button></div>`;
  $('#mk').onclick = () => store.createHousehold($('#hn').value.trim() || 'うちの家').catch((e) => toast(e.message));
  $('#jn').onclick = () => store.joinHousehold($('#jc').value).catch(() => toast('参加できませんでした。コードを確認してください'));
}

function renderStock(v) {
  const list = items.filter((i) => (!cat || i.category === cat) && (!loc || i.location === loc) && (!q || norm(i.name).includes(norm(q))))
    .sort((a, b) => isLow(b) - isLow(a) || a.name.localeCompare(b.name, 'ja'));
  const chips = (arr, cur, k) => `<div class="chips"><button class="chip ${cur ? '' : 'on'}" data-${k}="">すべて</button>${arr.map((c) => `<button class="chip ${cur === c ? 'on' : ''}" data-${k}="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
  v.innerHTML = `<input id="q" type="search" placeholder="さがす" value="${esc(q)}">${chips(CATS, cat, 'cat')}${chips(LOCS, loc, 'loc')}` +
    (list.length ? list.map((i) => `<div class="card item row ${isLow(i) ? 'low' : ''}" data-id="${i.id}">
      <div class="grow" data-edit><div class="nm">${esc(i.name)}</div><div class="sub">${esc(i.location || '')} ${esc(i.category || '')}${isLow(i) ? ' ・ 残りわずか' : ''}${i.expiry ? ' ・ 期限 ' + esc(i.expiry) : ''}</div></div>
      <button class="b" data-d="-1">−</button><div class="qty">${i.qty}</div><button class="b" data-d="1">＋</button></div>`).join('')
      : `<div class="empty">まだ登録がありません。<br>右下の＋か「取り込み」から追加できます</div>`) +
    `<button class="b p fab" id="add">＋</button>`;
  $('#q').oninput = (e) => { q = e.target.value; const p = e.target.selectionStart; renderStock(v); const n = $('#q'); n.focus(); n.setSelectionRange(p, p); };
  v.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { cat = b.dataset.cat; render(); }));
  v.querySelectorAll('[data-loc]').forEach((b) => (b.onclick = () => { loc = b.dataset.loc; render(); }));
  v.querySelectorAll('.item').forEach((el) => {
    const it = items.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-edit]').onclick = () => editDialog(it);
    el.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => store.save({ ...it, qty: Math.max(0, it.qty + +b.dataset.d) })));
  });
  $('#add').onclick = () => editDialog();
}

function renderShop(v) {
  const list = items.filter(isLow);
  v.innerHTML = list.length ? `<p class="sub">残りが「最低在庫」以下のものが自動で並びます。</p>` + list.map((i) => `<div class="card row"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="sub">残り ${i.qty}(最低 ${i.minQty})</div></div><button class="b p" data-id="${i.id}">買った +${i.buyQty || 1}</button></div>`).join('')
    : `<div class="empty">買い足すものはありません 🎉<br><span class="sub">在庫の編集で「最低在庫」を設定すると、ここに出ます</span></div>`;
  v.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => { const i = items.find((x) => x.id === b.dataset.id); store.save({ ...i, qty: i.qty + (i.buyQty || 1), boughtAt: new Date().toISOString().slice(0, 10) }); }));
}

function renderFamily(v) {
  const h = state.household;
  v.innerHTML = `<div class="card"><h3>${esc(h.name)}</h3>${store.mode === 'cloud' ? `<p class="sub">家族に次のコードを伝えて、同じアプリで「家族コードで参加」してもらってください。</p><div class="code">${esc(h.id)}</div>` : `<p class="sub">いまは「お試しモード」です。家族で共有するには js/config.js に Firebase の設定が必要です(README参照)。</p>`}</div>
  ${store.mode === 'cloud' ? '<button class="b" id="out">ログアウト</button>' : ''}`;
  $('#out')?.addEventListener('click', () => store.signOut());
}

function renderImport(v) {
  v.innerHTML = `<div class="card"><h3>📷 レシート写真</h3><p class="sub">端末内で文字認識します(画像は送信されません)。結果は確認してから登録します。</p><input type="file" id="rc" accept="image/*" multiple><div class="sub" id="rcs"></div></div>
  ${gmailAvailable ? `<div class="card"><h3>✉️ Gmailの注文メール</h3><p class="sub">Amazon・楽天の注文確認メールを読み取ります(読み取り専用)。</p>
  <div class="grid2"><select id="gk"><option value="amazon">Amazon</option><option value="rakuten">楽天市場</option></select><select id="gm"><option value="1">過去1か月</option><option value="3" selected>過去3か月</option><option value="12">過去1年</option></select></div>
  <button class="b p" id="gb" style="margin-top:8px">読み取る</button><div class="sub" id="gs"></div></div>` : ''}
  <div class="card"><h3>📋 テキスト貼り付け</h3><p class="sub">注文履歴ページや購入メールの本文をそのまま貼り付けます。</p><textarea id="tx" rows="4"></textarea><button class="b" id="tb" style="margin-top:8px">解析する</button></div>`;
  $('#rc').onchange = async (e) => {
    const fs = [...e.target.files]; if (!fs.length) return;
    const s = $('#rcs'); resetReview();
    try {
      let raw = '';
      for (const [i, f] of fs.entries()) raw += await readReceipt(f, (t) => (s.textContent = `${fs.length > 1 ? `${i + 1}/${fs.length}枚目 ` : ''}${t}`));
      openReview(raw);
    } catch (err) { s.textContent = err.message; }
  };
  $('#tb').onclick = () => { const t = $('#tx').value; import('./parse.js').then((m) => { const r = [...m.parseOrderMail(t, { source: 'paste', key: 'p' + Date.now() })]; if (r.length) startReview(r, t); else { resetReview(); addReceipt(parseReceipt(t).map((x) => ({ ...x, source: 'paste' })), parseReceiptMeta(t)); openReview(t); } }); };
  $('#gb')?.addEventListener('click', async () => {
    const s = $('#gs');
    try { startReview(await fetchOrders($('#gk').value, $('#gm').value, (a, b) => (s.textContent = `読み取り中 ${a}/${b}`))); }
    catch (err) { s.textContent = err.message; }
  });
}

// ---------- 取り込み確認 ----------
const resetReview = () => { draft = []; receipts = []; };

// 写真1枚 → OCR → 確認中のリストに追加。戻り値は OCR テキスト
async function readReceipt(file, onStatus) {
  onStatus('読み取り中…(初回は言語データのダウンロードで時間がかかります)');
  const t = await ocr(file, (p) => onStatus(`読み取り中 ${Math.round(p * 100)}%`));
  addReceipt(parseReceipt(t), parseReceiptMeta(t));
  onStatus('');
  return t + '\n';
}

// レシート1枚ぶんの品目と店名・日付・合計を draft / receipts に足す
function addReceipt(cands, meta) {
  const rid = receipts.length;
  receipts.push({ store: meta?.store || '', date: meta?.date || '', total: meta?.total || 0, tax: meta?.tax || 0, adjust: meta?.adjust || 0 });
  draft.push(...cands.map((c) => ({ ...c, rid, on: true })));
}

// メール・貼り付けの候補から確認画面へ
function startReview(cands, raw) {
  resetReview();
  const known = new Set(items.map((i) => i.srcKeys || []).flat());
  draft = cands.map((c) => ({ ...c, on: !known.has(c.srcKey), dup: known.has(c.srcKey) }));
  openReview(raw);
}

// draft が出来上がっていれば確認画面を開く(レシートは readReceipt/addReceipt で作成済み)
function openReview(raw) {
  for (const c of draft) c.category ??= guessCategory(c.name);
  if (!draft.length) { toast('品目を見つけられませんでした'); if (raw) editDialog(null, raw); return; }
  reviewDialog();
}

const yen = (n) => '¥' + Math.abs(n).toLocaleString('ja-JP');
// レシートごとの検算結果の表示(品目の合計 と レシートの合計)
function checkText(r, n) {
  const c = checkTotal(draft.filter((x) => x.rid === n), r);
  if (c.ok === null) return { cls: '', t: `品目計 ${yen(c.sum)} ・ 合計が読み取れませんでした(右の欄に入れると検算します)` };
  if (c.ok) return { cls: 'ok', t: `✓ 合計と一致(${yen(c.sum)})` };
  return { cls: 'ng', t: `⚠ 合計と合いません 品目計 ${yen(c.sum)} / 差額 ${c.diff > 0 ? '+' : '−'}${yen(c.diff)}(${c.diff > 0 ? '品目が多い' : '読み落としの可能性'})` };
}

function reviewDialog() {
  const d = $('#dlg'), st = d.scrollTop;
  const row = (c, n) => `<div class="card rv"><div class="row"><input type="checkbox" data-on="${n}" ${c.on ? 'checked' : ''} style="width:auto" aria-label="登録する"><input class="grow" data-nm="${n}" value="${esc(c.name)}" aria-label="品名"><button class="b d" data-rm="${n}" aria-label="この行を削除">✕</button></div>
    <div class="rv2"><div><label>カテゴリ</label><select data-ct="${n}"><option value="">未設定</option>${CATS.map((x) => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div><label>数量</label><input data-q="${n}" type="number" min="1" value="${c.qty}"></div><div><label>金額(円)</label><input data-pr="${n}" type="number" min="0" value="${c.price || ''}"></div></div>
    <div class="sub">${c.dup ? '取り込み済み ・ ' : ''}${SRC[c.source] || ''} ${esc(c.boughtAt || '')}${c.discount ? ` ・ 値引 −¥${c.discount} 反映済み` : ''}</div></div>`;
  const head = (r, n) => { const k = checkText(r, n); return `<div class="card rc"><div class="grid2"><div><label>店名</label><input data-rs="${n}" value="${esc(r.store)}"></div><div><label>日付</label><input type="date" data-rd="${n}" value="${esc(r.date)}"></div></div>
    <div class="grid2"><div><label>レシートの合計(円)</label><input type="number" min="0" data-rt="${n}" value="${r.total || ''}"></div><div class="chk ${k.cls}" data-ck="${n}" role="status">${k.t}</div></div></div>`; };
  d.innerHTML = `<h3>この内容で登録しますか?</h3><p class="sub">名前・数量・金額・カテゴリを直せます。同じ名前が在庫にあれば数量を足します。</p>
  ${receipts.map(head).join('')}${draft.map(row).join('')}
  <div class="row" style="margin-top:8px"><button class="b grow" id="ad">＋ 品目を追加</button>${receipts.length ? '<label class="b grow filebtn">📷 別のレシートを追加<input type="file" id="more" accept="image/*" multiple hidden></label>' : ''}</div>
  <div class="sub" id="mst"></div>
  <div class="row" style="margin-top:12px"><button class="b" id="cx">やめる</button><button class="b p grow" id="ok">登録</button></div>`;
  const refresh = () => receipts.forEach((r, n) => { const k = checkText(r, n), e = d.querySelector(`[data-ck="${n}"]`); if (e) { e.className = `chk ${k.cls}`; e.textContent = k.t; } });
  d.querySelectorAll('[data-on]').forEach((e) => (e.onchange = () => (draft[e.dataset.on].on = e.checked)));
  d.querySelectorAll('[data-nm]').forEach((e) => (e.oninput = () => (draft[e.dataset.nm].name = e.value)));
  d.querySelectorAll('[data-ct]').forEach((e) => (e.onchange = () => (draft[e.dataset.ct].category = e.value)));
  d.querySelectorAll('[data-q]').forEach((e) => (e.oninput = () => (draft[e.dataset.q].qty = Math.max(1, +e.value || 1))));
  d.querySelectorAll('[data-pr]').forEach((e) => (e.oninput = () => { draft[e.dataset.pr].price = Math.max(0, +e.value || 0); refresh(); }));
  d.querySelectorAll('[data-rm]').forEach((e) => (e.onclick = () => { draft.splice(+e.dataset.rm, 1); reviewDialog(); }));
  d.querySelectorAll('[data-rs]').forEach((e) => (e.oninput = () => (receipts[e.dataset.rs].store = e.value)));
  d.querySelectorAll('[data-rd]').forEach((e) => (e.onchange = () => { receipts[e.dataset.rd].date = e.value; draft.forEach((c) => c.rid === +e.dataset.rd && (c.boughtAt = e.value)); }));
  d.querySelectorAll('[data-rt]').forEach((e) => (e.oninput = () => { receipts[e.dataset.rt].total = Math.max(0, +e.value || 0); refresh(); }));
  $('#ad').onclick = () => {
    const rid = receipts.length ? receipts.length - 1 : undefined;
    draft.push({ name: '', qty: 1, price: 0, boughtAt: receipts[rid]?.date || '', source: rid === undefined ? 'manual' : 'receipt', category: '', on: true, rid });
    reviewDialog(); d.querySelector(`[data-nm="${draft.length - 1}"]`)?.focus();
  };
  $('#more')?.addEventListener('change', async (e) => {
    const fs = [...e.target.files], s = $('#mst'); if (!fs.length) return;
    try {
      for (const [i, f] of fs.entries()) await readReceipt(f, (t) => (s.textContent = `${fs.length > 1 ? `${i + 1}/${fs.length}枚目 ` : ''}${t}`));
      for (const c of draft) c.category ??= guessCategory(c.name);
      reviewDialog();
    } catch (err) { s.textContent = err.message; }
  });
  $('#cx').onclick = () => d.close();
  $('#ok').onclick = async () => {
    const byName = new Map(items.map((i) => [norm(i.name), i]));
    let n = 0;
    for (const c of draft.filter((x) => x.on && x.name.trim())) {
      const ex = byName.get(norm(c.name));
      const keys = c.srcKey ? [c.srcKey] : [];
      const rec = ex ? { ...ex, qty: ex.qty + c.qty, category: ex.category || c.category || '', boughtAt: c.boughtAt || ex.boughtAt, srcKeys: [...(ex.srcKeys || []), ...keys] }
        : { name: c.name.trim(), qty: c.qty, category: c.category || '', location: '', minQty: 0, buyQty: 1, price: c.price, boughtAt: c.boughtAt, source: c.source, srcKeys: keys };
      await store.save(rec); if (!ex) byName.set(norm(c.name), rec); n++;
    }
    d.close(); toast(`${n}件を登録しました`); tab = 'stock'; render();
  };
  if (!d.open) d.showModal();
  d.scrollTop = st;
}

// ---------- 編集 ----------
function editDialog(it, memo) {
  const d = $('#dlg'); const x = it || { name: '', qty: 1, minQty: 0, buyQty: 1, category: '', location: '', expiry: '', source: 'manual' };
  const opts = (arr, v) => `<option value="">未設定</option>${arr.map((c) => `<option ${c === v ? 'selected' : ''}>${c}</option>`).join('')}`;
  d.innerHTML = `<h3>${it ? '編集' : '追加'}</h3>${memo ? `<p class="sub">読み取り結果(参考): <br>${esc(memo.slice(0, 200))}</p>` : ''}
  <label>名前</label><input id="f-n" value="${esc(x.name)}">
  <div class="grid2"><div><label>数量</label><input id="f-q" type="number" min="0" value="${x.qty}"></div><div><label>最低在庫(これ以下で買い物リストへ)</label><input id="f-m" type="number" min="0" value="${x.minQty || 0}"></div>
  <div><label>1回に買う数</label><input id="f-b" type="number" min="1" value="${x.buyQty || 1}"></div><div><label>賞味・使用期限</label><input id="f-e" type="date" value="${esc(x.expiry || '')}"></div>
  <div><label>カテゴリ</label><select id="f-c">${opts(CATS, x.category)}</select></div><div><label>置き場所</label><select id="f-l">${opts(LOCS, x.location)}</select></div></div>
  <div class="row" style="margin-top:12px">${it ? '<button class="b d" id="del">削除</button>' : ''}<button class="b" id="cx">やめる</button><button class="b p grow" id="ok">保存</button></div>`;
  $('#cx').onclick = () => d.close();
  $('#del')?.addEventListener('click', async () => { if (confirm('削除しますか?')) { await store.remove(it.id); d.close(); } });
  $('#ok').onclick = async () => {
    const name = $('#f-n').value.trim(); if (!name) return toast('名前を入れてください');
    await store.save({ ...x, name, qty: +$('#f-q').value || 0, minQty: +$('#f-m').value || 0, buyQty: +$('#f-b').value || 1, expiry: $('#f-e').value, category: $('#f-c').value, location: $('#f-l').value });
    d.close();
  };
  d.showModal();
}

// ---------- 起動 ----------
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
(async () => {
  store = await createStore();
  await store.init((s) => {
    state = s; unsub?.(); unsub = null;
    if (s.household) unsub = store.subscribe((a) => { items = a; render(); });
    render();
  });
})().catch((e) => { $('#view').innerHTML = `<div class="empty">起動に失敗: ${esc(e.message)}</div>`; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
