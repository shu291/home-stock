// 間取り(部屋と収納場所の四角)のデータモデル。DOM/Firestore 非依存の純粋関数。操作は元のモデルを変えず新しいモデルを返す。
//
// layout = { v: 1, rooms: { [id]: Room }, spots: { [id]: Spot }, dead: { [id]: 削除した時刻(ms) } }
//   Room = { id, name, kind, x, y, w, h, color, u }   家全体の平面図の四角。単位は「マス」(整数)。横は GRID_W マス固定・縦は MAX_ROWS マスまで
//   Spot = { id, room, name, kind, x, y, w, h, u }    部屋の中の収納場所。座標は「部屋を SPOT_GRID×SPOT_GRID に正規化した刻み」(整数 0〜24)
// 収納場所を正規化座標で持つので、部屋を拡大縮小しても収納場所は壊れない(部屋の四角だけが変わり、収納場所のデータは触らない)。
// 描画は spotRect(room, spot, 描画幅px, 描画高px)。部屋の縦横比で描くと収納場所も同じ比に伸縮する。
//
// u = その要素の最終更新時刻(ms)。共有(applyRemote)では要素ごとに u が新しいほうが勝つ(LWW)。
// 削除は dead[id] = u の墓標(要素は rooms/spots から消える)。同時に別の端末で編集されても、削除が新しければ消え、編集が新しければ残る。
// 墓標は compact() で TOMB_DAYS 日より古いものを捨てる。
import { canonLocation, COLOR_TOKENS } from './taxonomy.js';
import { expiryDays, EXPIRY_DAYS } from './optimize.js';

export const GRID_W = 24;      // 平面図の横(マス)
export const MAX_ROWS = 60;    // 平面図の縦の上限(マス)
export const ROOM_MIN = 2, ROOM_MAX = 24;   // 部屋の幅・高さ(マス)
export const SPOT_GRID = 24;   // 部屋の中の刻み数(縦横とも)
export const SPOT_MIN = 2;     // 収納場所の幅・高さの最小(刻み)
export const NAME_MAX = 20;       // 入力できる名前の長さ(一意化で添える部屋名・番号を足すと長くなるので、保存側は NAME_STORED まで許す)
const NAME_STORED = 80;
export const TOMB_DAYS = 60;
export const DELETE = '__hs_delete__'; // diffLayout の「このパスを消す」印。store.js が deleteField() に置き換える

// ---- ひな形(種類) ----
export const ROOM_KINDS = [
  { kind: 'living', label: 'リビング', icon: '🛋️', w: 8, h: 6, color: 'orange' },
  { kind: 'dining', label: 'ダイニング', icon: '🍽️', w: 6, h: 5, color: 'amber' },
  { kind: 'kitchen', label: 'キッチン', icon: '🍳', w: 6, h: 4, color: 'green' },
  { kind: 'bedroom', label: '寝室', icon: '🛏️', w: 6, h: 5, color: 'purple' },
  { kind: 'kids', label: '子ども部屋', icon: '🧸', w: 5, h: 5, color: 'pink' },
  { kind: 'study', label: '書斎', icon: '📚', w: 4, h: 4, color: 'blue' },
  { kind: 'washroom', label: '洗面所', icon: '🚿', w: 3, h: 3, color: 'teal' },
  { kind: 'bath', label: 'お風呂', icon: '🛁', w: 3, h: 3, color: 'blue' },
  { kind: 'toilet', label: 'トイレ', icon: '🚽', w: 2, h: 3, color: 'teal' },
  { kind: 'entrance', label: '玄関', icon: '🚪', w: 4, h: 3, color: 'orange' },
  { kind: 'hall', label: '廊下', icon: '🚶', w: 2, h: 5, color: 'gray' },
  { kind: 'balcony', label: 'ベランダ', icon: '🌿', w: 8, h: 2, color: 'green' },
  { kind: 'garden', label: '庭', icon: '🌳', w: 8, h: 5, color: 'green' },
  { kind: 'garage', label: '車庫', icon: '🚗', w: 6, h: 6, color: 'gray' },
  { kind: 'storeroom', label: '納戸', icon: '🗄️', w: 3, h: 3, color: 'amber' },
  { kind: 'other', label: 'その他', icon: '📦', w: 4, h: 4, color: 'gray' },
];
export const SPOT_KINDS = [
  { kind: 'fridge', label: '冷蔵庫', icon: '🧊', w: 5, h: 6, color: 'blue' },
  { kind: 'freezer', label: '冷凍庫', icon: '❄️', w: 5, h: 4, color: 'teal' },
  { kind: 'pantry', label: 'パントリー', icon: '🥫', w: 6, h: 6, color: 'amber' },
  { kind: 'cupboard', label: '食器棚', icon: '🍽️', w: 7, h: 4, color: 'orange' },
  { kind: 'shelf', label: '棚', icon: '📚', w: 8, h: 3, color: 'green' },
  { kind: 'drawer', label: '引き出し', icon: '🗃️', w: 6, h: 4, color: 'purple' },
  { kind: 'closet', label: 'クローゼット', icon: '👕', w: 9, h: 4, color: 'pink' },
  { kind: 'oshiire', label: '押入れ', icon: '🛏️', w: 10, h: 5, color: 'purple' },
  { kind: 'sink', label: '洗面台の下', icon: '🚿', w: 7, h: 4, color: 'teal' },
  { kind: 'genkan', label: '玄関収納', icon: '🚪', w: 8, h: 4, color: 'orange' },
  { kind: 'veranda', label: 'ベランダ収納', icon: '🌿', w: 8, h: 4, color: 'green' },
  { kind: 'mono', label: '物置', icon: '📦', w: 8, h: 6, color: 'amber' },
  { kind: 'car', label: '車', icon: '🚗', w: 10, h: 7, color: 'gray' },
  { kind: 'other', label: 'その他', icon: '📦', w: 5, h: 5, color: 'gray' },
];
const RK = new Map(ROOM_KINDS.map((k) => [k.kind, k])), SK = new Map(SPOT_KINDS.map((k) => [k.kind, k]));
export const roomKind = (k) => RK.get(k) || RK.get('other');
export const spotKind = (k) => SK.get(k) || SK.get('other');
// 描画用の色トークン名(style.css の --c-<token>-bg / -fg)。収納場所は種類ごとの既定色
export const spotColor = (spot) => spotKind(spot?.kind).color;
export const roomColor = (room) => (COLOR_TOKENS[room?.color] ? room.color : roomKind(room?.kind).color);

// ---- 基本 ----
export const emptyLayout = () => ({ v: 1, rooms: {}, spots: {}, dead: {} });
const AR = { w: GRID_W, h: MAX_ROWS, min: ROOM_MIN, maxW: ROOM_MAX, maxH: ROOM_MAX };   // 部屋を置ける範囲
const AS = { w: SPOT_GRID, h: SPOT_GRID, min: SPOT_MIN, maxW: SPOT_GRID, maxH: SPOT_GRID }; // 部屋の中
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, isNum(v) ? Math.round(v) : lo));
const ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const free = (others, r) => !others.some((o) => ov(o, r));
const rectOf = (e) => ({ x: e.x, y: e.y, w: e.w, h: e.h });
const same = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const byU = (a, b) => a.u - b.u || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const rnd = () => { try { const a = crypto.getRandomValues(new Uint32Array(2)); return (a[0].toString(36) + a[1].toString(36)).slice(0, 8); } catch { return Math.random().toString(36).slice(2, 10); } };
const newId = (p, L) => { for (;;) { const id = `${p}_${rnd().padEnd(6, '0')}`; if (!L.rooms[id] && !L.spots[id] && L.dead[id] === undefined) return id; } };
// 編集時刻: 他の端末の時計が進んでいても、自分の編集が負けないよう必ず前より大きくする
const stamp = (now, old) => Math.max(isNum(now) ? now : Date.now(), (old?.u || 0) + 1);

// 範囲 A に収まる四角へ丸める(大きさ→位置の順)
function fit(r, A) {
  const w = clampI(r.w, A.min, Math.min(A.maxW, A.w)), h = clampI(r.h, A.min, Math.min(A.maxH, A.h));
  return { x: clampI(r.x, 0, A.w - w), y: clampI(r.y, 0, A.h - h), w, h };
}
// 重ならない、希望位置にいちばん近い空き位置(同距離なら上・左を優先)。first=true は上から左から最初の空き。無ければ null
function place(others, r, A, first) {
  const f = fit(r, A);
  if (!first && free(others, f)) return f;
  let best = null, bd = Infinity;
  for (let y = 0; y <= A.h - f.h; y++) for (let x = 0; x <= A.w - f.w; x++) {
    const c = { x, y, w: f.w, h: f.h };
    if (!free(others, c)) continue;
    if (first) return c;
    const d = (x - f.x) ** 2 + (y - f.y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}
// 拡大縮小用: 現在の四角 from から希望 to へ向かい、ぶつからない最後の四角(隣に当たったらそこで止まる)
function stretch(others, from, to, A) {
  const t = fit(to, A), n = Math.max(Math.abs(t.x - from.x), Math.abs(t.y - from.y), Math.abs(t.w - from.w), Math.abs(t.h - from.h));
  for (let k = n; k > 0; k--) {
    const q = k / n, c = {}; for (const key of ['x', 'y', 'w', 'h']) c[key] = Math.round(from[key] + (t[key] - from[key]) * q);
    if (same(c, fit(c, A)) && free(others, c)) return c;
  }
  return from;
}

// ---- 名前(家の中で一意) ----
// 収納場所の名前は品目の location の文字列そのものになるので、部屋名と収納場所名は同じ名前空間で一意にする。
// 比較は全角半角・空白・大文字小文字・旧名(押入れ→押入れ・収納)を吸収した locKey で行う。
export const cleanName = (s, max = NAME_MAX) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max);
export const locKey = (loc, hint = '') => canonLocation(String(loc ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(), hint);
// 重なったら、収納場所は「棚(キッチン)」のように部屋名を添え、それでも重なれば「棚(キッチン)2」「…3」。部屋は「名前2」「名前3」
function pickName(taken, base, roomName) {
  if (!taken.has(locKey(base))) return base;
  const b = roomName ? `${base}(${roomName})` : base;
  if (roomName && !taken.has(locKey(b))) return b;
  for (let n = 2; ; n++) if (!taken.has(locKey(b + n))) return b + n;
}
const takenKeys = (L, self) => new Set([...Object.values(L.rooms), ...Object.values(L.spots)].filter((e) => e.id !== self).map((e) => locKey(e.name)));
export function uniqueName(layout, want, { room, self } = {}) {
  const base = cleanName(want);
  return base ? pickName(takenKeys(layout, self), base, room ? layout.rooms[room]?.name : '') : '';
}

// ---- 結果の形 ----
// 操作の返り値: { ok, layout, changed, id?, name?, adjusted?, reason? }
//   adjusted = 希望どおりにならず補正した(ずらした/手前で止めた)。ok=false のときは layout は元のまま(reason: 'not-found' | 'no-space')
const ng = (layout, reason) => ({ ok: false, layout, changed: false, reason });
const done = (layout, extra) => ({ ok: true, changed: true, layout, ...extra });
const unchanged = (layout, extra) => ({ ok: true, changed: false, layout, ...extra });

// ---- 部屋 ----
export function addRoom(layout, kind, o = {}) {
  const L = layout || emptyLayout(), k = roomKind(kind), first = !(isNum(o.x) && isNum(o.y));
  const want = { x: first ? 0 : o.x, y: first ? 0 : o.y, w: o.w ?? k.w, h: o.h ?? k.h };
  const r = place(Object.values(L.rooms).map(rectOf), want, AR, first);
  if (!r) return ng(L, 'no-space');
  const id = o.id || newId('r', L), name = uniqueName(L, o.name, {}) || uniqueName(L, k.label, {});
  const room = { id, name, kind: k.kind, ...r, color: COLOR_TOKENS[o.color] ? o.color : k.color, u: stamp(o.now, L.dead[id] !== undefined ? { u: L.dead[id] } : null) };
  const dead = { ...L.dead }; delete dead[id];
  return done({ ...L, rooms: { ...L.rooms, [id]: room }, dead }, { id, name, adjusted: !first && !same(r, fit(want, AR)) });
}
function setRoom(L, id, patch, extra) {
  return done({ ...L, rooms: { ...L.rooms, [id]: { ...L.rooms[id], ...patch } } }, { id, ...extra });
}
// 位置だけ動かす。重なるなら最も近い空き位置へずらす(adjusted)。範囲外は範囲内へ丸める
export function moveRoom(layout, id, x, y, o = {}) {
  const r0 = layout.rooms[id]; if (!r0) return ng(layout, 'not-found');
  x = Math.round(x); y = Math.round(y);
  const want = { ...rectOf(r0), x, y }, r = place(Object.values(layout.rooms).filter((e) => e.id !== id).map(rectOf), want, AR, false);
  if (!r) return ng(layout, 'no-space');
  const adjusted = r.x !== x || r.y !== y;
  return same(r, rectOf(r0)) ? unchanged(layout, { id, adjusted }) : setRoom(layout, id, { ...r, u: stamp(o.now, r0) }, { adjusted });
}
// 大きさを変える。rect は { w, h } か、上や左の辺を引く操作では { x, y, w, h }。隣の部屋に当たったらその手前で止まる(adjusted)
export function resizeRoom(layout, id, rect, o = {}) {
  const r0 = layout.rooms[id]; if (!r0) return ng(layout, 'not-found');
  const want = { ...rectOf(r0), ...rect };
  const r = stretch(Object.values(layout.rooms).filter((e) => e.id !== id).map(rectOf), rectOf(r0), want, AR);
  const adjusted = !same(r, want);
  return same(r, rectOf(r0)) ? unchanged(layout, { id, adjusted }) : setRoom(layout, id, { ...r, u: stamp(o.now, r0) }, { adjusted });
}
export function renameRoom(layout, id, name, o = {}) {
  const r0 = layout.rooms[id]; if (!r0) return ng(layout, 'not-found');
  const nm = uniqueName(layout, name, { self: id }) || r0.name;
  return nm === r0.name ? unchanged(layout, { id, name: nm }) : setRoom(layout, id, { name: nm, u: stamp(o.now, r0) }, { name: nm });
}
export function setRoomColor(layout, id, color, o = {}) {
  const r0 = layout.rooms[id]; if (!r0) return ng(layout, 'not-found');
  return !COLOR_TOKENS[color] || color === r0.color ? unchanged(layout, { id }) : setRoom(layout, id, { color, u: stamp(o.now, r0) });
}
// 部屋と、その中の収納場所をすべて消す(墓標を残す)
export function deleteRoom(layout, id, o = {}) {
  const r0 = layout.rooms[id]; if (!r0) return ng(layout, 'not-found');
  const rooms = { ...layout.rooms }, spots = { ...layout.spots }, dead = { ...layout.dead };
  delete rooms[id]; dead[id] = stamp(o.now, r0);
  for (const s of Object.values(layout.spots)) if (s.room === id) { delete spots[s.id]; dead[s.id] = stamp(o.now, s); }
  return done({ ...layout, rooms, spots, dead }, { id });
}

// ---- 収納場所 ----
const spotsOf = (L, room) => Object.values(L.spots).filter((s) => s.room === room);
export function addSpot(layout, roomId, kind, o = {}) {
  const L = layout, room = L.rooms[roomId]; if (!room) return ng(L, 'not-found');
  const k = spotKind(kind), first = !(isNum(o.x) && isNum(o.y));
  const want = { x: first ? 0 : o.x, y: first ? 0 : o.y, w: o.w ?? k.w, h: o.h ?? k.h };
  const r = place(spotsOf(L, roomId).map(rectOf), want, AS, first);
  if (!r) return ng(L, 'no-space');
  const id = o.id || newId('s', L), nm = uniqueName(L, o.name, { room: roomId }) || uniqueName(L, k.label, { room: roomId });
  const spot = { id, room: roomId, name: nm, kind: k.kind, ...r, u: stamp(o.now, L.dead[id] !== undefined ? { u: L.dead[id] } : null) };
  const dead = { ...L.dead }; delete dead[id];
  return done({ ...L, spots: { ...L.spots, [id]: spot }, dead }, { id, name: nm, adjusted: !first && !same(r, fit(want, AS)) });
}
function setSpot(L, id, patch, extra) {
  return done({ ...L, spots: { ...L.spots, [id]: { ...L.spots[id], ...patch } } }, { id, ...extra });
}
export function moveSpot(layout, id, x, y, o = {}) {
  const s0 = layout.spots[id]; if (!s0) return ng(layout, 'not-found');
  x = Math.round(x); y = Math.round(y);
  const others = spotsOf(layout, s0.room).filter((s) => s.id !== id).map(rectOf);
  const r = place(others, { ...rectOf(s0), x, y }, AS, false);
  if (!r) return ng(layout, 'no-space');
  const adjusted = r.x !== x || r.y !== y;
  return same(r, rectOf(s0)) ? unchanged(layout, { id, adjusted }) : setSpot(layout, id, { ...r, u: stamp(o.now, s0) }, { adjusted });
}
export function resizeSpot(layout, id, rect, o = {}) {
  const s0 = layout.spots[id]; if (!s0) return ng(layout, 'not-found');
  const want = { ...rectOf(s0), ...rect };
  const r = stretch(spotsOf(layout, s0.room).filter((s) => s.id !== id).map(rectOf), rectOf(s0), want, AS);
  const adjusted = !same(r, want);
  return same(r, rectOf(s0)) ? unchanged(layout, { id, adjusted }) : setSpot(layout, id, { ...r, u: stamp(o.now, s0) }, { adjusted });
}
export function renameSpot(layout, id, name, o = {}) {
  const s0 = layout.spots[id]; if (!s0) return ng(layout, 'not-found');
  const nm = uniqueName(layout, name, { self: id, room: s0.room }) || s0.name;
  return nm === s0.name ? unchanged(layout, { id, name: nm }) : setSpot(layout, id, { name: nm, u: stamp(o.now, s0) }, { name: nm });
}
export function deleteSpot(layout, id, o = {}) {
  const s0 = layout.spots[id]; if (!s0) return ng(layout, 'not-found');
  const spots = { ...layout.spots }; delete spots[id];
  return done({ ...layout, spots, dead: { ...layout.dead, [id]: stamp(o.now, s0) } }, { id });
}

// ---- ドラッグ補助 ----
export const snap = (v, step = 1) => Math.round(v / step) * step;
// 家全体(scope='house')なら x,y は「マス」の座標で部屋を、scope=部屋のid なら「刻み」の座標でその部屋の収納場所を返す。無ければ null
export function hitTest(layout, x, y, scope = 'house') {
  const hit = (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h;
  if (scope === 'house') { const r = Object.values(layout.rooms).find(hit); return r ? { type: 'room', id: r.id } : null; }
  const s = spotsOf(layout, scope).find(hit);
  return s ? { type: 'spot', id: s.id } : null;
}
// 外接矩形。scope='house' は部屋全体、部屋のidはその部屋の収納場所(空なら既定)。{ x, y, w, h, maxX, maxY }
export function bounds(layout, scope = 'house') {
  const es = scope === 'house' ? Object.values(layout.rooms) : spotsOf(layout, scope);
  if (!es.length) return { x: 0, y: 0, w: scope === 'house' ? GRID_W : SPOT_GRID, h: scope === 'house' ? 10 : SPOT_GRID, maxX: scope === 'house' ? GRID_W : SPOT_GRID, maxY: scope === 'house' ? 10 : SPOT_GRID };
  const x = Math.min(...es.map((e) => e.x)), y = Math.min(...es.map((e) => e.y)), maxX = Math.max(...es.map((e) => e.x + e.w)), maxY = Math.max(...es.map((e) => e.y + e.h));
  return { x, y, w: maxX - x, h: maxY - y, maxX, maxY };
}
// 部屋の描画領域(W×H px)の中の収納場所の四角(px)
export const spotRect = (spot, W, H) => ({ x: (spot.x / SPOT_GRID) * W, y: (spot.y / SPOT_GRID) * H, w: (spot.w / SPOT_GRID) * W, h: (spot.h / SPOT_GRID) * H });
// px 座標(部屋の描画領域内)→ 刻み(小数のまま。snap で丸める)
export const toSpotUnits = (px, size) => (px / size) * SPOT_GRID;

// ---- 読み込み・整合(外から来たデータを安全な形に) ----
function cleanRoom(id, r) {
  if (!r || typeof r !== 'object') return null;
  const k = roomKind(r.kind);
  return { id, name: cleanName(r.name, NAME_STORED) || k.label, kind: k.kind, ...fit(r, AR), color: COLOR_TOKENS[r.color] ? r.color : k.color, u: isNum(r.u) ? r.u : 0 };
}
function cleanSpot(id, s) {
  if (!s || typeof s !== 'object' || typeof s.room !== 'string') return null;
  const k = spotKind(s.kind);
  return { id, room: s.room, name: cleanName(s.name, NAME_STORED) || k.label, kind: k.kind, ...fit(s, AS), u: isNum(s.u) ? s.u : 0 };
}
// 墓標との食い違い(同じidで、削除が新しければ消える・編集が新しければ生き返る。同時刻は削除が勝つ)
function settle(L) {
  const dead = { ...L.dead }, rooms = {}, spots = {};
  for (const [id, r] of Object.entries(L.rooms)) { if (dead[id] !== undefined && dead[id] >= r.u) continue; delete dead[id]; rooms[id] = r; }
  for (const [id, s] of Object.entries(L.spots)) { if (dead[id] !== undefined && dead[id] >= s.u) continue; delete dead[id]; spots[id] = s; }
  return { v: 1, rooms, spots, dead };
}
// 保存データ(Firestore・localStorage・他端末)→ layout。未設定・壊れたデータは空/該当要素を捨てる。
// 重なり・名前の重複・部屋が無い収納場所の補正はしない(repair/applyRemote がする。画面には applyRemote 後の layout を使う)
export function parseLayout(raw) {
  const L = emptyLayout();
  if (!raw || typeof raw !== 'object') return L;
  for (const [id, r] of Object.entries(raw.rooms || {})) { const c = ID_RE.test(id) && cleanRoom(id, r); if (c) L.rooms[id] = c; }
  for (const [id, s] of Object.entries(raw.spots || {})) { const c = ID_RE.test(id) && cleanSpot(id, s); if (c) L.spots[id] = c; }
  for (const [id, u] of Object.entries(raw.dead || {})) if (ID_RE.test(id) && isNum(u)) L.dead[id] = u;
  return settle(L);
}

// 部屋が無い収納場所の削除、重なり・範囲外・名前の重複を、決まった順序(古い順→同時刻はid順)で直す。同じ入力なら誰がやっても同じ結果になる(直した要素は u+1)
export function repair(layout) {
  const L = settle(layout), rooms = {}, spots = {}, dead = { ...L.dead }, used = new Set(), placed = [];
  // 重なるなら最寄りの空きへ、無ければ最小の大きさにして探し、それも無ければ null(その要素は消す)
  const seat = (pl, r, A) => {
    const q = fit(r, A); if (free(pl, q)) return q;
    return place(pl, q, A, false) || place(pl, { ...q, w: A.min, h: A.min }, A, false);
  };
  for (const r of Object.values(L.rooms).sort(byU)) {
    const q = seat(placed, r, AR);
    if (!q) { dead[r.id] = r.u + 1; continue; }
    let u = same(q, rectOf(r)) ? r.u : r.u + 1;
    const name = pickName(used, r.name, ''); if (name !== r.name) u = Math.max(u, r.u + 1);
    used.add(locKey(name)); placed.push(q); rooms[r.id] = { ...r, ...q, name, u };
  }
  const byRoom = {}, all = [];
  for (const s of Object.values(L.spots).sort(byU)) { if (rooms[s.room]) (byRoom[s.room] ||= []).push(s); else dead[s.id] = Math.max(s.u, dead[s.room] ?? 0) + 1; }
  for (const [rid, list] of Object.entries(byRoom)) {
    const pl = [];
    for (const s of list) {
      const q = seat(pl, s, AS);
      if (!q) { dead[s.id] = s.u + 1; continue; }
      pl.push(q); all.push({ ...s, ...q, u: same(q, rectOf(s)) ? s.u : s.u + 1, rid });
    }
  }
  for (const s of all.sort(byU)) { // 名前は部屋が先、収納場所は古い順
    const name = pickName(used, s.name, rooms[s.rid].name), u = name !== s.name ? s.u + 1 : s.u;
    used.add(locKey(name)); const { rid, ...rest } = s; spots[s.id] = { ...rest, name, u };
  }
  return { v: 1, rooms, spots, dead };
}

// ---- 共有 ----
const pick = (x, y) => (x.u !== y.u ? (x.u > y.u ? x : y) : JSON.stringify(x) >= JSON.stringify(y) ? x : y);
const mergeMap = (a, b, f) => { const o = { ...a }; for (const id of Object.keys(b)) o[id] = id in a ? f(a[id], b[id]) : b[id]; return o; };
// 手元(local)と他端末の保存(remote)を合わせる: 要素ごとに u が新しいほうを採る(削除も墓標の u で同じ)。
// 片方にしか無い要素は残る(別の部屋を同時に編集してもどちらも消えない)。順序を入れ替えても同じ結果。重なりは repair で直す
export function applyRemote(local, remote, { fix = true } = {}) {
  const a = parseLayout(local), b = parseLayout(remote);
  const m = settle({ v: 1, rooms: mergeMap(a.rooms, b.rooms, pick), spots: mergeMap(a.spots, b.spots, pick), dead: mergeMap(a.dead, b.dead, Math.max) });
  return fix ? repair(m) : m; // fix=false は純粋な「新しいほうを採る」合成(テスト用)
}
const eq = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => a[k] === b[k]); };
// prev → next の差分を、Firestore updateDoc のドット記法パス更新で返す。消すパスは値が DELETE。undefined は含まない
export function diffLayout(prev, next) {
  const p = prev || emptyLayout(), n = next || emptyLayout(), out = {};
  for (const t of ['rooms', 'spots']) {
    for (const [id, e] of Object.entries(n[t] || {})) if (!(p[t] || {})[id] || !eq(p[t][id], e)) out[`layout.${t}.${id}`] = { ...e };
    for (const id of Object.keys(p[t] || {})) if (!(n[t] || {})[id]) out[`layout.${t}.${id}`] = DELETE;
  }
  for (const [id, u] of Object.entries(n.dead || {})) if ((p.dead || {})[id] !== u) out[`layout.dead.${id}`] = u;
  for (const id of Object.keys(p.dead || {})) if (!(n.dead || {})[id]) out[`layout.dead.${id}`] = DELETE;
  if (Object.keys(out).length && n.v !== p.v) out['layout.v'] = n.v ?? 1;
  return out;
}
// ドット記法の差分を layout に当てる(お試しモードの保存と、diffLayout のテスト用)
export function applyPatch(layout, patch) {
  const L = JSON.parse(JSON.stringify(layout || emptyLayout()));
  for (const [path, v] of Object.entries(patch || {})) {
    const seg = path.split('.'); if (seg[0] !== 'layout') continue;
    const rest = seg.slice(1);
    if (rest.length === 1) { if (rest[0] === 'v' && v !== DELETE) L.v = v; continue; }
    const [t, id] = rest; if (!['rooms', 'spots', 'dead'].includes(t) || !id) continue;
    L[t] ||= {};
    if (v === DELETE || v === undefined) delete L[t][id]; else L[t][id] = JSON.parse(JSON.stringify(v));
  }
  return L;
}
// 古い墓標を捨てる(TOMB_DAYS 日より前)。長く開いていない端末が古い要素を生き返らせる可能性はあるが、まれ
export function compact(layout, now = Date.now(), days = TOMB_DAYS) {
  const dead = {}; for (const [id, u] of Object.entries(layout.dead || {})) if (u > now - days * 864e5) dead[id] = u;
  return { ...layout, dead };
}
// 共有の手続きをまとめた入れ物。ops の結果を apply に渡し、store から来た layout を receive に渡す
//   const sync = createSync((patch) => store.saveLayoutPatch(patch));
//   store.subscribeLayout((remote) => { sync.receive(remote); render(sync.layout); });
//   const r = addRoom(sync.layout, 'living'); sync.apply(r.layout);
export function createSync(send, now = () => Date.now()) {
  const S = { layout: emptyLayout(), last: '' };
  const push = (patch) => {
    const j = JSON.stringify(patch);
    if (!Object.keys(patch).length || j === S.last) return Promise.resolve();
    S.last = j; return Promise.resolve(send(patch)).catch((e) => { S.last = ''; throw e; });
  };
  return {
    get layout() { return S.layout; },
    // 手元の編集を反映して送る(差分だけ)。送信の失敗は返り値の Promise で分かる
    apply(next) { const prev = S.layout; S.layout = compact(next, now()); return push(diffLayout(prev, S.layout)); },
    // 他端末(や自分の保存)の内容を取り込む。相手に足りないものや、補正した分は送り直す
    receive(remote) {
      const rm = parseLayout(remote); S.layout = applyRemote(S.layout, rm);
      return push(diffLayout(rm, S.layout)).catch(() => {});
    },
  };
}

// ---- 在庫との結びつき ----
// 収納場所の name(または部屋の name)と品目の location が locKey で一致する品がその場所の在庫。
// 部屋名と一致する品は、その部屋の「場所が細かく決まっていない品」(loose)。収納場所と部屋の名前は一意なので、一致はひとつに決まる。
const isLow = (i) => i.minQty > 0 && i.qty <= i.minQty;
const isEstLow = (i) => (i.expirySrc === '予測' || i.expirySrc === '前回') && i.expiryLevel === 'low';
const blank = () => ({ count: 0, have: 0, low: 0, exp: 0, expEst: 0, items: [] });
function add(sum, i, f) {
  sum.count++; sum.items.push(i);
  if (f.have) sum.have++;
  if (f.low) sum.low++;
  if (f.exp) sum.exp++;
  if (f.est) sum.expEst++;
}
function keyIndex(L) {
  const m = new Map();
  for (const r of Object.values(L.rooms)) m.set(locKey(r.name), { type: 'room', id: r.id });
  for (const s of Object.values(L.spots)) if (L.rooms[s.room]) m.set(locKey(s.name), { type: 'spot', id: s.id }); // 万一同名なら収納場所が優先
  return m;
}
// → { spots: { [id]: Sum }, rooms: { [id]: Sum & { loose: Sum } } }   Sum = { count(品目数), have(数量>0), low(足りない), exp(期限が近い/切れ), expEst(予測の期限=弱い警告), items }
//   rooms[id] は部屋全体(部屋名の品 + 部屋の中の収納場所の品)、rooms[id].loose は部屋名だけの品
export function summarize(layout, items, now = Date.now()) {
  const L = layout, idx = keyIndex(L), out = { spots: {}, rooms: {} };
  for (const r of Object.values(L.rooms)) out.rooms[r.id] = { ...blank(), loose: blank() };
  for (const s of Object.values(L.spots)) if (L.rooms[s.room]) out.spots[s.id] = blank();
  for (const i of items || []) {
    if (!i || !i.name) continue;
    const t = idx.get(locKey(i.location, i.name)); if (!t) continue;
    const d = expiryDays(i, now), near = (+i.qty || 0) > 0 && d !== null && d <= EXPIRY_DAYS, est = near && isEstLow(i);
    const f = { have: (+i.qty || 0) > 0, low: isLow(i), exp: near && !est, est };
    if (t.type === 'spot') { add(out.spots[t.id], i, f); add(out.rooms[L.spots[t.id].room], i, f); }
    else { add(out.rooms[t.id].loose, i, f); add(out.rooms[t.id], i, f); }
  }
  return out;
}
// どの部屋・収納場所の名前とも一致しない品を、場所名ごとに: [{ name(表示用・旧名は新名に読み替え), key, empty(場所が空), count, items }](多い順)
export function unplaced(layout, items) {
  const idx = keyIndex(layout), g = new Map();
  for (const i of items || []) {
    if (!i || !i.name) continue;
    const key = locKey(i.location, i.name); if (idx.has(key)) continue;
    let e = g.get(key); if (!e) g.set(key, e = { name: key ? canonLocation(String(i.location ?? '').trim(), i.name) : '', key, empty: !key, count: 0, items: [] });
    e.count++; e.items.push(i);
  }
  return [...g.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

// ---- 初期配置(補助) ----
// [kind, x, y, w, h(省略は既定)]。キッチン・洗面所・玄関には、よくある収納場所を最初から置く(在庫の「冷蔵庫」などがすぐ結びつく)
const STARTERS = {
  '1K': { label: '1K', rooms: [['kitchen', 0, 0, 4, 4], ['bedroom', 4, 0, 6, 5], ['entrance', 0, 4, 4, 2], ['washroom', 4, 5, 3, 3], ['bath', 7, 5, 3, 3], ['toilet', 0, 6, 2, 3]] },
  '2LDK': { label: '2LDK', rooms: [['living', 0, 0, 8, 6], ['kitchen', 8, 0, 5, 4], ['bedroom', 13, 0, 6, 5], ['kids', 13, 5, 6, 4], ['washroom', 8, 4, 3, 3], ['toilet', 11, 4, 2, 3], ['bath', 8, 7, 3, 3], ['entrance', 0, 6, 4, 3], ['balcony', 0, 9, 8, 2]] },
  '3LDK': { label: '3LDK', rooms: [['living', 0, 0, 8, 6], ['kitchen', 8, 0, 5, 4], ['bedroom', 13, 0, 6, 5], ['kids', 13, 5, 5, 4], ['study', 18, 5, 4, 4], ['washroom', 8, 4, 3, 3], ['toilet', 11, 4, 2, 3], ['bath', 8, 7, 3, 3], ['storeroom', 11, 7, 2, 2], ['entrance', 0, 6, 4, 3], ['balcony', 0, 9, 8, 2]] },
  house: { label: '一戸建て', rooms: [['living', 0, 0, 8, 6], ['dining', 8, 0, 6, 5], ['kitchen', 14, 0, 6, 4], ['toilet', 20, 0, 2, 3], ['washroom', 14, 4, 4, 3], ['bath', 18, 4, 4, 3], ['entrance', 0, 6, 5, 3], ['hall', 5, 6, 2, 5], ['bedroom', 8, 5, 6, 5], ['kids', 14, 7, 5, 4], ['garage', 0, 11, 6, 6], ['garden', 7, 11, 10, 5]] },
};
const STARTER_SPOTS = { kitchen: ['fridge', 'freezer', 'pantry'], washroom: ['sink'], entrance: ['genkan'] };
export const STARTER_KINDS = [...Object.entries(STARTERS).map(([kind, s]) => ({ kind, label: s.label })), { kind: 'empty', label: '空から作る' }];
export function starterLayout(kind, now = Date.now()) {
  let L = emptyLayout();
  for (const [k, x, y, w, h] of STARTERS[kind]?.rooms || []) {
    const r = addRoom(L, k, { x, y, w, h, now }); L = r.layout;
    for (const sk of STARTER_SPOTS[k] || []) L = addSpot(L, r.id, sk, { now }).layout;
  }
  return L;
}
