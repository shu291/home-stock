// 間取りの画面(DOM)。app.js から必要なときに動的 import する。データの操作・計算は floorplan.js の純粋関数。
// 見る/編集の2モード。見るモードは四角をタップして開く(スクロールを妨げない)。編集モードだけ、四角をなぞって動かせる(pointer イベント)。
// 共有: 操作は sync.apply(差分送信)。他の人の変更は update() で画面に反映する(なぞっている最中・入力中は終わるまで待つ)。
import { GRID_W, MAX_ROWS, ROOM_MIN, SPOT_GRID, SPOT_MIN, NAME_MAX, ROOM_KINDS, SPOT_KINDS, roomKind, spotKind, roomColor, spotColor, addRoom, moveRoom, resizeRoom, renameRoom, setRoomColor, deleteRoom, addSpot, moveSpot, resizeSpot, renameSpot, deleteSpot, snap, bounds, summarize, unplaced, starterLayout, STARTER_KINDS } from './floorplan.js';
import { COLOR_TOKENS } from './taxonomy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const byPos = (a, b) => a.y - b.y || a.x - b.x;
const COLOR_JA = { green: '緑', blue: '青', amber: '黄', teal: '青緑', pink: 'ピンク', red: '赤', purple: '紫', orange: 'オレンジ', gray: 'グレー' };
const REASON = { 'no-space': 'ここには置けません(空きがありません)', 'not-found': 'ほかの人が変更したため、操作できませんでした' };
const ZOOMS = [1, 1.5, 2, 3];

// ---- 純粋な補助(テストできる) ----
const ver = (L, id) => { const e = L.rooms[id] || L.spots[id]; return e ? e.u : L.dead[id] ?? 0; };
const sig = (L, id) => JSON.stringify([L.rooms[id], L.spots[id], L.dead[id]]);
// a と b で状態(あり/なし/中身)が違う要素の id
export function touchedIds(a, b) {
  const ids = new Set([a, b].flatMap((L) => [...Object.keys(L.rooms), ...Object.keys(L.spots), ...Object.keys(L.dead)]));
  return [...ids].filter((id) => sig(a, id) !== sig(b, id));
}
// 操作(before → after)を、いまの cur の上で元に戻す。共有では u の新しいほうが勝つので、戻した要素には新しい u を付ける
// (古い u のまま送ると、他の端末では「編集後」のほうが勝って戻らない)。操作のあとにほかの人が変えた要素は触らず skipped に入れる
export function undoLayout(cur, before, after, now = Date.now()) {
  const rooms = { ...cur.rooms }, spots = { ...cur.spots }, dead = { ...cur.dead }, skipped = [];
  for (const id of touchedIds(before, after)) {
    if (ver(cur, id) > ver(after, id)) { skipped.push(id); continue; }
    const u = Math.max(now, ver(cur, id) + 1, ver(before, id) + 1);
    delete rooms[id]; delete spots[id];
    if (before.rooms[id]) { rooms[id] = { ...before.rooms[id], u }; delete dead[id]; }
    else if (before.spots[id]) { spots[id] = { ...before.spots[id], u }; delete dead[id]; }
    else dead[id] = u;
  }
  return { layout: { v: 1, rooms, spots, dead }, skipped };
}
// 場所の名前から、収納場所の種類を推測する(「間取りにない置き場所」を置くとき)
const KIND_HINTS = [[/冷凍/, 'freezer'], [/冷蔵/, 'fridge'], [/パントリー|食品庫/, 'pantry'], [/食器棚|カップボード/, 'cupboard'], [/引き出し|引出/, 'drawer'], [/クローゼット|衣装|ワードローブ/, 'closet'], [/押入|押し入れ/, 'oshiire'], [/洗面/, 'sink'], [/玄関|シューズ|靴/, 'genkan'], [/ベランダ/, 'veranda'], [/物置|倉庫|納戸/, 'mono'], [/車|ガレージ/, 'car'], [/棚|ラック/, 'shelf']];
export const guessSpotKind = (name) => (KIND_HINTS.find(([re]) => re.test(String(name ?? '').normalize('NFKC'))) || [0, 'other'])[1];
// なぞって大きさを変えるときの、つまみの向き(dir)ごとの希望の四角。単位は「マス」(部屋)/「刻み」(収納場所)
export function resizeTarget(rect, dir, ux, uy, house) {
  const W = house ? GRID_W : SPOT_GRID, H = house ? MAX_ROWS : SPOT_GRID, min = house ? ROOM_MIN : SPOT_MIN, max = house ? 24 : SPOT_GRID;
  let { x, y } = rect, r = x + rect.w, b = y + rect.h;
  if (dir.includes('e')) r = clamp(r + ux, x + min, Math.min(W, x + max));
  if (dir.includes('w')) x = clamp(x + ux, Math.max(0, r - max), r - min);
  if (dir.includes('s')) b = clamp(b + uy, y + min, Math.min(H, y + max));
  if (dir.includes('n')) y = clamp(y + uy, Math.max(0, b - max), b - min);
  return { x, y, w: r - x, h: b - y };
}

// ---- 画面 ----
const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
// 再描画の前後でフォーカスを戻すための目印(同じ部品を探す selector)
const keyOf = (el, root) => {
  if (!el || el === document.body || !root.contains(el)) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;
  const cls = ['fpr', 'fprow'].find((c) => el.classList.contains(c)), at = Object.entries(el.dataset).map(([k, v]) => `[data-${kebab(k)}="${CSS.escape(v)}"]`).join('');
  return cls || at ? `${cls ? '.' + cls : el.tagName.toLowerCase()}${at}` : '';
};
const pills = (s, full) => `${s.low ? `<span class="hb low">${full ? '足りない ' : '⚠'}${s.low}</span>` : ''}${s.exp ? `<span class="hb exp">${full ? '期限 ' : '⏰'}${s.exp}</span>` : ''}`;
const estNote = (s) => (s.expEst ? `<span class="fpest">期限の目安 ${s.expEst}</span>` : '');
const lbl = (name, s) => `${name}、${s.count}品${s.low ? `、足りない${s.low}品` : ''}${s.exp ? `、期限が近い${s.exp}品` : ''}`;
const spotOk = (L, s) => s && L.rooms[s.room] ? s : null;

function dialog(id) {
  let d = document.getElementById(id);
  if (!d) { d = document.createElement('dialog'); d.id = id; d.setAttribute('aria-labelledby', `${id}-h`); d.addEventListener('keydown', (e) => e.stopPropagation()); document.body.append(d); }
  return d;
}

// env: { sync(): createSync の入れ物, items(), status(): {ready, pending, error}, toast(msg, undo), save(item),
//        rows(items): 品目の行のHTML, rowClick(button): 行の操作(−/＋・編集)をしたら true, edit(item), add(場所名), scan(場所名), ctx(): 追加先 }
export function mountPlan(host, env) {
  const S = { scope: 'house', edit: false, sel: null, zoom: 1, pal: false, more: false, sheet: null };
  let drag = null, pending = false, dragMoved = false, own = 0, destroyed = false, msgT = 0, openerKey = '';
  const sync = () => env.sync(), lay = () => sync().layout;
  let seen = lay();
  host.innerHTML = '<div class="vh" role="status" aria-live="polite"></div><div class="fpmain"></div>';
  const srEl = host.firstChild, main = host.lastChild;
  let msg = '';
  const msgHtml = () => `<p class="fpmsg" ${msg ? '' : 'hidden'}>${esc(msg)}</p>`;
  // 操作の結果(ずらした・動かせない など)。見える所(平面図の上)と読み上げ用の領域の両方に出す。9秒で消える
  const say = (m, quiet) => { // quiet=読み上げだけ(画面には、すでに見えている変化)
    msg = quiet ? '' : m || ''; srEl.textContent = ''; setTimeout(() => { srEl.textContent = m || ''; }, 30);
    const e = main.querySelector('.fpmsg'); if (e) { e.textContent = msg; e.hidden = !msg; }
    clearTimeout(msgT); if (msg) msgT = setTimeout(() => say(''), 9000);
  };
  const house = () => S.scope === 'house';
  const sorted = (a) => [...a].sort(byPos);
  const typing = () => { const a = document.activeElement; return !!(a?.matches?.('input') && main.contains(a) && a.value !== a.defaultValue); }; // 入力中(値を変えた)の間は、再描画を待つ

  // ---- 描き方 ----
  const roomRows = (L) => clamp(Math.max(bounds(L).maxY, 4) + (S.edit ? 3 : 0), S.edit ? 8 : 4, MAX_ROWS);
  function rectHtml(e, type, s, rows) {
    const rm = type === 'room', k = rm ? roomKind(e.kind) : spotKind(e.kind), color = rm ? roomColor(e) : spotColor(e);
    const W = rm ? GRID_W : SPOT_GRID, H = rm ? rows : SPOT_GRID, sel = S.edit && S.sel === e.id;
    const pos = `left:${(e.x / W) * 100}%;top:${(e.y / H) * 100}%;width:${(e.w / W) * 100}%;height:${(e.h / H) * 100}%`;
    const hd = sel ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="fphd ${h}" data-h="${h}" aria-hidden="true"></span>`).join('') : '';
    return `<div class="fpr${sel ? ' sel' : ''}" role="button" tabindex="0" data-eid="${esc(e.id)}" data-k="${type}" aria-label="${esc(lbl(e.name, s) + (sel ? '、選択中' : ''))}"${S.edit ? ` aria-pressed="${sel}"` : ''} style="${pos};--rb:var(--c-${color}-bg);--rf:var(--c-${color}-fg)"><span class="fpi"><span class="ic" aria-hidden="true">${k.icon}</span><span class="nm">${esc(e.name)}</span><span class="brk"></span><span class="ct">${s.count}品</span><span class="bd" aria-hidden="true">${pills(s)}</span></span>${hd}</div>`;
  }
  function rowHtml(e, type, s) {
    const k = type === 'room' ? roomKind(e.kind) : spotKind(e.kind), sel = S.edit && S.sel === e.id;
    return `<li><button type="button" class="fprow${sel ? ' sel' : ''}" data-eid="${esc(e.id)}" data-k="${type}"${S.edit ? ` aria-pressed="${sel}"` : ''}><span class="ic" aria-hidden="true">${k.icon}</span><span class="fprn"><b>${esc(e.name)}</b><span class="sub">${s.count}品</span>${estNote(s)}</span><span class="bdg">${pills(s, true)}</span><span class="chev" aria-hidden="true">›</span></button></li>`;
  }
  const modeSeg = () => `<div class="seg fpmode" role="group" aria-label="モード"><button type="button" data-a="mode" data-v="view" aria-pressed="${!S.edit}">見る</button><button type="button" data-a="mode" data-v="edit" aria-pressed="${S.edit}">✏️ 編集</button></div>`;
  const hint = (t) => (S.edit ? `<p class="sub fphint">${t}</p>` : '');
  function paletteHtml() {
    const hs = house(), ks = hs ? ROOM_KINDS : SPOT_KINDS;
    return `<section class="fppal" aria-label="${hs ? '部屋' : '収納場所'}を置く"><button type="button" class="b fppb" data-a="pal" aria-expanded="${S.pal}" aria-controls="fp-pal"><span aria-hidden="true">${S.pal ? '▾' : '▸'}</span> ＋ ${hs ? '部屋' : '収納場所'}を置く</button>`
      + `<div id="fp-pal" class="chips fpk" role="group" aria-label="${hs ? '部屋' : '収納場所'}の種類" ${S.pal ? '' : 'hidden'}>${ks.map((k) => `<button type="button" class="chip" data-a="add" data-kind="${k.kind}"><span aria-hidden="true">${k.icon}</span> ${esc(k.label)}</button>`).join('')}</div></section>`;
  }
  function toolbarHtml(L, sum) {
    const hs = house(), e = hs ? L.rooms[S.sel] : spotOk(L, L.spots[S.sel]);
    if (!S.edit || !S.sel || !e) return '';
    const s = hs ? sum.rooms[e.id] : sum.spots[e.id];
    const mv = (dx, dy, t, a) => `<button type="button" class="b" data-a="mv" data-dx="${dx}" data-dy="${dy}" aria-label="${a}">${t}</button>`;
    const sz = (dw, dh, t, a) => `<button type="button" class="b" data-a="sz" data-dw="${dw}" data-dh="${dh}" aria-label="${a}">${t}</button>`;
    return `<section class="card fptb" aria-labelledby="fptb-h"><h4 id="fptb-h" class="fptbh">選んだ四角: <b>${esc(e.name)}</b> <span class="sub">${e.w}×${e.h}${hs ? 'マス' : ''}</span></h4>`
      + `<div class="fpr2"><span class="fpl2" id="fp-mvl">動かす</span><div class="fpbs" role="group" aria-labelledby="fp-mvl">${mv(-1, 0, '←', '1マス左へ')}${mv(0, -1, '↑', '1マス上へ')}${mv(0, 1, '↓', '1マス下へ')}${mv(1, 0, '→', '1マス右へ')}</div></div>`
      + `<div class="fpr2"><span class="fpl2" id="fp-szl">大きさ</span><div class="fpbs" role="group" aria-labelledby="fp-szl">${sz(1, 0, '横＋', '横に1マス広げる')}${sz(-1, 0, '横−', '横を1マス縮める')}${sz(0, 1, '縦＋', '縦に1マス広げる')}${sz(0, -1, '縦−', '縦を1マス縮める')}</div></div>`
      + `<details class="fpmore"${S.more ? ' open' : ''}><summary>名前${hs ? '・色' : ''}を変える</summary><form class="fpn" data-f="rename"><label for="fp-nm">名前${hs ? '' : '(品の「置き場所」の名前になります)'}</label><div class="row"><input id="fp-nm" maxlength="${NAME_MAX}" value="${esc(e.name)}" enterkeyhint="done" autocomplete="off"><button type="submit" class="b">名前を変える</button></div></form>`
      + (hs ? `<div class="fpcol" role="radiogroup" aria-label="部屋の色">${Object.keys(COLOR_TOKENS).map((c) => `<button type="button" class="fpsw" role="radio" aria-checked="${roomColor(e) === c}" data-a="color" data-c="${c}" aria-label="${COLOR_JA[c] || c}" style="background:var(--c-${c}-bg);border-color:var(--c-${c}-fg);color:var(--c-${c}-fg)">${roomColor(e) === c ? '✓' : ''}</button>`).join('')}</div>` : '') + '</details>'
      + `<div class="row fpbt">${hs ? '<button type="button" class="b grow" data-a="open">この部屋の中を編集 ›</button>' : '<button type="button" class="b grow" data-a="look">在庫を見る</button>'}<button type="button" class="b d" data-a="del">削除</button></div>`
      + (s.count ? `<p class="sub">消しても、品(${s.count}品)は消えません。「間取りにない置き場所」に出ます。</p>` : '') + '</section>';
  }
  function emptyHtml() {
    return `<div class="card fpe"><div class="big" aria-hidden="true">🏠</div><h3 class="fpt" id="fp-t" tabindex="-1">間取りを作りましょう</h3><p class="sub">部屋と収納場所を四角で並べて、自分の家の間取りを作ります。場所ごとに在庫を見たり、その場所に追加したりできます。家族とも共有されます。</p>`
      + '<button type="button" class="b p fpbig" data-a="blank">空から作る</button>'
      + `<h4 class="fph4">ひな形から始める</h4><p class="sub">選ぶと部屋が並んだ状態で始まります。あとから自由に動かせます。</p><div class="chips fpk" role="group" aria-label="ひな形">${STARTER_KINDS.filter((k) => k.kind !== 'empty').map((k) => `<button type="button" class="chip" data-a="tpl" data-t="${k.kind}">${esc(k.label)}</button>`).join('')}</div></div>`;
  }
  function unplacedHtml(L) {
    if (!Object.keys(L.rooms).length) return '';
    const u = unplaced(L, env.items()), named = u.filter((g) => !g.empty), blank = u.find((g) => g.empty);
    if (!named.length && !blank) return '';
    const n = named.reduce((a, g) => a + g.count, 0);
    return `<section class="card fpu" aria-labelledby="fpu-h">${named.length ? `<h3 id="fpu-h">間取りにない置き場所 ${named.length}</h3><p class="sub">在庫の「置き場所」のうち、間取りの部屋・収納場所にない名前です(${n}品)。間取りに置くと、その場所から在庫が見られます。</p><button type="button" class="b" data-a="unp">一覧を見る</button>` : '<h3 id="fpu-h">場所が未設定の品</h3>'}`
      + (blank ? `<p class="sub fpnl">場所が未設定の品が ${blank.count}品 あります。品を開いて「置き場所」を選ぶと、その場所に入ります。</p><button type="button" class="b" data-a="noloc">場所が未設定の品を見る</button>` : '') + '</section>';
  }
  function houseHtml(L, sum) {
    const rooms = sorted(Object.values(L.rooms)), rows = roomRows(L), z = S.zoom;
    return `<div class="fph"><h3 class="fpt vh" id="fp-t" tabindex="-1">間取り</h3>${modeSeg()}<div class="fpz" role="group" aria-label="表示の大きさ"><button type="button" class="b" data-a="zout" aria-label="小さく見る" aria-disabled="${z <= ZOOMS[0]}">－</button><span class="fpzv">${Math.round(z * 100)}%</span><button type="button" class="b" data-a="zin" aria-label="大きく見る" aria-disabled="${z >= ZOOMS[ZOOMS.length - 1]}">＋</button></div></div>`
      + msgHtml() + hint('編集中: 部屋の四角をなぞると動きます。タップで選ぶと、つまみと下のボタンが出ます。')
      + `<div class="fpw ${z === 1 ? 'z1' : 'zz'}" style="--z:${z}"><div class="fpc${S.edit ? ' ed' : ''}" role="group" aria-label="家の間取り" data-rows="${rows}" style="--gx:${GRID_W};--gy:${rows};--rows:${rows}">${rooms.map((r) => rectHtml(r, 'room', sum.rooms[r.id], rows)).join('')}<div class="fpg" hidden></div></div></div>`
      + toolbarHtml(L, sum) + (S.edit ? paletteHtml() : '')
      + `<section aria-labelledby="fpl-h"><h4 class="fph4" id="fpl-h">部屋の一覧</h4><ul class="fpl">${rooms.map((r) => rowHtml(r, 'room', sum.rooms[r.id])).join('')}</ul></section>` + unplacedHtml(L);
  }
  function roomHtml(L, sum) {
    const room = L.rooms[S.scope], spots = sorted(Object.values(L.spots).filter((s) => s.room === room.id)), rs = sum.rooms[room.id], lo = rs.loose, k = roomKind(room.kind), rc = roomColor(room);
    return `<div class="fph"><div class="fpbc" role="navigation" aria-label="いまの場所"><button type="button" class="fpbk" data-a="home">‹ 間取り</button><span aria-hidden="true">›</span><h3 class="fpt" id="fp-t" tabindex="-1" aria-current="page"><span aria-hidden="true">${k.icon}</span> ${esc(room.name)}</h3></div>${modeSeg()}</div>`
      + `<p class="fpsum">この部屋の品: <b>${rs.count}品</b> ${pills(rs, true)}${estNote(rs)}</p>`
      + msgHtml() + hint('編集中: 収納場所の四角をなぞると動きます。タップで選ぶと、つまみと下のボタンが出ます。')
      + `<div class="fpw z1"><div class="fpc room${S.edit ? ' ed' : ''}" role="group" aria-label="${esc(room.name)}の間取り" style="--gx:${SPOT_GRID};--gy:${SPOT_GRID};--rw:${room.w};--rh:${room.h};--rc:var(--c-${rc}-fg)">${spots.map((s) => rectHtml(s, 'spot', sum.spots[s.id])).join('')}<div class="fpg" hidden></div></div></div>`
      + (!spots.length ? `<p class="sub fpnone">${S.edit ? '' : 'まだ収納場所がありません。「✏️ 編集」で、冷蔵庫や棚などの四角を置けます。'}</p>` : '')
      + toolbarHtml(L, sum) + (S.edit ? paletteHtml() : '')
      + `<div class="row fpra"><button type="button" class="b p grow" data-a="addroom">＋ この部屋に追加</button></div>`
      + `<section aria-labelledby="fpl-h"><h4 class="fph4" id="fpl-h">収納場所の一覧</h4><ul class="fpl">${spots.map((s) => rowHtml(s, 'spot', sum.spots[s.id])).join('')}`
      + `<li><button type="button" class="fprow" data-a="loose"><span class="ic" aria-hidden="true">📦</span><span class="fprn"><b>この部屋のその他の品</b><span class="sub">${lo.count}品 ・ 場所を細かく決めていない品</span>${estNote(lo)}</span><span class="bdg">${pills(lo, true)}</span><span class="chev" aria-hidden="true">›</span></button></li></ul></section>`;
  }

  function render() {
    if (destroyed) return;
    const L = lay(), st = env.status(), fk = keyOf(document.activeElement, main), sx = main.querySelector('.fpw')?.scrollLeft || 0;
    if (!house() && !L.rooms[S.scope]) { S.scope = 'house'; S.sel = null; S.sheet = null; say('この部屋は、ほかの人が消しました'); }
    if (S.sel && !(house() ? L.rooms[S.sel] : spotOk(L, L.spots[S.sel])?.room === S.scope)) S.sel = null;
    const sum = summarize(L, env.items(), Date.now()), none = !Object.keys(L.rooms).length;
    host.classList.toggle('ed', S.edit);
    const status = st.pending ? '<p class="sub fpsync" role="status">同期中…(オフラインでも編集できます。つながると送られます)</p>' : st.error ? '<p class="sub fpsync warn" role="status">⚠ 同期エラー: 間取りを送れていないかもしれません</p>' : '';
    main.innerHTML = !st.ready ? '<p class="sub" role="status">間取りを読み込んでいます…</p>' : (none && !S.edit) ? emptyHtml() : status + (house() ? houseHtml(L, sum) : roomHtml(L, sum));
    tiers();
    const sc = main.querySelector('.fpw'); if (sc && sx) sc.scrollLeft = sx;
    if (fk) main.querySelector(fk)?.focus({ preventScroll: true });
  }
  // 四角の大きさに合わせて、中に出す文字を決める(小さい四角は絵文字だけ。名前や数は下の一覧で見られる)
  function tiers() {
    main.querySelectorAll('.fpr').forEach((r) => {
      const b = r.getBoundingClientRect(), w = b.width, h = b.height;
      r.dataset.t = w < 40 || h < 34 ? '0' : w < 56 || h < 50 ? '1' : w < 96 || h < 68 ? '2' : '3';
      r.style.setProperty('--ln', h >= 76 ? '2' : '1');
      if (r.classList.contains('sel')) { // つまみの当たり判定: 大きい四角は44px、小さい四角は縮める
        const hs = Math.round(clamp(Math.min(w, h) * 0.45, 22, 44));
        r.style.setProperty('--hs', `${hs}px`); r.toggleAttribute('data-ex', w >= hs * 3); r.toggleAttribute('data-ey', h >= hs * 3);
      }
    });
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => tiers()) : null; ro?.observe(host);

  // ---- 操作の確定(共有・元に戻す) ----
  function commit(r, msg, o = {}) {
    const before = lay(); let p;
    own++; try { p = sync().apply(r.layout); } finally { own--; }
    const after = lay(); seen = after;
    const fail = (e) => env.toast(`間取りを保存できませんでした: ${e?.code || e?.message || ''}`);
    p.catch(fail);
    const olds = o.items || [];
    env.toast(msg, async () => {
      const { layout, skipped } = undoLayout(lay(), before, after);
      own++; try { sync().apply(layout).catch(fail); } finally { own--; }
      seen = lay(); S.sel = null; refresh();
      for (const i of olds) await env.save(i); // 置き場所を直した品も戻す
      if (skipped.length) say('ほかの人が変更した部分は、そのままにしました');
    });
    refresh();
  }
  const refresh = () => { render(); renderSheet(); };
  const stale = () => { S.sel = null; say(REASON['not-found']); refresh(); };
  const kind = () => (house() ? 'room' : 'spot');
  const cur = (id) => (house() ? lay().rooms[id] : spotOk(lay(), lay().spots[id]));
  const op = (name, ...a) => ({ moveRoom, moveSpot, resizeRoom, resizeSpot, renameRoom, renameSpot, deleteRoom, deleteSpot })[name + (house() ? 'Room' : 'Spot')](lay(), ...a);

  function doMoveBy(dx, dy) {
    const e = cur(S.sel); if (!e) return stale();
    const r = op('move', e.id, e.x + dx, e.y + dy);
    if (!r.ok) return say(REASON[r.reason]);
    if (r.adjusted || !r.changed) return say('となりに当たる、または端なので、これ以上動かせません');
    commit(r, `「${e.name}」を動かしました`);
  }
  function doSizeBy(dw, dh) {
    const e = cur(S.sel); if (!e) return stale();
    const min = house() ? ROOM_MIN : SPOT_MIN, w = e.w + dw, h = e.h + dh;
    if (w < min || h < min) return say(`これ以上小さくできません(${min}マスまで)`);
    const r = op('resize', e.id, { w, h });
    if (!r.ok) return say(REASON[r.reason]);
    if (!r.changed) return say('となりに当たる、または端なので、これ以上大きくできません');
    commit(r, `「${e.name}」の大きさを変えました${r.adjusted ? '(となりの手前で止めました)' : ''}`);
  }
  function doAdd(kindKey) {
    const hs = house(), L = lay(), r = hs ? addRoom(L, kindKey) : addSpot(L, S.scope, kindKey), k = (hs ? roomKind : spotKind)(kindKey);
    if (!r.ok) return say(r.reason === 'no-space' ? (hs ? '部屋を置く空きがありません。ほかの部屋を小さくしてください' : 'この部屋にはもう置けません。ほかの収納場所を小さくしてください') : REASON[r.reason]);
    S.sel = r.id; const cv = main.querySelector('.fpc'); if (cv && cv.getBoundingClientRect().top < 0) cv.scrollIntoView({ block: 'start' });
    const linked = hs ? 0 : summarize(r.layout, env.items()).spots[r.id].count;
    commit(r, `「${r.name}」を置きました${r.name !== k.label ? '(同じ名前があるので、名前を変えました)' : ''}${linked ? `。この場所の品が${linked}品入りました` : ''}`);
  }
  async function doRename(want) {
    const e = cur(S.sel); if (!e) return stale();
    let r = op('rename', e.id, want);
    if (!r.ok) return say(REASON[r.reason]);
    if (!r.changed) return say('名前は変わりませんでした');
    const sum = summarize(lay(), env.items()), mine = (house() ? sum.rooms[e.id].loose : sum.spots[e.id]).items;
    let fix = false;
    if (mine.length) {
      const a = await ask({ title: '置き場所の名前も直しますか?', html: `<p>「${esc(e.name)}」の品が ${mine.length}品 あります。置き場所の名前を「${esc(r.name)}」に直すと、そのまま${house() ? 'この部屋' : 'この場所'}の品のままになります。直さないと、品は「間取りにない置き場所」になります。</p>${nameNote(want, r.name)}`, buttons: [{ label: `${mine.length}品も直す`, v: 'fix', p: true }, { label: '品はそのまま', v: 'keep' }, { label: '名前を変えない', v: null }] });
      if (a === null) return say('名前は変えませんでした');
      fix = a === 'fix';
      r = op('rename', e.id, want); // 待つあいだに変わっていたら、いまの状態でやり直す
      if (!r.ok) return say(REASON[r.reason]);
    }
    const olds = fix ? mine.map((i) => ({ ...i })) : [];
    commit(r, `名前を「${r.name}」にしました${r.name !== String(want).trim() ? '(同じ名前があるため)' : ''}${fix ? `。品${olds.length}個の置き場所も直しました` : ''}`, { items: olds });
    for (const i of olds) await env.save({ ...i, location: r.name });
  }
  const nameNote = (want, got) => (got !== String(want).trim() ? `<p class="sub">「${esc(String(want).trim())}」は家の中で他の部屋・収納場所と同じ名前になるため、「${esc(got)}」になりました。</p>` : '');
  async function doDelete() {
    const e = cur(S.sel); if (!e) return stale();
    const L = lay(), sum = summarize(L, env.items()), hs = house(), n = hs ? sum.rooms[e.id].count : sum.spots[e.id].count, ns = hs ? Object.values(L.spots).filter((s) => s.room === e.id).length : 0;
    const ok = await ask({ title: `「${e.name}」を間取りから消しますか?`, html: `<p>${hs ? `この部屋${ns ? `と、中の収納場所 ${ns}か所` : ''}を間取りから消します。` : 'この収納場所を間取りから消します。'}</p><p><b>品は消えません。</b>${n ? `(${n}品)` : ''}置き場所の名前はそのまま残り、「間取りにない置き場所」に出ます。いつでも置き直せます。</p>`, buttons: [{ label: '消す', v: true, d: true }, { label: 'やめる', v: false, p: true }] });
    if (!ok) return;
    const r = op('delete', e.id); if (!r.ok) return stale();
    S.sel = null; commit(r, `「${e.name}」を間取りから消しました。品は残っています`);
  }
  function doColor(c) {
    const e = cur(S.sel); if (!e || !house()) return stale();
    const r = setRoomColor(lay(), e.id, c); if (r.changed) commit(r, `「${e.name}」の色を${COLOR_JA[c] || c}にしました`);
  }
  function doTemplate(t) {
    if (Object.keys(lay().rooms).length) { say('すでに間取りがあります'); return refresh(); }
    const label = STARTER_KINDS.find((k) => k.kind === t)?.label || '';
    commit({ layout: starterLayout(t) }, `${label}の間取りを入れました。「✏️ 編集」で自由に動かせます`);
  }
  function openRoom(id) {
    S.scope = id; S.sel = null; S.pal = !Object.values(lay().spots).some((s) => s.room === id); render();
    if (host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: 'start' });
    main.querySelector('#fp-t')?.focus({ preventScroll: true });
  }
  function goHome() {
    const id = S.scope; S.scope = 'house'; S.sel = null; render();
    if (host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: 'start' });
    (main.querySelector(`.fpr[data-eid="${CSS.escape(id)}"]`) || main.querySelector('#fp-t'))?.focus({ preventScroll: true });
  }
  function setMode(edit) {
    if (S.edit === edit) return; S.edit = edit; S.sel = null; drag = null;
    S.pal = edit && !(house() ? Object.keys(lay().rooms).length : Object.values(lay().spots).some((s) => s.room === S.scope));
    say(edit ? '編集モードにしました。四角をなぞって動かせます' : '見るモードにしました', true); render();
    main.querySelector(`[data-a="mode"][data-v="${edit ? 'edit' : 'view'}"]`)?.focus({ preventScroll: true });
  }
  function activate(id, k) {
    if (S.edit) { S.sel = id; render(); return; }
    if (k === 'room') openRoom(id); else { openerKey = keyOf(document.activeElement, main); openSheet({ type: 'spot', id }); }
  }

  // ---- クリック・キー ----
  host.addEventListener('click', (e) => {
    if (dragMoved) { dragMoved = false; return; }
    const t = e.target.closest('[data-eid],[data-a],.fpc,.fpw'); if (!t || !main.contains(t)) return;
    if (t.dataset.eid) return activate(t.dataset.eid, t.dataset.k);
    const a = t.dataset.a;
    if (!a) { if (S.edit && S.sel && (e.target.classList.contains('fpc') || e.target.classList.contains('fpw'))) { S.sel = null; render(); } return; }
    if (a === 'mode') return setMode(t.dataset.v === 'edit');
    if (a === 'home') return goHome();
    if (a === 'zin' || a === 'zout') { const i = ZOOMS.indexOf(S.zoom) + (a === 'zin' ? 1 : -1); if (i < 0 || i >= ZOOMS.length) return say(a === 'zin' ? 'これ以上、大きくできません' : 'いちばん小さい表示です'); S.zoom = ZOOMS[i]; say(`表示の大きさ ${Math.round(S.zoom * 100)}%`, true); return render(); }
    if (a === 'pal') { S.pal = !S.pal; return render(); }
    if (a === 'add') return doAdd(t.dataset.kind);
    if (a === 'blank') { S.edit = true; S.pal = true; say('編集モードです。下の「部屋を置く」から種類を選びます', true); render(); return main.querySelector('#fp-t')?.focus({ preventScroll: true }); }
    if (a === 'tpl') return doTemplate(t.dataset.t);
    if (a === 'mv') return doMoveBy(+t.dataset.dx, +t.dataset.dy);
    if (a === 'sz') return doSizeBy(+t.dataset.dw, +t.dataset.dh);
    if (a === 'color') return doColor(t.dataset.c);
    if (a === 'del') return doDelete();
    if (a === 'open') { const id = S.sel; if (id && lay().rooms[id]) openRoom(id); return; }
    if (a === 'look') { openerKey = keyOf(t, main); return openSheet({ type: 'spot', id: S.sel }); }
    if (a === 'addroom') { const r = lay().rooms[S.scope]; if (r) env.add(r.name); return; }
    if (a === 'loose') { openerKey = keyOf(t, main); return openSheet({ type: 'room', id: S.scope }); }
    if (a === 'unp') return unplacedDialog();
    if (a === 'noloc') return nolocDialog();
  });
  host.addEventListener('toggle', (e) => { if (e.target.classList?.contains('fpmore')) S.more = e.target.open; }, true);
  host.addEventListener('submit', (e) => { if (e.target.dataset.f !== 'rename') return; e.preventDefault(); doRename(e.target.querySelector('input').value); });
  host.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (pending && !drag && !typing()) { pending = false; update(); } }, 0); });
  host.addEventListener('keydown', (e) => {
    const r = e.target.closest?.('.fpr'); if (!r || e.target !== r || e.ctrlKey || e.metaKey || e.altKey) return;
    const id = r.dataset.eid, k = r.dataset.k;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return activate(id, k); }
    if (!S.edit) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d) { e.preventDefault(); S.sel = id; return e.shiftKey ? doSizeBy(d[0], d[1]) : doMoveBy(d[0], d[1]); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); S.sel = id; return doDelete(); }
    if (e.key === 'Escape' && S.sel) { S.sel = null; render(); r.isConnected && main.querySelector(`.fpr[data-eid="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
  });

  // ---- なぞって動かす(編集モードだけ。pointer イベントなので指・マウス・ペンどれでも) ----
  host.addEventListener('pointerdown', (e) => {
    if (!S.edit || drag || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.fptb,.fppal')) return;
    const r = e.target.closest('.fpr'), hd = e.target.closest('.fphd'); if (!r) return;
    const id = r.dataset.eid, el = cur(id), cv = r.closest('.fpc'); if (!el) return;
    const hs = house(), rows = +cv.dataset.rows || 0;
    drag = { id, mode: hd ? hd.dataset.h : 'move', sx: e.clientX, sy: e.clientY, ux: cv.clientWidth / GRID_W, uy: hs ? cv.clientHeight / rows : cv.clientHeight / SPOT_GRID, rect: { x: el.x, y: el.y, w: el.w, h: el.h }, el: r, cv, rows, pid: e.pointerId, moved: false, res: null };
    if (!hs) drag.ux = cv.clientWidth / SPOT_GRID;
    try { r.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
    if (e.pointerType === 'mouse') e.preventDefault();
  });
  const preview = (dx, dy) => {
    const d = drag, hs = house(), sx = snap(dx / d.ux), sy = snap(dy / d.uy), L = lay(), id = d.id;
    let r;
    if (d.mode === 'move') r = op('move', id, d.rect.x + sx, d.rect.y + sy);
    else r = op('resize', id, resizeTarget(d.rect, d.mode, sx, sy, hs));
    d.res = r;
    const e = r.ok && (hs ? r.layout.rooms[id] : r.layout.spots[id]);
    if (!e) return;
    const W = hs ? GRID_W : SPOT_GRID, H = hs ? d.rows : SPOT_GRID, box = (el) => { el.style.left = `${(e.x / W) * 100}%`; el.style.top = `${(e.y / H) * 100}%`; el.style.width = `${(e.w / W) * 100}%`; el.style.height = `${(e.h / H) * 100}%`; };
    if (d.mode === 'move') {
      d.el.style.transform = `translate(${dx}px,${dy}px)`;
      const g = d.cv.querySelector('.fpg'); g.hidden = false; g.classList.toggle('adj', !!r.adjusted); box(g);
    } else box(d.el);
    return L;
  };
  host.addEventListener('pointermove', (e) => {
    const d = drag; if (!d || e.pointerId !== d.pid) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved) { if (Math.hypot(dx, dy) < 6) return; d.moved = true; d.el.classList.add('drg'); }
    preview(dx, dy);
  });
  const endDrag = (e, ok) => {
    const d = drag; if (!d || e.pointerId !== d.pid) return;
    drag = null; try { d.el.releasePointerCapture(e.pointerId); } catch { /* 済み */ }
    if (d.moved) { dragMoved = true; setTimeout(() => { dragMoved = false; }, 60); }
    if (ok && d.moved && d.res) {
      const r = d.res, el = cur(d.id);
      if (!r.ok || !el) { say(REASON[r.reason] || REASON['not-found']); S.sel = null; seen = lay(); refresh(); }
      else if (!r.changed) { say(r.adjusted ? 'となりに当たるので、動かせませんでした' : ''); render(); }
      else { S.sel = d.id; const nm = el.name; commit(r, d.mode === 'move' ? `「${nm}」を動かしました${r.adjusted ? '(重なるので、近くの空きにずらしました)' : ''}` : `「${nm}」の大きさを変えました${r.adjusted ? '(となりの手前で止めました)' : ''}`); }
    } else if (d.moved) render(); // やめた(pointercancel): 元の表示に戻す
    if (pending) { pending = false; update(); }
  };
  host.addEventListener('pointerup', (e) => endDrag(e, true));
  host.addEventListener('pointercancel', (e) => endDrag(e, false));

  // ---- ダイアログ ----
  function ask({ title, html = '', buttons }) {
    const d = dialog('fpd'); if (d.open) d.close();
    return new Promise((resolve) => {
      let v = null;
      d.className = 'fpd'; d.innerHTML = `<h3 id="fpd-h" tabindex="-1">${esc(title)}</h3><div class="fpdb">${html}</div><div class="btns">${buttons.map((b, i) => `<button type="button" class="b${b.p ? ' p' : ''}${b.d ? ' d' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
      d.onclick = (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; v = buttons[+b.dataset.i].v; d.close(); };
      d.onclose = () => { if (!d.open) resolve(v); }; // close は遅れて届く: 開き直したあとの古い close は無視する
      d.showModal(); d.querySelector('#fpd-h').focus({ preventScroll: true });
    });
  }
  // 「間取りにない置き場所」: 一覧 → どの部屋に置くか → 収納場所を作る(名前は品の置き場所と同じ)
  function unplacedDialog() {
    const d = dialog('fpd'); if (d.open) d.close();
    const list = unplaced(lay(), env.items()).filter((g) => !g.empty);
    d.className = 'fpd';
    const step1 = () => {
      d.innerHTML = `<h3 id="fpd-h" tabindex="-1">間取りにない置き場所</h3><p class="sub">品の「置き場所」に付いている名前のうち、間取りにないものです。間取りに置くと、その場所から在庫が見られます。</p>`
        + (list.length ? `<ul class="fpl">${list.map((g, i) => `<li class="fpup"><span class="fprn"><b>${esc(g.name)}</b><span class="sub">${g.count}品</span></span><button type="button" class="b" data-p="${i}" aria-label="「${esc(g.name)}」を間取りに置く">間取りに置く</button></li>`).join('')}</ul>` : '<p>ありません。</p>') + '<div class="btns"><button type="button" class="b p" data-x>閉じる</button></div>';
      d.querySelector('#fpd-h').focus({ preventScroll: true });
    };
    let chosen = null;
    const step2 = (g) => {
      chosen = g;
      const rooms = sorted(Object.values(lay().rooms));
      d.innerHTML = `<h3 id="fpd-h" tabindex="-1">「${esc(g.name)}」を、どの部屋に置きますか?</h3><p class="sub">${g.count}品の置き場所です。部屋の中に収納場所の四角を作ります(名前は「${esc(g.name)}」のまま)。</p>`
        + `<ul class="fpl">${rooms.map((r) => `<li><button type="button" class="fprow" data-r="${esc(r.id)}"><span class="ic" aria-hidden="true">${roomKind(r.kind).icon}</span><span class="fprn"><b>${esc(r.name)}</b></span><span class="chev" aria-hidden="true">›</span></button></li>`).join('')}</ul><div class="btns"><button type="button" class="b" data-back>← もどる</button><button type="button" class="b" data-x>やめる</button></div>`;
      d.querySelector('#fpd-h').focus({ preventScroll: true });
    };
    d.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.x !== undefined) return d.close();
      if (b.dataset.back !== undefined) return step1();
      if (b.dataset.p !== undefined) return Object.keys(lay().rooms).length ? step2(list[+b.dataset.p]) : say('先に部屋を作ってください');
      if (b.dataset.r === undefined) return;
      const g = chosen; d.close(); if (g) await placeSpot(g, b.dataset.r);
    };
    d.onclose = () => {};
    step1(); d.showModal();
  }
  async function placeSpot(g, roomId) {
    const L = lay(); if (!L.rooms[roomId]) return stale();
    let r = addSpot(L, roomId, guessSpotKind(g.name), { name: g.name });
    if (!r.ok) return say(r.reason === 'no-space' ? 'その部屋にはもう置けません。ほかの部屋を選ぶか、収納場所を小さくしてください' : REASON[r.reason]);
    let fix = false;
    if (r.name !== g.name) {
      const a = await ask({ title: `名前が「${r.name}」になりました`, html: `<p>「${esc(g.name)}」は家の中で他の部屋・収納場所と同じ名前になるため、「${esc(r.name)}」になりました。この場所の品 ${g.count}個の置き場所も「${esc(r.name)}」に直しますか?</p>`, buttons: [{ label: `${g.count}品も直す`, v: 'fix', p: true }, { label: '直さない', v: 'keep' }, { label: 'やめる', v: null }] });
      if (a === null) return;
      fix = a === 'fix';
      r = addSpot(lay(), roomId, guessSpotKind(g.name), { name: g.name }); if (!r.ok) return stale();
    }
    const olds = fix ? g.items.map((i) => ({ ...i })) : [];
    S.scope = roomId; S.edit = true; S.sel = r.id; S.pal = false;
    commit(r, `「${r.name}」を「${lay().rooms[roomId].name}」に置きました。なぞって動かせます${fix ? `。品${olds.length}個の置き場所も直しました` : ''}`, { items: olds });
    for (const i of olds) await env.save({ ...i, location: r.name });
    main.querySelector('#fp-t')?.focus({ preventScroll: true });
  }
  function nolocDialog() {
    const d = dialog('fpd'); if (d.open) d.close();
    const g = unplaced(lay(), env.items()).find((x) => x.empty), list = g ? g.items.slice(0, 40) : [];
    d.className = 'fpd';
    d.innerHTML = `<h3 id="fpd-h" tabindex="-1">場所が未設定の品</h3><p class="sub">品をタップして「置き場所」を選ぶと、その場所に入ります(間取りに置かれた場所から選べます)。</p>${list.length ? `<ul class="fpl">${list.map((i) => `<li><button type="button" class="fprow" data-i="${esc(i.id)}"><span class="fprn"><b>${esc(i.name)}</b><span class="sub">残り ${esc(i.qty)}</span></span><span class="chev" aria-hidden="true">›</span></button></li>`).join('')}</ul>${g.count > 40 ? `<p class="sub">ほか ${g.count - 40}品</p>` : ''}` : '<p>ありません。</p>'}<div class="btns"><button type="button" class="b p" data-x>閉じる</button></div>`;
    d.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.x !== undefined) return d.close();
      const it = env.items().find((x) => x.id === b.dataset.i); if (it) { d.close(); env.edit(it); }
    };
    d.onclose = () => {}; d.showModal(); d.querySelector('#fpd-h').focus({ preventScroll: true });
  }

  // ---- 収納場所のシート(下から出る): その場所の在庫・追加 ----
  // モーダルにすると、外にある「元に戻す」のトーストまで操作できなくなる。そこで非モーダルの dialog にして、背景(header/main/ナビ)を inert にして閉じ込めを保つ
  const BG = 'header,main,#tabs';
  const sheetOpen = (d) => {
    d.show(); document.querySelectorAll(BG).forEach((e) => { e.inert = true; });
    let bd = document.getElementById('fpsbd'); if (!bd) { bd = document.createElement('div'); bd.id = 'fpsbd'; document.body.append(bd); }
    bd.onclick = () => d.close();
  };
  const sheetShut = () => { document.querySelectorAll(BG).forEach((e) => { e.inert = false; }); document.getElementById('fpsbd')?.remove(); };
  function openSheet(s) { S.sheet = s; renderSheet(); }
  function renderSheet() {
    const d = dialog('fps');
    if (!S.sheet) { if (d.open) d.close(); return; }
    const L = lay(), { type, id } = S.sheet, el = type === 'spot' ? spotOk(L, L.spots[id]) : L.rooms[id];
    if (!el) { S.sheet = null; if (d.open) d.close(); say('その場所は、ほかの人が消しました'); return; }
    const sum = summarize(L, env.items(), Date.now()), room = type === 'spot' ? L.rooms[el.room] : el, s = type === 'spot' ? sum.spots[id] : sum.rooms[id].loose;
    const ic = (type === 'spot' ? spotKind(el.kind) : roomKind(el.kind)).icon, fk = d.open ? keyOf(document.activeElement, d) : '', st = d.scrollTop, c = env.ctx();
    const title = type === 'spot' ? el.name : `${el.name}のその他の品`, crumb = type === 'spot' ? `${esc(room.name)} › ${esc(el.name)}` : `${esc(room.name)}(場所を細かく決めていない品)`;
    d.classList.add('fps');
    d.innerHTML = `<div class="fpsr"><span class="ic" aria-hidden="true">${ic}</span><div class="grow"><h3 id="fps-h" tabindex="-1">${esc(title)}</h3><div class="sub">${crumb}</div></div><button type="button" class="b" data-x aria-label="閉じる">✕</button></div>`
      + `<div class="fpsb"><b>${s.count}品</b>${pills(s, true)}${estNote(s)}</div>`
      + `<div class="fpsa"><button type="button" class="b p" data-a="add">＋ ${type === 'spot' ? 'ここに追加' : 'この部屋に追加'}</button><button type="button" class="b" data-a="scan">📷 バーコードで続けて追加</button></div>`
      + (c?.sticky && c.location === el.name ? '<p class="sub fpfix" role="status">追加先を「' + esc(el.name) + '」に固定しています(追加先バーの「固定をはずす」で戻せます)。</p>' : '')
      + `<div class="fpsl">${s.items.length ? env.rows(s.items) : `<p class="sub fpnone">まだ品がありません。「＋ ${type === 'spot' ? 'ここに追加' : 'この部屋に追加'}」で入れます。</p>`}</div>`;
    d.onclick = (e) => {
      if (e.target === d) { const b = d.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) d.close(); return; }
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.x !== undefined) return d.close();
      if (b.dataset.a === 'add') return env.add(el.name);
      if (b.dataset.a === 'scan') return env.scan(el.name);
      env.rowClick(b);
    };
    d.setAttribute('aria-modal', 'true');
    d.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); d.close(); } };
    d.onclose = () => { if (d.open) return; S.sheet = null; sheetShut(); if (!destroyed) (openerKey && main.querySelector(openerKey))?.focus({ preventScroll: true }); };
    if (!d.open) { sheetOpen(d); d.querySelector('#fps-h').focus({ preventScroll: true }); }
    else { d.scrollTop = st; if (fk) d.querySelector(fk)?.focus({ preventScroll: true }); }
  }

  // ---- 外からの更新(他の人の編集・在庫の変化) ----
  function update() {
    if (destroyed) return;
    if (drag || typing()) { pending = true; return; }
    if (own) return;
    const L = lay(), prev = seen; seen = L;
    const ch = prev === L ? [] : touchedIds(prev, L);
    if (ch.length) {
      if (S.sel && ch.includes(S.sel)) { const gone = !(L.rooms[S.sel] || L.spots[S.sel]); say(gone ? 'ほかの人が、選んでいた四角を消しました' : 'ほかの人が、選んでいた四角を変更しました'); if (gone) S.sel = null; }
      else say('ほかの人が間取りを変更しました');
    }
    refresh();
  }
  function destroy() {
    destroyed = true; clearTimeout(msgT); ro?.disconnect();
    for (const id of ['fps', 'fpd']) { const d = document.getElementById(id); if (d) { d.onclose = null; if (d.open) d.close(); } }
    sheetShut();
  }
  render();
  return { update, destroy, state: S };
}
