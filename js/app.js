import { createStore } from './store.js';
import { norm, parseReceipt, parseReceiptMeta, checkTotal } from './parse.js';
import { ocr, warmupOcr } from './ocr.js';
import { gmailAvailable, fetchOrders } from './gmail.js';
import { scan, lookupName } from './barcode.js';
import { CATS, LOCS, LEGACY_CATEGORY, canonCategory, canonLocation, catInfo, locInfo, categoryOptions, locationOptions } from './taxonomy.js';
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
// category/location が空なら自動分類で補う(ユーザーが選んだ値は上書きしない)。補ったら auto:true
const fillAuto = (rec) => {
  if (rec.category && rec.location) return rec;
  const r = autoClassify(rec, items, { locs: locationOptions(items) });
  const out = { ...rec, category: rec.category || r.category, location: rec.location || r.location, ...(r.sub && !rec.sub ? { sub: r.sub } : {}) };
  return out.category !== (rec.category || '') || out.location !== (rec.location || '') ? { ...out, auto: true } : out;
};
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
const pillOf = (x) => (x.rank === 0 ? ['expired', '⛔', '期限切れ'] : x.rank === 1 ? ['zero', '✕', 'なくなった'] : x.rank === 2 ? ['low', '⚠', '残りわずか']
  : x.rank === 3 ? ['soon', '⏰', x.d === 0 ? '今日まで' : `あと${x.d}日`] : x.i.qty <= 0 ? ['none', '', '在庫なし'] : null);
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
    const ci = k ? catInfo(k) : UNCAT, g = { key: k || UNCAT.name, name: ci.name || UNCAT.name, icon: ci.icon, color: ci.color, items: a, hint: k ? '' : '分類をつけると探しやすくなります。品名をタップして編集できます。' };
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
    out.push({ key: li.name, name: li.name, icon: li.icon, place: true, items: a, hint: k ? '' : '置き場所をつけると、冷蔵庫など場所ごとに見られます。' });
  }
  return out;
}
function groupHtml(g, n, ctx, closed) {
  const nl = g.items.filter((x) => x.low).length, ne = g.items.filter((x) => x.near).length, id = `g-${ctx}-${n}`, shut = closed.has(g.key);
  const colors = g.place ? '--gbg:var(--place-bg);--gfg:var(--place-fg)' : `--gbg:var(--c-${g.color}-bg);--gfg:var(--c-${g.color}-fg)`;
  const body = g.subs ? g.subs.map(([sn, arr]) => `<h4 class="sh">${esc(sn)}<span>${arr.length}品</span></h4>${arr.map((x) => rowHtml(x, ctx)).join('')}`).join('') : g.items.map((x) => rowHtml(x, ctx)).join('');
  return `<section class="lg" style="${colors}"><h3 class="gh"><button data-fold="${esc(g.key)}" aria-expanded="${!shut}" aria-controls="${id}"><span class="ic" aria-hidden="true">${g.icon}</span><span class="gn">${esc(g.name)}<span class="ct">${g.items.length}品</span></span><span class="gr"><span class="bdg">${nl ? `<span class="hb low">足りない ${nl}</span>` : ''}${ne ? `<span class="hb exp">期限 ${ne}</span>` : ''}</span><span class="chev" aria-hidden="true">${CHEV}</span></span></button></h3>`
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
  for (const { item: i, days, expired } of p.expiring) cs.push({ type: 'exp', key: `exp:${i.id}:${i.expiry}`, cls: 'alert', title: `${nm(i)}の期限${expired ? 'が切れています' : 'が近づいています'}`,
    body: `期限 ${dateJa(i.expiry)}(${expired ? `${-days}日前` : days === 0 ? '今日' : `あと${days}日`})・ 残り ${i.qty}個`,
    ok: expired ? { label: '捨てた(数を0にする)', fn: () => saveQty(i, { ...i, qty: 0, expiry: '' }, { skip: true }) } : null, ok2: expired ? { label: 'まだ使える(期限を消す)', fn: () => save({ ...i, expiry: '' }) } : null, no: expired ? 'あとで' : '見ました' });
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
  <div class="card"><h3>レシートの修正の学習</h3><p class="sub">レシートの読み間違いを直すと、この端末が覚えて、次から自動で直します(この端末の中だけに保存されます)。覚えた数: <span id="fxn">${fixLoad().length}</span>件</p><button class="b" id="fx-reset" ${fixLoad().length ? '' : 'disabled'}>修正の学習をリセット</button></div>
  ${cloud ? '<div class="danger"><button class="b" id="out">ログアウト</button></div>' : ''}`;
  const copy = (t, m) => (navigator.clipboard?.writeText(t) ?? Promise.reject()).then(() => toast(m), () => toast('コピーできませんでした。コードを長押しして選んでください'));
  $('#out')?.addEventListener('click', () => store.signOut());
  $('#cp')?.addEventListener('click', () => copy(h.id, 'コードをコピーしました'));
  $('#cl')?.addEventListener('click', () => copy(link, 'リンクをコピーしました'));
  $('#sh')?.addEventListener('click', () => (navigator.share ? navigator.share({ title: 'うちの在庫', text: `「うちの在庫」に参加してください。開いてログインすると家族コード(${h.id})が入ります。`, url: link }).catch(() => {}) : copy(link, 'リンクをコピーしました。LINEなどに貼ってください')));
  $('#fx-reset').onclick = () => { const was = fixLoad(); fixSave([]); $('#fxn').textContent = '0'; $('#fx-reset').disabled = true; toast('修正の学習をリセットしました', () => { fixSave(was); renderFamily(v); }); };
  $('#ex-csv').onclick = () => exportData('csv'); $('#ex-json').onclick = () => exportData('json');
}

function renderImport(v) {
  v.innerHTML = `<h2>まとめて追加</h2><div class="card"><h3>バーコードで追加</h3><p class="sub">商品のバーコードをカメラで読むだけで追加できます。一度登録した商品は、次から数量が増えます。家族にも共有されます。</p><button class="b p" id="bc">バーコードを読む</button></div>
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
    reviewDialog();
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
  reviewDialog();
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
function openViewer(url) {
  let v = $('#pv');
  if (!v) { v = document.createElement('dialog'); v.id = 'pv'; v.setAttribute('aria-label', 'レシートの写真'); document.body.append(v); }
  v.innerHTML = '<div class="pvs"><img alt="レシートの写真" draggable="false"></div><div class="pvh">指でなぞると動かせます。2本の指で拡大できます</div><div class="pvb"><button type="button" class="b" data-z="1">＋ 大きく</button><button type="button" class="b" data-z="-1">－ 小さく</button><button type="button" class="b" data-z="0">全体を見る</button><button type="button" class="b p" data-x autofocus>閉じる</button></div>';
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
  const row = (c, n) => `<div class="card rv" data-row="${n}"><div class="fl" data-fl="${n}"></div><div class="row"><input type="checkbox" data-on="${n}" ${c.on ? 'checked' : ''} aria-label="登録する"><input class="grow" data-nm="${n}" list="rv-names" autocomplete="off" autocorrect="off" enterkeyhint="next" value="${esc(c.name)}" aria-label="品名"><button class="b d" data-rm="${n}" aria-label="この行を削除">✕</button></div>
    <div class="rv2"><div><label>カテゴリ</label><select data-ct="${n}"><option value="">未設定</option>${CATS.map((x) => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div><label>数量</label><input data-q="${n}" type="number" inputmode="numeric" min="1" value="${c.qty}"></div><div><label>金額(円)</label><input data-pr="${n}" type="number" inputmode="numeric" enterkeyhint="next" min="0" value="${c.price || ''}"></div></div>
    <div class="sub">${c.fix ? `<span class="fixd" data-fx="${n}">前回の修正を適用</span> ・ ` : ''}${c.auto && c.category ? '<span class="auto" title="自動で分類しました。違えば選び直せます">自動</span> ' : ''}${c.dup ? '取り込み済み ・ ' : ''}${SRC[c.source] || ''} ${esc(c.boughtAt || '')}${c.discount ? ` ・ 値引 −¥${c.discount} 反映済み` : ''}${c.gap ? ' ・ 検算用(在庫には登録しません)' : ''}</div></div>`;
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
  <h3 id="dlg-h" tabindex="-1" autofocus>${manual ? '写真を見ながら入力してください' : 'この内容で登録しますか?'}</h3><p class="sub">${manual ? '名前と金額を入れてください。次の欄へは「次へ」キーで進めます。' : '黄色の行は読み間違いかもしれません。写真を見て、名前・数量・金額を直せます。'}同じ名前が在庫にあれば数量を足します。</p>
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
    e.onchange = () => { draft[n].checked = true; refreshFlags(); }; // 手で直したら確認済み
    e.onfocus = () => { if (!flagsOf(draft[n])?.nm) return; const v = e.value; e.select(); setTimeout(() => e.value === v && e.select(), 0); }; // 崩れた名前は全選択 → そのまま打てば置き換わる/候補が出る
    e.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const nx = flagged().find((i) => i > n); (nx === undefined ? d.querySelector(`[data-pr="${n}"]`) : d.querySelector(`[data-nm="${nx}"]`)).focus(); } }; // 次へ: 要確認の行が続くならそこへ(金額は合っていることが多い)
  });
  d.querySelectorAll('[data-ct]').forEach((e) => (e.onchange = () => { draft[e.dataset.ct].category = e.value; delete draft[e.dataset.ct].sub; draft[e.dataset.ct].auto = false; e.closest('.rv').querySelector('.auto')?.remove(); }));
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
    let n = 0;
    fixLearn(draft.filter((c) => c.on && c.name.trim() && c.ocrName && fixKey(c.ocrName) && fixKey(c.name) !== fixKey(c.ocrName) && !known.has(norm(c.ocrName))).map((c) => [fixKey(c.ocrName), c.name.trim()])); // 崩れ→直した名前を学習(端末内のみ)
    for (const c of draft.filter((x) => x.on && x.name.trim())) {
      const ex = byName.get(norm(c.name));
      const keys = c.srcKey ? [c.srcKey] : [];
      let rec = ex ? { ...ex, qty: ex.qty + c.qty, category: ex.category || c.category || '', ...(!ex.category && !ex.sub && c.sub ? { sub: c.sub } : {}), boughtAt: c.boughtAt || ex.boughtAt || '', srcKeys: [...(ex.srcKeys || []), ...keys] }
        : { name: c.name.trim(), qty: c.qty, category: c.category || '', ...(c.sub ? { sub: c.sub } : {}), location: '', minQty: 0, buyQty: 1, price: c.price || 0, boughtAt: c.boughtAt || '', source: c.source, srcKeys: keys };
      rec = fillAuto(rec); if (c.auto && c.category && !ex?.category) rec.auto = true;
      rec = withLog(ex || null, rec); // 数量の履歴を追記
      save(rec).catch(() => {}); byName.set(norm(c.name), rec); n++; // 送信は待たず、失敗は toast で知らせる
    }
    d.close(); toast(`${n}件を登録しました`); tab = 'stock'; render();
  };
  refresh(true); cnt();
  const sync = () => d.style.setProperty('--phh', `${$('#phbar').offsetHeight}px`);
  openDlg('review');
  d.scrollTop = st; sync();
  if (img) { img.addEventListener('load', sync); }
}

// ---------- バーコード追加 ----------
async function barcodeAdd() {
  const d = $('#dlg'); openDlg('barcode');
  for (;;) {
    const sp = scan(d); d.querySelector('h3')?.setAttribute('id', 'dlg-h'); // 番号入力欄で Enter でも決定できるようにする
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
    const opts = (arr, v) => `<option value="">未設定</option>${arr.map((c) => `<option ${c === v ? 'selected' : ''}>${c}</option>`).join('')}`;
    d.innerHTML = `<form id="b-form" autocomplete="off"><h3 id="dlg-h">${ex ? '登録済みの商品' : '新しい商品'}</h3><div class="sub">バーコード ${esc(code)}</div>
    <label for="b-n">名前</label><input id="b-n" value="${esc(ex?.name || '')}" placeholder="${ex ? '' : '商品名を検索中…'}">
    <div class="sub" id="b-note" role="status" aria-live="polite" style="margin-top:4px"></div><div id="b-help" hidden></div>
    <div class="grid2"><div><label>${ex ? `追加する数(いま ${ex.qty})` : '数量'}</label><input id="b-q" type="number" inputmode="numeric" enterkeyhint="done" min="1" value="1"></div>
    <div><label>カテゴリ</label><select id="b-c">${opts(CATS, ex?.category)}</select></div></div>
    <div class="btns" style="margin-top:12px"><button type="button" class="b" id="bx">終了</button><button type="submit" class="b p grow" id="bok">${ex ? '数量を追加して次へ' : '登録して次へ'}</button></div></form>`;
    const n = d.querySelector('#b-n'), c = d.querySelector('#b-c'); let typed = false, stopUi = () => {};
    n.oninput = () => (typed = true);
    c.onchange = () => (c.dataset.auto = '');
    const apply = (name, fromOcr) => { // 検索結果・OCRの候補を名前欄へ。カテゴリは名前から推定(選択済みなら変えない)
      n.value = name; if (fromOcr) typed = true;
      if (!c.value || c.dataset.auto) { const g = autoClassify({ name, category: '', location: '' }, items, { locs: LOCS }).category; if (g || c.dataset.auto) { c.value = g; c.dataset.auto = g ? '1' : ''; } }
    };
    if (!ex) stopUi = ui.mountLookup(d, { code, input: n, apply, isTyped: () => typed });
    d.querySelector('#bx').onclick = () => { stopUi(); resolve(false); };
    d.querySelector('#b-form').onsubmit = (ev) => {
      ev.preventDefault();
      const name = n.value.trim(); if (!name) return toast('名前を入れてください');
      const add = Math.max(1, +d.querySelector('#b-q').value || 1);
      const same = ex || items.find((i) => norm(i.name) === norm(name));
      const auto = !!c.dataset.auto && !!c.value;
      stopUi();
      (same ? saveQty(same, { ...same, qty: same.qty + add, barcode: code, category: same.category || c.value, ...(auto && !same.category ? { auto: true } : {}) })
        : saveQty(null, { ...fillAuto({ name, qty: add, category: c.value, location: '', minQty: 0, buyQty: 1, barcode: code, source: 'barcode' }), ...(auto ? { auto: true } : {}) })).catch(() => {});
      toast(`${name} を追加しました`); resolve(true);
    };
  });
}

// ---------- 編集 ----------
// focus='q' なら数量欄にカーソルを置く。新規は名前欄、編集は何も置かない(キーボードを出さない)
function editDialog(it, memo, focus) {
  const d = $('#dlg'); const x = it || { name: '', qty: 1, minQty: 0, buyQty: 1, category: '', location: '', expiry: '', source: 'manual' };
  const opts = (arr, v) => `<option value="">未設定</option>${arr.map((c) => `<option ${c === v ? 'selected' : ''}>${c}</option>`).join('')}`;
  const xc = canonCategory(x.category, guessClass(x.name).category), xl = canonLocation(x.location, x.name); // 古い版の名前は新体系の名前で表示(保存すると新しい名前になる)
  d.innerHTML = `<form id="f-form" autocomplete="off"><h3 id="dlg-h" ${it ? 'tabindex="-1" autofocus' : ''}>${it ? '編集' : '追加'}</h3>${memo ? `<p class="sub">読み取り結果(参考): <br>${esc(memo.slice(0, 200))}</p>` : ''}
  <label for="f-n">名前</label><input id="f-n" ${it ? '' : 'autofocus list="f-names"'} enterkeyhint="done" autocorrect="off" value="${esc(x.name)}">${it ? '' : `<datalist id="f-names">${items.map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>`}
  <div class="sub" id="f-dup" role="status"></div>
  <label for="f-q">数量</label><div class="row" style="flex-wrap:wrap"><button type="button" class="b" id="f-qm" tabindex="-1" aria-label="1つ減らす">−</button><input id="f-q" type="number" inputmode="numeric" enterkeyhint="done" min="0" value="${x.qty}" style="text-align:center;font-size:20px;font-weight:700"><button type="button" class="b" id="f-qp" tabindex="-1" aria-label="1つ増やす">＋</button></div>
  <details class="more"><summary id="f-sum"></summary>
  <div class="grid2"><div><label for="f-m">買い足しライン(この数になったら買い物リストに出す)</label><input id="f-m" type="number" inputmode="numeric" min="0" value="${x.minQty || 0}"></div>
  <div><label for="f-b">買うときの個数</label><input id="f-b" type="number" inputmode="numeric" min="1" value="${x.buyQty || 1}"></div>
  <div><label for="f-e">賞味・使用期限</label><input id="f-e" type="date" value="${esc(x.expiry || '')}"></div><div></div>
  <div><label for="f-c">カテゴリ</label><select id="f-c">${opts(categoryOptions(items), xc)}</select></div><div><label for="f-l">置き場所</label><select id="f-l">${opts(locationOptions(items), xl)}</select></div></div>
  <div class="sub" id="f-h"></div></details>
  <div class="btns" style="margin-top:12px">${it ? '' : '<button type="button" class="b" id="again" style="order:2">続けて追加</button>'}<button type="submit" class="b p grow" id="ok" style="order:3">${it ? '保存' : '追加'}</button><button type="button" class="b" id="cx" style="order:1">やめる</button></div>
  ${it ? '<div class="danger"><button type="button" class="b d" id="del" style="width:100%">この品目を削除</button></div>' : ''}</form>`; // Tab順は 続けて追加→追加→やめる(見た目は やめる・続けて追加・追加)
  // 名前から分類の候補を事前選択する。すでに選んである(または保存済みの)欄は変えない
  const fC = $('#f-c'), fL = $('#f-l'); let fixC = !!x.category, fixL = !!x.location, sugC = '', sugL = '', sugS = '';
  const sum = () => { const t = [+$('#f-m').value ? `${$('#f-m').value}以下で買い足し` : '', $('#f-e').value ? `期限 ${dateJa($('#f-e').value)}` : '', fC.value, fL.value].filter(Boolean).join(' ・ '); $('#f-sum').textContent = `くわしく設定${t ? `(${t})` : ''}`; };
  fC.onchange = () => { fixC = true; sugC = ''; showHint(); }; fL.onchange = () => { fixL = true; sugL = ''; showHint(); };
  const showHint = () => { $('#f-h').textContent = sugC || sugL ? `自動の候補: ${[sugC, sugL].filter(Boolean).join(' / ')}(変更できます)` : ''; sum(); };
  const dupOf = () => (it ? null : items.find((i) => norm(i.name) === norm($('#f-n').value) && $('#f-n').value.trim()));
  const suggest = () => {
    const r = autoClassify({ id: x.id, name: $('#f-n').value, category: fixC ? fC.value : '', location: fixL ? fL.value : '' }, items, { locs: locationOptions(items) });
    sugS = r.sub; if (!fixC) { fC.value = sugC = r.category; }
    if (!fixL) { fL.value = sugL = r.location; }
    const ex = dupOf();
    $('#f-dup').textContent = ex ? `「${ex.name}」は登録済みです(いま ${ex.qty})。追加すると数量が足されます。` : '';
    $('#ok').textContent = ex ? '数量を足す' : it ? '保存' : '追加';
    showHint();
  };
  $('#f-n').oninput = suggest; suggest();
  ['f-m', 'f-e'].forEach((k) => ($(`#${k}`).oninput = sum));
  const step = (n) => { const q = $('#f-q'); q.value = Math.max(0, (+q.value || 0) + n); };
  $('#f-qm').onclick = () => step(-1); $('#f-qp').onclick = () => step(1);
  $('#cx').onclick = () => d.close();
  $('#del')?.addEventListener('click', () => { d.close(); store.remove(it.id).catch((e) => toast(`削除できませんでした: ${e.code || e.message}`)); toast(`「${it.name}」を削除しました`, () => save(it)); });
  const submit = (again) => {
    const name = $('#f-n').value.trim(); if (!name) { toast('名前を入れてください'); $('#f-n').focus(); return; }
    const qty = +$('#f-q').value || 0, ex = dupOf();
    if (ex) saveQty(ex, { ...ex, qty: ex.qty + qty }).catch(() => {});
    else {
      const rec = { ...x, name, qty, minQty: +$('#f-m').value || 0, buyQty: +$('#f-b').value || 1, expiry: $('#f-e').value, category: fC.value, location: fL.value };
      if (rec.sub && canonCategory(fC.value, '') !== xc) delete rec.sub; // 大分類を変えたら古い小分類は外す
      // 自動の候補をそのまま使った(または以前の自動分類から変えていない)なら「自動」の印を付ける
      const keep = x.auto && fC.value === xc && fL.value === xl;
      if (keep || (sugC && fC.value === sugC) || (sugL && fL.value === sugL)) rec.auto = true; else delete rec.auto;
      if (rec.auto && sugS && !rec.sub) rec.sub = sugS; // 自動分類のときだけ小分類も自動で補う(手で選んだ分類には足さない)
      saveQty(it || null, rec).catch(() => {}); // 送信は待たない(オフラインでも閉じる)。失敗は toast で知らせる
    }
    toast(it ? `「${name}」を保存しました` : ex ? `「${name}」に ${qty} 足しました` : `「${name}」を追加しました`);
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
document.querySelectorAll('#tabs [data-tab]').forEach((b) => (b.onclick = () => { if (tab !== b.dataset.tab) { shopDone.clear(); scrollTo(0, 0); } tab = b.dataset.tab; render(); }));
$('#addnav').onclick = () => state.household && editDialog();
// 数量などの数字欄は、タップしたら全選択(そのまま打てば置き換わる)
document.addEventListener('focusin', (e) => { if (e.target.matches?.('input[type=number]')) try { e.target.select(); } catch {} });
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
