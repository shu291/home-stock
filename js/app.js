import { createStore } from './store.js';
import { norm, parseReceipt, parseReceiptMeta, checkTotal } from './parse.js';
import { ocr } from './ocr.js';
import { gmailAvailable, fetchOrders } from './gmail.js';
import { scan, lookupName } from './barcode.js';
import { plan, daysLeft, expiryDays, withLog, autoClassify, MIN_EVENTS, MIN_SPAN_DAYS } from './optimize.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CATS = ['食品', '飲料', '日用品', '洗剤・衛生', '薬', '消耗品', 'その他'];
const LOCS = ['キッチン', '洗面所', '風呂・トイレ', '押入れ', '玄関', 'その他'];
const SRC = { amazon: 'Amazon', rakuten: '楽天', receipt: 'レシート', paste: '貼り付け', manual: '手入力', barcode: 'バーコード' };

let store, state = { user: null, household: null }, items = [], unsub = null, lastSig = '', syncMsg = '';
let tab = 'stock', q = '', cat = '', loc = '';
let draft = []; // 取り込み確認中の候補
let receipts = []; // 確認中のレシートごとの {store, date, total, tax, adjust}。draft の rid が添字

const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2200); };
// 保存に失敗したら理由を出す(これが無いと「追加したのに増えない」原因が見えない)
const save = (rec) => store.save(rec).catch((e) => { toast(`保存できませんでした: ${e.code || e.message}`); throw e; });
const isLow = (i) => i.minQty > 0 && i.qty <= i.minQty;
// 数量が変わる保存はすべてここを通す(使用履歴 log を追記)。old=null は新規。opts.skip: 処分など消費ではない変更
const saveQty = (old, next, opts) => save(withLog(old, next, Date.now(), opts));
// category/location が空なら自動分類で補う(ユーザーが選んだ値は上書きしない)。補ったら auto:true
const fillAuto = (rec) => {
  if (rec.category && rec.location) return rec;
  const r = autoClassify(rec, items, { locs: LOCS });
  const out = { ...rec, category: rec.category || r.category, location: rec.location || r.location };
  return out.category !== (rec.category || '') || out.location !== (rec.location || '') ? { ...out, auto: true } : rec;
};
// 「今はしない」の記録(端末内のみ。60日たつと再評価される)
const DKEY = 'hs-dismiss', DISMISS_MS = 60 * 864e5;
const dismissed = () => { try { const o = JSON.parse(localStorage.getItem(DKEY)) || {}, n = Date.now(); return Object.fromEntries(Object.entries(o).filter(([, t]) => n - t < DISMISS_MS)); } catch { return {}; } };
const dismiss = (k) => { try { localStorage.setItem(DKEY, JSON.stringify({ ...dismissed(), [k]: Date.now() })); } catch {} };
// 分析結果は品目が変わるか1時間たつまで使い回す
let planMemo = { sig: '', v: null };
const getPlan = () => { const sig = lastSig + Math.floor(Date.now() / 36e5); return planMemo.sig === sig ? planMemo.v : (planMemo = { sig, v: plan(items, Date.now(), { locs: LOCS }) }).v; };
const etaText = (d) => (d < 1 ? 'あと1日未満' : d <= 180 ? `あと約${Math.round(d)}日` : '半年以上もちそう');

// ---------- 画面 ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#who').textContent = state.user ? `${state.household?.name ?? ''} / ${state.user.name}${syncMsg}` : '';
  const nb = state.household ? aiCards().length : 0;
  $('#tabs [data-tab=ai]').innerHTML = `提案${nb ? `<span class="bd">${nb}</span>` : ''}`;
  const v = $('#view');
  if (!state.user) return (v.innerHTML = `<div class="empty"><p>家族みんなで使う在庫管理</p><button class="b p" id="login">Googleでログイン</button></div>`, $('#login').onclick = () => store.signIn());
  if (!state.household) return renderSetup(v);
  ({ stock: renderStock, shop: renderShop, ai: renderAi, import: renderImport, family: renderFamily })[tab](v);
}

function renderSetup(v) {
  v.innerHTML = `<div class="card"><h3>はじめに</h3><p class="sub">家族のだれか1人が「新しく作る」、ほかの人は「家族コード」で参加します。</p>
  <label>家の名前</label><input id="hn" value="うちの家"><button class="b p" id="mk" style="margin-top:8px">新しく作る</button></div>
  <div class="card"><label>家族コードで参加</label><input id="jc" placeholder="10文字のコード" autocapitalize="characters"><button class="b" id="jn" style="margin-top:8px">参加する</button></div>`;
  $('#mk').onclick = () => store.createHousehold($('#hn').value.trim() || 'うちの家').catch((e) => toast(e.message));
  $('#jn').onclick = () => store.joinHousehold($('#jc').value).catch(() => toast('参加できませんでした。コードを確認してください'));
}

// 期限は7日以内/切れを目立たせる。「あと約N日」は消費ペースを学習済みの品だけ
function expiryHtml(i) {
  const d = expiryDays(i, Date.now());
  if (d === null) return i.expiry ? ' ・ 期限 ' + esc(i.expiry) : '';
  if (d < 0) return ` ・ <span class="warn">期限切れ(${esc(i.expiry)})</span>`;
  return d <= 7 ? ` ・ <span class="warn">期限まであと${d}日</span>` : ' ・ 期限 ' + esc(i.expiry);
}
function etaHtml(i) {
  const d = i.qty > 0 ? daysLeft(i, Date.now()) : null;
  return d === null ? '' : ` ・ <span class="eta ${d <= 7 ? 'warn' : ''}">${etaText(d)}</span>`;
}

function renderStock(v) {
  const list = items.filter((i) => (!cat || i.category === cat) && (!loc || i.location === loc) && (!q || norm(i.name).includes(norm(q))))
    .sort((a, b) => isLow(b) - isLow(a) || a.name.localeCompare(b.name, 'ja'));
  const chips = (arr, cur, k) => `<div class="chips"><button class="chip ${cur ? '' : 'on'}" data-${k}="">すべて</button>${arr.map((c) => `<button class="chip ${cur === c ? 'on' : ''}" data-${k}="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
  v.innerHTML = `<div class="row"><input id="q" type="search" placeholder="さがす" value="${esc(q)}"><button class="b" id="scan" aria-label="バーコードで追加">📷</button></div>${chips(CATS, cat, 'cat')}${chips(LOCS, loc, 'loc')}` +
    (list.length ? list.map((i) => `<div class="card item row ${isLow(i) ? 'low' : ''}" data-id="${i.id}">
      <div class="grow" data-edit><div class="nm">${esc(i.name)}</div><div class="sub">${esc(i.location || '')} ${esc(i.category || '')}${i.auto ? '<span class="auto" title="自動で分類しました">自動</span>' : ''}${isLow(i) ? ' ・ 残りわずか' : ''}${expiryHtml(i)}${etaHtml(i)}</div></div>
      <button class="b" data-d="-1">−</button><div class="qty">${i.qty}</div><button class="b" data-d="1">＋</button></div>`).join('')
      : `<div class="empty">まだ登録がありません。<br>右下の＋か「取り込み」から追加できます</div>`) +
    `<button class="b p fab" id="add">＋</button>`;
  $('#q').oninput = (e) => { q = e.target.value; const p = e.target.selectionStart; renderStock(v); const n = $('#q'); n.focus(); n.setSelectionRange(p, p); };
  v.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { cat = b.dataset.cat; render(); }));
  v.querySelectorAll('[data-loc]').forEach((b) => (b.onclick = () => { loc = b.dataset.loc; render(); }));
  v.querySelectorAll('.item').forEach((el) => {
    const it = items.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-edit]').onclick = () => editDialog(it);
    el.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => saveQty(it, { ...it, qty: Math.max(0, it.qty + +b.dataset.d) })));
  });
  $('#add').onclick = () => editDialog();
  $('#scan').onclick = barcodeAdd;
}

function renderShop(v) {
  const list = items.filter(isLow);
  const soon = getPlan().soonOut.filter((x) => !isLow(x.item));
  const buy = (i) => `<button class="b p" data-id="${i.id}">買った +${i.buyQty || 1}</button>`;
  v.innerHTML = (list.length ? `<p class="sub">残りが「最低在庫」以下のものが自動で並びます。</p>` + list.map((i) => `<div class="card row"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="sub">残り ${i.qty}(最低 ${i.minQty})</div></div>${buy(i)}</div>`).join('') : '')
    + (soon.length ? `<h3 class="sec">もうすぐ切れそう</h3><p class="sub">使うペースからの予測です(使うほど正確になります)。</p>` + soon.map(({ item: i, days }) => `<div class="card row"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="sub">残り ${i.qty} ・ <span class="warn">${i.qty > 0 ? etaText(days) : '切れています'}</span></div></div>${buy(i)}</div>`).join('') : '')
    + (list.length || soon.length ? '' : `<div class="empty">買い足すものはありません 🎉<br><span class="sub">在庫の編集で「最低在庫」を設定すると、ここに出ます</span></div>`);
  v.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => { const i = items.find((x) => x.id === b.dataset.id); saveQty(i, { ...i, qty: i.qty + (i.buyQty || 1), boughtAt: new Date().toISOString().slice(0, 10) }); }));
}

// ---------- かしこい提案(端末内の統計による推定。外部には送信しない) ----------
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const nm = (i) => `「${esc(i.name)}」`;
// 提案カードの一覧 {key, cls, title, body, ok:{label, fn}}。「今はしない」済みは除く
function aiCards() {
  const p = getPlan(), dm = dismissed(), cs = [];
  for (const { item: i, days, expired } of p.expiring) cs.push({ key: `exp:${i.id}:${i.expiry}`, cls: 'alert', title: `${nm(i)}${expired ? 'の期限が切れています' : 'の期限が近づいています'}`,
    body: `期限 ${esc(i.expiry)}(${expired ? `${-days}日前` : days === 0 ? '今日' : `あと${days}日`})・ 残り ${i.qty}`,
    ok: expired ? { label: '処分した(0にする)', fn: () => saveQty(i, { ...i, qty: 0, expiry: '' }, { skip: true }) } : null, ok2: expired ? { label: 'まだ使える(期限を消す)', fn: () => save({ ...i, expiry: '' }) } : null, no: expired ? '今はしない' : '確認した' });
  for (const { item: i, cur, sug, rate } of p.parSuggestions) cs.push({ key: `par:${i.id}:${sug.minQty}:${sug.buyQty}`, title: `${nm(i)}の在庫設定を見直しませんか`,
    body: `最低在庫 ${cur.minQty} → <b>${sug.minQty}</b> ・ 1回に買う数 ${cur.buyQty} → <b>${sug.buyQty}</b><br>1日に約${rate.toFixed(2)}個のペースで使っている計算です(最低在庫は約1週間分、買う数は約2週間分)。`,
    ok: { label: '適用', fn: () => save({ ...i, minQty: sug.minQty, buyQty: sug.buyQty }) } });
  for (const g of p.duplicates) cs.push({ key: `dup:${g.items.map((x) => x.id).sort().join(',')}`, title: '同じ品かもしれません',
    body: `${g.items.map((x) => `${nm(x)}(${x.qty})`).join(' と ')}<br>→ ${nm(g.keep)} <b>${g.merged.qty}</b>個にまとめます(数量は合算、バーコード・履歴は引き継ぎ)。`,
    ok: { label: 'まとめる', fn: async () => { await save(g.merged); for (const x of g.items) if (x !== g.keep) await store.remove(x.id); } } });
  const fills = p.autoFill;
  if (fills.length) {
    const nc = fills.filter((x) => x.category).length, nl = fills.filter((x) => x.location).length;
    cs.push({ key: `auto:${hash(fills.map((x) => x.item.id).sort().join())}`, title: `未分類の${fills.length}件をまとめて自動分類`,
      body: `カテゴリ ${nc}件・置き場所 ${nl}件を補います(すでに入っている値は変えません)。<br>${fills.slice(0, 6).map((x) => `${nm(x.item)}→${esc([x.item.category ? '' : x.category, x.item.location ? '' : x.location].filter(Boolean).join(' / '))}`).join('<br>')}${fills.length > 6 ? `<br>ほか${fills.length - 6}件` : ''}<br><span class="sub">家族が付けた分類(類似名)があればそれを優先し、なければ品名の辞書で推定します。辞書は完全ではないので、違っていたら在庫の編集で直してください(「自動」の印が付きます)。</span>`,
      ok: { label: `${fills.length}件に適用`, fn: () => Promise.all(fills.map((x) => save({ ...x.item, category: x.item.category || x.category, location: x.item.location || x.location, auto: true }))) } });
  }
  for (const { item: i, idleDays, days } of p.overstock) cs.push({ key: `over:${i.id}`, title: `${nm(i)}は十分あります`,
    body: `${idleDays}日間動きがなく、${i.qty}個あります${days === null ? '' : `(いまのペースで${days > 365 ? '1年以上' : `約${Math.round(days)}日`}分)`}。しばらく買わなくて大丈夫そうです。`, ok: null, no: '確認した' });
  return cs.filter((c) => !dm[c.key]);
}

function renderAi(v) {
  const cs = aiCards(), L = getPlan().learning;
  const hint = L.ready ? `${L.ready}品の使うペースを学習済みです。` : L.tracking ? `使うペースを学習中です。早い品で、あと約${L.etaDays}日で最初の予測が出ます。` : `まだ学習中です。数量を−や「買った」で記録していくと、${MIN_SPAN_DAYS}日・${MIN_EVENTS}回ほどで予測が始まります。`;
  v.innerHTML = `<p class="sub">端末の中だけで計算した統計的な推定です(外部には送信しません)。使うほど正確になりますが、記録が少ないうちは外れます。${hint}</p>` +
    (cs.length ? cs.map((c, n) => `<div class="card sg ${c.cls || ''}"><div class="nm">${c.title}</div><div class="sub sgb">${c.body}</div>
      <div class="row"><button class="b grow" data-no="${n}">${c.no || '今はしない'}</button>${c.ok2 ? `<button class="b grow" data-ok2="${n}">${c.ok2.label}</button>` : ''}${c.ok ? `<button class="b p grow" data-ok="${n}">${c.ok.label}</button>` : ''}</div></div>`).join('')
      : `<div class="empty">いまのところ提案はありません</div>`);
  const run = (f) => async () => { try { await f(); toast('反映しました'); } catch {} render(); };
  v.querySelectorAll('[data-no]').forEach((b) => (b.onclick = () => { dismiss(cs[b.dataset.no].key); render(); }));
  v.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = run(cs[b.dataset.ok].ok.fn)));
  v.querySelectorAll('[data-ok2]').forEach((b) => (b.onclick = run(cs[b.dataset.ok2].ok2.fn)));
}

function renderFamily(v) {
  const h = state.household;
  v.innerHTML = `<div class="card"><h3>${esc(h.name)}</h3>${store.mode === 'cloud' ? `<p class="sub">家族に次のコードを伝えて、同じアプリで「家族コードで参加」してもらってください。</p><div class="code">${esc(h.id)}</div>` : `<p class="sub">いまは「お試しモード」です。家族で共有するには js/config.js に Firebase の設定が必要です(README参照)。</p>`}</div>
  ${store.mode === 'cloud' ? '<button class="b" id="out">ログアウト</button>' : ''}`;
  $('#out')?.addEventListener('click', () => store.signOut());
}

function renderImport(v) {
  v.innerHTML = `<div class="card"><h3>▮▮ バーコードで追加</h3><p class="sub">商品のバーコードをカメラで読むだけで追加できます。一度登録した商品は、次から数量が増えます。家族にも共有されます。</p><button class="b p" id="bc">バーコードを読む</button></div>
  <div class="card"><h3>📷 レシート写真</h3><p class="sub">端末内で文字認識します(画像は送信されません)。結果は確認してから登録します。</p><input type="file" id="rc" accept="image/*" multiple><div class="sub" id="rcs"></div></div>
  ${gmailAvailable ? `<div class="card"><h3>✉️ Gmailの注文メール</h3><p class="sub">Amazon・楽天の注文確認メールを読み取ります(読み取り専用)。</p>
  <div class="grid2"><select id="gk"><option value="amazon">Amazon</option><option value="rakuten">楽天市場</option></select><select id="gm"><option value="1">過去1か月</option><option value="3" selected>過去3か月</option><option value="12">過去1年</option></select></div>
  <button class="b p" id="gb" style="margin-top:8px">読み取る</button><div class="sub" id="gs"></div></div>` : ''}
  <div class="card"><h3>📋 テキスト貼り付け</h3><p class="sub">注文履歴ページや購入メールの本文をそのまま貼り付けます。</p><textarea id="tx" rows="4"></textarea><button class="b" id="tb" style="margin-top:8px">解析する</button></div>`;
  $('#bc').onclick = barcodeAdd;
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

// 取り込み候補のカテゴリが空なら自動分類の推定で埋める(c.auto=自動。手で選び直したら外す)
// 確認前の候補はすべて自動の推定(取り込み時の辞書推定を含む)なので、家族の学習結果があればそちらを優先する
const autoDraft = (c) => {
  if (c.auto === false) return;
  const cat = autoClassify({ name: c.name || '', category: '', location: '' }, items, { locs: LOCS }).category || c.category || '';
  if (cat) { c.category = cat; c.auto = true; }
};

// draft が出来上がっていれば確認画面を開く(レシートは readReceipt/addReceipt で作成済み)
function openReview(raw) {
  for (const c of draft) autoDraft(c);
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
    <div class="sub">${c.auto && c.category ? '<span class="auto" title="自動で分類しました。違えば選び直せます">自動</span> ' : ''}${c.dup ? '取り込み済み ・ ' : ''}${SRC[c.source] || ''} ${esc(c.boughtAt || '')}${c.discount ? ` ・ 値引 −¥${c.discount} 反映済み` : ''}</div></div>`;
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
  d.querySelectorAll('[data-ct]').forEach((e) => (e.onchange = () => { draft[e.dataset.ct].category = e.value; draft[e.dataset.ct].auto = false; e.closest('.rv').querySelector('.auto')?.remove(); }));
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
      for (const c of draft) autoDraft(c);
      reviewDialog();
    } catch (err) { s.textContent = err.message; }
  });
  $('#cx').onclick = () => d.close();
  $('#ok').onclick = () => {
    const byName = new Map(items.map((i) => [norm(i.name), i]));
    let n = 0;
    for (const c of draft.filter((x) => x.on && x.name.trim())) {
      const ex = byName.get(norm(c.name));
      const keys = c.srcKey ? [c.srcKey] : [];
      let rec = ex ? { ...ex, qty: ex.qty + c.qty, category: ex.category || c.category || '', boughtAt: c.boughtAt || ex.boughtAt || '', srcKeys: [...(ex.srcKeys || []), ...keys] }
        : { name: c.name.trim(), qty: c.qty, category: c.category || '', location: '', minQty: 0, buyQty: 1, price: c.price || 0, boughtAt: c.boughtAt || '', source: c.source, srcKeys: keys };
      rec = fillAuto(rec); if (c.auto && c.category && !ex?.category) rec.auto = true;
      rec = withLog(ex || null, rec); // 数量の履歴を追記
      save(rec).catch(() => {}); byName.set(norm(c.name), rec); n++; // 送信は待たず、失敗は toast で知らせる
    }
    d.close(); toast(`${n}件を登録しました`); tab = 'stock'; render();
  };
  if (!d.open) d.showModal();
  d.scrollTop = st;
}

// ---------- バーコード追加 ----------
async function barcodeAdd() {
  const d = $('#dlg'); if (!d.open) d.showModal();
  for (;;) {
    const code = await scan(d); if (!code) return d.close();
    if (!(await barcodeForm(d, code))) return d.close(); // false=終了 / true=続けて読む
  }
}

// 読み取った番号の登録フォーム。登録済みなら数量を足す。戻り値: 続けるか
function barcodeForm(d, code) {
  return new Promise((resolve) => {
    const ex = items.find((i) => i.barcode === code);
    const opts = (arr, v) => `<option value="">未設定</option>${arr.map((c) => `<option ${c === v ? 'selected' : ''}>${c}</option>`).join('')}`;
    d.innerHTML = `<h3>${ex ? '登録済みの商品' : '新しい商品'}</h3><div class="sub">バーコード ${esc(code)}</div>
    <label>名前</label><input id="b-n" value="${esc(ex?.name || '')}" placeholder="${ex ? '' : '商品名を検索中…'}">
    <div class="grid2"><div><label>${ex ? `追加する数(いま ${ex.qty})` : '数量'}</label><input id="b-q" type="number" min="1" value="1"></div>
    <div><label>カテゴリ</label><select id="b-c">${opts(CATS, ex?.category)}</select></div></div>
    <div class="row" style="margin-top:12px"><button class="b" id="bx">終了</button><button class="b p grow" id="bok">${ex ? '数量を追加して次へ' : '登録して次へ'}</button></div>`;
    const n = d.querySelector('#b-n'), c = d.querySelector('#b-c'); let typed = false;
    n.oninput = () => (typed = true);
    c.onchange = () => (c.dataset.auto = '');
    if (!ex) lookupName(code).then((name) => {
      if (!typed && name) { n.value = name; if (!c.value) { c.value = autoClassify({ name, category: '', location: '' }, items, { locs: LOCS }).category; c.dataset.auto = c.value ? '1' : ''; } }
      else if (!name) n.placeholder = '商品名を入力(見つかりませんでした)';
    });
    d.querySelector('#bx').onclick = () => resolve(false);
    d.querySelector('#bok').onclick = () => {
      const name = n.value.trim(); if (!name) return toast('名前を入れてください');
      const add = Math.max(1, +d.querySelector('#b-q').value || 1);
      const same = ex || items.find((i) => norm(i.name) === norm(name));
      const auto = !!c.dataset.auto && !!c.value;
      (same ? saveQty(same, { ...same, qty: same.qty + add, barcode: code, category: same.category || c.value, ...(auto && !same.category ? { auto: true } : {}) })
        : saveQty(null, { ...fillAuto({ name, qty: add, category: c.value, location: '', minQty: 0, buyQty: 1, barcode: code, source: 'barcode' }), ...(auto ? { auto: true } : {}) })).catch(() => {});
      toast(`${name} を追加しました`); resolve(true);
    };
  });
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
  <div class="sub" id="f-h"></div>
  <div class="row" style="margin-top:12px">${it ? '<button class="b d" id="del">削除</button>' : ''}<button class="b" id="cx">やめる</button><button class="b p grow" id="ok">保存</button></div>`;
  // 名前から分類の候補を事前選択する。すでに選んである(または保存済みの)欄は変えない
  const fC = $('#f-c'), fL = $('#f-l'); let fixC = !!x.category, fixL = !!x.location, sugC = '', sugL = '';
  fC.onchange = () => { fixC = true; sugC = ''; showHint(); }; fL.onchange = () => { fixL = true; sugL = ''; showHint(); };
  const showHint = () => { $('#f-h').textContent = sugC || sugL ? `自動の候補: ${[sugC, sugL].filter(Boolean).join(' / ')}(変更できます)` : ''; };
  const suggest = () => {
    const r = autoClassify({ id: x.id, name: $('#f-n').value, category: fixC ? fC.value : '', location: fixL ? fL.value : '' }, items, { locs: LOCS });
    if (!fixC) { fC.value = sugC = r.category; }
    if (!fixL) { fL.value = sugL = r.location; }
    showHint();
  };
  $('#f-n').oninput = suggest; suggest();
  $('#cx').onclick = () => d.close();
  $('#del')?.addEventListener('click', async () => { if (confirm('削除しますか?')) { await store.remove(it.id); d.close(); } });
  $('#ok').onclick = async () => {
    const name = $('#f-n').value.trim(); if (!name) return toast('名前を入れてください');
    const rec = { ...x, name, qty: +$('#f-q').value || 0, minQty: +$('#f-m').value || 0, buyQty: +$('#f-b').value || 1, expiry: $('#f-e').value, category: fC.value, location: fL.value };
    // 自動の候補をそのまま使った(または以前の自動分類から変えていない)なら「自動」の印を付ける
    const keep = x.auto && fC.value === (x.category || '') && fL.value === (x.location || '');
    if (keep || (sugC && fC.value === sugC) || (sugL && fL.value === sugL)) rec.auto = true; else delete rec.auto;
    await saveQty(it || null, rec);
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
    if (s.household) unsub = store.subscribe((a, m) => {
      syncMsg = m?.pending ? ' ・ 同期中…' : '';
      const sig = JSON.stringify(a);
      if (sig !== lastSig) { lastSig = sig; items = a; render(); } else $('#who').textContent = `${state.household.name} / ${state.user.name}${syncMsg}`;
    }, (e) => { syncMsg = ' ・ ⚠同期エラー'; toast(`同期できません: ${e.code || e.message}`); render(); });
    render();
  });
})().catch((e) => { $('#view').innerHTML = `<div class="empty">起動に失敗: ${esc(e.message)}</div>`; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
