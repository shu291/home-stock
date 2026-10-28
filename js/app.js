import { createStore } from './store.js';
import { norm, parseReceipt, parseReceiptMeta, checkTotal } from './parse.js';
import { ocr, warmupOcr } from './ocr.js';
import { gmailAvailable, fetchOrders } from './gmail.js';
import { scan, lookupName, canonCode } from './barcode.js';
import { CATS, LOCS, LEGACY_CATEGORY, canonCategory, canonLocation, catInfo, locInfo, categoryOptions, subOptions, locationOptions } from './taxonomy.js';
import { guessClass } from './category.js';
import { plan, daysLeft, expiryDays, withLog, autoClassify, EXPIRY_DAYS, MIN_EVENTS, MIN_SPAN_DAYS } from './optimize.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SRC = { amazon: 'Amazon', rakuten: '楽天', receipt: 'レシート', paste: '貼り付け', manual: '手入力', barcode: 'バーコード' };

let store, state = { user: null, household: null }, items = [], unsub = null, lastSig = '', syncMsg = '';
let tab = 'stock', q = '', filterKey = ''; // 在庫一覧の検索語と、要約チップの絞り込み('' / 'low' / 'exp')
let draft = []; // 取り込み確認中の候補
let receipts = []; // 確認中のレシートごとの {store, date, total, tax, adjust}。draft の rid が添字

// undo があれば「元に戻す」ボタンを付けて長めに出す。popover(最前面)なのでダイアログの上にも出る
let toastT;
const hideToast = () => { const t = $('#toast'); t.classList.remove('on'); try { t.hidePopover?.(); } catch {} };
const toast = (m, undo) => {
  const t = $('#toast'); clearTimeout(toastT); t.textContent = '';
  if (undo) { const b = document.createElement('button'); b.textContent = '元に戻す'; b.onclick = async () => { hideToast(); try { await undo(); toast('元に戻しました'); } catch {} }; t.append(b); }
  const sp = document.createElement('span'); sp.className = 'm'; sp.textContent = m; t.append(sp);
  t.classList.add('on'); try { if (!t.matches(':popover-open')) t.showPopover?.(); } catch {}
  toastT = setTimeout(hideToast, undo ? 8000 : 2600);
};
// 保存に失敗したら理由を出す(これが無いと「追加したのに増えない」原因が見えない)
const save = (rec) => store.save(rec).catch((e) => { toast(`保存できませんでした: ${e.code || e.message}`); throw e; });
const isLow = (i) => i.minQty > 0 && i.qty <= i.minQty;
// 数量が変わる保存はすべてここを通す(使用履歴 log を追記)。old=null は新規。opts.skip: 処分など消費ではない変更
const saveQty = (old, next, opts) => save(withLog(old, next, Date.now(), opts));
// 「今はしない」の記録(端末内のみ。60日たつと再評価される)
const DKEY = 'hs-dismiss', DISMISS_MS = 60 * 864e5;
const dismissed = () => { try { const o = JSON.parse(localStorage.getItem(DKEY)) || {}, n = Date.now(); return Object.fromEntries(Object.entries(o).filter(([, t]) => n - t < DISMISS_MS)); } catch { return {}; } };
const undismiss = async (ks) => { try { const o = dismissed(); ks.forEach((k) => delete o[k]); localStorage.setItem(DKEY, JSON.stringify(o)); } catch {} };
const dismiss = (k) => { try { localStorage.setItem(DKEY, JSON.stringify({ ...dismissed(), [k]: Date.now() })); } catch {} };
// 分析結果は品目が変わるか1時間たつまで使い回す
let planMemo = { sig: '', v: null };
const getPlan = () => { const sig = lastSig + Math.floor(Date.now() / 36e5); return planMemo.sig === sig ? planMemo.v : (planMemo = { sig, v: plan(items, Date.now(), { locs: locationOptions(items) }) }).v; };
const etaText = (d) => (d < 1 ? 'あと1日未満' : d <= 180 ? `あと約${Math.round(d)}日` : '半年以上もちそう');

// ---------- 画面 ----------
const JOIN = (new URLSearchParams(location.search).get('join') || '').trim().toUpperCase(); // 家族の誘いリンク ?join=コード
const clearJoin = () => { try { history.replaceState(null, '', location.pathname + location.hash); } catch {} };
const SORTS = [['std', '並び: 足りない順'], ['expiry', '並び: 期限が近い順'], ['eta', '並び: なくなりそうな順'], ['name', '並び: 名前順'], ['recent', '並び: 最近変えた順']];
const VIEWS = [['loc', '置き場所別'], ['cat', '分類別'], ['flat', 'すべて']];
// 端末ごとの見かた(hs-view=表示のしかた / hs-sort=並び / hs-fold=たたんだ見出し)。保存できなくても動く
let sortKey = 'std', viewMode = 'loc', foldS = { cat: new Set(), loc: new Set() };
try {
  const s = localStorage.getItem('hs-sort'), v = localStorage.getItem('hs-view');
  if (SORTS.some(([k]) => k === s)) sortKey = s;
  if (VIEWS.some(([k]) => k === v)) viewMode = v;
  if (s === 'loc') { viewMode = 'loc'; localStorage.setItem('hs-view', 'loc'); localStorage.setItem('hs-sort', 'std'); } // 旧「置き場所別の並び」は表示のしかたへ移した
  const o = JSON.parse(localStorage.getItem('hs-fold'));
  for (const k of ['cat', 'loc']) if (Array.isArray(o?.[k])) foldS[k] = new Set(o[k].filter((x) => typeof x === 'string'));
} catch {}
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ---------- 追加先(連続して追加するあいだ保つ、置き場所と分類) ----------
// 選んだ項目だけが新しい品の初期値になる(選ばなかった項目は自動分類)。優先: 品目ごとに手で選んだ値 > 追加先 > 自動分類
// 「固定」をオンにしたときだけ、ダイアログを閉じても次の追加へ引き継ぐ(端末ごと: hs-addctx)。オフなら閉じると「おまかせ」に戻る
const ACKEY = 'hs-addctx';
const trim = (v) => (typeof v === 'string' ? v.trim() : '');
const ctxNorm = (o) => { const category = trim(o?.category), location = trim(o?.location); return { location, category, sub: category ? trim(o?.sub) : '', sticky: !!(o?.sticky && (location || category)) }; };
let addCtx = ctxNorm({}), ctxHook = null; // ctxHook: いま開いている追加画面が、追加先の変更を受け取る関数
try { const o = JSON.parse(localStorage.getItem(ACKEY)); if (o?.sticky === true) addCtx = ctxNorm(o); } catch {}
const ctxEmpty = () => !addCtx.location && !addCtx.category;
function setCtx(patch) {
  addCtx = ctxNorm({ ...addCtx, ...patch });
  try { addCtx.sticky ? localStorage.setItem(ACKEY, JSON.stringify(addCtx)) : localStorage.removeItem(ACKEY); } catch {}
  renderBars(); ctxHook?.();
}
// 追加の画面を閉じたとき: 固定でなければ「おまかせ」に戻す
function endCtx() { ctxHook = null; if (!addCtx.sticky && !ctxEmpty()) setCtx({ location: '', category: '', sub: '' }); else renderBars(); }
// 追加先バー(各画面の上に置く)。押すと選択シート。場所・分類のボタンがそのまま「変更」ボタン
const acbInner = () => {
  const { location: l, category: c, sub: s, sticky } = addCtx, empty = ctxEmpty();
  const lt = l ? `${locInfo(l).icon} ${esc(l)}` : empty ? '📍 場所を選ぶ' : '📍 場所: おまかせ', ct = c ? `${catInfo(c).icon} ${esc(c)}${s ? ` / ${esc(s)}` : ''}` : empty ? '🏷️ 分類を選ぶ' : '🏷️ 分類: おまかせ';
  const stk = empty ? '' : `<button type="button" class="ab${sticky ? ' lock' : ''}" data-ac="sticky" aria-label="${sticky ? '追加先の固定をはずす(いまは固定中)' : '追加先を固定する(閉じても次の追加へ引き継ぎます)'}">${sticky ? '🔒 固定をはずす' : '🔓 固定する'}</button>`;
  return `<div class="ach"><span class="acl">追加先${empty ? ': <b>おまかせ</b>(自動で分類)' : ''}</span>${stk}</div><div class="acr">`
    + `<button type="button" class="ab${l ? ' set' : ''}" data-ac="loc" aria-haspopup="dialog" aria-label="置き場所を選ぶ(いま: ${l ? esc(l) : 'おまかせ'})">${lt} <span aria-hidden="true">▾</span></button>`
    + `<button type="button" class="ab${c ? ' set' : ''}" data-ac="cat" aria-haspopup="dialog" aria-label="分類を選ぶ(いま: ${c ? esc(c + (s ? ` / ${s}` : '')) : 'おまかせ'})">${ct} <span aria-hidden="true">▾</span></button></div>`;
};
const acb = () => `<div class="acb${ctxEmpty() ? '' : ' on'}" role="group" aria-label="追加先">${acbInner()}</div>`;
function renderBars() {
  const h = acbInner();
  document.querySelectorAll('.acb').forEach((e) => { if (e.innerHTML !== h) e.innerHTML = h; e.classList.toggle('on', !ctxEmpty()); });
  const n = $('#addnav'); if (n) n.setAttribute('aria-label', addCtx.sticky ? `品目を追加(追加先 ${[addCtx.location, addCtx.category].filter(Boolean).join('・')} に固定中)` : '品目を追加');
}
const inDlg = (sel) => (dlg.open ? dlg : document).querySelector(sel);
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.acb [data-ac]'); if (!b) return;
  const k = b.dataset.ac;
  if (k === 'sticky') { setCtx({ sticky: !addCtx.sticky }); inDlg('.acb [data-ac="sticky"]')?.focus({ preventScroll: true }); } else ctxSheet(k);
});
// 追加先を選ぶシート(置き場所 / 大分類→小分類)。大きなボタンで1タップ。選ぶと閉じる
let sheetFrom = '';
function ctxSheet(kind) {
  let s = $('#acs');
  if (!s) {
    s = document.createElement('dialog'); s.id = 'acs'; s.setAttribute('aria-labelledby', 'acs-h'); document.body.append(s);
    s.addEventListener('close', () => inDlg(`.acb [data-ac="${sheetFrom}"]`)?.focus?.({ preventScroll: true }));
    s.addEventListener('click', (e) => { if (e.target !== s) return; const r = s.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) s.close(); });
  }
  sheetFrom = kind; let stage = '', pick = '';
  const chip = (v, label, on, a = 'data-v') => `<button type="button" class="chip" ${a}="${esc(v)}" aria-pressed="${on}">${label}</button>`;
  const note = '<p class="sub">「固定」にすると、閉じても次の追加へ引き継ぎます。</p><button type="button" class="b" data-x style="width:100%">閉じる</button>';
  const draw = () => {
    if (kind === 'loc') {
      const cur = addCtx.location, ls = locationOptions(items); if (cur && !ls.includes(cur)) ls.push(cur);
      s.innerHTML = `<h3 id="acs-h" tabindex="-1">置き場所を選ぶ</h3><p class="sub">選んだ場所に、これから追加する品が入ります。</p>
        <div class="chips" role="group" aria-label="置き場所">${chip('', '✨ おまかせ', !cur)}${ls.map((l) => chip(l, `${locInfo(l).icon} ${esc(l)}`, l === cur)).join('')}</div>
        <label for="acs-t">ほかの場所(自由に入力)</label><div class="row"><input id="acs-t" enterkeyhint="done" placeholder="例: 物置" autocomplete="off"><button type="button" class="b" id="acs-ok">決定</button></div>${note}`;
    } else if (stage === 'sub') {
      const cur = addCtx.category === pick ? addCtx.sub : '', ss = subOptions(pick, items), ci = catInfo(pick);
      s.innerHTML = `<h3 id="acs-h" tabindex="-1">${ci.icon} ${esc(pick)}の小分類</h3><p class="sub">小分類まで決めると、品がその分類に入ります。</p>
        <div class="chips" role="group" aria-label="小分類">${chip('', '小分類は決めない', !cur, 'data-s')}${ss.map((x) => chip(x, esc(x), x === cur, 'data-s')).join('')}</div>
        <button type="button" class="b" data-back style="width:100%;margin:8px 0">← 大分類にもどる</button>${note}`;
    } else {
      const cur = addCtx.category, cs = categoryOptions(items); if (cur && !cs.includes(cur)) cs.push(cur);
      s.innerHTML = `<h3 id="acs-h" tabindex="-1">分類を選ぶ</h3><p class="sub">大分類を選ぶと、小分類も選べます。</p>
        <div class="chips" role="group" aria-label="大分類">${chip('', '✨ おまかせ', !cur)}${cs.map((c) => chip(c, `${catInfo(c).icon} ${esc(c)}`, c === cur)).join('')}</div>${note}`;
    }
    const f = s.querySelector('#acs-h'); if (f) f.focus({ preventScroll: true });
  };
  s.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.x !== undefined) return s.close();
    if (b.dataset.back !== undefined) { stage = ''; return draw(); }
    if (b.id === 'acs-ok') { const v = trim($('#acs-t').value); if (!v) return $('#acs-t').focus(); setCtx({ location: v }); return s.close(); }
    if (b.dataset.s !== undefined) { setCtx({ category: pick, sub: b.dataset.s }); return s.close(); }
    if (b.dataset.v === undefined) return;
    const v = b.dataset.v;
    if (kind === 'loc') { setCtx({ location: v }); return s.close(); }
    if (v && subOptions(v, items).length) { pick = v; stage = 'sub'; return draw(); } // 小分類がある大分類は、続けて小分類を選ぶ
    setCtx({ category: v, sub: '' }); s.close();
  };
  s.onkeydown = (e) => { if (e.key === 'Enter' && e.target.id === 'acs-t') { e.preventDefault(); $('#acs-ok').click(); } };
  draw(); s.showModal();
}
// カテゴリ・小分類・置き場所の3つの欄(editDialog と barcodeForm で共通)。値の優先: 手で選んだ値 > 追加先 > 自動分類
// init: 保存済みの値(あれば手で選んだ扱い)。useCtx: 追加先を使うか(新規だけ)。src: 'hand'|'ctx'|'auto'|''(各欄の値の出どころ)
function classForm({ fC, fS, fL, getName, id, init = {}, useCtx, onChange }) {
  const pin = { c: !!init.category, l: !!init.location }; pin.s = pin.c || !!init.sub;
  const src = { c: pin.c ? (init.auto ? 'auto' : 'hand') : '', s: '', l: pin.l ? (init.auto ? 'auto' : 'hand') : '' }, touched = { c: false, s: false, l: false };
  const fill = (sel, list, v) => { const a = !v || list.includes(v) ? list : [...list, v], h = '<option value="">未設定</option>' + a.map((x) => `<option>${esc(x)}</option>`).join(''); if (sel.dataset.k !== h) { sel.innerHTML = h; sel.dataset.k = h; } sel.value = v || ''; };
  fill(fC, categoryOptions(items), init.category || ''); fill(fS, subOptions(init.category || '', items), init.sub || ''); fill(fL, locationOptions(items), init.location || '');
  const recompute = () => {
    const x = useCtx ? addCtx : {}, catX = pin.c ? fC.value : x.category || '', subX = pin.s ? fS.value : !pin.c && x.category ? x.sub || '' : '', locX = pin.l ? fL.value : x.location || '';
    const r = autoClassify({ id, name: getName(), category: catX, sub: subX, location: locX }, items, { locs: locationOptions(items) });
    const cat = pin.c ? catX : catX || r.category, sub = pin.s ? subX : subX || r.sub, loc = pin.l ? locX : locX || r.location;
    if (!pin.c) src.c = catX ? 'ctx' : cat ? 'auto' : '';
    if (!pin.s) src.s = subX ? 'ctx' : sub ? 'auto' : '';
    if (!pin.l) src.l = locX ? 'ctx' : loc ? 'auto' : '';
    fill(fC, categoryOptions(items), cat); fill(fS, subOptions(cat, items), sub); fill(fL, locationOptions(items), loc);
    onChange?.();
  };
  const hand = (k) => { touched[k] = true; pin[k] = true; src[k] = 'hand'; if (init.auto) src.c = src.l = 'hand'; };
  fC.onchange = () => { hand('c'); pin.s = false; recompute(); }; // 大分類を変えたら小分類はクリア(自動の候補だけが入る)
  fS.onchange = () => { pin.c = true; hand('s'); recompute(); };
  fL.onchange = () => { hand('l'); recompute(); };
  const values = () => ({ category: fC.value, sub: fS.value, location: fL.value, auto: !!((src.c === 'auto' && fC.value) || (src.l === 'auto' && fL.value)), touched, src: { ...src } });
  const hint = () => {
    const by = (s) => [[fC.value, 'c'], [fS.value, 's'], [fL.value, 'l']].filter(([v, k]) => v && src[k] === s).map(([v]) => v);
    return [by('ctx').length && `追加先の指定: ${by('ctx').join(' / ')}`, by('auto').length && `自動の候補: ${by('auto').join(' / ')}(変更できます)`].filter(Boolean).join(' ・ ');
  };
  return { recompute, values, hint };
}
// 検索用: ひらがな/カタカナ・全角半角・大文字小文字・空白と「・」の違いを無視する(長音や小書き文字は変えない)
const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 96)).replace(/[\s・]+/g, '');
// 2026-10-26 → 10月26日(年が違うときだけ年つき)
const dateJa = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${+m[1] === new Date().getFullYear() ? '' : `${m[1]}年`}${+m[2]}月${+m[3]}日` : esc(s || ''); };
const whoText = () => (!state.user ? '' : store.mode === 'local' ? 'この携帯だけで使用中' : `${state.household?.name ?? ''} / ${state.user.name}${syncMsg}`);

function render() {
  document.body.dataset.screen = tab; // 在庫タブだけ、ヘッダーを固定しない(一覧の見出しを画面の上端に張り付かせるため)
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('#who').textContent = whoText();
  const ready = !!(state.user && state.household);
  document.body.classList.toggle('setup', !ready); // ログイン前・はじめにの画面ではナビを隠す
  // バッジ: おしらせ=期限が切れた/7日以内の品、買い物=買い足しライン以下の品(「今すぐ見るべきもの」だけ)
  const nb = ready ? aiCards().filter((c) => c.type === 'exp').length : 0, ns = ready ? items.filter(isLow).length : 0;
  for (const [t, label, n] of [['ai', 'おしらせ', nb], ['shop', '買い物', ns]]) { const b = $(`#tabs [data-tab=${t}]`); b.innerHTML = `${label}${n ? `<span class="bd" aria-hidden="true">${n}</span>` : ''}`; b.setAttribute('aria-label', `${label}${n ? ` ${n}件` : ''}`); }
  $('#addnav').hidden = !state.household;
  const v = $('#view');
  // 在庫タブは検索欄を作り直さない(入力中・日本語変換中に消えるため)。一覧だけ更新する
  if (state.household && tab === 'stock' && items.length && $('#lst') && $('#q')) return renderList();
  if (!state.user) return (v.innerHTML = `<div class="empty"><p>家族みんなで使う在庫管理</p>${JOIN ? '<p class="sub">家族に誘われています。ログインすると、参加の画面に進みます。</p>' : ''}<button class="b p" id="login">Googleでログイン</button></div>`, $('#login').onclick = () => store.signIn());
  if (!state.household) return renderSetup(v);
  ({ stock: renderStock, shop: renderShop, ai: renderAi, import: renderImport, family: renderFamily })[tab](v);
}

function renderSetup(v) {
  const mk = `<div class="card"><h3>ひとりで使う・最初の1人</h3><p class="sub">家の名前を決めて、新しく作ります。家族はあとから誘えます。</p>
  <label for="hn">家の名前</label><input id="hn" value="うちの家" enterkeyhint="done"><button class="b p" id="mk" style="margin-top:8px;width:100%">新しく作る</button></div>`;
  const jn = `<div class="card"><h3>家族に誘われた</h3><p class="sub">${JOIN ? '誘いのリンクのコードが入っています。' : '家族から届いた10文字のコードを入れます。'}</p>
  <label for="jc">家族コード</label><input id="jc" placeholder="10文字のコード" autocapitalize="characters" autocomplete="off" enterkeyhint="go" value="${esc(JOIN)}"><button class="b ${JOIN ? 'p' : ''}" id="jn" style="margin-top:8px;width:100%">参加する</button></div>`;
  v.innerHTML = `<h2>はじめまして</h2>${JOIN ? jn + mk : mk + jn}`;
  $('#mk').onclick = () => store.createHousehold($('#hn').value.trim() || 'うちの家').then(clearJoin).catch((e) => toast(e.message));
  $('#jn').onclick = () => store.joinHousehold($('#jc').value).then(clearJoin).catch(() => toast('参加できませんでした。コードを確認してください'));
  $('#hn').onkeydown = (e) => { if (e.key === 'Enter') $('#mk').click(); };
  $('#jc').onkeydown = (e) => { if (e.key === 'Enter') $('#jn').click(); };
}

// ---------- 在庫の一覧 ----------
// −/＋ を押した直後は並び順を保つ(押した品が「残りわずか」で先頭へ飛び、次のタップが別の品に当たるのを防ぐ)。subOrder: 固定中の小分類の順
let hold = { until: 0, ids: [], subOrder: new Map() };
let tmpClosed = new Set(); // 絞り込み中に開閉した見出し(保存しない。絞り込みが変わると戻る)
let idMap = new Map();
const FILTERS = [['', 'all', 'ぜんぶ'], ['low', 'low', '足りない'], ['exp', 'exp', '期限が近い']];
const UNCAT = { name: '未分類', icon: '🏷️', color: 'gray' }, NOLOC = { name: '置き場所なし', icon: '📍' };
const CHEV = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 1品ぶんの導出値(状態・期限・大分類・置き場所)。描画1回につき1品1回だけ計算して、行・見出し・要約で使い回す
function infoOf(i, now) {
  const d = expiryDays(i, now), low = isLow(i), raw = String(i.category ?? '').trim();
  const rank = d !== null && d < 0 ? 0 : low && i.qty <= 0 ? 1 : low ? 2 : d !== null && d <= EXPIRY_DAYS ? 3 : 9; // 状態の重さ
  const cat = canonCategory(raw, LEGACY_CATEGORY[raw] ? guessClass(i.name).category : ''), loc = canonLocation(i.location, i.name);
  return { i, d, low, rank, near: d !== null && d <= EXPIRY_DAYS, cat, ci: catInfo(cat), loc, li: locInfo(loc), sub: String(i.sub ?? '').trim() };
}
// 予測・前回の期限は「(予測)」「(前回から)」を併記し、期限切れは実際の表示より控えめな文言にする
const pillOf = (x) => { const est = estSrc(x.i.expirySrc), sfx = est ? `(${x.i.expirySrc === '前回' ? '前回から' : '予測'})` : '';
  return x.rank === 0 ? (est ? ['expired est', '⛔', `期限の目安を過ぎています${sfx}`] : ['expired', '⛔', '期限切れ']) : x.rank === 1 ? ['zero', '✕', 'なくなった'] : x.rank === 2 ? ['low', '⚠', '残りわずか']
  : x.rank === 3 ? ['soon', '⏰', (x.d === 0 ? '今日まで' : `あと${x.d}日`) + sfx] : x.i.qty <= 0 ? ['none', '', '在庫なし'] : null; };
const SORT_CMP = (now) => {
  const nameCmp = (a, b) => a.i.name.localeCompare(b.i.name, 'ja');
  return {
    std: (a, b) => a.rank - b.rank || nameCmp(a, b), name: nameCmp,
    expiry: (a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || nameCmp(a, b),
    eta: (a, b) => (a.i.qty <= 0 ? -1 : daysLeft(a.i, now) ?? 1e9) - (b.i.qty <= 0 ? -1 : daysLeft(b.i, now) ?? 1e9) || nameCmp(a, b),
    recent: (a, b) => (b.i.updatedAt || 0) - (a.i.updatedAt || 0),
  };
};

function rowHtml(x, ctx) {
  const { i, ci, li } = x, p = pillOf(x), where = li.name ? `${li.icon} ${esc(li.name)}` : '<i>置き場所なし</i>';
  const sec = ctx === 'cat' ? where : ctx === 'loc' ? `${ci.icon} ${esc(x.sub || ci.name || '未分類')}` : `${ci.icon} ${esc(x.sub || ci.name || '未分類')} ・ ${where}`;
  const state = p ? `(${p[2]})` : '';
  return `<div class="it${x.low ? ' low' : ''}" data-id="${esc(i.id)}" style="--st:var(--c-${ci.color}-fg)"><button class="info" data-edit aria-label="${esc(i.name)}を編集"><span class="nm">${esc(i.name)}</span><span class="meta">${p ? `<span class="pill ${p[0]}">${p[1] ? `<span aria-hidden="true">${p[1]}</span> ` : ''}${p[2]}</span>` : ''}<span>${sec}</span></span></button>`
    + `<div class="ctl"><button class="pm" data-d="-1" aria-label="${esc(i.name)}を1つ減らす">−</button><button class="qty" data-q aria-label="${esc(i.name)} 残り${i.qty}${state}。タップして数を入力">${i.qty}</button><button class="pm" data-d="1" aria-label="${esc(i.name)}を1つ増やす">＋</button></div></div>`;
}

// 大分類でまとめる: TAXONOMY の順 → 家族が付けた分類(多い順) → 未分類。小分類の小見出しは足りない/期限が近い品のある所を上へ
function groupByCat(list, held) {
  const by = new Map(), order = [...CATS];
  for (const x of list) { if (!by.has(x.cat)) by.set(x.cat, []); by.get(x.cat).push(x); }
  const extra = [...by.keys()].filter((k) => k && !CATS.includes(k)).sort((a, b) => by.get(b).length - by.get(a).length || a.localeCompare(b, 'ja'));
  const out = [];
  for (const k of [...order, ...extra, '']) {
    const a = by.get(k); if (!a) continue;
    const ci = k ? catInfo(k) : UNCAT, g = { key: k || UNCAT.name, name: ci.name || UNCAT.name, icon: ci.icon, color: ci.color, items: a, none: !k, hint: k ? '' : '分類をつけると探しやすくなります。品名をタップして編集できます。' };
    if (ci.subs?.length) {
      const names = [...ci.subs, ...new Set(a.map((x) => x.sub).filter((s) => s && !ci.subs.includes(s)))];
      let subs = names.map((n) => [n, a.filter((x) => (x.sub || 'その他') === n)]).filter(([, arr]) => arr.length);
      if (held && hold.subOrder.has(g.key)) { const ix = new Map(hold.subOrder.get(g.key).map((n, j) => [n, j])); subs.sort((p, q) => (ix.get(p[0]) ?? 1e9) - (ix.get(q[0]) ?? 1e9)); }
      else if (sortKey === 'std' || sortKey === 'expiry') {
        const key = (arr) => Math.min(...arr.map((x) => (sortKey === 'std' ? x.rank : x.d ?? 1e9)));
        subs = subs.map((s, n) => [s, n]).sort((p, q) => key(p[0][1]) - key(q[0][1]) || p[1] - q[1]).map(([s]) => s);
      }
      hold.subOrder.set(g.key, subs.map(([n]) => n));
      g.subs = subs;
    }
    out.push(g);
  }
  return out;
}
// 置き場所でまとめる: LOCS の順 → 一覧にない置き場所(多い順) → 置き場所なし
function groupByLoc(list) {
  const by = new Map();
  for (const x of list) { if (!by.has(x.loc)) by.set(x.loc, []); by.get(x.loc).push(x); }
  const extra = [...by.keys()].filter((k) => k && !LOCS.includes(k)).sort((a, b) => by.get(b).length - by.get(a).length || a.localeCompare(b, 'ja'));
  const out = [];
  for (const k of [...LOCS, ...extra, '']) {
    const a = by.get(k); if (!a) continue;
    const li = k ? locInfo(k) : NOLOC;
    out.push({ key: li.name, name: li.name, icon: li.icon, place: true, none: !k, items: a, hint: k ? '' : '置き場所をつけると、冷蔵庫など場所ごとに見られます。' });
  }
  return out;
}
function groupHtml(g, n, ctx, closed) {
  const nl = g.items.filter((x) => x.low).length, ne = g.items.filter((x) => x.near).length, id = `g-${ctx}-${n}`, shut = closed.has(g.key);
  const colors = g.place ? '--gbg:var(--place-bg);--gfg:var(--place-fg)' : `--gbg:var(--c-${g.color}-bg);--gfg:var(--c-${g.color}-fg)`;
  const body = g.subs ? g.subs.map(([sn, arr]) => `<h4 class="sh">${esc(sn)}<span>${arr.length}品</span></h4>${arr.map((x) => rowHtml(x, ctx)).join('')}`).join('') : g.items.map((x) => rowHtml(x, ctx)).join('');
  const add = g.none ? '' : `<button type="button" class="gadd" data-gadd="${esc(g.key)}" aria-label="${esc(g.name)}に品を追加"><span aria-hidden="true">＋</span><span class="gat">追加</span></button>`;
  return `<section class="lg" style="${colors}"><div class="gw"><h3 class="gh"><button data-fold="${esc(g.key)}" aria-expanded="${!shut}" aria-controls="${id}"><span class="ic" aria-hidden="true">${g.icon}</span><span class="gn">${esc(g.name)}<span class="ct">${g.items.length}品</span></span><span class="gr"><span class="bdg">${nl ? `<span class="hb low">足りない ${nl}</span>` : ''}${ne ? `<span class="hb exp">期限 ${ne}</span>` : ''}</span><span class="chev" aria-hidden="true">${CHEV}</span></span></button></h3>${add}</div>`
    + `<div class="gbody" id="${id}" ${shut ? 'hidden' : ''}>${g.hint ? `<p class="gnote">${g.hint}</p>` : ''}${body}</div></section>`;
}

function renderStock(v) {
  if (!items.length) {
    v.innerHTML = `<h2 class="vh">在庫一覧</h2><div class="empty"><div class="big" aria-hidden="true">📦</div><p class="tt">まだ登録がありません</p><p>最初の1品を追加してみましょう。</p><button class="b p" id="e-add">品目を追加</button><br><button class="b" id="e-imp">レシートやバーコードでまとめて追加</button></div>`;
    $('#e-add').onclick = () => editDialog(); $('#e-imp').onclick = () => { tab = 'import'; render(); };
    return;
  }
  v.innerHTML = `<h2 class="vh">在庫一覧</h2><div class="srow"><div class="sw"><input id="q" type="search" enterkeyhint="search" placeholder="さがす(ひらがなでもOK)" aria-label="品名でさがす" autocomplete="off" value="${esc(q)}"><button class="x" id="qx" aria-label="入力を消す" ${q ? '' : 'hidden'}>×</button></div><button class="b" id="scan" aria-label="バーコードで追加">📷</button></div>
  <div class="sum" id="sum" role="group" aria-label="状態でしぼりこむ">${FILTERS.map(([f, c, l]) => `<button class="sc ${c}" data-f="${f}" aria-pressed="false"><span class="n"></span><span class="l">${l}</span></button>`).join('')}</div>
  <div class="seg" id="segw" role="group" aria-label="表示のしかた">${VIEWS.map(([k, t]) => `<button data-mode="${k}" aria-pressed="false">${t}</button>`).join('')}</div>
  <div class="tools"><select id="srt" aria-label="並び替え">${SORTS.map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select><button class="fold" id="foldall"></button></div>
  <div class="filt" id="filt" hidden><span class="t" id="filt-t" role="status"></span><button class="b" data-clear>解除</button></div><div id="lst"></div>`;
  const reset = () => { hold.until = 0; tmpClosed = new Set(); };
  const clearAll = () => { q = filterKey = ''; $('#q').value = ''; $('#qx').hidden = true; reset(); renderList(); $('#sum [data-f=""]').focus({ preventScroll: true }); };
  $('#q').oninput = (e) => { q = e.target.value; $('#qx').hidden = !q; reset(); renderList(); };
  $('#qx').onclick = () => { q = ''; $('#q').value = ''; $('#qx').hidden = true; reset(); renderList(); $('#q').focus(); };
  $('#sum').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filterKey = b.dataset.f === filterKey ? '' : b.dataset.f; reset(); renderList(); };
  $('#segw').onclick = (e) => {
    const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === viewMode) return;
    viewMode = b.dataset.mode; lsSet('hs-view', viewMode); reset(); renderList();
    const y = $('#sum').getBoundingClientRect().top + scrollY - 8; if (scrollY > y) scrollTo(0, Math.max(0, y)); // 一覧の先頭が見える所まで戻す
  };
  $('#srt').onchange = (e) => { sortKey = e.target.value; lsSet('hs-sort', sortKey); reset(); renderList(); };
  $('#foldall').onclick = () => {
    const bs = [...$('#lst').querySelectorAll('[data-fold]')], shut = !bs.every((b) => b.getAttribute('aria-expanded') === 'false');
    bs.forEach((b) => setOpen(b, !shut)); saveFold(); syncFoldBtn();
  };
  $('#filt [data-clear]').onclick = clearAll;
  $('#scan').onclick = barcodeAdd;
  $('#lst').onclick = (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.gadd !== undefined) { // 見出しの＋: その場所/分類を追加先にして、追加ダイアログを開く(固定中なら固定のまま)
      setCtx(viewMode === 'loc' ? { location: t.dataset.gadd, category: '', sub: '' } : { category: t.dataset.gadd, sub: '', location: '' }); return editDialog();
    }
    if (t.dataset.fold !== undefined) { setOpen(t, t.getAttribute('aria-expanded') !== 'true'); saveFold(); syncFoldBtn(); return; }
    if (t.dataset.clear !== undefined) return clearAll();
    const row = t.closest('.it'), it = row && idMap.get(row.dataset.id); if (!it) return;
    if (t.dataset.edit !== undefined) editDialog(it);
    else if (t.dataset.q !== undefined) editDialog(it, null, 'q');
    else if (t.dataset.d) {
      const qty = Math.max(0, it.qty + +t.dataset.d); if (qty === it.qty) return;
      hold.until = Date.now() + 6000;
      saveQty(it, { ...it, qty }).catch(() => {});
      toast(`${it.name}: ${it.qty} → ${qty}`, () => save(it));
    }
  };
  renderList();
}

// 見出しの開閉(一覧は作り直さない=フォーカスもスクロールも動かない)。絞り込み中は保存しない
const closedSet = () => (filterKey || fold(q) ? tmpClosed : foldS[viewMode]);
function setOpen(btn, open) {
  btn.setAttribute('aria-expanded', open); $(`#${btn.getAttribute('aria-controls')}`).hidden = !open;
  const s = closedSet(); open ? s.delete(btn.dataset.fold) : s.add(btn.dataset.fold);
}
function saveFold() {
  if (filterKey || fold(q)) return;
  const keys = new Set([...$('#lst').querySelectorAll('[data-fold]')].map((b) => b.dataset.fold)); // 今ない見出しのキーはここで掃除
  foldS[viewMode] = new Set([...foldS[viewMode]].filter((k) => keys.has(k)));
  lsSet('hs-fold', JSON.stringify({ cat: [...foldS.cat], loc: [...foldS.loc] }));
}
function syncFoldBtn() {
  const bs = [...$('#lst').querySelectorAll('[data-fold]')], all = bs.length > 0 && bs.every((b) => b.getAttribute('aria-expanded') === 'false'), f = $('#foldall');
  f.hidden = viewMode === 'flat'; f.textContent = all ? 'すべて開く' : 'すべてたたむ'; f.setAttribute('aria-label', all ? 'すべての見出しを開く' : 'すべての見出しをたたむ');
}

function renderList() {
  const el = $('#lst'), now = Date.now(), fq = fold(q), filtering = !!(filterKey || fq);
  const infos = items.map((i) => infoOf(i, now));
  idMap = new Map(items.map((i) => [i.id, i]));
  let nLow = 0, nNear = 0;
  for (const x of infos) { if (x.low) nLow++; if (x.near) nNear++; }
  const list = infos.filter((x) => (!filterKey || (filterKey === 'low' ? x.low : x.near)) && (!fq || fold(x.i.name).includes(fq)));
  const held = now < hold.until;
  if (held) { const ix = new Map(hold.ids.map((id, n) => [id, n])); list.sort((a, b) => (ix.get(a.i.id) ?? 1e9) - (ix.get(b.i.id) ?? 1e9)); }
  else list.sort(SORT_CMP(now)[sortKey]);
  hold.ids = list.map((x) => x.i.id);
  // 再描画で消える要素にフォーカスがあったら、同じ品目の同じボタンへ戻す(連続して押せるように)
  const ae = document.activeElement, fk = ae && el.contains(ae) ? (ae.dataset.fold !== undefined ? { fold: ae.dataset.fold } : { id: ae.closest('.it')?.dataset.id, sel: ae.dataset.d ? `[data-d="${ae.dataset.d}"]` : ae.matches('[data-q]') ? '[data-q]' : '[data-edit]' }) : null;
  // 上の部品は作り直さず、属性と数字だけ更新する
  $('#sum').querySelectorAll('[data-f]').forEach((b) => {
    const f = b.dataset.f, n = f === 'low' ? nLow : f === 'exp' ? nNear : items.length, l = FILTERS.find((x) => x[0] === f)[2];
    b.querySelector('.n').textContent = n; b.setAttribute('aria-pressed', f === filterKey); b.setAttribute('aria-label', `${l} ${n}品`);
  });
  $('#segw').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === viewMode));
  $('#srt').value = sortKey;
  const ft = [filterKey && `「${filterKey === 'low' ? '足りない' : '期限が近い'}」`, q.trim() && `「${q.trim()}」`].filter(Boolean).join('と') + `で絞り込み中: ${list.length}品`;
  $('#filt').hidden = !filtering; if ($('#filt-t').textContent !== ft) $('#filt-t').textContent = ft;
  let html;
  if (!list.length) {
    const none = q.trim() && !filterKey ? `<div class="big" aria-hidden="true">🔍</div><p class="tt">「${esc(q.trim())}」は見つかりません</p><p>ひらがなでも探せます。ほかの言葉や、短い言葉で試してください。</p>`
      : filterKey === 'low' ? `<div class="big" aria-hidden="true">🎉</div><p class="tt">足りないものはありません</p><p>すべて、買い足しラインより多くあります。</p>`
      : filterKey === 'exp' ? `<div class="big" aria-hidden="true">👍</div><p class="tt">期限が近いものはありません</p><p>7日以内に期限が来る品はありません。</p>`
      : `<div class="big" aria-hidden="true">🔍</div><p class="tt">条件に合う品はありません</p>`;
    html = `<div class="empty">${none}<button class="b p" data-clear>${q.trim() && !filterKey ? '検索を消す' : 'すべての品を見る'}</button></div>`;
  } else if (viewMode === 'flat') html = list.map((x) => rowHtml(x, 'flat')).join('');
  else {
    const closed = closedSet(), gs = viewMode === 'cat' ? groupByCat(list, held) : groupByLoc(list);
    html = gs.map((g, n) => groupHtml(g, n, viewMode, closed)).join('');
  }
  el.innerHTML = html;
  syncFoldBtn();
  if (fk) {
    const t = fk.fold !== undefined ? [...el.querySelectorAll('[data-fold]')].find((b) => b.dataset.fold === fk.fold) : [...el.querySelectorAll('.it')].find((r) => r.dataset.id === fk.id)?.querySelector(fk.sel);
    t?.focus({ preventScroll: true });
  }
}

// 買い物: 「買った」を押した品はその場に残して(取り消し線)、押し間違いはすぐ戻せる。タブを離れると消える
const shopDone = new Map(); // id -> {old, sec, idx}
function renderShop(v) {
  const secs = [items.filter(isLow).map((i) => ({ i })), getPlan().soonOut.filter((x) => !isLow(x.item)).map((x) => ({ i: x.item, days: x.days }))];
  for (const [id, m] of shopDone) { const cur = items.find((x) => x.id === id); if (cur && !secs.flat().some((r) => r.i.id === id)) secs[m.sec].splice(Math.min(m.idx, secs[m.sec].length), 0, { i: cur }); }
  const row = ({ i, days }, sec, idx) => {
    const dn = shopDone.get(i.id);
    if (dn) return `<div class="card row done"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="sub">買いました(いま ${i.qty}個)</div></div><button class="b" data-undo="${i.id}" aria-label="${esc(i.name)}の「買った」を取り消す">元に戻す</button></div>`;
    const sub = sec === 0 ? `残り ${i.qty}個 ・ ${i.minQty}個以下で表示` : `残り ${i.qty}個 ・ <span class="warn">${i.qty > 0 ? etaText(days) : '切れています'}</span>`;
    return `<div class="card row"><div class="grow"><div class="nm">${esc(i.name)}</div><div class="sub">${sub}</div></div><button class="b p" data-id="${i.id}" data-sec="${sec}" data-idx="${idx}" aria-label="${esc(i.name)}を買った(+${i.buyQty || 1}個)">買った +${i.buyQty || 1}</button></div>`;
  };
  const [list, soon] = secs;
  v.innerHTML = '<h2 class="vh">買い物リスト</h2>' + (list.length ? `<p class="sub">残りが「買い足しライン」以下の品が自動で並びます。買ったら右のボタンを押してください。</p>` + list.map((r, n) => row(r, 0, n)).join('') : '')
    + (soon.length ? `<h3 class="sec">もうすぐ切れそう</h3><p class="sub">使うペースからの予測です(使うほど正確になります)。</p>` + soon.map((r, n) => row(r, 1, n)).join('') : '')
    + (list.length || soon.length ? '' : `<div class="empty">買い足すものはありません 🎉<br><span class="sub">在庫の編集で「買い足しライン」を決めると、その数以下になったときここに出ます</span></div>`);
  v.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => {
    const i = items.find((x) => x.id === b.dataset.id);
    shopDone.set(i.id, { old: i, sec: +b.dataset.sec, idx: +b.dataset.idx });
    saveQty(i, { ...i, qty: i.qty + (i.buyQty || 1), boughtAt: new Date().toISOString().slice(0, 10) }).catch(() => { shopDone.delete(i.id); render(); });
  }));
  v.querySelectorAll('[data-undo]').forEach((b) => (b.onclick = () => { const m = shopDone.get(b.dataset.undo); shopDone.delete(b.dataset.undo); save(m.old).catch(() => {}); render(); }));
}

// ---------- おしらせ(かしこい提案。端末内の統計による推定で、外部には送信しない) ----------
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const nm = (i) => `「${esc(i.name)}」`;
// カードの一覧 {type, key, cls, title, body, ok:{label, fn}}。「あとで」済みは除く
function aiCards() {
  const p = getPlan(), dm = dismissed(), cs = [];
  for (const { item: i, days, expired } of p.expiring) {
    const est = estSrc(i.expirySrc), lab = i.expirySrc === '前回' ? '前回の期間からの目安' : '予測';
    cs.push({ type: 'exp', key: `exp:${i.id}:${i.expiry}`, cls: 'alert', title: est ? `${nm(i)}の期限の目安${expired ? 'を過ぎています' : 'が近づいています'}(${lab})` : `${nm(i)}の期限${expired ? 'が切れています' : 'が近づいています'}`,
      body: `${est ? '予測の期限' : '期限'} ${dateJa(i.expiry)}(${expired ? `${-days}日前` : days === 0 ? '今日' : `あと${days}日`})・ 残り ${i.qty}個${est ? '<br><span class="sub">標準的な期間からの目安です。パッケージの表示を確かめてください。</span>' : ''}`,
      ok: expired ? { label: '捨てた(数を0にする)', fn: () => saveQty(i, { ...noExp(i), qty: 0 }, { skip: true }) } : null, ok2: expired ? { label: 'まだ使える(期限を消す)', fn: () => save(noExp(i)) } : null, no: expired ? 'あとで' : '見ました' });
  }
  for (const { item: i, cur, sug, rate } of p.parSuggestions) cs.push({ type: 'par', key: `par:${i.id}:${sug.minQty}:${sug.buyQty}`, title: `${nm(i)}の買い方を見直しませんか`,
    body: `いま: ${cur.minQty}個以下になったら買い物リストに出す ・ 1回に${cur.buyQty}個買う<br>→ <b>${sug.minQty}個以下で出す ・ 1回に${sug.buyQty}個買う</b>にするとちょうどよさそうです。<br><span class="sub">1日に約${rate.toFixed(2)}個のペースで使っている計算です(約1週間分を切らさず、約2週間分ずつ買う目安)。</span>`,
    ok: { label: '変更する', fn: () => save({ ...i, minQty: sug.minQty, buyQty: sug.buyQty }) } });
  for (const g of p.duplicates) cs.push({ type: 'dup', key: `dup:${g.items.map((x) => x.id).sort().join(',')}`, title: '同じ品かもしれません',
    body: `${g.items.map((x) => `${nm(x)}(${x.qty})`).join(' と ')}<br>→ ${nm(g.keep)} <b>${g.merged.qty}</b>個にまとめます(数量は合算、バーコード・履歴は引き継ぎ)。`,
    ok: { label: 'まとめる', fn: async () => { await save(g.merged); for (const x of g.items) if (x !== g.keep) await store.remove(x.id); } } });
  const fills = p.autoFill;
  if (fills.length) {
    const nc = fills.filter((x) => x.category).length, nl = fills.filter((x) => x.location).length;
    cs.push({ type: 'auto', key: `auto:${hash(fills.map((x) => x.item.id).sort().join())}`, title: `分類がまだの${fills.length}件に、自動で分類をつけます`,
      body: `カテゴリ ${nc}件・置き場所 ${nl}件を補います(すでに入っている値は変えません)。<br>${fills.slice(0, 6).map((x) => `${nm(x.item)}→${esc([x.item.category ? '' : x.category, x.item.location ? '' : x.location].filter(Boolean).join(' / '))}`).join('<br>')}${fills.length > 6 ? `<br>ほか${fills.length - 6}件` : ''}<br><span class="sub">家族が付けた分類(類似名)があればそれを優先し、なければ品名の辞書で推定します。違っていたら在庫の編集で直してください(「自動」の印が付きます)。</span>`,
      ok: { label: `${fills.length}件に適用`, fn: () => Promise.all(fills.map((x) => save({ ...x.item, category: x.item.category || x.category, location: x.item.location || x.location, ...(x.sub && !x.item.sub ? { sub: x.sub } : {}), auto: true }))) } });
  }
  for (const { item: i, idleDays, days } of p.overstock) cs.push({ type: 'over', key: `over:${i.id}`, title: `${nm(i)}は十分あります`,
    body: `${idleDays}日間動きがなく、${i.qty}個あります${days === null ? '' : `(いまのペースで${days > 365 ? '1年以上' : `約${Math.round(days)}日`}分)`}。しばらく買わなくて大丈夫そうです。`, ok: null, no: '見ました' });
  return cs.filter((c) => !dm[c.key]);
}

const GROUPS = [['exp', '期限が近い・切れている'], ['par', '買い方の見直し'], ['dup', '同じ品かもしれないもの'], ['auto', '分類をまとめてつける'], ['over', '十分ありそうなもの']];
const gOpen = new Set(['exp']), gAll = new Set(); // 開いている種類 / 全件表示にした種類
const GMAX = 5;
function renderAi(v) {
  const cs = aiCards(), L = getPlan().learning;
  const hint = L.ready ? `${L.ready}品の使うペースを学習済みです。` : L.tracking ? `使うペースを学習中です。早い品で、あと約${L.etaDays}日で最初の予測が出ます。` : `まだ学習中です。数量を−や「買った」で記録していくと、${MIN_SPAN_DAYS}日・${MIN_EVENTS}回ほどで予測が始まります。`;
  const idx = new Map(cs.map((c, n) => [c, n]));
  const card = (c) => `<div class="card sg ${c.cls || ''}"><div class="nm">${c.title}</div><div class="sub sgb">${c.body}</div>
      <div class="row"><button class="b grow" data-no="${idx.get(c)}">${c.no || 'あとで'}</button>${c.ok2 ? `<button class="b grow" data-ok2="${idx.get(c)}">${c.ok2.label}</button>` : ''}${c.ok ? `<button class="b p grow" data-ok="${idx.get(c)}">${c.ok.label}</button>` : ''}</div></div>`;
  const group = ([t, title]) => {
    const g = cs.filter((c) => c.type === t); if (!g.length) return '';
    const shown = gAll.has(t) ? g : g.slice(0, GMAX);
    return `<details class="grp" data-g="${t}" ${gOpen.has(t) ? 'open' : ''}><summary>${title}<span class="n">${g.length}件</span></summary>
      <div class="gact">${t === 'par' ? `<button class="b p" data-bulk-ok="${t}">${g.length}件まとめて変更</button>` : ''}<button class="b" data-bulk-no="${t}">${t === 'over' ? 'まとめて 見ました' : 'まとめて あとで'}</button></div>
      ${shown.map(card).join('')}${g.length > GMAX && !gAll.has(t) ? `<div class="gact"><button class="b" data-more="${t}">もっと見る(あと${g.length - GMAX}件)</button></div>` : ''}</details>`;
  };
  v.innerHTML = `<h2>おしらせ</h2><p class="sub">端末の中だけで計算した統計的な推定です(外部には送信しません)。使うほど正確になりますが、記録が少ないうちは外れます。${hint}</p>` +
    (cs.length ? GROUPS.map(group).join('') : `<div class="empty">いまのところ、おしらせはありません</div>`);
  // 反映後に「元に戻す」: 反映で変わった品目だけ、反映前の内容に保存し直す(その間の他の人の変更は巻き込まない)
  const run = (f) => async () => {
    const snap = new Map(items.map((i) => [i.id, JSON.stringify(i)]));
    try {
      await f(); await new Promise((r) => setTimeout(r, 60));
      const back = [...snap].filter(([id, j]) => { const c = items.find((x) => x.id === id); return !c || JSON.stringify(c) !== j; }).map(([, j]) => JSON.parse(j));
      toast('反映しました', back.length ? async () => { for (const o of back) await save(o); } : null);
    } catch {}
    render();
  };
  const of = (t) => cs.filter((c) => c.type === t);
  v.querySelectorAll('details.grp').forEach((d) => (d.ontoggle = () => (d.open ? gOpen.add(d.dataset.g) : gOpen.delete(d.dataset.g))));
  v.querySelectorAll('[data-more]').forEach((b) => (b.onclick = () => { gAll.add(b.dataset.more); render(); }));
  v.querySelectorAll('[data-bulk-no]').forEach((b) => (b.onclick = () => { const ks = of(b.dataset.bulkNo).map((c) => c.key); ks.forEach(dismiss); toast(`${ks.length}件を${b.dataset.bulkNo === 'over' ? '見ました' : 'あとで'}にしました`, () => undismiss(ks).then(render)); render(); }));
  v.querySelectorAll('[data-bulk-ok]').forEach((b) => (b.onclick = run(async () => { for (const c of of(b.dataset.bulkOk)) await c.ok.fn(); })));
  v.querySelectorAll('[data-no]').forEach((b) => (b.onclick = () => { dismiss(cs[b.dataset.no].key); render(); }));
  v.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = run(cs[b.dataset.ok].ok.fn)));
  v.querySelectorAll('[data-ok2]').forEach((b) => (b.onclick = run(cs[b.dataset.ok2].ok2.fn)));
}

// 書き出し(いま持っているデータをそのまま)
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1e4); };
function exportData(kind) {
  const day = new Date().toISOString().slice(0, 10), rows = [...items].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (kind === 'json') download(`uchi-zaiko-${day}.json`, JSON.stringify(rows, null, 2), 'application/json');
  else {
    const c = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`, ts = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
    download(`uchi-zaiko-${day}.csv`, '﻿' + [['名前', '数量', '買い足しライン', '買うときの個数', 'カテゴリ', '置き場所', '期限', '更新日'].map(c).join(','), ...rows.map((i) => [i.name, i.qty, i.minQty || 0, i.buyQty || 1, i.category, i.location, i.expiry, ts(i.updatedAt)].map(c).join(','))].join('\r\n'), 'text/csv');
  }
  toast(`${rows.length}件を書き出しました`);
}

function renderFamily(v) {
  const h = state.household, cloud = store.mode === 'cloud';
  const link = `${location.origin}${location.pathname}?join=${h.id}`;
  v.innerHTML = `<h2 class="vh">家族と設定</h2><div class="card"><h3>${esc(h.name)}</h3>${cloud ? `<p class="sub">家族に下のリンクを送ってください。開いてログインすると、参加の画面にコードが自動で入ります。</p><div class="code" id="code">${esc(h.id)}</div>
    <div class="row" style="flex-wrap:wrap"><button class="b p" id="sh" style="flex:1 1 45%;white-space:normal">家族にリンクを送る</button><button class="b" id="cl" style="flex:1 1 45%;white-space:normal">リンクをコピー</button><button class="b" id="cp" style="flex:1 1 45%;white-space:normal">コードだけコピー</button></div>` : `<p class="sub">いまは、この携帯だけで使っています(家族とは共有されません)。家族で共有するには js/config.js に Firebase の設定が必要です(README参照)。</p>`}</div>
  <div class="card"><h3>データの書き出し</h3><p class="sub">いまの在庫(${items.length}件)を、表計算ソフトなどで開けるファイルに保存します。</p><div class="row"><button class="b grow" id="ex-csv">CSV</button><button class="b grow" id="ex-json">JSON</button></div></div>
  <div class="card" id="xp"><h3>期限の予測</h3><label class="swl"><input type="checkbox" id="ae" ${autoExp() ? 'checked' : ''}><span>期限が書いていないとき、予測で自動入力する</span></label>
  <p class="sub">予測は標準的な期間にもとづく目安です。パッケージの表示があれば必ずそちらを使ってください。この設定はこの端末だけのものです。</p>
  <h4 class="xh">予測の的中率</h4><p id="xs" role="status"></p><p class="sub">予測・前回の期限を、実際の日付に直した品と、「合っていた」を押した品の結果です(この端末だけの記録)。目安を確かめるための記録で、精度を保証するものではありません。「長すぎた予測」は、予測が実際より長かった誤りです。</p><button class="b" id="xs-reset">記録をリセット</button></div>
  <div class="card"><h3>レシートの修正の学習</h3><p class="sub">レシートの読み間違いを直すと、この端末が覚えて、次から自動で直します(この端末の中だけに保存されます)。覚えた数: <span id="fxn">${fixLoad().length}</span>件</p><button class="b" id="fx-reset" ${fixLoad().length ? '' : 'disabled'}>修正の学習をリセット</button></div>
  ${cloud ? '<div class="danger"><button class="b" id="out">ログアウト</button></div>' : ''}`;
  const copy = (t, m) => (navigator.clipboard?.writeText(t) ?? Promise.reject()).then(() => toast(m), () => toast('コピーできませんでした。コードを長押しして選んでください'));
  $('#out')?.addEventListener('click', () => store.signOut());
  $('#cp')?.addEventListener('click', () => copy(h.id, 'コードをコピーしました'));
  $('#cl')?.addEventListener('click', () => copy(link, 'リンクをコピーしました'));
  $('#sh')?.addEventListener('click', () => (navigator.share ? navigator.share({ title: 'うちの在庫', text: `「うちの在庫」に参加してください。開いてログインすると家族コード(${h.id})が入ります。`, url: link }).catch(() => {}) : copy(link, 'リンクをコピーしました。LINEなどに貼ってください')));
  $('#fx-reset').onclick = () => { const was = fixLoad(); fixSave([]); $('#fxn').textContent = '0'; $('#fx-reset').disabled = true; toast('修正の学習をリセットしました', () => { fixSave(was); renderFamily(v); }); };
  const xsPaint = () => { const x = xsLoad(); $('#xs').innerHTML = x.n >= 5 ? `<b>${x.n}件中${x.hit}件(${Math.round((x.hit / x.n) * 100)}%)</b>。長すぎた予測: ${x.long}件` : `まだデータがたまっていません(あと${5 - x.n}件)`; $('#xs-reset').disabled = !x.n; };
  xsPaint();
  $('#ae').onchange = (e) => { lsSet('hs-autoexp', e.target.checked ? '1' : '0'); toast(e.target.checked ? '予測の自動入力をオンにしました' : '予測の自動入力をオフにしました'); };
  $('#xs-reset').onclick = () => { const was = xsLoad(); xsSave({ n: 0, hit: 0, long: 0 }); xsPaint(); toast('的中率の記録をリセットしました', () => { xsSave(was); xsPaint(); }); };
  $('#ex-csv').onclick = () => exportData('csv'); $('#ex-json').onclick = () => exportData('json');
}

function renderImport(v) {
  v.innerHTML = `<h2>まとめて追加</h2>${acb()}<p class="sub" style="margin:0">追加先を選ぶと、バーコード・レシート・貼り付けの品がその場所・分類に入ります(選ばない項目は自動で分類)。</p><div class="card"><h3>バーコードで追加</h3><p class="sub">商品のバーコードをカメラで読むだけで追加できます。一度登録した商品は、次から数量が増えます。家族にも共有されます。</p><button class="b p" id="bc">バーコードを読む</button></div>
  <div class="card"><h3>レシートを撮って追加</h3><p class="sub">端末の中で文字を読み取ります(画像は送信されません)。読み間違いは、写真を見ながら直してから登録します。</p>
  <div class="sub" id="mdl"></div><ul class="tips"><li>明るい場所で撮る</li><li>レシートを平らにして、真上から撮る</li><li>自分の影が入らないようにする</li></ul>
  <div class="row"><label class="b p filebtn grow">カメラで撮る<input type="file" id="rcc" accept="image/*" capture="environment" class="vh"></label><label class="b filebtn grow">アルバムから選ぶ<input type="file" id="rc" accept="image/*" multiple class="vh"></label></div><div id="rcs"></div></div>
  ${gmailAvailable ? `<div class="card"><h3>Gmailの注文メールから追加</h3><p class="sub">Amazon・楽天の注文確認メールを読み取ります(読み取り専用)。</p>
  <div class="grid2"><select id="gk" aria-label="お店"><option value="amazon">Amazon</option><option value="rakuten">楽天市場</option></select><select id="gm" aria-label="期間"><option value="1">過去1か月</option><option value="3" selected>過去3か月</option><option value="12">過去1年</option></select></div>
  <button class="b p" id="gb" style="margin-top:8px">読み取る</button><div class="sub" id="gs" role="status"></div></div>` : ''}
  <div class="card"><h3>注文メールの文章から追加</h3><p class="sub">注文履歴ページや購入メールの本文をそのまま貼り付けます。</p><textarea id="tx" rows="4" aria-label="貼り付ける文章"></textarea><button class="b" id="tb" style="margin-top:8px">読み取る</button></div>`;
  const mdl = $('#mdl');
  if (!ocrReady()) {
    mdl.innerHTML = '初回だけ、読み取り用のデータ(約34MB)をダウンロードします。Wi-Fiでの利用をおすすめします。<br><button type="button" class="b" id="mdlb">いま準備する</button>';
    $('#mdlb').onclick = async () => {
      const b = $('#mdlb'); b.disabled = true; b.textContent = '準備中…';
      const ok = await warmupOcr((p) => { b.textContent = `準備中 ${Math.round(p * 100)}%`; });
      if (ok) { setOcrReady(); mdl.textContent = '準備できました。次から早く読み取れます。'; }
      else mdl.textContent = '準備できませんでした。そのまま撮影しても、別の方式で読み取れます。';
    };
  }
  $('#bc').onclick = barcodeAdd;
  const pick = (e) => { const fs = [...e.target.files]; e.target.value = ''; return startPhotos(fs, $('#rcs')); };
  $('#rc').onchange = pick; $('#rcc').onchange = pick;
  $('#tb').onclick = () => { const t = $('#tx').value; import('./parse.js').then((m) => { const r = [...m.parseOrderMail(t, { source: 'paste', key: 'p' + Date.now() })]; if (r.length) startReview(r, t); else { resetReview(); addReceipt(parseReceipt(t).map((x) => ({ ...x, source: 'paste' })), parseReceiptMeta(t)); openReview(t); } }); };
  if (reading && readBox?.id === 'rcs') $('#rcs').replaceWith(readBox);
  $('#gb')?.addEventListener('click', async () => {
    const s = $('#gs');
    try { startReview(await fetchOrders($('#gk').value, $('#gm').value, (a, b) => (s.textContent = `読み取り中 ${a}/${b}`))); }
    catch (err) { s.textContent = err.message; }
  });
}

// ---------- 取り込み確認 ----------
let reviewGen = 0, reading = false, readCancel = null, readBox = null; // reviewGen: 確認が閉じられた/やり直された後の遅れた結果を捨てるための世代
let ph = { open: null, sel: 0, zoom: 220 }; // 写真パネル(open: null=自動 / zoom: 写真の表示幅 %)
const READ_LIMIT = 60e3, READ_LIMIT_FIRST = 300e3, SLOW_MS = 10e3; // 初回は読み取り用データ(約34MB)のダウンロード分だけ長く待つ
const ocrReady = () => { try { return localStorage.getItem('hs-ocr-ready') === '1'; } catch { return false; } };
const setOcrReady = () => { try { localStorage.setItem('hs-ocr-ready', '1'); } catch { /* 保存できなくても動く */ } };
const FAIL_NOTE = 'うまく読み取れませんでした。写真を見ながら入力できます';
// 写真は端末内のメモリ(ObjectURL)だけで持つ。保存も送信もしない。確認を閉じる/やり直すときに必ず手放す
const resetReview = () => { receipts.forEach((r) => r.photo && URL.revokeObjectURL(r.photo)); draft = []; receipts = []; ph = { open: null, sel: 0, zoom: 220 }; reviewGen++; };

// 「崩れた名前 → 直した名前」の学習(端末内の localStorage だけ。新しい順に最大 FMAX 件)
const FKEY = 'hs-fixmap', FMAX = 300;
const fixKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const fixLoad = () => { try { const a = JSON.parse(localStorage.getItem(FKEY)); return Array.isArray(a) ? a.filter((p) => Array.isArray(p) && p.length === 2 && p[0] && p[1]) : []; } catch { return []; } };
const fixSave = (a) => { try { a.length ? localStorage.setItem(FKEY, JSON.stringify(a.slice(-FMAX))) : localStorage.removeItem(FKEY); } catch {} };
const fixGet = (name) => { const k = fixKey(name); return k ? fixLoad().find((p) => p[0] === k)?.[1] : undefined; };
const fixLearn = (pairs) => { if (!pairs.length) return; const ks = new Set(pairs.map((p) => p[0])); fixSave([...fixLoad().filter((p) => !ks.has(p[0])), ...pairs]); };

// 品名が文字化けらしいか(理由を返す。空なら問題なし)。OCRの崩れ方(記号の混入・1文字・半角カナ・細切れ)を簡易に見る
function suspectName(name) {
  const s = String(name ?? '').trim(); if (!s) return '';
  if ([...s].length <= 1) return '1文字だけです';
  if (!/\p{L}/u.test(s)) return '数字や記号だけです';
  if (/[ｦ-ﾟ]/.test(s)) return '半角カナが混ざっています';
  if (/[|\\_=~^<>{}[\]@#$*;`¦¬°§¿。]/.test(s)) return '変な記号が混ざっています';
  if (/[ぁ-ゖァ-ヺ][0-9０-９][ぁ-ゖァ-ヺ]/.test(s)) return '文字の間に数字が入っています';
  if ((s.match(/[A-Za-z0-9]{4,}/g) || []).some((w) => /\d/.test(w) && /[A-Za-z]/.test(w) && !/^\d+[A-Za-z]{1,2}$/.test(w))) return '英数字が入り交じっています';
  const t = s.split(/\s+/);
  if (t.length >= 2 && t.some((x) => [...x].length === 1 && !/[一-龠々]/.test(x))) return '1文字だけの部分があります';
  if (t.length >= 4 && s.replace(/\s/g, '').length / t.length < 3) return '文字が細かく分かれています';
  return '';
}
// 金額が極端か(0円・レシート合計より高い・桁が多すぎる)
function suspectPrice(c, r) {
  if (c.rid === undefined) return '';
  if (!c.price) return c.discount ? '' : '0円になっています';
  if (r?.total && c.price > r.total) return 'レシートの合計より高くなっています';
  if (c.price >= 50000) return '桁が多すぎるかもしれません';
  return '';
}

// 写真1枚ぶんの確認枠と、読めなかったとき手入力を始めるための空の行
const blankRow = (rid) => ({ name: '', qty: 1, price: 0, boughtAt: receipts[rid]?.date || '', source: rid === undefined ? 'manual' : 'receipt', category: '', on: true, rid, checked: true, pchecked: true });

// 写真(複数可)を1枚ずつ読む。失敗・時間切れ・0件・「やめる」のどれでも、その写真は手入力用の枠として残す
async function readPhotos(files, box) {
  reading = true; readBox = box;
  const gen = reviewGen; // 読み取り中に確認が閉じられたら、以降は何も足さない
  let cancelled = false, cur = 0, pct = 0, t0 = Date.now(), wake, ac = null;
  const cancelP = new Promise((r) => (wake = r));
  readCancel = () => { cancelled = true; ac?.abort(); wake(null); }; // 「やめる」で裏のOCRも止める
  box.innerHTML = '<div class="rdg"><div><span class="rd-m"></span> <span class="rd-t" aria-hidden="true"></span></div><div class="rd-w sub" role="status"></div><button type="button" class="b d" data-cancel>やめる(写真を見ながら入力)</button></div>';
  const m = box.querySelector('.rd-m'), tt = box.querySelector('.rd-t'), w = box.querySelector('.rd-w');
  const put = (e, s) => { if (e.textContent !== s) e.textContent = s; };
  const paint = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    put(m, `${files.length > 1 ? `${cur + 1}/${files.length}枚目 ` : ''}読み取り中…`); put(tt, `${pct}% ・ ${s}秒`);
    put(w, Date.now() - t0 >= SLOW_MS ? 'しばらくかかります。待たずに「やめる」を押して、写真を見ながら入力することもできます' : pct === 0 && !ocrReady() ? '(初回は読み取り用のデータ約34MBをダウンロードします。Wi-Fiでの利用をおすすめします)' : '');
  };
  box.querySelector('[data-cancel]').onclick = () => readCancel?.();
  const timer = setInterval(paint, 500);
  try {
    for (const [i, f] of files.entries()) {
      if (gen !== reviewGen) break;
      const rid = addReceipt([], null, URL.createObjectURL(f));
      let text = '';
      if (!cancelled) {
        cur = i; pct = 0; t0 = Date.now(); paint();
        let to;
        try {
          ac = new AbortController();
          const op = ocr(f, (p) => { if (cur === i) pct = Math.round(p * 100); }, { signal: ac.signal });
          op.then(setOcrReady, () => {});
          text = (await Promise.race([op, cancelP, new Promise((_, rj) => (to = setTimeout(() => rj(new Error('timeout')), ocrReady() ? READ_LIMIT : READ_LIMIT_FIRST)))])) || '';
        } catch { text = ''; } finally { clearTimeout(to); }
      }
      if (gen !== reviewGen) break;
      let cands = [], meta = null;
      try { if (text) { cands = parseReceipt(text); meta = parseReceiptMeta(text); } } catch { cands = []; }
      const r = receipts[rid];
      if (meta) Object.assign(r, { store: meta.store || '', date: meta.date || '', total: meta.total || 0, tax: meta.tax || 0, adjust: meta.adjust || 0 });
      if (cands.length) fillRows(rid, cands);
      else { r.note = FAIL_NOTE; draft.push(blankRow(rid)); }
    }
  } finally { clearInterval(timer); box.innerHTML = ''; reading = false; readCancel = null; readBox = null; }
}

// 写真を読んで確認画面を出す。inDlg=確認画面の「写真を追加」から(いまの内容に足す)
async function startPhotos(files, box, inDlg) {
  if (!files.length) return;
  if (reading) return toast('いま読み取り中です。終わるまでお待ちください');
  if (!inDlg) resetReview();
  const gen = reviewGen;
  try {
    await readPhotos(files, box);
    if (gen !== reviewGen) return; // 読み取り中に確認が閉じられた
    for (const c of draft) autoDraft(c);
    reviewDialog(); autoExpDraft();
  } catch (err) { box.textContent = `うまくいきませんでした: ${err.message}`; }
}

// レシート1枚ぶんの枠(店名・日付・合計・写真)を足し、品目があれば draft に入れる。戻り値は rid
function addReceipt(cands, meta, photo) {
  const rid = receipts.length;
  receipts.push({ store: meta?.store || '', date: meta?.date || '', total: meta?.total || 0, tax: meta?.tax || 0, adjust: meta?.adjust || 0, photo: photo || '' });
  fillRows(rid, cands);
  return rid;
}
// 読み取った品目を draft に足す。前に直した名前(hs-fixmap)と一致する崩れは、直した名前を入れる
function fillRows(rid, cands) {
  draft.push(...cands.map((c) => { const fx = fixGet(c.name); return { ...c, rid, on: true, ocrName: c.name, ...(fx ? { name: fx, fix: true } : {}) }; }));
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
  const r = autoClassify({ name: c.name || '', category: '', location: '' }, items, { locs: locationOptions(items) });
  const cat = r.category || canonCategory(c.category || '', guessClass(c.name || '').category); // 解析が付けた古い大分類(洗剤・衛生など)は新体系の名前にそろえる
  if (cat) { c.category = cat; c.auto = true; }
  if (r.category && r.sub) c.sub = r.sub; else delete c.sub;
};

// draft が出来上がっていれば確認画面を開く(レシートは startPhotos/addReceipt で作成済み)
function openReview(raw) {
  for (const c of draft) autoDraft(c);
  if (!draft.length) { toast('品目を見つけられませんでした'); if (raw) editDialog(null, raw); return; }
  reviewDialog(); autoExpDraft();
}

const yen = (n) => '¥' + Math.abs(n).toLocaleString('ja-JP');
// レシートごとの検算(品目の合計 と レシートの合計)。差額を大きく出し、読み落としなら「その他」で埋めるボタンを付ける
function checkHtml(r, n) {
  const c = checkTotal(draft.filter((x) => x.rid === n), r);
  if (c.ok === null) return `<div class="ck">品目の合計は ${yen(c.sum)} です。写真の「合計」の金額を上の欄に入れると、読み違いがないか検算します。</div>`;
  if (c.ok) return `<div class="ck ok">✓ 合計と一致しました(${yen(c.sum)})</div>`;
  const more = c.diff > 0;
  return `<div class="ck ng"><div class="gap">⚠ 差額 ${more ? '+' : '−'}${yen(c.diff)}</div><div>品目の合計 ${yen(c.sum)} ・ レシートの合計 ${yen(c.total)}</div>
    <div>${more ? '品目の金額が多すぎます。金額の読み違いや、同じ品が二重になっていないか、写真で確かめてください。' : '読み落とした品目か、金額の読み違いがあるかもしれません。'}</div>
    ${more ? '' : `<button type="button" class="b" data-gap="${n}">差額 ${yen(c.diff)} を「その他」として追加</button>`}</div>`;
}

// 写真の全画面表示。1本指でなぞる・2本指で拡大・ダブルタップ・ボタンで拡大縮小
function openViewer(url, label = 'レシートの写真') {
  let v = $('#pv');
  if (!v) { v = document.createElement('dialog'); v.id = 'pv'; document.body.append(v); }
  v.setAttribute('aria-label', label);
  v.innerHTML = '<div class="pvs"><img alt="${esc(label)}" draggable="false"></div><div class="pvh">指でなぞると動かせます。2本の指で拡大できます</div><div class="pvb"><button type="button" class="b" data-z="1">＋ 大きく</button><button type="button" class="b" data-z="-1">－ 小さく</button><button type="button" class="b" data-z="0">全体を見る</button><button type="button" class="b p" data-x autofocus>閉じる</button></div>';
  const st = v.querySelector('.pvs'), im = st.firstChild, P = new Map();
  let s = 1, x = 0, y = 0, tap = 0, moved = 0;
  const W = () => st.clientWidth, H = () => st.clientHeight, IH = () => (im.naturalWidth ? im.naturalHeight / im.naturalWidth : 1) * W();
  const minS = () => Math.min(1, H() / IH());
  const apply = () => {
    const w = W() * s, h = IH() * s;
    x = w > W() ? Math.min(0, Math.max(W() - w, x)) : (W() - w) / 2; y = h > H() ? Math.min(0, Math.max(H() - h, y)) : (H() - h) / 2;
    im.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  };
  const zoomAt = (ns, cx, cy) => { ns = Math.min(8, Math.max(minS(), ns)); x = cx - (cx - x) * ns / s; y = cy - (cy - y) * ns / s; s = ns; apply(); };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  st.onpointerdown = (e) => { try { st.setPointerCapture(e.pointerId); } catch {} P.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; };
  st.onpointermove = (e) => {
    const p = P.get(e.pointerId); if (!p) return;
    const prev = [...P.values()]; P.set(e.pointerId, [e.clientX, e.clientY]); const cur = [...P.values()];
    moved += Math.abs(e.clientX - p[0]) + Math.abs(e.clientY - p[1]);
    if (cur.length === 1) { x += e.clientX - p[0]; y += e.clientY - p[1]; apply(); }
    else if (cur.length === 2) {
      const mp = [(prev[0][0] + prev[1][0]) / 2, (prev[0][1] + prev[1][1]) / 2], mc = [(cur[0][0] + cur[1][0]) / 2, (cur[0][1] + cur[1][1]) / 2];
      zoomAt(s * dist(cur[0], cur[1]) / (dist(prev[0], prev[1]) || 1), mp[0], mp[1]); x += mc[0] - mp[0]; y += mc[1] - mp[1]; apply();
    }
  };
  const up = (e) => {
    if (!P.delete(e.pointerId) || P.size || moved > 10) return;
    const n = Date.now(); if (n - tap < 350) { s > 1.01 ? ((s = 1), (x = y = 0), apply()) : zoomAt(2.5, e.clientX, e.clientY); tap = 0; } else tap = n;
  };
  st.onpointerup = up; st.onpointercancel = (e) => P.delete(e.pointerId);
  st.onwheel = (e) => { e.preventDefault(); zoomAt(s * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX, e.clientY); };
  v.querySelectorAll('[data-z]').forEach((b) => (b.onclick = () => { const z = +b.dataset.z; z ? zoomAt(s * (z > 0 ? 1.5 : 1 / 1.5), W() / 2, H() / 2) : zoomAt(minS(), W() / 2, H() / 2); }));
  v.querySelector('[data-x]').onclick = () => v.close();
  im.onload = apply; im.src = url; apply();
  v.showModal();
}

// 取り込み確認の1行の、場所・分類(手で選んだ値 c.uc/c.us/c.ul > 追加先 > 自動)。出どころ src: hand|ctx|auto
const rvOpen = new WeakSet(); // 「置き場所・小分類」を開いている行(再描画しても開いたまま)
const withCur = (list, v) => (!v || list.includes(v) ? list : [...list, v]);
const selOpts = (arr, v) => `<option value="">未設定</option>${arr.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
function rowEff(c) {
  const x = addCtx;
  let cat, catSrc, sub = '', subSrc = '';
  if (c.uc) { cat = c.category || ''; catSrc = 'hand'; }
  else if (x.category) { cat = x.category; catSrc = 'ctx'; }
  else { cat = c.category || ''; catSrc = cat ? (c.auto === false ? 'hand' : 'auto') : ''; }
  if (c.us) { sub = c.sub || ''; subSrc = 'hand'; }
  else if (!c.uc && x.category && x.sub) { sub = x.sub; subSrc = 'ctx'; }
  else if (!c.uc && !x.category && c.sub) { sub = c.sub; subSrc = 'auto'; }
  const loc0 = c.ul ? '' : x.location || '';
  const r = autoClassify({ name: c.name || '', category: cat, sub, location: loc0 }, items, { locs: locationOptions(items) });
  if (!cat && r.category) { cat = r.category; catSrc = 'auto'; }
  if (!sub && !c.us && cat && r.sub) { sub = r.sub; subSrc = 'auto'; }
  const location = c.ul ? c.location || '' : loc0 || r.location, locSrc = c.ul ? 'hand' : loc0 ? 'ctx' : location ? 'auto' : '';
  return { category: cat, sub, location, catSrc, subSrc, locSrc, auto: !!((catSrc === 'auto' && cat) || (locSrc === 'auto' && location)) };
}
const rcText = (e) => `<span>場所・小分類:</span> <b>${e.location ? `${locInfo(e.location).icon} ${esc(e.location)}` : '置き場所なし'}</b>${e.locSrc === 'ctx' ? '(追加先)' : e.locSrc === 'auto' ? '(自動)' : ''} ・ <b>${e.sub ? esc(e.sub) : '小分類なし'}</b>`;

// 取り込み確認の行の期限(c.expiry/expiryKind/expirySrc/expiryFrom。c.ue=手で触った)。折りたたみの中に置く
const expSum = (c) => ` ・ <b>${c.expiry ? `期限 ${c.expirySrc === '予測' ? '予測 ' : ''}${dateJa(c.expiry)}` : '期限なし'}</b>`;
function paintExp(n) {
  const d = $('#dlg'), c = draft[n], card = d.dataset.kind === 'review' && c ? d.querySelector(`[data-row="${n}"]`) : null; if (!card) return;
  card.querySelector('[data-rcs]').innerHTML = rcText(rowEff(c)) + expSum(c);
  const i = card.querySelector('[data-ex]'); if (i.value !== (c.expiry || '')) i.value = c.expiry || '';
  card.querySelector('[data-es]').innerHTML = c.expirySrc === '予測' ? `<span class="auto">予測</span> ${esc(c.expNote || '')}。目安です。パッケージの表示があれば直してください。<button type="button" class="b" data-xoff="${n}">予測を外す</button>` : '';
}
// 期限が空の行に、自動予測(確信度0.85以上)を入れる。手で触った行・在庫に期限がある品は触らない。読み込めなくても取り込みは進む
async function autoExpDraft(only) {
  if (!autoExp()) return; const gen = reviewGen;
  try { await loadSL(); } catch { return; }
  if (gen !== reviewGen) return;
  for (const n of only === undefined ? draft.keys() : [only]) {
    const c = draft[n]; if (!c || c.ue || c.gap || !String(c.name || '').trim() || (c.expirySrc && c.expirySrc !== '予測')) continue;
    const ex = items.find((i) => norm(i.name) === norm(c.name));
    const e = rowEff(c), base = /^\d{4}-\d{2}-\d{2}$/.test(c.boughtAt || '') ? c.boughtAt : todayStr();
    let r = null; if (!(ex && ex.expiry && ex.qty > 0)) { try { r = SL.predictExpiry({ name: c.name, category: e.category, sub: e.sub, location: e.location, boughtAt: base, today: todayStr() }); } catch {} }
    if (r) Object.assign(c, { expiry: r.date, expiryKind: r.kind, expirySrc: '予測', expiryFrom: base, expNote: `${r.basis}・買ってから約${r.days}日` });
    else for (const k of ['expiry', 'expiryKind', 'expirySrc', 'expiryFrom', 'expNote']) delete c[k];
    paintExp(n);
  }
}

function reviewDialog() {
  const d = $('#dlg'), st = d.scrollTop, pvOld = d.querySelector('.phv'), pvPos = pvOld ? [pvOld.scrollLeft, pvOld.scrollTop] : null;
  delete d.dataset.cf;
  const known = new Set(items.map((i) => norm(i.name)));
  const names = [...new Set(items.map((i) => i.name))].slice(0, 500);
  const hasPh = receipts.some((r) => r.photo), multi = receipts.length > 1;
  if (!receipts[ph.sel]?.photo) ph.sel = Math.max(0, receipts.findIndex((r) => r.photo));
  // 強調: 品名(未確認の文字化けらしさ)と金額(極端)。登録しない行・空の行は見ない
  const flagsOf = (c) => {
    if (!c.on || !c.name.trim() || c.ocrName === undefined) return null; // 取り込みで読んだ行だけ見る(手入力・メールは対象外)
    const nm = !c.checked && !c.fix && !known.has(norm(c.name)) ? suspectName(c.name) : '', pr = !c.pchecked ? suspectPrice(c, receipts[c.rid]) : '';
    return nm || pr ? { nm, pr } : null;
  };
  if (ph.open === null) ph.open = hasPh && (receipts.some((r) => r.note) ? innerHeight >= 500 : innerHeight >= 700 && draft.some((c) => flagsOf(c))); // 低い画面では写真を最初はしまっておく(編集欄が狭くなるため)
  const row = (c, n) => {
    const e = rowEff(c), lo = locationOptions(items);
    return `<div class="card rv" data-row="${n}"><div class="fl" data-fl="${n}"></div><div class="row"><input type="checkbox" data-on="${n}" ${c.on ? 'checked' : ''} aria-label="登録する"><input class="grow" data-nm="${n}" list="rv-names" autocomplete="off" autocorrect="off" enterkeyhint="next" value="${esc(c.name)}" aria-label="品名"><button class="b d" data-rm="${n}" aria-label="この行を削除">✕</button></div>
    <div class="rv2"><div><label>カテゴリ</label><select data-ct="${n}">${selOpts(withCur(categoryOptions(items), e.category), e.category)}</select></div>
    <div><label>数量</label><input data-q="${n}" type="number" inputmode="numeric" min="1" value="${c.qty}"></div><div><label>金額(円)</label><input data-pr="${n}" type="number" inputmode="numeric" enterkeyhint="next" min="0" value="${c.price || ''}"></div></div>
    <details class="rvc" data-rc="${n}" ${rvOpen.has(c) ? 'open' : ''}><summary data-rcs="${n}">${rcText(e)}${expSum(c)}</summary><div class="grid2"><div><label>小分類</label><select data-sb="${n}">${selOpts(withCur(subOptions(e.category, items), e.sub), e.sub)}</select></div><div><label>置き場所</label><select data-lc="${n}">${selOpts(withCur(lo, e.location), e.location)}</select></div><div><label>期限</label><input type="date" data-ex="${n}" value="${esc(c.expiry || '')}"></div></div><div class="sub exs" data-es="${n}"></div></details>
    <div class="sub">${c.fix ? `<span class="fixd" data-fx="${n}">前回の修正を適用</span> ・ ` : ''}<span data-bg="${n}">${e.catSrc === 'auto' && e.category ? '<span class="auto" title="自動で分類しました。違えば選び直せます">自動</span> ' : e.catSrc === 'ctx' ? '<span class="auto">追加先</span> ' : ''}</span>${c.dup ? '取り込み済み ・ ' : ''}${SRC[c.source] || ''} ${esc(c.boughtAt || '')}${c.discount ? ` ・ 値引 −¥${c.discount} 反映済み` : ''}${c.gap ? ' ・ 検算用(在庫には登録しません)' : ''}</div></div>`;
  };
  const smTxt = (r) => `店名・日付: ${r.store || '(なし)'} ・ ${r.date ? dateJa(r.date) : '(日付なし)'}(タップで直す)`;
  const add = (rid) => `<button type="button" class="b" data-add="${rid ?? ''}" style="width:100%">＋ 品目を追加${multi ? `(${rid + 1}枚目)` : ''}</button>`;
  const head = (r, n) => `<div class="card rc"><div class="rh">${r.photo ? `<button type="button" class="th" data-pv="${n}" aria-label="${multi ? `${n + 1}枚目の` : ''}レシートの写真を全画面で見る"><img src="${r.photo}" alt=""></button>` : ''}<div class="grow"><div class="rt">レシート${multi ? ` ${n + 1}枚目` : ''}</div>${r.note ? `<div class="note"><span aria-hidden="true">⚠ </span>${esc(r.note)}</div>` : ''}${r.photo ? '<div class="sub">写真をタップすると大きく見られます</div>' : ''}</div></div>
    <details class="more"><summary data-sm="${n}">${esc(smTxt(r))}</summary><div class="grid2"><div><label>店名</label><input data-rs="${n}" value="${esc(r.store)}"></div><div><label>日付</label><input type="date" data-rd="${n}" value="${esc(r.date)}"></div></div></details>
    <label>レシートの合計(円)</label><input type="number" inputmode="numeric" min="0" data-rt="${n}" value="${r.total || ''}" placeholder="写真の「合計」の金額">
    <div data-ck="${n}" role="status">${checkHtml(r, n)}</div></div>
    ${draft.map((c, i) => (c.rid === n ? row(c, i) : '')).join('')}${add(n)}`;
  const phSel = receipts.map((r, n) => (r.photo && multi ? `<button type="button" class="b" data-phs="${n}" aria-pressed="${n === ph.sel}">${n + 1}枚目</button>` : '')).join('');
  const manual = receipts.length && receipts.every((r) => r.note);
  const keepBox = reading && readBox?.id === 'mst' && readBox;
  d.innerHTML = `<div class="phbar" id="phbar"><div class="row">${hasPh ? `<button type="button" class="b grow" id="phtg" aria-expanded="${ph.open}" aria-controls="phpn">📷 写真を${ph.open ? 'しまう' : '見ながら直す'}</button>` : ''}<button type="button" class="b grow" id="jump" hidden></button></div>
  ${hasPh ? `<div id="phpn" ${ph.open ? '' : 'hidden'}><div class="phw"><div class="phc">${phSel}<button type="button" class="b" data-zm="-1" aria-label="写真を小さくする">－</button><button type="button" class="b" data-zm="1" aria-label="写真を大きくする">＋</button><button type="button" class="b" id="phfs">全画面</button></div>
  <div class="phv" tabindex="0" role="region" aria-label="レシートの写真(指でなぞると動かせます)"><img id="phimg" src="${receipts[ph.sel].photo}" alt="レシートの写真" style="width:${ph.zoom}%"></div></div></div>` : ''}</div>
  <h3 id="dlg-h" tabindex="-1" autofocus>${manual ? '写真を見ながら入力してください' : 'この内容で登録しますか?'}</h3>${acb()}${ctxEmpty() ? '' : '<button type="button" class="b wide" id="acall">手で変えた行も、追加先にそろえる</button>'}<p class="sub">${manual ? '名前と金額を入れてください。次の欄へは「次へ」キーで進めます。' : '黄色の行は読み間違いかもしれません。写真を見て、名前・数量・金額を直せます。'}同じ名前が在庫にあれば数量を足します。</p>
  <datalist id="rv-names">${names.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
  ${receipts.map(head).join('')}${draft.some((c) => c.rid === undefined) ? draft.map((c, i) => (c.rid === undefined ? row(c, i) : '')).join('') + add(undefined) : ''}
  ${receipts.length ? `<div class="row" style="margin-top:8px"><label class="b grow filebtn">写真を撮って追加<input type="file" id="more-cam" accept="image/*" capture="environment" class="vh"></label><label class="b grow filebtn">アルバムから追加<input type="file" id="more" accept="image/*" multiple class="vh"></label></div>` : ''}
  <div id="mst"></div>
  <div class="stickybar"><div class="cf" id="cf" role="alert" hidden></div><button class="b" id="cx">やめる</button><button class="b p grow" id="ok">登録</button></div>`;
  if (keepBox) $('#mst').replaceWith(keepBox); // 読み取り中の表示(やめるボタン)を作り直しで消さない
  const nOn = () => draft.filter((x) => x.on && x.name.trim()).length;
  const cnt = () => { const n = nOn(); $('#ok').textContent = `${d.dataset.cf ? 'このまま' : ''}${n}件を登録`; $('#ok').disabled = !n; };
  const flagged = () => draft.map((c, i) => (flagsOf(c) ? i : -1)).filter((i) => i >= 0);
  const jump = () => {
    const fl = flagged(); if (!fl.length) return;
    const n = fl.find((i) => i > jumpAt) ?? fl[0]; jumpAt = n;
    const e = d.querySelector(`[data-nm="${n}"]`); e.closest('.rv').scrollIntoView({ block: 'start' }); e.focus({ preventScroll: true });
    if (flagsOf(draft[n]).nm) e.select();
  };
  let jumpAt = -1;
  const refreshFlags = () => {
    let nn = 0, np = 0;
    draft.forEach((c, i) => {
      const card = d.querySelector(`[data-row="${i}"]`); if (!card) return;
      const f = flagsOf(c), fl = card.querySelector('.fl');
      card.classList.toggle('hl', !!f); card.querySelector('[data-nm]').classList.toggle('bad', !!f?.nm); card.querySelector('[data-pr]').classList.toggle('bad', !!f?.pr);
      const html = f ? `${f.nm ? `<div><span aria-hidden="true">⚠ </span>写真を見て品名を直してください(${f.nm})</div>` : ''}${f.pr ? `<div><span aria-hidden="true">⚠ </span>金額を確かめてください(${f.pr})</div>` : ''}<button type="button" class="b" data-okrow="${i}">このままで合っている</button>` : '';
      if (fl.innerHTML !== html) { fl.innerHTML = html; fl.querySelector('[data-okrow]')?.addEventListener('click', () => { c.checked = c.pchecked = true; refreshFlags(); cnt(); }); }
      if (f?.nm) nn++; else if (f?.pr) np++;
    });
    const j = $('#jump'), n = nn + np;
    j.hidden = !n; j.textContent = `⚠ 要確認 ${n}件`; j.setAttribute('aria-label', `要確認の行へ移動(あと${n}件)`);
    const cf = $('#cf');
    if (!n) { delete d.dataset.cf; cf.hidden = true; }
    else if (d.dataset.cf) { cf.hidden = false; cf.innerHTML = `<span><span aria-hidden="true">⚠ </span>${nn ? `${nn + np}件の品名・金額が未確認です` : `${np}件の金額が未確認です`}。写真と見くらべましたか?</span><button type="button" class="b" id="cf-j">確認する</button>`; $('#cf-j').onclick = jump; }
    $('#phbar').hidden = !hasPh && !n;
  };
  const refresh = (first) => { receipts.forEach((r, n) => {
    const e = d.querySelector(`[data-ck="${n}"]`), h = checkHtml(r, n); d.querySelector(`[data-rt="${n}"]`).classList.toggle('bad', !r.total);
    if (e && (first || e.innerHTML !== h)) { e.innerHTML = h; e.querySelector('[data-gap]')?.addEventListener('click', () => addGap(n)); }
  }); refreshFlags(); };
  const addGap = (n) => {
    const r = receipts[n], c = checkTotal(draft.filter((x) => x.rid === n), r); if (c.ok !== false || c.diff >= 0) return;
    draft.push({ ...blankRow(n), name: 'その他', price: -c.diff, category: 'その他', auto: false, gap: true, on: false });
    reviewDialog(); toast('差額を「その他」として足しました(在庫には登録しません)');
  };
  const addRow = (rid) => { draft.push(blankRow(rid)); reviewDialog(); d.querySelector(`[data-nm="${draft.length - 1}"]`)?.focus(); };
  d.querySelectorAll('[data-on]').forEach((e) => (e.onchange = () => { draft[e.dataset.on].on = e.checked; cnt(); refreshFlags(); }));
  d.querySelectorAll('[data-nm]').forEach((e) => {
    const n = +e.dataset.nm;
    e.oninput = () => { const c = draft[n]; c.name = e.value; if (c.fix) { c.fix = false; d.querySelector(`[data-fx="${n}"]`)?.remove(); } cnt(); refreshFlags(); };
    e.onchange = () => { draft[n].checked = true; refreshFlags(); syncRow(n); autoExpDraft(n); }; // 手で直したら確認済み(名前が変わると自動の場所も変わる)
    e.onfocus = () => { if (!flagsOf(draft[n])?.nm) return; const v = e.value; e.select(); setTimeout(() => e.value === v && e.select(), 0); }; // 崩れた名前は全選択 → そのまま打てば置き換わる/候補が出る
    e.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const nx = flagged().find((i) => i > n); (nx === undefined ? d.querySelector(`[data-pr="${n}"]`) : d.querySelector(`[data-nm="${nx}"]`)).focus(); } }; // 次へ: 要確認の行が続くならそこへ(金額は合っていることが多い)
  });
  // 行の場所・分類の表示を、いまの値(手で選んだ値 > 追加先 > 自動)に合わせ直す
  const syncRow = (n) => {
    const c = draft[n], card = d.querySelector(`[data-row="${n}"]`); if (!card) return;
    const e = rowEff(c), set = (sel, arr, v) => { sel.innerHTML = selOpts(withCur(arr, v), v); };
    set(card.querySelector('[data-ct]'), categoryOptions(items), e.category); set(card.querySelector('[data-sb]'), subOptions(e.category, items), e.sub); set(card.querySelector('[data-lc]'), locationOptions(items), e.location);
    card.querySelector('[data-rcs]').innerHTML = rcText(e) + expSum(c);
    card.querySelector('[data-bg]').innerHTML = e.catSrc === 'auto' && e.category ? '<span class="auto" title="自動で分類しました。違えば選び直せます">自動</span> ' : e.catSrc === 'ctx' ? '<span class="auto">追加先</span> ' : '';
  };
  d.querySelectorAll('[data-ct]').forEach((e) => (e.onchange = () => { const c = draft[e.dataset.ct]; c.category = e.value; c.uc = true; c.us = false; delete c.sub; c.auto = false; syncRow(+e.dataset.ct); })); // 大分類を変えたら小分類はクリア
  d.querySelectorAll('[data-sb]').forEach((e) => (e.onchange = () => { const c = draft[e.dataset.sb], f = rowEff(c); c.category = f.category; c.uc = true; c.auto = false; c.us = true; if (e.value) c.sub = e.value; else delete c.sub; syncRow(+e.dataset.sb); }));
  d.querySelectorAll('[data-lc]').forEach((e) => (e.onchange = () => { const c = draft[e.dataset.lc]; c.ul = true; c.location = e.value; syncRow(+e.dataset.lc); }));
  d.querySelectorAll('[data-ex]').forEach((e) => (e.oninput = () => { const c = draft[e.dataset.ex]; c.ue = true; c.expiry = e.value; if (e.value) { c.expirySrc = '手入力'; c.expiryFrom = /^\d{4}-\d{2}-\d{2}$/.test(c.boughtAt || '') ? c.boughtAt : todayStr(); } else for (const k of ['expiryKind', 'expirySrc', 'expiryFrom', 'expNote']) delete c[k]; paintExp(+e.dataset.ex); }));
  d.querySelectorAll('[data-es]').forEach((e) => (e.onclick = (ev) => { const b = ev.target.closest('[data-xoff]'); if (!b) return; const n = +b.dataset.xoff, c = draft[n]; c.ue = true; for (const k of ['expiry', 'expiryKind', 'expirySrc', 'expiryFrom', 'expNote']) delete c[k]; paintExp(n); d.querySelector(`[data-ex="${n}"]`)?.focus(); }));
  d.querySelectorAll('[data-rc]').forEach((e) => (e.ontoggle = () => { const c = draft[e.dataset.rc]; if (c) e.open ? rvOpen.add(c) : rvOpen.delete(c); }));
  $('#acall')?.addEventListener('click', () => { // 手で変えた行も追加先に合わせる(追加先で選んだ項目だけ)
    for (const c of draft) { if (addCtx.category) { c.uc = c.us = false; } if (addCtx.location) c.ul = false; }
    reviewDialog(); toast('すべての行を追加先にそろえました');
  });
  d.querySelectorAll('[data-q]').forEach((e) => (e.oninput = () => (draft[e.dataset.q].qty = Math.max(1, +e.value || 1))));
  d.querySelectorAll('[data-pr]').forEach((e) => {
    const n = +e.dataset.pr;
    e.oninput = () => { draft[n].price = Math.max(0, +e.value || 0); refresh(); };
    e.onchange = () => { draft[n].pchecked = true; refreshFlags(); };
    e.onkeydown = (ev) => {
      if (ev.key !== 'Enter') return; ev.preventDefault();
      const all = [...d.querySelectorAll('[data-nm]')], nx = all[all.findIndex((x) => +x.dataset.nm === n) + 1];
      nx ? nx.focus() : addRow(draft[n].rid);
    };
  });
  d.querySelectorAll('[data-rm]').forEach((e) => (e.onclick = () => { draft.splice(+e.dataset.rm, 1); reviewDialog(); }));
  d.querySelectorAll('[data-rs]').forEach((e) => (e.oninput = () => { receipts[e.dataset.rs].store = e.value; d.querySelector(`[data-sm="${e.dataset.rs}"]`).textContent = smTxt(receipts[e.dataset.rs]); }));
  d.querySelectorAll('[data-rd]').forEach((e) => (e.onchange = () => { receipts[e.dataset.rd].date = e.value; d.querySelector(`[data-sm="${e.dataset.rd}"]`).textContent = smTxt(receipts[e.dataset.rd]); draft.forEach((c) => c.rid === +e.dataset.rd && (c.boughtAt = e.value)); }));
  d.querySelectorAll('[data-rt]').forEach((e) => (e.oninput = () => { receipts[e.dataset.rt].total = Math.max(0, +e.value || 0); refresh(); }));
  d.querySelectorAll('[data-add]').forEach((e) => (e.onclick = () => addRow(e.dataset.add === '' ? undefined : +e.dataset.add)));
  d.querySelectorAll('[data-pv]').forEach((e) => (e.onclick = () => { ph.sel = +e.dataset.pv; openViewer(receipts[ph.sel].photo); }));
  // 写真パネル(上に固定): 開閉・枚数の切り替え・拡大縮小・全画面
  const img = $('#phimg'), pv = d.querySelector('.phv');
  if (img) {
    const toggle = () => { ph.open = !ph.open; $('#phpn').hidden = !ph.open; const b = $('#phtg'); b.setAttribute('aria-expanded', ph.open); b.textContent = `📷 写真を${ph.open ? 'しまう' : '見ながら直す'}`; };
    $('#phtg').onclick = toggle;
    $('#phfs').onclick = () => openViewer(receipts[ph.sel].photo);
    d.querySelectorAll('[data-phs]').forEach((e) => (e.onclick = () => { ph.sel = +e.dataset.phs; img.src = receipts[ph.sel].photo; pv.scrollTo(0, 0); d.querySelectorAll('[data-phs]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.phs === ph.sel)); }));
    d.querySelectorAll('[data-zm]').forEach((e) => (e.onclick = () => { ph.zoom = Math.min(400, Math.max(100, ph.zoom + 60 * +e.dataset.zm)); img.style.width = `${ph.zoom}%`; }));
    if (pvPos) { const put = () => pv.scrollTo(pvPos[0], pvPos[1]); img.complete ? put() : img.addEventListener('load', put, { once: true }); }
  }
  $('#jump').onclick = jump;
  const more = async (e) => { const fs = [...e.target.files]; e.target.value = ''; await startPhotos(fs, $('#mst'), true); };
  $('#more')?.addEventListener('change', more); $('#more-cam')?.addEventListener('change', more);
  $('#cx').onclick = () => d.close();
  $('#ok').onclick = () => {
    if (flagged().length && !d.dataset.cf) { d.dataset.cf = '1'; refreshFlags(); cnt(); $('#cf-j').focus(); return; } // 強調が残っていれば一度だけ確認(止めはしない)
    const byName = new Map(items.map((i) => [norm(i.name), i]));
    let n = 0; const wheres = new Set();
    fixLearn(draft.filter((c) => c.on && c.name.trim() && c.ocrName && fixKey(c.ocrName) && fixKey(c.name) !== fixKey(c.ocrName) && !known.has(norm(c.ocrName))).map((c) => [fixKey(c.ocrName), c.name.trim()])); // 崩れ→直した名前を学習(端末内のみ)
    for (const c of draft.filter((x) => x.on && x.name.trim())) {
      const ex = byName.get(norm(c.name)), e = rowEff(c); // e: 手で選んだ値 > 追加先 > 自動
      const keys = c.srcKey ? [c.srcKey] : [];
      let rec;
      if (ex) { // 同名の品は数量を足すだけ。場所・分類は、空のときだけ補う(上書きしない)
        rec = { ...ex, qty: ex.qty + c.qty, boughtAt: c.boughtAt || ex.boughtAt || '', srcKeys: [...(ex.srcKeys || []), ...keys] };
        let au = false;
        if (!ex.category && e.category) { rec.category = e.category; if (!ex.sub && e.sub) rec.sub = e.sub; au = e.catSrc === 'auto'; }
        if (!ex.location && e.location) { rec.location = e.location; au = au || e.locSrc === 'auto'; }
        if (au) rec.auto = true;
        if (c.expiry && (c.ue || !ex.expiry || ex.qty <= 0)) { if (c.expirySrc === '手入力') xsJudge(ex, c.expiry); putExpiry(rec, { date: c.expiry, kind: c.expiryKind, src: c.expirySrc || '手入力', from: c.expiryFrom || todayStr() }); }
      } else rec = { name: c.name.trim(), qty: c.qty, category: e.category, ...(e.sub ? { sub: e.sub } : {}), location: e.location, minQty: 0, buyQty: 1, price: c.price || 0, boughtAt: c.boughtAt || '', source: c.source, srcKeys: keys, ...(e.auto ? { auto: true } : {}) };
      if (!ex && c.expiry) putExpiry(rec, { date: c.expiry, kind: c.expiryKind, src: c.expirySrc || '手入力', from: c.expiryFrom || todayStr() });
      if (rec.location) wheres.add(rec.location);
      rec = withLog(ex || null, rec); // 数量の履歴を追記
      save(rec).catch(() => {}); byName.set(norm(c.name), rec); n++; // 送信は待たず、失敗は toast で知らせる
    }
    d.close(); toast(`${wheres.size === 1 ? `${[...wheres][0]}に` : ''}${n}件を登録しました`); tab = 'stock'; render();
  };
  draft.forEach((c, n) => c.expirySrc === '予測' && paintExp(n));
  refresh(true); cnt(); ctxHook = () => reviewDialog(); // 追加先が変わったら、画面を作り直す(手で変えていない行が追加先に変わる)
  const sync = () => d.style.setProperty('--phh', `${$('#phbar').offsetHeight}px`);
  openDlg('review');
  d.scrollTop = st; sync();
  if (img) { img.addEventListener('load', sync); }
}

// ---------- バーコード追加 ----------
async function barcodeAdd() {
  const d = $('#dlg'); openDlg('barcode');
  for (;;) {
    ctxHook = null;
    const sp = scan(d); d.querySelector('h3')?.setAttribute('id', 'dlg-h');
    d.querySelector('h3')?.insertAdjacentHTML('afterend', acb()); // 読み取り画面の上に追加先バー(読み取りの部品 barcode.js は変えずに差し込む)
    // 番号入力欄で Enter でも決定できるようにする
    d.querySelector('#bn')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') d.querySelector('#bg')?.click(); });
    const code = await sp; if (!code) return d.close();
    if (!(await barcodeForm(d, code))) return d.close(); // false=終了 / true=続けて読む
  }
}

// 読み取った番号の登録フォーム。登録済みなら数量を足す。戻り値: 続けるか
// 名前の検索・見つからないときの案内・パッケージ文字の読み取り(OCR)は lookup-ui.js。登録すると、品目にこの番号(barcode)が付き、次からは検索せずに出る
function barcodeForm(d, code0) {
  return new Promise(async (resolve) => {
    let bc, ui;
    try { [bc, ui] = await Promise.all([import('./barcode.js'), import('./lookup-ui.js')]); } // barcode.js は読み込み済み
    catch { toast('読み込みに失敗しました。通信を確認して、もう一度お試しください'); return resolve(false); }
    const code = bc.canonCode(code0); // 12桁(UPC-A)・13桁・UPC-E の表記の違いをそろえる
    const ex = items.find((i) => bc.canonCode(i.barcode) === code);
    d.innerHTML = `<form id="b-form" autocomplete="off"><h3 id="dlg-h">${ex ? '登録済みの商品' : '新しい商品'}</h3><div class="sub">バーコード ${esc(code)}</div>${acb()}
    <label for="b-n">名前</label><input id="b-n" value="${esc(ex?.name || '')}" placeholder="${ex ? '' : '商品名を検索中…'}">
    <div class="sub" id="b-note" role="status" aria-live="polite" style="margin-top:4px"></div><div id="b-help" hidden></div>
    <div class="grid2"><div><label for="b-q">${ex ? `追加する数(いま ${ex.qty})` : '数量'}</label><input id="b-q" type="number" inputmode="numeric" enterkeyhint="done" min="1" value="1"></div>
    <div><label for="b-c">カテゴリ</label><select id="b-c"></select></div><div><label for="b-s">小分類</label><select id="b-s"></select></div><div><label for="b-l">置き場所</label><select id="b-l"></select></div></div>
    <div class="exr" id="b-ex"><div class="exl" id="b-et" role="status" aria-live="polite"></div><div class="exa"><label class="b filebtn">📷 写真で読む<input type="file" accept="image/*" capture="environment" class="vh" id="b-ep"></label><button type="button" class="b" id="b-ei">入力</button><button type="button" class="b" id="b-ex-x" hidden>外す</button></div></div>
    <div class="sub" id="b-h" style="margin-top:4px">${ex ? '登録済みの商品なので、置き場所・分類はそのままです(変えるときだけ選びます)。' : ''}</div>
    <div class="btns" style="margin-top:12px"><button type="button" class="b" id="bx">終了</button><button type="submit" class="b p grow" id="bok">${ex ? '数量を追加して次へ' : '登録して次へ'}</button></div></form>`;
    const n = d.querySelector('#b-n'); let typed = false, stopUi = () => {};
    // 登録済みの商品は、いまの場所・分類を表示するだけ(追加先は使わない)。新しい商品は 手で選んだ値 > 追加先 > 自動分類
    const cf = classForm({ fC: d.querySelector('#b-c'), fS: d.querySelector('#b-s'), fL: d.querySelector('#b-l'), getName: () => n.value, id: ex?.id, init: ex ? { category: canonCategory(ex.category, guessClass(ex.name).category), sub: ex.sub, location: canonLocation(ex.location, ex.name), auto: ex.auto } : {}, useCtx: !ex,
      onChange: () => { if (!ex) d.querySelector('#b-h').textContent = cf.hint(); } });
    ctxHook = () => cf.recompute();
    cf.recompute();
    // 期限の行: 触らなくても登録できる。手で決めていなければ 前回 > 予測 の順で自動で入れる(外せる)。登録済みの品は、いまの期限をそのまま(期限が空・在庫0なら新しい期限を提案)
    const B = { date: '', kind: '', src: '', from: '', note: '', user: false };
    const keepEx = () => !!(ex && ex.expiry && ex.qty > 0);
    const paintB = () => {
      const et = d.querySelector('#b-et'); if (!et) return; // 画面が次の読み取りに変わったあとは何もしない
      const est = estSrc(B.src) ? `<span class="auto">${B.src === '前回' ? '前回から' : '予測'}</span> ` : '';
      et.innerHTML = B.date ? `期限: ${est}<b>${dateJa(B.date)}</b>(${relJa(B.date)})${B.kind ? ` ・ ${B.kind}` : ''}${estSrc(B.src) ? '<br><span class="sub">目安です。パッケージの表示があれば、写真か入力で直せます。</span>' : ''}`
        : keepEx() ? `期限: いまのまま <b>${dateJa(ex.expiry)}</b>(${relJa(ex.expiry)})${estSrc(ex.expirySrc) ? ` ${ex.expirySrc === '前回' ? '(前回から)' : '(予測)'}` : ''}` : '期限: 未設定';
      d.querySelector('#b-ex-x').hidden = !B.date;
      d.querySelector('#b-ei').textContent = keepEx() && !B.date ? '新しい期限を入れる' : '入力';
    };
    let tok = 0, expP = Promise.resolve();
    const compute = async () => {
      if (B.user) return; const my = ++tok, name = n.value.trim();
      Object.assign(B, { date: '', kind: '', src: '', from: '', note: '' });
      if (keepEx() || !name || !autoExp()) return paintB();
      const pv = prevInterval(name, code);
      if (pv) Object.assign(B, { date: plusDays(todayStr(), pv.days), kind: pv.kind, src: '前回', from: todayStr(), note: `前回は買ってから${pv.days}日でした` });
      else { const v = cf.values(), r = await predictSafe({ name, category: v.category, sub: v.sub, location: v.location }); if (my !== tok || B.user) return; if (r) Object.assign(B, { date: r.date, kind: r.kind, src: '予測', from: todayStr(), note: r.basis }); }
      paintB();
    };
    let ct; const recompute = () => { clearTimeout(ct); ct = setTimeout(() => (expP = compute()), 250); };
    expP = compute(); paintB();
    const setB = (r) => { Object.assign(B, { date: r.date, kind: KINDS.includes(r.kind) ? r.kind : '', src: r.src, from: todayStr(), note: '', user: true }); paintB(); };
    d.querySelector('#b-ep').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) expirySheet(f, { from: e.target, onPick: (r) => setB({ ...r, src: '写真' }) }); };
    d.querySelector('#b-ex-x').onclick = () => { tok++; Object.assign(B, { date: '', kind: '', src: '', from: '', note: '', user: true }); paintB(); d.querySelector('#b-ei').focus(); };
    d.querySelector('#b-ei').onclick = () => expiryInputSheet(B, { info: () => { const v = cf.values(); return { name: n.value, category: v.category, sub: v.sub, location: v.location }; }, code, from: d.querySelector('#b-ei'), onDone: (S) => { tok++; Object.assign(B, { date: S.date, kind: S.kind, src: S.date ? S.src : '', from: S.date ? S.from : '', note: S.note || '', user: true }); paintB(); } });
    n.oninput = () => { typed = true; if (!ex) cf.recompute(); recompute(); };
    const apply = (name, fromOcr) => { n.value = name; if (fromOcr) typed = true; cf.recompute(); recompute(); }; // 検索結果・OCRの候補を名前欄へ。分類は 手で選んだ値 > 追加先 > 名前からの推定
    if (!ex) stopUi = ui.mountLookup(d, { code, input: n, apply, isTyped: () => typed });
    d.querySelector('#bx').onclick = () => { stopUi(); resolve(false); };
    let sent = false;
    d.querySelector('#b-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const name = n.value.trim(); if (!name) return toast('名前を入れてください');
      if (sent) return; sent = true;
      if (!B.user) await Promise.race([expP, new Promise((r) => setTimeout(r, 500))]); // 自動の期限が計算中なら、少しだけ待つ
      const add = Math.max(1, +d.querySelector('#b-q').value || 1);
      const same = ex || items.find((i) => norm(i.name) === norm(name)), v = cf.values();
      stopUi();
      let rec;
      if (same) { // 登録済み・同名の品は数量を足すだけ。場所・分類は、空のときと手で選び直したときだけ入れる(追加先では上書きしない)
        rec = { ...same, qty: same.qty + add, barcode: code };
        const catNew = v.touched.c || v.touched.s || !same.category, locNew = v.touched.l || !same.location;
        if (catNew) { rec.category = v.category; if (v.sub) rec.sub = v.sub; else delete rec.sub; }
        if (locNew) rec.location = v.location;
        if ((catNew || locNew) && v.auto) rec.auto = true; else if (v.touched.c || v.touched.s || v.touched.l) delete rec.auto;
        if (B.date) { if (B.src === '手入力' || B.src === '写真') xsJudge(same, B.date); putExpiry(rec, B); } // 数量を足すだけなら期限は変えない(新しい期限を入れたときだけ更新)
      } else { rec = { name, qty: add, category: v.category, ...(v.sub ? { sub: v.sub } : {}), location: v.location, minQty: 0, buyQty: 1, barcode: code, source: 'barcode', ...(v.auto ? { auto: true } : {}) }; if (B.date) putExpiry(rec, B); }
      saveQty(same || null, rec).catch(() => {});
      toast(`${name} を${rec.location ? `${rec.location}に` : ''}追加しました${B.date && estSrc(B.src) ? `(期限は${B.src === '前回' ? '前回から' : '予測'} ${dateJa(B.date)})` : ''}`); resolve(true);
    };
  });
}

// ---------- 期限(写真・手入力・予測) ----------
// expirySrc: 手入力・写真(=パッケージの表示。無印の旧データも同じ扱い) > 前回 > 予測。予測と前回は「目安」として画面で区別する
// expiryFrom: 期限の起算日(購入日)。「前回は買ってから◯日」と的中率の計算に使う(boughtAt は「買った」で上書きされるので別に持つ)
const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`; };
const dayNo = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : NaN; };
const plusDays = (s, n) => { const t = new Date((dayNo(s) + n) * 864e5); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
const relJa = (date) => { const d = dayNo(date) - dayNo(todayStr()); return d < 0 ? `${-d}日前` : d === 0 ? '今日' : `${d}日後`; };
const estSrc = (s) => s === '予測' || s === '前回';
const KINDS = ['賞味', '消費'];
// 部品は使うときに読み込む(起動を軽く。失敗しても保存・追加は進む)
let SL = null, slP = null, eoP = null;
const loadSL = () => (slP ||= import('./shelflife.js').then((m) => (SL = m), (e) => { slP = null; throw e; }));
const loadEO = () => (eoP ||= import('./expiry-ocr.js').catch((e) => { eoP = null; throw e; }));
// 予測(確信度 0.85 以上のみ)。読み込めない・時間切れ・予測なしは null
const predictNow = (info) => { try { return SL.predictExpiry({ ...info, today: todayStr() }) || null; } catch { return null; } };
const predictSafe = async (info, ms = 1500) => {
  if (SL) return predictNow(info); // 読み込み済みなら待たない(連続追加を遅くしない)
  try { const m = await Promise.race([loadSL(), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]); return m.predictExpiry({ ...info, today: todayStr() }) || null; } catch { return null; }
};
const autoExp = () => { try { return localStorage.getItem('hs-autoexp') !== '0'; } catch { return true; } };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
// 期限の状態 S({date, kind, src, from})を品目 rec に書く。空なら期限と関連項目を消す(undefined は入れない)
function putExpiry(rec, S) {
  if (S.date) { rec.expiry = S.date; for (const [k, v] of [['expiryKind', S.kind], ['expirySrc', S.src], ['expiryFrom', S.from]]) if (v) rec[k] = v; else delete rec[k]; }
  else { rec.expiry = ''; for (const k of ['expiryKind', 'expirySrc', 'expiryFrom']) delete rec[k]; }
  return rec;
}
const noExp = (i) => putExpiry({ ...i }, {});
// 同じバーコード(なければ同名)の過去の品の「買ってから期限まで」の日数。パッケージの表示(手入力・写真)で入れたものだけ
function prevInterval(name, code) {
  const nn = norm(name); if (!nn && !code) return null;
  let a = code ? items.filter((i) => i.barcode && canonCode(i.barcode) === code) : [];
  if (!a.length) a = items.filter((i) => norm(i.name) === nn);
  const c = a.filter((i) => i.expiry && !estSrc(i.expirySrc)).map((i) => ({ i, days: dayNo(i.expiry) - dayNo(i.expiryFrom || i.boughtAt) })).filter((x) => x.days > 0 && x.days <= 1100).sort((p, q) => (q.i.updatedAt || 0) - (p.i.updatedAt || 0));
  return c.length ? { days: c[0].days, kind: c[0].i.expiryKind || '' } : null;
}
// 予測の的中率の記録(端末ごと: hs-expstats {n, hit, long})。的中の許容は評価と同じ: 実際の期間が10日以内は±2日、30日以内は±20%か4日の大きい方、それ以上は±25%
const XKEY = 'hs-expstats', XMAX = 9999;
const xsLoad = () => { try { const o = JSON.parse(localStorage.getItem(XKEY)); return { n: Math.min(XMAX, Math.max(0, +o.n || 0)), hit: Math.max(0, +o.hit || 0), long: Math.max(0, +o.long || 0) }; } catch { return { n: 0, hit: 0, long: 0 }; } };
const xsSave = (o) => { try { o.n ? localStorage.setItem(XKEY, JSON.stringify(o)) : localStorage.removeItem(XKEY); } catch {} };
const xsAdd = (hit, long) => { const s = xsLoad(); if (s.n >= XMAX) return; xsSave({ n: s.n + 1, hit: s.hit + (hit ? 1 : 0), long: s.long + (long ? 1 : 0) }); };
const withinTol = (pd, ad) => Math.abs(pd - ad) <= (ad <= 10 ? 2 : ad <= 30 ? Math.max(4, ad * 0.2) : ad * 0.25);
// 予測・前回の品 old について、実際の日付 date に直した(date)/「合っていた」を押した(null)結果を記録。予測が実際より長い誤りは「長すぎ」
function xsJudge(old, date) {
  if (!old || !estSrc(old.expirySrc) || !old.expiry) return;
  if (date === null) return xsAdd(true, false);
  const f = dayNo(old.expiryFrom), pd = dayNo(old.expiry) - f, ad = dayNo(date) - f;
  if (!Number.isFinite(pd) || !Number.isFinite(ad)) return;
  const hit = withinTol(pd, ad); xsAdd(hit, !hit && pd > ad);
}
const mkDlg = (id) => { let s = $('#' + id); if (!s) { s = document.createElement('dialog'); s.id = id; s.setAttribute('aria-labelledby', id + '-h'); document.body.append(s); } return s; };
const fullDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : ''; };

// 期限の入力部品(編集ダイアログと、バーコードの「入力」シートで共通)。S {date, kind, src, from, note, confirmed} を書き換える
// o: { p: id の接頭辞, S, info(): {name, category, sub, location}, prev(): 前回の日数, bought(): 購入日, ok: 「合っていた」を出すか, onChange() }
function expiryEditor(host, o) {
  const { S, p } = o; let flash = '';
  host.innerHTML = `<label for="${p}e">賞味・消費期限</label><input id="${p}e" type="date" value="${esc(S.date || '')}">
  <div class="chips ek" role="group" aria-label="期限の種類">${KINDS.map((k) => `<button type="button" class="chip" data-k="${k}" aria-pressed="false">${k}期限</button>`).join('')}</div>
  <div class="exs" data-st role="status" aria-live="polite"></div><div class="exw" data-w role="status"></div><div class="exc" data-c></div>
  <div class="exb"><label class="b filebtn">📷 撮って読む<input type="file" accept="image/*" capture="environment" class="vh" data-ph></label><label class="b filebtn">🖼 アルバムから<input type="file" accept="image/*" class="vh" data-ph></label>
  <button type="button" class="b" data-a="pred">🔮 予測で入れる</button><button type="button" class="b" data-a="prev" hidden></button><button type="button" class="b" data-a="open" hidden>📦 開封した</button><button type="button" class="b" data-a="ok" hidden>👍 合っていた</button></div>`;
  const q = (s) => host.querySelector(s), inp = q(`#${p}e`);
  const openR = () => { if (!SL) return null; const i = o.info(); if (!String(i.name || '').trim()) return null; try { return SL.predictExpiry({ ...i, today: todayStr(), opened: true }); } catch { return null; } };
  const paint = () => {
    if (inp.value !== (S.date || '')) inp.value = S.date || '';
    host.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === S.kind));
    const when = S.date ? `${dateJa(S.date)}(${relJa(S.date)})` : '';
    q('[data-st]').innerHTML = flash || (!S.date ? 'パッケージに期限が書いてあれば、写真か日付で入れます。書いていなければ「予測で入れる」を使えます。'
      : S.src === '予測' ? `<span class="auto">予測</span> <b>${when}</b><br>${esc(S.note || '')}。標準的な期間にもとづく目安で、パッケージの表示と同じとは限りません。表示があれば必ずそちらを使ってください。`
      : S.src === '前回' ? `<span class="auto">前回から</span> <b>${when}</b><br>${esc(S.note || '')}。パッケージの表示があれば、そちらを使ってください。`
      : S.src === '写真' ? '📷 写真から読み取った日付です。' : S.confirmed ? '👍 合っていると確認しました。' : '');
    flash = '';
    const t = todayStr(), w = [];
    if (S.date) {
      const b = o.bought?.(), d = dayNo(S.date);
      if (d < dayNo(t)) w.push('過去の日付です(すでに期限が切れています)');
      if (b && d < dayNo(b)) w.push('購入日より前の日付です');
      if (d - dayNo(t) > 3652) w.push('10年以上先の日付です');
    }
    q('[data-w]').textContent = w.length ? `⚠ 日付を確認してください: ${w.join('、')}` : '';
    const pv = o.prev?.(), pb = q('[data-a=prev]'); pb.hidden = !pv; if (pv) pb.textContent = `🕘 前回の期限を使う(前回は買ってから${pv.days}日)`;
    q('[data-a=ok]').hidden = !(o.ok && estSrc(S.src) && S.date && !S.confirmed);
    q('[data-a=open]').hidden = !openR();
    o.onChange?.();
  };
  const set = (r) => {
    S.date = r.date; if (KINDS.includes(r.kind)) S.kind = r.kind; S.src = r.src; S.from = r.from || todayStr(); S.note = r.note || ''; S.confirmed = false; paint();
  };
  inp.oninput = () => { S.date = inp.value; S.src = S.date ? '手入力' : ''; S.from = S.date ? todayStr() : ''; S.note = ''; S.confirmed = false; paint(); };
  host.querySelectorAll('[data-ph]').forEach((f) => (f.onchange = () => { const file = f.files[0]; f.value = ''; if (file) expirySheet(file, { from: f, onPick: (r) => set({ ...r, src: '写真' }) }); }));
  host.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k) { S.kind = S.kind === b.dataset.k ? '' : b.dataset.k; return paint(); }
    const a = b.dataset.a, box = q('[data-c]');
    if (a === 'pred') {
      b.disabled = true; let r = null, err = false;
      try { const m = await loadSL(); r = m.predictExpiry({ ...o.info(), today: todayStr() }); } catch { err = true; }
      b.disabled = false;
      if (r) return set({ date: r.date, kind: r.kind, src: '予測', note: `${r.basis}・買ってから約${r.days}日` });
      flash = err ? '予測の部品を読み込めませんでした。通信を確かめてください(期限は手で入れられます)。' : 'この品は予測できません(種類によって期間が大きく違うためです)。期限が書いてあれば、写真か入力で入れてください。';
      paint();
    } else if (a === 'prev') { const pv = o.prev(); if (pv) set({ date: plusDays(todayStr(), pv.days), kind: pv.kind, src: '前回', note: `前回は買ってから${pv.days}日でした` }); }
    else if (a === 'ok') { S.confirmed = true; S.src = '手入力'; paint(); }
    else if (a === 'open') {
      const r = openR(); if (!r) return;
      const later = S.date && !estSrc(S.src) && dayNo(r.date) > dayNo(S.date);
      box.innerHTML = `<div class="exq"><p><b>開封後の目安に変えますか?</b><br>${dateJa(r.date)}(${relJa(r.date)}) ・ ${esc(r.basis)}${later ? '<br>いまの期限(表示)のほうが早いです。変えると期限が延びます。' : ''}</p><div class="row"><button type="button" class="b" data-a="oc">やめる</button><button type="button" class="b p grow" data-a="oy">変える</button></div></div>`;
      box.querySelector('[data-a=oc]').focus();
    } else if (a === 'oc') { box.innerHTML = ''; q('[data-a=open]').focus(); }
    else if (a === 'oy') { const r = openR(); box.innerHTML = ''; if (r) set({ date: r.date, kind: r.kind, src: '予測', note: `${r.basis}・開封後の目安` }); q('[data-a=open]').focus(); }
  };
  paint();
  return { paint, set, warm: () => loadSL().then(paint, () => {}) };
}

// 期限の写真を読んで、候補を確認するシート。写真は端末のメモリ(ObjectURL)だけで持ち、閉じると手放す。自動では保存せず、必ず確認を通す
// o: { from: 閉じたあとにフォーカスを戻す要素, onPick({date, kind}) }
function expirySheet(file, o) {
  const s = mkDlg('exs'); s._end?.(); if (s.open) s.close(); // 前のシートの後始末を先にする(close イベントは遅れて届くため)
  const url = URL.createObjectURL(file), ac = new AbortController(), today = todayStr();
  let timer = null, res = null, pick = { date: '', kind: '' }, t0 = 0, pct = 0, cancelled = false;
  let ended = false;
  const end = () => { if (ended) return; ended = true; cancelled = true; ac.abort(); clearInterval(timer); URL.revokeObjectURL(url); };
  s._end = end; s.onclose = () => { if (s.open || ended) return; end(); o.from?.focus?.({ preventScroll: true }); };
  const thumb = `<button type="button" class="exth" data-big aria-label="写真を全画面で見る"><img src="${url}" alt="期限を撮った写真"></button>`;
  const head = (t) => `<h3 id="exs-h" tabindex="-1">${t}</h3>`;
  const foc = () => s.querySelector('#exs-h')?.focus({ preventScroll: true });
  s.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.big !== undefined) return openViewer(url, '期限の写真');
    if (b.dataset.x !== undefined) return s.close();
    if (b.dataset.cancel !== undefined) { ac.abort(); return; }
    if (b.dataset.go !== undefined) return read();
    if (b.dataset.prep !== undefined) return prep(b);
    if (b.dataset.use !== undefined) { if (!pick.date) return; const r = { ...pick }; s.close(); o.onPick(r); return; }
    if (b.dataset.k) { pick.kind = pick.kind === b.dataset.k ? '' : b.dataset.k; return mark(); }
    if (b.dataset.c !== undefined) { const c = res.cands[+b.dataset.c]; pick = { date: c.date, kind: KINDS.includes(c.kind) ? c.kind : '' }; return mark(); }
  };
  s.oninput = (e) => { if (e.target.id === 'exs-d') { pick.date = e.target.value; mark(); } };
  const mark = () => {
    const sel = res?.cands.findIndex((c) => c.date === pick.date) ?? -1;
    s.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.c === sel));
    s.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === pick.kind));
    const d = s.querySelector('#exs-d'); if (d && d.value !== pick.date) d.value = pick.date;
    const w = [], dn = dayNo(pick.date);
    if (pick.date) { if (dn < dayNo(today)) w.push('過去の日付です'); if (dn - dayNo(today) > 3652) w.push('10年以上先の日付です'); }
    s.querySelector('#exs-w').textContent = w.length ? `⚠ 日付を確認してください: ${w.join('、')}` : '';
    s.querySelector('[data-use]').disabled = !pick.date;
  };
  const manual = () => `<label for="exs-d">日付(写真を見ながら入力・修正)</label><input id="exs-d" type="date"><div class="chips ek" role="group" aria-label="期限の種類">${KINDS.map((k) => `<button type="button" class="chip" data-k="${k}" aria-pressed="false">${k}期限</button>`).join('')}</div><div class="exw" id="exs-w" role="status"></div>`;
  const foot = (extra = '') => `<div class="btns" style="margin-top:12px"><button type="button" class="b" data-x>やめる</button>${extra}<button type="button" class="b p grow" data-use disabled>この日付を使う</button></div>`;
  const show = () => { if (!s.open) s.showModal(); foc(); };
  const prep = async (b) => {
    b.disabled = true; b.textContent = '準備中…';
    try { const m = await loadEO(); const ok = await m.warmupExpiryOcr((p) => { b.textContent = `準備中 ${Math.round(p * 100)}%`; }); if (ok) { try { localStorage.setItem('hs-ocr-ready', '1'); } catch {} } } catch {}
    if (!cancelled) read();
  };
  const fail = (msg) => { res = { cands: [] }; s.innerHTML = `${head('読み取れませんでした')}${thumb}<p>${esc(msg)}</p>${manual()}${foot()}`; mark(); foc(); };
  const confirmView = () => {
    const r = res.r, cands = res.cands, best = r.best, n = r.notes || {};
    const notes = [r.usedFallback ? '簡易な読み取りを使ったため、精度が下がります。' : '', n.note ? `写真に「${esc(n.note)}」とあります。日付は別の場所に印字されているかもしれません。` : '',
      ...(n.mfg || []).map((m) => `製造日らしい日付: ${esc(dateJa(m.date))}(期限としては使いません)`), ...(n.opened || []).map((m) => `「開封後は${m.days}日以内」と書かれています(期限ではないので入れていません)`)].filter(Boolean);
    const lv = (c) => (c >= 0.8 ? '自信 高' : c >= 0.6 ? '自信 中' : '自信 低');
    s.innerHTML = `${head(best ? 'この日付で合っていますか?' : 'これで合っていますか?')}${thumb}
      <p class="sub">${best ? '読み取った日付です。写真の印字と、数字を1文字ずつ見比べてください(1文字だけの読み違いは、アプリでは見つけられません)。' : '読み取りの自信が低い候補です。写真と見比べて、合っているものだけ選んでください。'}</p>
      <div class="cands" role="group" aria-label="読み取った候補">${cands.map((c, i) => `<button type="button" class="cand" data-c="${i}" aria-pressed="false"><span class="cd">${fullDate(c.date)}</span><span class="cr">${relJa(c.date)} ・ ${c.kind === '不明' ? '種類は不明' : `${c.kind}期限`} ・ ${lv(c.conf)}</span>${c.label ? `<span class="cl">${esc(c.label)}</span>` : ''}</button>`).join('')}</div>
      ${notes.length ? `<ul class="tips">${notes.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
      <details class="more"><summary>ちがうとき: 日付を直す</summary>${manual()}</details>${foot()}`;
    if (best) { pick = { date: best.date, kind: KINDS.includes(best.kind) ? best.kind : '' }; }
    mark(); foc();
  };
  const read = async () => {
    t0 = Date.now(); pct = 0;
    s.innerHTML = `${head('読み取り中…')}${thumb}<div class="rdg"><div role="status"><span id="exs-t"></span></div><div class="sub" id="exs-n" role="status"></div><button type="button" class="b d" data-cancel>やめる(手入力にする)</button></div>`;
    const paint = () => { const sec = Math.floor((Date.now() - t0) / 1000); const t = s.querySelector('#exs-t'), n = s.querySelector('#exs-n'); if (t) t.textContent = `${pct}% ・ ${sec}秒`; if (n) n.textContent = sec >= 10 ? 'しばらくかかります。待たずに「やめる」を押して、写真を見ながら入力することもできます。' : ''; };
    clearInterval(timer); timer = setInterval(paint, 500); paint(); foc();
    try {
      const m = await loadEO();
      const r = await m.readExpiryFromPhoto(file, { onProgress: (p) => { pct = Math.round(p * 100); }, signal: ac.signal, today });
      if (cancelled) return; clearInterval(timer);
      const cands = [...(r.candidates || [])].sort((a, b) => b.conf - a.conf).slice(0, 4);
      if (!cands.length) return fail('日付を見つけられませんでした。写真を見ながら入力してください。');
      res = { r, cands }; confirmView();
    } catch (e) {
      if (cancelled) return; clearInterval(timer);
      fail(e?.name === 'AbortError' ? '読み取りをやめました。写真を見ながら入力してください。' : '読み取りに失敗しました。写真を見ながら入力してください。');
    }
  };
  (async () => {
    s.innerHTML = `${head('期限を読み取る')}${thumb}<p class="sub" role="status">準備しています…</p>`; show();
    let ready = false; try { ready = await (await loadEO()).isExpiryOcrReady(); } catch {}
    if (cancelled) return;
    if (ready) return read();
    s.innerHTML = `${head('読み取りの準備')}${thumb}<p>初回だけ、読み取り用のデータ(約34MB)をダウンロードします。Wi-Fiでの利用をおすすめします。</p>
      <div class="btns"><button type="button" class="b" data-x>やめる</button><button type="button" class="b" data-go>そのまま読む</button><button type="button" class="b p grow" data-prep>準備する(約34MB)</button></div>`;
    foc();
  })();
}

// バーコードの「入力」: 期限を入れる小さなシート(編集ダイアログの期限と同じ部品)。決定で onDone(S)
function expiryInputSheet(B, o) {
  const s = mkDlg('exi'); if (s.open) s.close();
  const S = { date: B.date, kind: B.kind, src: B.src, from: B.from, note: B.note, confirmed: false };
  s.innerHTML = '<h3 id="exi-h" tabindex="-1">期限を入れる</h3><div id="exi-ed"></div><div class="btns" style="margin-top:12px"><button type="button" class="b" data-x>やめる</button><button type="button" class="b p grow" data-ok>決定</button></div>';
  const ed = expiryEditor(s.querySelector('#exi-ed'), { p: 'x-', S, info: o.info, prev: () => prevInterval(o.info().name, o.code) });
  s.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.x !== undefined) s.close(); else if (b.dataset.ok !== undefined) { const r = { ...S }; s.close(); o.onDone(r); } };
  s.onclose = () => { if (!s.open) o.from?.focus?.({ preventScroll: true }); };
  s.showModal(); ed.warm(); s.querySelector('#exi-h').focus({ preventScroll: true });
}

// ---------- 編集 ----------
// focus='q' なら数量欄にカーソルを置く。新規は名前欄、編集は何も置かない(キーボードを出さない)
// 新規のときは上に追加先バーを出し、場所・分類は 手で選んだ値 > 追加先 > 自動分類 の順で決める
// 「くわしく設定」の中は、まとまりごと(data-grp)に分けてある: class=分類・置き場所 / stock=買い足し / expiry=期限
function editDialog(it, memo, focus) {
  ctxHook = null; const d = $('#dlg'); const x = it || { name: '', qty: 1, minQty: 0, buyQty: 1, category: '', location: '', expiry: '', source: 'manual' };
  const xc = canonCategory(x.category, guessClass(x.name).category), xl = canonLocation(x.location, x.name); // 古い版の名前は新体系の名前で表示(保存すると新しい名前になる)
  d.innerHTML = `<form id="f-form" autocomplete="off"><h3 id="dlg-h" ${it ? 'tabindex="-1" autofocus' : ''}>${it ? '編集' : '追加'}</h3>${memo ? `<p class="sub">読み取り結果(参考): <br>${esc(memo.slice(0, 200))}</p>` : ''}${it ? '' : acb()}
  <label for="f-n">名前</label><input id="f-n" ${it ? '' : 'autofocus list="f-names"'} enterkeyhint="done" autocorrect="off" value="${esc(x.name)}">${it ? '' : `<datalist id="f-names">${items.map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>`}
  <div class="sub" id="f-dup" role="status"></div>
  <label for="f-q">数量</label><div class="row" style="flex-wrap:wrap"><button type="button" class="b" id="f-qm" tabindex="-1" aria-label="1つ減らす">−</button><input id="f-q" type="number" inputmode="numeric" enterkeyhint="done" min="0" value="${x.qty}" style="text-align:center;font-size:20px;font-weight:700"><button type="button" class="b" id="f-qp" tabindex="-1" aria-label="1つ増やす">＋</button></div>
  <details class="more"><summary id="f-sum"></summary>
  <div data-grp="class"><div class="grid2"><div><label for="f-c">カテゴリ</label><select id="f-c"></select></div><div><label for="f-s">小分類</label><select id="f-s"></select></div><div><label for="f-l">置き場所</label><select id="f-l"></select></div></div><div class="sub" id="f-h" role="status"></div></div>
  <div data-grp="stock" class="grid2"><div><label for="f-m">買い足しライン(この数になったら買い物リストに出す)</label><input id="f-m" type="number" inputmode="numeric" min="0" value="${x.minQty || 0}"></div>
  <div><label for="f-b">買うときの個数</label><input id="f-b" type="number" inputmode="numeric" min="1" value="${x.buyQty || 1}"></div></div>
  <div data-grp="expiry" id="f-ex"></div></details>
  <div class="btns" style="margin-top:12px">${it ? '' : '<button type="button" class="b" id="again" style="order:2">続けて追加</button>'}<button type="submit" class="b p grow" id="ok" style="order:3">${it ? '保存' : '追加'}</button><button type="button" class="b" id="cx" style="order:1">やめる</button></div>
  ${it ? '<div class="danger"><button type="button" class="b d" id="del" style="width:100%">この品目を削除</button></div>' : ''}</form>`; // Tab順は 続けて追加→追加→やめる(見た目は やめる・続けて追加・追加)
  const fC = $('#f-c'), fS = $('#f-s'), fL = $('#f-l');
  const S = { date: x.expiry || '', kind: x.expiryKind || '', src: x.expirySrc || '', from: x.expiryFrom || '', note: '', confirmed: false }; // 期限の状態(出どころつき)
  const sum = () => { // 追加先で決めた分は上のバーに出ているので、ここには入れない
    const sr = cf?.values().src || {}, t = [+$('#f-m').value ? `${$('#f-m').value}以下で買い足し` : '', S.date ? `期限 ${dateJa(S.date)}${estSrc(S.src) ? `(${S.src === '前回' ? '前回から' : '予測'})` : ''}` : '', sr.c === 'ctx' ? '' : fC.value, sr.s === 'ctx' ? '' : fS.value, sr.l === 'ctx' ? '' : fL.value].filter(Boolean).join(' ・ ');
    $('#f-sum').textContent = `くわしく設定${t ? `(${t})` : ''}`;
  };
  const cf = classForm({ fC, fS, fL, getName: () => $('#f-n').value, id: x.id, init: { category: xc, sub: x.sub, location: xl, auto: x.auto }, useCtx: !it, onChange: () => { $('#f-h').textContent = cf.hint(); sum(); } });
  const ed = expiryEditor($('#f-ex'), { p: 'f-', S, ok: true, info: () => ({ name: $('#f-n').value, category: fC.value, sub: fS.value, location: fL.value }), bought: () => x.boughtAt || '', prev: () => prevInterval($('#f-n').value, canonCode(x.barcode || '')), onChange: sum });
  $('#f-form > details.more').addEventListener('toggle', (e) => { if (e.target.open) ed.warm(); });
  if (!it && autoExp()) setTimeout(() => loadSL().catch(() => {}), 400); // 保存時の自動予測のために先に読んでおく
  const dupOf = () => (it ? null : items.find((i) => norm(i.name) === norm($('#f-n').value) && $('#f-n').value.trim()));
  const suggest = () => {
    cf.recompute();
    const ex = dupOf();
    $('#f-dup').textContent = ex ? `「${ex.name}」は登録済みです(いま ${ex.qty})。追加すると数量が足されます(場所・分類はそのまま)。` : '';
    $('#ok').textContent = ex ? '数量を足す' : it ? '保存' : '追加';
  };
  $('#f-n').oninput = () => { suggest(); ed.paint(); }; suggest();
  if (!it) ctxHook = suggest; // 追加先が変わったら、名前から決めた分を計算し直す
  $('#f-m').oninput = sum;
  const step = (n) => { const q = $('#f-q'); q.value = Math.max(0, (+q.value || 0) + n); };
  $('#f-qm').onclick = () => step(-1); $('#f-qp').onclick = () => step(1);
  $('#cx').onclick = () => d.close();
  $('#del')?.addEventListener('click', () => { d.close(); store.remove(it.id).catch((e) => toast(`削除できませんでした: ${e.code || e.message}`)); toast(`「${it.name}」を削除しました`, () => save(it)); });
  let busy = false;
  const submit = async (again) => {
    const name = $('#f-n').value.trim(); if (!name) { toast('名前を入れてください'); $('#f-n').focus(); return; }
    if (busy) return; busy = true;
    const qty = +$('#f-q').value || 0, ex = dupOf(), v = cf.values(); let wh = '', auto = null, undo = null;
    // 新しい品で期限が空なら、自動予測が有効なとき予測を入れる(確信度0.85以上。読み込めなくても保存は進む)
    if (!it && !S.date && autoExp() && !(ex && ex.expiry && ex.qty > 0)) {
      const pi = { name, category: v.category, sub: v.sub, location: v.location }, r = SL ? predictNow(pi) : await predictSafe(pi);
      if (r) { Object.assign(S, { date: r.date, kind: r.kind, src: '予測', from: todayStr() }); auto = r; }
    }
    if (ex) { // 同名の品は数量を足す(場所・分類は変えない)。期限は、この画面で入れた/自動で入れたときだけ更新する
      const next = { ...ex, qty: ex.qty + qty };
      if (S.date) { if (S.src === '手入力' || S.src === '写真') xsJudge(ex, S.date); putExpiry(next, S); }
      saveQty(ex, next).catch(() => {}); if (auto) undo = () => save(ex);
    } else {
      const rec = { ...x, name, qty, minQty: +$('#f-m').value || 0, buyQty: +$('#f-b').value || 1, category: v.category, location: v.location };
      putExpiry(rec, S);
      if (it && estSrc(it.expirySrc)) { if (S.confirmed) xsJudge(it, null); else if (S.date && (S.src === '手入力' || S.src === '写真')) xsJudge(it, S.date); } // 予測の的中率の記録
      if (v.sub) rec.sub = v.sub; else delete rec.sub;
      if (v.auto) rec.auto = true; else delete rec.auto; // 自動の候補をそのまま使った場合だけ「自動」の印(手で選んだ値・追加先の値には付けない)
      if (!it && auto) rec.id = newId();
      saveQty(it || null, rec).catch(() => {}); // 送信は待たない(オフラインでも閉じる)。失敗は toast で知らせる
      wh = rec.location; if (!it && auto) undo = () => store.remove(rec.id);
    }
    const note = auto ? `(期限は予測 ${dateJa(auto.date)})` : '';
    toast((it ? `「${name}」を保存しました` : ex ? `「${name}」に ${qty} 足しました${ex.location ? `(${canonLocation(ex.location, ex.name)})` : ''}` : `「${name}」を${wh ? `${wh}に` : ''}追加しました`) + note, undo);
    busy = false;
    if (again) { editDialog(); $('#f-n').focus(); } else d.close();
  };
  $('#f-form').onsubmit = (e) => { e.preventDefault(); submit(false); };
  $('#again')?.addEventListener('click', () => submit(true));
  openDlg('edit');
  if (focus === 'q') { const q = $('#f-q'); q.focus(); q.select(); }
}

// ---------- ダイアログ共通 ----------
// 閉じたら開いた元の要素へフォーカスを戻す。短い入力ダイアログ(edit)は、まだ何も入力していなければ外側タップで閉じる
const dlg = $('#dlg'); let dlgOrigin = null, dlgDirty = false;
function openDlg(kind) {
  if (!dlg.open) { const a = document.activeElement; dlgOrigin = a && a !== document.body ? { el: a, id: a.closest?.('.it')?.dataset.id, sel: a.matches?.('[data-q]') ? '[data-q]' : '[data-edit]' } : null; }
  dlg.dataset.kind = kind; dlgDirty = false; dlg.setAttribute('aria-labelledby', 'dlg-h');
  if (!dlg.open) dlg.showModal();
}
dlg.addEventListener('input', () => (dlgDirty = true));
dlg.addEventListener('click', (e) => {
  if (e.target !== dlg || dlg.dataset.kind !== 'edit' || dlgDirty) return;
  const r = dlg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
});
dlg.addEventListener('close', () => {
  if (dlg.dataset.kind === 'review') { readCancel?.(); resetReview(); } // 写真(ObjectURL)をここで手放す
  if (['edit', 'barcode', 'review'].includes(dlg.dataset.kind)) endCtx(); // 追加が終わったので、固定でなければ追加先を「おまかせ」に戻す
  const o = dlgOrigin; dlgOrigin = null; if (!o) return;
  (o.el.isConnected ? o.el : o.id && document.querySelector(`.it[data-id="${o.id}"] ${o.sel}`))?.focus?.({ preventScroll: true });
});
// キーボード(PC): / で検索、n で追加
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || dlg.open || e.target.matches?.('input,textarea,select,[contenteditable]') || !state.household) return;
  if (e.key === '/') { e.preventDefault(); if (tab !== 'stock') { tab = 'stock'; render(); } $('#q')?.focus(); }
  else if (e.key === 'n') { e.preventDefault(); editDialog(); }
});

// ---------- 起動 ----------
document.querySelectorAll('#tabs [data-tab]').forEach((b) => (b.onclick = () => { if (tab !== b.dataset.tab) { shopDone.clear(); scrollTo(0, 0); } if (tab === 'import' && b.dataset.tab !== 'import') endCtx(); tab = b.dataset.tab; render(); }));
$('#addnav').onclick = () => state.household && editDialog();
// 数量などの数字欄は、タップしたら全選択(そのまま打てば置き換わる)
document.addEventListener('focusin', (e) => { if (e.target.matches?.('input[type=number]')) try { e.target.select(); } catch {} });
renderBars(); // 固定していた追加先があれば、ナビの＋の読み上げに反映
(async () => {
  store = await createStore();
  await store.init((s) => {
    state = s; unsub?.(); unsub = null;
    if (s.household) unsub = store.subscribe((a, m) => {
      syncMsg = m?.pending ? ' ・ 同期中…' : '';
      const sig = JSON.stringify(a);
      if (sig !== lastSig) { lastSig = sig; items = a; render(); } else $('#who').textContent = whoText();
    }, (e) => { syncMsg = ' ・ ⚠同期エラー'; toast(`同期できません: ${e.code || e.message}`); render(); });
    render();
  });
})().catch((e) => { $('#view').innerHTML = `<div class="empty">起動に失敗: ${esc(e.message)}</div>`; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
