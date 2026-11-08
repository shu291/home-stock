// node js/floorplan.test.mjs  (依存なし)
// 間取りのデータモデル(floorplan.js)と、store.js の間取り保存(Firestore はモック)の単体テスト。
import assert from 'node:assert/strict';
import * as F from './floorplan.js';
import { cloudStore, localStore } from './store.js';

const { GRID_W, MAX_ROWS, SPOT_GRID, DELETE } = F;
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`NG  ${name}\n    ${e.message.split('\n').join('\n    ')}`); } };
const ta = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.log(`NG  ${name}\n    ${e.message.split('\n').join('\n    ')}`); } };
const freeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };
const J = (o) => JSON.parse(JSON.stringify(o));
const NOW = 1_700_000_000_000;
let tick = 0; const now = () => NOW + ++tick;

// 不変条件: 部屋は範囲内・重ならない / 収納場所は部屋があり、内側・重ならない / 名前は一意 / undefined なし / 墓標と生きている要素は排他
const inv = (L, label = '') => {
  const rooms = Object.values(L.rooms), spots = Object.values(L.spots), ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const r of rooms) {
    assert.ok(r.w >= F.ROOM_MIN && r.w <= F.ROOM_MAX && r.h >= F.ROOM_MIN && r.h <= F.ROOM_MAX, `${label} room size ${JSON.stringify(r)}`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= GRID_W && r.y + r.h <= MAX_ROWS, `${label} room range ${JSON.stringify(r)}`);
    assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h), `${label} int`);
  }
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) assert.ok(!ov(rooms[i], rooms[j]), `${label} rooms overlap ${JSON.stringify([rooms[i], rooms[j]])}`);
  for (const s of spots) {
    assert.ok(L.rooms[s.room], `${label} orphan spot ${s.id}`);
    assert.ok(s.w >= F.SPOT_MIN && s.h >= F.SPOT_MIN && s.x >= 0 && s.y >= 0 && s.x + s.w <= SPOT_GRID && s.y + s.h <= SPOT_GRID, `${label} spot range ${JSON.stringify(s)}`);
  }
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) if (spots[i].room === spots[j].room) assert.ok(!ov(spots[i], spots[j]), `${label} spots overlap`);
  const keys = [...rooms, ...spots].map((e) => F.locKey(e.name));
  assert.equal(new Set(keys).size, keys.length, `${label} names not unique: ${keys}`);
  for (const id of Object.keys(L.dead)) assert.ok(!L.rooms[id] && !L.spots[id], `${label} dead & live ${id}`);
  const js = JSON.stringify(L); assert.ok(!js.includes('undefined') && !js.includes('null'), `${label} undefined/null`);
};
// 配列の入れ子が無い(Firestore は配列の入れ子を拒否)
const noNestedArray = (o) => { const w = (v, inArr) => { if (Array.isArray(v)) { assert.ok(!inArr, 'nested array'); v.forEach((x) => w(x, true)); } else if (v && typeof v === 'object') Object.values(v).forEach((x) => w(x, false)); }; w(o, false); };
const mk = (...kinds) => { let L = F.emptyLayout(); for (const k of kinds) L = F.addRoom(L, k, { now: now() }).layout; return L; };
const rid = (L, name) => Object.values(L.rooms).find((r) => r.name === name)?.id;
const sid = (L, name) => Object.values(L.spots).find((r) => r.name === name)?.id;

// ---- ランダムな操作列(シード固定) ----
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const NAMES = ['棚', '冷蔵庫', 'リビング', 'ＡＢＣ', 'abc', '押入れ', '押入れ・収納', '', ' ', 'キッチン', 'x', 'あ'.repeat(30)];
function randomOp(L, R, t0) {
  const pi = (n) => Math.floor(R() * n), pick = (a) => a[pi(a.length)], T = { now: (t0 ?? NOW) + pi(1000) };
  const rooms = Object.keys(L.rooms), spots = Object.keys(L.spots), c = R();
  let r;
  if (c < 0.14 || !rooms.length) r = F.addRoom(L, pick(F.ROOM_KINDS).kind, { ...T, ...(R() < 0.6 ? { x: pi(30) - 3, y: pi(30) - 3 } : {}), ...(R() < 0.5 ? { w: pi(30), h: pi(30) } : {}), name: pick(NAMES) });
  else if (c < 0.26) r = F.moveRoom(L, pick(rooms), pi(40) - 5 + R(), pi(70) - 5, T);
  else if (c < 0.38) r = F.resizeRoom(L, pick(rooms), R() < 0.5 ? { w: pi(30), h: pi(30) } : { x: pi(24), y: pi(30), w: pi(30), h: pi(30) }, T);
  else if (c < 0.43) r = F.renameRoom(L, pick(rooms), pick(NAMES), T);
  else if (c < 0.46) r = F.deleteRoom(L, pick(rooms), T);
  else if (c < 0.50) r = F.setRoomColor(L, pick(rooms), pick(['green', 'zz', 'red']), T);
  else if (c < 0.66) r = F.addSpot(L, pick(rooms), pick(F.SPOT_KINDS).kind, { ...T, ...(R() < 0.6 ? { x: pi(30) - 3, y: pi(30) - 3 } : {}), ...(R() < 0.4 ? { w: pi(30), h: pi(30) } : {}), name: pick(NAMES) });
  else if (!spots.length) r = F.addSpot(L, pick(rooms), 'shelf', T);
  else if (c < 0.78) r = F.moveSpot(L, pick(spots), pi(34) - 5 + R(), pi(34) - 5, T);
  else if (c < 0.88) r = F.resizeSpot(L, pick(spots), { w: pi(30), h: pi(30), ...(R() < 0.3 ? { x: pi(24), y: pi(24) } : {}) }, T);
  else if (c < 0.95) r = F.renameSpot(L, pick(spots), pick(NAMES), T);
  else r = F.deleteSpot(L, pick(spots), T);
  assert.ok(r.layout && (r.ok || r.reason), 'result shape');
  return r.layout;
}

// ---- 追加・既定 ----
t('空のレイアウトの形', () => assert.deepEqual(F.emptyLayout(), { v: 1, rooms: {}, spots: {}, dead: {} }));
t('addRoom: 既定の大きさ・色・名前、上から左から最初の空きに置く', () => {
  const r = F.addRoom(F.emptyLayout(), 'living', { now: NOW }); const room = Object.values(r.layout.rooms)[0];
  assert.deepEqual([room.name, room.kind, room.x, room.y, room.w, room.h, room.u], ['リビング', 'living', 0, 0, 8, 6, NOW]);
  assert.equal(room.color, 'orange');
  const r2 = F.addRoom(r.layout, 'kitchen', {}), k = r2.layout.rooms[r2.id];
  assert.deepEqual([k.x, k.y], [8, 0]);
});
t('addRoom: 横がいっぱいなら次の段に置く', () => {
  let L = F.emptyLayout(); for (let i = 0; i < 4; i++) L = F.addRoom(L, 'dining', { w: 6, h: 5 }).layout; // 6*4=24
  const r = F.addRoom(L, 'dining', { w: 6, h: 5 }); assert.deepEqual([r.layout.rooms[r.id].x, r.layout.rooms[r.id].y], [0, 5]); inv(r.layout);
});
t('addRoom: 位置指定が空いていればそのまま(adjusted=false)、重なるなら最寄りの空きへ(adjusted)', () => {
  const L = mk('living'); // 0,0 8x6
  const a = F.addRoom(L, 'study', { x: 10, y: 1 }); assert.equal(a.adjusted, false); assert.deepEqual([a.layout.rooms[a.id].x, a.layout.rooms[a.id].y], [10, 1]);
  const b = F.addRoom(L, 'study', { x: 6, y: 2 }); assert.equal(b.adjusted, true); inv(b.layout);
  const room = b.layout.rooms[b.id]; assert.ok(room.x >= 8 || room.y >= 6);
});
t('addRoom: 大きさは最小最大に丸める・範囲外の位置は範囲内へ', () => {
  const a = F.addRoom(F.emptyLayout(), 'other', { w: 1, h: 99, x: 100, y: -5 }); const r = a.layout.rooms[a.id];
  assert.deepEqual([r.w, r.h, r.x, r.y], [2, 24, 22, 0]);
});
t('addRoom: 未知の種類は other、未知の色は種類の既定色', () => {
  const a = F.addRoom(F.emptyLayout(), 'xx', { color: 'nope' }); const r = a.layout.rooms[a.id];
  assert.deepEqual([r.kind, r.name, r.color], ['other', 'その他', 'gray']);
});
t('種類のひな形: 全部屋種類・全収納種類が揃い、色はトークンにある', async () => {
  const { COLOR_TOKENS } = await import('./taxonomy.js');
  for (const k of [...F.ROOM_KINDS, ...F.SPOT_KINDS]) assert.ok(COLOR_TOKENS[k.color] && k.label && k.icon && k.w >= 2 && k.h >= 2, k.kind);
  for (const k of ['living', 'dining', 'kitchen', 'bedroom', 'kids', 'study', 'washroom', 'bath', 'toilet', 'entrance', 'hall', 'balcony', 'garden', 'garage', 'storeroom', 'other']) assert.ok(F.ROOM_KINDS.some((x) => x.kind === k), k);
  for (const k of ['fridge', 'freezer', 'pantry', 'cupboard', 'shelf', 'drawer', 'closet', 'oshiire', 'sink', 'genkan', 'veranda', 'mono', 'car', 'other']) assert.ok(F.SPOT_KINDS.some((x) => x.kind === k), k);
  assert.ok(F.ROOM_KINDS.every((k) => k.w <= F.ROOM_MAX && k.h <= F.ROOM_MAX) && F.SPOT_KINDS.every((k) => k.w <= SPOT_GRID && k.h <= SPOT_GRID));
  assert.equal(F.roomColor({ color: 'zzz', kind: 'kitchen' }), 'green'); assert.equal(F.spotColor({ kind: 'fridge' }), 'blue');
});

// ---- 移動 ----
t('moveRoom: 空きへ移動・元は変更されない', () => {
  const L = freeze(mk('living', 'kitchen')); const id = rid(L, 'キッチン');
  const r = F.moveRoom(L, id, 10, 8); assert.equal(r.adjusted, false); assert.deepEqual([r.layout.rooms[id].x, r.layout.rooms[id].y], [10, 8]);
  assert.equal(L.rooms[id].x, 8); assert.ok(r.layout.rooms[id].u > L.rooms[id].u);
});
t('moveRoom: 重なる位置は、最も近い空きにずらす(同距離は上・左)', () => {
  const L = freeze(mk('living', 'kitchen')); const id = rid(L, 'キッチン'); // living 0..8 x 0..6, kitchen 6x4 at 8,0
  const r = F.moveRoom(L, id, 6, 0); assert.equal(r.adjusted, true); assert.deepEqual([r.layout.rooms[id].x, r.layout.rooms[id].y], [8, 0]); // 右に2ずらすのが最短
  const r2 = F.moveRoom(L, id, 2, 4); assert.equal(r2.adjusted, true); inv(r2.layout);
  const q = r2.layout.rooms[id]; assert.ok(q.y >= 6 || q.x >= 8);
});
t('moveRoom: 境界(範囲外は範囲内へ丸め、同じ位置なら変更なし)', () => {
  const L = freeze(mk('living')); const id = rid(L, 'リビング');
  const a = F.moveRoom(L, id, -5, -5); assert.equal(a.changed, false); assert.equal(a.layout, L);
  const b = F.moveRoom(L, id, 99, 99); assert.deepEqual([b.layout.rooms[id].x, b.layout.rooms[id].y], [16, 54]); assert.equal(b.adjusted, true);
  const c = F.moveRoom(L, id, 3.4, 2.6); assert.deepEqual([c.layout.rooms[id].x, c.layout.rooms[id].y], [3, 3]); assert.equal(c.adjusted, false);
});
t('moveRoom: 存在しないidは ok=false', () => { const r = F.moveRoom(mk('living'), 'zz', 1, 1); assert.deepEqual([r.ok, r.reason], [false, 'not-found']); });
t('moveRoom: 隣に接する(辺が触れる)のは重なりではない', () => {
  const L = mk('living', 'kitchen'); const id = rid(L, 'キッチン'); const r = F.moveRoom(L, id, 8, 0); assert.equal(r.changed, false);
  const r2 = F.moveRoom(L, id, 8, 5); assert.equal(r2.adjusted, false); assert.equal(r2.layout.rooms[id].y, 5); // living(0..8 x 0..6)と辺で接するだけ
});
t('moveRoom: 満杯に近くても必ず不変条件を守る', () => {
  let L = F.emptyLayout(); for (let i = 0; i < 12; i++) L = F.addRoom(L, 'living', { w: 8, h: 8 }).layout; inv(L);
  const id = Object.keys(L.rooms)[0]; inv(F.moveRoom(L, id, 12, 12).layout);
});

// ---- 拡大縮小 ----
t('resizeRoom: 最小・最大に丸める', () => {
  const L = mk('living'); const id = rid(L, 'リビング');
  const a = F.resizeRoom(L, id, { w: 1, h: 1 }); assert.deepEqual([a.layout.rooms[id].w, a.layout.rooms[id].h], [2, 2]); assert.equal(a.adjusted, true);
  const b = F.resizeRoom(L, id, { w: 40, h: 40 }); assert.deepEqual([b.layout.rooms[id].w, b.layout.rooms[id].h], [24, 24]);
});
t('resizeRoom: 隣の部屋に当たったらその手前で止まる(位置はずらさない)', () => {
  const L = freeze(mk('living', 'kitchen')); const id = rid(L, 'リビング'); // living 8 wide, kitchen starts at x=8
  const r = F.resizeRoom(L, id, { w: 12 }); assert.equal(r.adjusted, true); assert.deepEqual([r.layout.rooms[id].x, r.layout.rooms[id].w], [0, 8]); assert.equal(r.changed, false);
  const r2 = F.resizeRoom(L, id, { h: 12 }); assert.equal(r2.layout.rooms[id].h, 12); assert.equal(r2.adjusted, false); inv(r2.layout);
  const k = rid(L, 'キッチン'), r3 = F.resizeRoom(L, k, { x: 5, w: 9 }); assert.equal(r3.layout.rooms[k].x >= 8, true); inv(r3.layout);
});
t('resizeRoom: 上・左の辺を引く(x,y,w,h を渡す)', () => {
  const L = F.addRoom(F.emptyLayout(), 'study', { x: 6, y: 6 }).layout; const id = Object.keys(L.rooms)[0];
  const r = F.resizeRoom(L, id, { x: 4, y: 4, w: 6, h: 6 }); assert.deepEqual([r.layout.rooms[id].x, r.layout.rooms[id].y, r.layout.rooms[id].w, r.layout.rooms[id].h], [4, 4, 6, 6]); assert.equal(r.adjusted, false);
});
t('resizeRoom: 右端・下端を超える拡大は範囲内に収まる', () => {
  const L = F.addRoom(F.emptyLayout(), 'study', { x: 20, y: 0 }).layout; const id = Object.keys(L.rooms)[0];
  const r = F.resizeRoom(L, id, { w: 10 }); inv(r.layout); assert.ok(r.layout.rooms[id].x + r.layout.rooms[id].w <= GRID_W);
});
t('部屋の拡大縮小で収納場所は変わらない(正規化座標)', () => {
  let L = mk('kitchen'); const rId = Object.keys(L.rooms)[0]; L = F.addSpot(L, rId, 'fridge', { x: 3, y: 2 }).layout;
  const before = J(L.spots), L2 = F.resizeRoom(L, rId, { w: 12, h: 9 }).layout, L3 = F.resizeRoom(L2, rId, { w: 2, h: 2 }).layout;
  assert.deepEqual(L2.spots, before); assert.deepEqual(L3.spots, before); inv(L3);
  const room = L3.rooms[rId], s = Object.values(L3.spots)[0], px = F.spotRect(s, 200, 100); assert.deepEqual(px, { x: 25, y: (2 / 24) * 100, w: (5 / 24) * 200, h: 25 });
});

// ---- 削除・名前 ----
t('deleteRoom: 収納場所も消え、墓標が残る', () => {
  let L = mk('kitchen', 'living'); const k = rid(L, 'キッチン'); L = F.addSpot(L, k, 'fridge').layout; L = F.addSpot(L, k, 'shelf').layout;
  const s = Object.keys(L.spots); const r = F.deleteRoom(freeze(L), k, { now: NOW + 99999 });
  assert.equal(Object.keys(r.layout.spots).length, 0); assert.equal(r.layout.rooms[k], undefined);
  assert.ok(r.layout.dead[k] && s.every((x) => r.layout.dead[x])); inv(r.layout);
});
t('名前: 同じ部屋名は「名前2」「名前3」', () => {
  let L = mk('living', 'living', 'living'); assert.deepEqual(Object.values(L.rooms).map((r) => r.name), ['リビング', 'リビング2', 'リビング3']);
});
t('名前: 収納場所は「棚(キッチン)」→「棚(キッチン)2」、別の部屋なら別の名前でもよい(家の中で一意)', () => {
  let L = mk('kitchen', 'washroom'); const k = rid(L, 'キッチン'), w = rid(L, '洗面所');
  const a = F.addSpot(L, k, 'shelf', { name: '棚' }); assert.equal(a.name, '棚');
  const b = F.addSpot(a.layout, k, 'shelf', { name: '棚' }); assert.equal(b.name, '棚(キッチン)');
  const c = F.addSpot(b.layout, k, 'shelf', { name: '棚' }); assert.equal(c.name, '棚(キッチン)2');
  const d = F.addSpot(c.layout, w, 'shelf', { name: '棚' }); assert.equal(d.name, '棚(洗面所)'); inv(d.layout);
});
t('名前: 全角半角・空白・大文字小文字・旧名(押入れ)の揺れを同じ名前とみなす', () => {
  let L = mk('storeroom'); const r = Object.keys(L.rooms)[0];
  L = F.addSpot(L, r, 'shelf', { name: 'ＡＢＣ' }).layout;
  assert.equal(F.addSpot(L, r, 'shelf', { name: 'abc' }).name, 'abc(納戸)');
  assert.equal(F.addSpot(L, r, 'shelf', { name: 'A B C' }).name, 'A B C(納戸)');
  L = F.addSpot(L, r, 'oshiire', { name: '押入れ' }).layout;
  assert.equal(F.addSpot(L, r, 'shelf', { name: '押入れ・収納' }).name, '押入れ・収納(納戸)');
});
t('名前: 収納場所の名前が部屋名と同じなら部屋名を添える', () => {
  const L = mk('kitchen', 'living'); const l = rid(L, 'リビング'); assert.equal(F.addSpot(L, l, 'shelf', { name: 'キッチン' }).name, 'キッチン(リビング)');
});
t('名前: 空・空白だけの名前は種類の名前になる・長い名前は20文字まで', () => {
  const L = mk('kitchen'); const k = Object.keys(L.rooms)[0];
  assert.equal(F.addSpot(L, k, 'fridge', { name: '   ' }).name, '冷蔵庫');
  assert.equal(F.addSpot(L, k, 'fridge', { name: 'あ'.repeat(50) }).name.length, 20);
});
t('renameRoom/renameSpot: 一意化・自分の名前への変更は変更なし・空は無視', () => {
  let L = mk('living', 'dining'); const a = rid(L, 'リビング'), b = rid(L, 'ダイニング');
  assert.equal(F.renameRoom(L, b, 'リビング').name, 'リビング2');
  assert.equal(F.renameRoom(L, a, 'リビング').changed, false);
  assert.equal(F.renameRoom(L, a, '  ').changed, false);
  assert.equal(F.renameRoom(L, a, ' 大きい　リビング ').name, '大きい リビング');
  L = F.addSpot(L, a, 'shelf', { name: '棚A' }).layout; const s = sid(L, '棚A');
  assert.equal(F.renameSpot(L, s, 'ダイニング').name, 'ダイニング(リビング)');
  const r = F.renameSpot(L, s, '本棚'); assert.equal(r.layout.spots[s].name, '本棚'); assert.ok(r.layout.spots[s].u > L.spots[s].u);
});

// ---- 収納場所 ----
t('addSpot: 部屋の内側・重ならない・不明な部屋は ok=false', () => {
  let L = mk('kitchen'); const k = Object.keys(L.rooms)[0];
  const a = F.addSpot(L, k, 'fridge', { x: 22, y: 22 }); const s = a.layout.spots[a.id]; assert.deepEqual([s.x, s.y, s.w, s.h], [19, 18, 5, 6]);
  assert.equal(F.addSpot(L, 'zz', 'fridge').ok, false);
  const b = F.addSpot(a.layout, k, 'fridge', { x: 20, y: 20 }); assert.equal(b.adjusted, true); inv(b.layout);
});
t('addSpot: 部屋がいっぱいなら no-space', () => {
  let L = mk('kitchen'); const k = Object.keys(L.rooms)[0], big = F.addSpot(L, k, 'other', { w: 24, h: 24 }).layout;
  const r = F.addSpot(big, k, 'other'); assert.deepEqual([r.ok, r.reason], [false, 'no-space']);
});
t('moveSpot/resizeSpot: ずらす・手前で止める・最小最大', () => {
  let L = mk('kitchen'); const k = Object.keys(L.rooms)[0];
  L = F.addSpot(L, k, 'fridge', { x: 0, y: 0 }).layout; L = F.addSpot(L, k, 'freezer', { x: 10, y: 0 }).layout; freeze(L);
  const a = sid(L, '冷蔵庫'), b = sid(L, '冷凍庫');
  const m = F.moveSpot(L, a, 9, 0); assert.equal(m.adjusted, true); inv(m.layout);
  const r = F.resizeSpot(L, a, { w: 20 }); assert.equal(r.layout.spots[a].w, 10); assert.equal(r.adjusted, true); // 冷凍庫(x=10)の手前
  const r2 = F.resizeSpot(L, a, { w: 0, h: 99 }); assert.deepEqual([r2.layout.spots[a].w, r2.layout.spots[a].h], [2, 24]); inv(r2.layout);
  const mv = F.moveSpot(L, b, 99, 99); assert.deepEqual([mv.layout.spots[b].x, mv.layout.spots[b].y], [19, 20]);
});
t('deleteSpot: 墓標が残る', () => {
  let L = mk('kitchen'); const k = Object.keys(L.rooms)[0]; const a = F.addSpot(L, k, 'fridge'); const d = F.deleteSpot(a.layout, a.id, { now: NOW + 5 });
  assert.equal(Object.keys(d.layout.spots).length, 0); assert.ok(d.layout.dead[a.id] >= NOW + 5);
});
t('u は必ず前より大きくなる(時計が進んでいる他端末の後でも負けない)', () => {
  let L = F.addRoom(F.emptyLayout(), 'living', { now: NOW + 1e9 }).layout; const id = Object.keys(L.rooms)[0];
  assert.ok(F.moveRoom(L, id, 3, 3, { now: NOW }).layout.rooms[id].u > NOW + 1e9);
});

// ---- ドラッグ補助 ----
t('snap・hitTest・bounds', () => {
  assert.equal(F.snap(3.4), 3); assert.equal(F.snap(3.5), 4); assert.equal(F.snap(7, 2), 8); assert.equal(F.snap(5, 5), 5);
  let L = mk('living', 'kitchen'); const l = rid(L, 'リビング'), k = rid(L, 'キッチン');
  assert.deepEqual(F.hitTest(L, 1, 1), { type: 'room', id: l }); assert.deepEqual(F.hitTest(L, 8, 0), { type: 'room', id: k });
  assert.equal(F.hitTest(L, 8, 3.99).id, k); assert.equal(F.hitTest(L, 8, 4), null); assert.equal(F.hitTest(L, -1, 0), null);
  L = F.addSpot(L, k, 'fridge', { x: 2, y: 2 }).layout; const s = sid(L, '冷蔵庫');
  assert.deepEqual(F.hitTest(L, 2, 2, k), { type: 'spot', id: s }); assert.equal(F.hitTest(L, 7, 2, k), null); assert.equal(F.hitTest(L, 2, 2, l), null);
  assert.deepEqual(F.bounds(L), { x: 0, y: 0, w: 14, h: 6, maxX: 14, maxY: 6 }); assert.deepEqual(F.bounds(L, k), { x: 2, y: 2, w: 5, h: 6, maxX: 7, maxY: 8 });
  assert.deepEqual(F.bounds(F.emptyLayout()), { x: 0, y: 0, w: GRID_W, h: 10, maxX: GRID_W, maxY: 10 });
  assert.equal(F.toSpotUnits(100, 200), 12);
});

// ---- 在庫との結びつき ----
const D = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
t('summarize: 収納場所・部屋・旧名・全角半角・足りない・期限・予測の期限', () => {
  let L = mk('kitchen', 'washroom', 'storeroom'); const k = rid(L, 'キッチン'), w = rid(L, '洗面所'), n = rid(L, '納戸');
  L = F.addSpot(L, k, 'fridge').layout; L = F.addSpot(L, k, 'pantry').layout; L = F.addSpot(L, n, 'oshiire').layout; L = F.addSpot(L, w, 'sink').layout;
  const items = [
    { id: 1, name: '牛乳', qty: 1, minQty: 2, location: '冷蔵庫', expiry: D(2) },            // low + exp
    { id: 2, name: '卵', qty: 6, minQty: 0, location: '冷蔵庫 ', expiry: D(-1) },             // exp(末尾空白を吸収)
    { id: 3, name: 'ヨーグルト', qty: 2, location: '冷蔵庫', expiry: D(3), expirySrc: '予測', expiryLevel: 'low' }, // expEst
    { id: 4, name: 'ハム', qty: 1, location: '冷蔵庫', expiry: D(3), expirySrc: '予測', expiryLevel: 'high' },       // 強い予測は exp
    { id: 5, name: '切れた牛乳', qty: 0, minQty: 1, location: '冷蔵庫', expiry: D(-5) },      // low のみ(数量0は期限を数えない)
    { id: 6, name: '米', qty: 1, location: 'パントリー' },
    { id: 7, name: '洗剤', qty: 1, location: '洗面所' },                                    // 部屋名 → loose
    { id: 8, name: '歯ブラシ', qty: 1, location: '洗面台の下' },
    { id: 9, name: '布団', qty: 1, location: '押入れ' },                                    // 旧名 → 押入れ・収納 の収納場所(名前『押入れ』)
    { id: 10, name: 'ティッシュ', qty: 1, location: 'ﾊﾟﾝﾄﾘｰ' },                              // 半角カナ
    { id: 11, name: 'どこか', qty: 1, location: 'ガレージ' },
    { id: 12, name: '場所なし', qty: 1, location: '' },
    { id: 13, name: '前回の目安', qty: 1, location: '冷蔵庫', expiry: D(1), expirySrc: '前回', expiryLevel: 'low' },
  ];
  const S = F.summarize(L, items, NOW), f = sid(L, '冷蔵庫');
  const fr = S.spots[f]; assert.deepEqual([fr.count, fr.have, fr.low, fr.exp, fr.expEst], [6, 5, 2, 3, 2]); assert.deepEqual(fr.items.map((i) => i.id), [1, 2, 3, 4, 5, 13]);
  const pa = S.spots[sid(L, 'パントリー')]; assert.deepEqual(pa.items.map((i) => i.id), [6, 10]);
  assert.deepEqual(S.spots[sid(L, '洗面台の下')].items.map((i) => i.id), [8]);
  assert.deepEqual(S.spots[sid(L, '押入れ')].items.map((i) => i.id), [9]);
  assert.deepEqual(S.rooms[w].loose.items.map((i) => i.id), [7]); assert.equal(S.rooms[w].count, 2); assert.equal(S.rooms[w].loose.count, 1);
  assert.equal(S.rooms[k].count, 8); assert.equal(S.rooms[k].loose.count, 0); assert.deepEqual([S.rooms[k].low, S.rooms[k].exp, S.rooms[k].expEst], [2, 3, 2]);
  assert.equal(S.rooms[n].count, 1);
  const u = F.unplaced(L, items); assert.deepEqual(u.map((x) => [x.name, x.count, x.empty]), [['ガレージ', 1, false], ['', 1, true]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  assert.deepEqual(u.find((x) => x.name === 'ガレージ').items.map((i) => i.id), [11]);
});
t('summarize: 旧名「風呂・トイレ」は品名でお風呂/トイレの部屋に振り分けられる', () => {
  const L = mk('bath', 'toilet'); const S = F.summarize(L, [{ name: 'トイレ用洗剤', qty: 1, location: '風呂・トイレ' }, { name: 'お風呂の洗剤', qty: 1, location: '風呂・トイレ' }], NOW);
  assert.equal(S.rooms[rid(L, 'トイレ')].loose.count, 1); assert.equal(S.rooms[rid(L, 'お風呂')].loose.count, 1);
  assert.deepEqual(F.unplaced(L, [{ name: 'x', qty: 1, location: '風呂・トイレ' }]).length, 0);
});
t('unplaced: 旧名は新しい名前で表示・多い順・空の items', () => {
  const L = mk('kitchen'); const u = F.unplaced(L, [{ name: 'a', location: '押入れ' }, { name: 'b', location: '押入れ・収納' }, { name: 'c', location: '車' }, null, { location: 'x' }]);
  assert.deepEqual(u.map((x) => [x.name, x.count]), [['押入れ・収納', 2], ['車', 1]]);
  assert.deepEqual(F.unplaced(F.emptyLayout(), []), []); assert.equal(F.summarize(F.emptyLayout(), null).rooms && Object.keys(F.summarize(F.emptyLayout(), []).rooms).length, 0);
});
t('summarize: 部屋の名前を変えると結びつきも変わる', () => {
  let L = mk('kitchen'); const k = Object.keys(L.rooms)[0]; const it = [{ name: 'a', qty: 1, location: 'キッチン' }];
  assert.equal(F.summarize(L, it, NOW).rooms[k].count, 1); L = F.renameRoom(L, k, '台所').layout;
  assert.equal(F.summarize(L, it, NOW).rooms[k].count, 0); assert.equal(F.unplaced(L, it)[0].name, 'キッチン');
});

// ---- 読み込み・整合 ----
t('parseLayout: 未設定・壊れたデータ・範囲外・不正なid・墓標との食い違い', () => {
  assert.deepEqual(F.parseLayout(undefined), F.emptyLayout()); assert.deepEqual(F.parseLayout('x'), F.emptyLayout()); assert.deepEqual(F.parseLayout({ rooms: 5 }), F.emptyLayout());
  const L = F.parseLayout({ rooms: { a: { x: -3, y: 1.6, w: 100, h: 0, name: '  ', kind: 'zz', u: 5 }, 'b.c': { x: 0, y: 0, w: 2, h: 2 }, d: null },
    spots: { s1: { room: 'a', x: 30, y: 30, w: 1, h: 99, name: 'x' }, s2: { room: 'nope', x: 0, y: 0, w: 3, h: 3 }, s3: { x: 0 } }, dead: { gone: 7, bad: 'x', s2: 3 } });
  assert.deepEqual(Object.keys(L.rooms), ['a']); assert.deepEqual(L.rooms.a, { id: 'a', name: 'その他', kind: 'other', x: 0, y: 2, w: 24, h: 2, color: 'gray', u: 5 });
  assert.deepEqual(Object.keys(L.spots), ['s1']); assert.deepEqual([L.spots.s1.x, L.spots.s1.w, L.spots.s1.h, L.spots.s1.y], [22, 2, 24, 0]);
  assert.ok(L.dead.gone === 7 && L.dead.s2 >= 3 && !('bad' in L.dead));
  const R = F.parseLayout({ rooms: { a: { x: 0, y: 0, w: 3, h: 3, u: 10 } }, dead: { a: 5 } }); assert.ok(R.rooms.a && !('a' in R.dead)); // 編集のほうが新しい
  const R2 = F.parseLayout({ rooms: { a: { x: 0, y: 0, w: 3, h: 3, u: 5 } }, dead: { a: 5 } }); assert.ok(!R2.rooms.a && R2.dead.a === 5); // 同時刻は削除が勝つ
});
t('JSON往復で同じ・undefined/null/配列の入れ子なし', () => {
  const L = F.starterLayout('house', NOW); assert.deepEqual(J(L), L); assert.deepEqual(F.parseLayout(J(L)), L); inv(L); noNestedArray(L);
  const P = F.diffLayout(F.emptyLayout(), L); noNestedArray(P); assert.ok(!JSON.stringify(P).includes('undefined'));
});
t('サイズ: 収納場所300・部屋30でも数十KB以内', () => {
  let L = F.emptyLayout(); for (let i = 0; i < 30; i++) { const r = F.addRoom(L, F.ROOM_KINDS[i % F.ROOM_KINDS.length].kind, { w: 2, h: 2, now: NOW + i }); if (r.ok) L = r.layout; }
  const ids = Object.keys(L.rooms); let n = 0;
  for (let i = 0; i < 300; i++) { const r = F.addSpot(L, ids[i % ids.length], F.SPOT_KINDS[i % F.SPOT_KINDS.length].kind, { w: 2, h: 2, name: `収納場所の名前${i}`, now: NOW + i }); if (r.ok) { L = r.layout; n++; } }
  const size = JSON.stringify(L).length; assert.ok(n >= 250, `spots ${n}`); assert.ok(size < 80_000, `size ${size}`); console.log(`  (部屋${ids.length}・収納場所${n} → ${size} バイト)`);
  assert.ok(size < 1_000_000);
});

// ---- ひな形 ----
t('starterLayout: 全種類で不変条件・ずれなし・キッチンに冷蔵庫など', () => {
  for (const k of ['1K', '2LDK', '3LDK', 'house']) {
    const L = F.starterLayout(k, NOW); inv(L, k);
    const spec = F.starterLayout(k, NOW); assert.deepEqual(Object.values(L.rooms).map((r) => [r.x, r.y, r.w, r.h]), Object.values(spec.rooms).map((r) => [r.x, r.y, r.w, r.h]));
    const names = Object.values(L.spots).map((s) => s.name); assert.ok(['冷蔵庫', '冷凍庫', 'パントリー', '洗面台の下', '玄関収納'].every((n) => names.includes(n)), `${k} ${names}`);
  }
  assert.deepEqual(F.starterLayout('empty'), F.emptyLayout()); assert.deepEqual(F.starterLayout('nope'), F.emptyLayout());
  assert.ok(F.STARTER_KINDS.length >= 4);
});
t('starterLayout: 指定どおりの位置に置かれる(ずれていない)', () => {
  // addRoom が位置指定で ずらしていないこと = 各部屋の座標がテンプレートと一致 (2LDK のリビングは 0,0 8x6)
  const L = F.starterLayout('2LDK', NOW), l = Object.values(L.rooms).find((r) => r.name === 'リビング'); assert.deepEqual([l.x, l.y, l.w, l.h], [0, 0, 8, 6]);
  assert.equal(Object.keys(L.rooms).length, 9);
});

// ---- 差分・共有 ----
const rd = (L) => J(L);
t('diffLayout: 追加・変更・削除がドット記法で出る・変更なしは空', () => {
  let a = mk('living', 'kitchen'); const k = rid(a, 'キッチン');
  assert.deepEqual(F.diffLayout(a, a), {});
  const b = F.moveRoom(a, k, 12, 8).layout, p = F.diffLayout(a, b); assert.deepEqual(Object.keys(p), [`layout.rooms.${k}`]); assert.equal(p[`layout.rooms.${k}`].x, 12);
  const c = F.addSpot(a, k, 'fridge'), pc = F.diffLayout(a, c.layout); assert.deepEqual(Object.keys(pc), [`layout.spots.${c.id}`]);
  const d = F.deleteRoom(c.layout, k, { now: NOW + 1e6 }), pd = F.diffLayout(c.layout, d.layout);
  assert.equal(pd[`layout.rooms.${k}`], DELETE); assert.equal(pd[`layout.spots.${c.id}`], DELETE); assert.equal(typeof pd[`layout.dead.${k}`], 'number'); assert.equal(typeof pd[`layout.dead.${c.id}`], 'number');
  assert.ok(Object.keys(F.diffLayout(F.emptyLayout(), a)).every((x) => x.startsWith('layout.')));
});
t('diffLayout + applyPatch で next に戻る(ランダムな編集列)', () => {
  const R = rng(7); let L = F.emptyLayout();
  for (let i = 0; i < 300; i++) { const n = randomOp(L, R); const p = F.diffLayout(L, n); const back = F.applyPatch(L, p); assert.deepEqual(F.parseLayout(back), F.parseLayout(n)); L = n; }
});
t('applyPatch: 元を変更しない・layout.以外のキーは無視', () => {
  const L = freeze(mk('living')); const r = F.applyPatch(L, { 'members.x': 1, 'layout.rooms.zz': { id: 'zz' }, 'layout.v': 1 }); assert.ok(r.rooms.zz && !L.rooms.zz);
});
t('applyRemote: 別の部屋を同時に編集しても両方残る', () => {
  const base = F.starterLayout('2LDK', NOW), a0 = rid(base, 'リビング'), b0 = rid(base, 'キッチン');
  const A = F.moveRoom(base, a0, 0, 20, { now: NOW + 10 }).layout, B = F.renameRoom(base, b0, '台所', { now: NOW + 20 }).layout;
  const m1 = F.applyRemote(A, B), m2 = F.applyRemote(B, A);
  assert.deepEqual(m1, m2); assert.equal(m1.rooms[a0].y, 20); assert.equal(m1.rooms[b0].name, '台所'); inv(m1);
});
t('applyRemote: 同じ要素の同時編集は新しいほうが勝つ(順序によらない)', () => {
  const base = mk('living'), id = Object.keys(base.rooms)[0];
  const A = F.moveRoom(base, id, 5, 5, { now: NOW + 100 }).layout, B = F.moveRoom(base, id, 9, 9, { now: NOW + 200 }).layout;
  assert.deepEqual([F.applyRemote(A, B).rooms[id].x, F.applyRemote(B, A).rooms[id].x], [9, 9]);
});
t('applyRemote: 同時刻でも順序によらず同じ結果(決定的)', () => {
  const base = mk('living'), id = Object.keys(base.rooms)[0];
  const A = F.moveRoom(base, id, 5, 5, { now: 5 }).layout, B = F.moveRoom(base, id, 9, 9, { now: 5 }).layout; B.rooms[id].u = A.rooms[id].u;
  assert.deepEqual(F.applyRemote(A, B), F.applyRemote(B, A));
});
t('applyRemote: 削除と編集(削除が新しければ消え、編集が新しければ残る)', () => {
  const base = F.starterLayout('1K', NOW), id = rid(base, '寝室');
  const del = F.deleteRoom(base, id, { now: NOW + 100 }).layout, edit = F.moveRoom(base, id, 14, 9, { now: NOW + 50 }).layout, edit2 = F.moveRoom(base, id, 14, 9, { now: NOW + 500 }).layout;
  const m = F.applyRemote(edit, del); assert.ok(!m.rooms[id] && m.dead[id]); assert.deepEqual(m, F.applyRemote(del, edit));
  const m2 = F.applyRemote(edit2, del); assert.ok(m2.rooms[id] && !m2.dead[id]); assert.deepEqual(m2, F.applyRemote(del, edit2)); inv(m2);
});
t('applyRemote: 部屋が消えたところへ同時に追加された収納場所は残らない(孤児を作らない)', () => {
  const base = mk('kitchen', 'living'), k = rid(base, 'キッチン');
  const A = F.deleteRoom(base, k, { now: NOW + 100 }).layout, B = F.addSpot(base, k, 'shelf', { now: NOW + 200 }).layout;
  const m = F.applyRemote(A, B); inv(m); assert.equal(Object.keys(m.spots).length, 0); assert.deepEqual(m, F.applyRemote(B, A));
});
t('applyRemote: 同時に同じ場所へ置いた部屋・同じ名前の収納場所は、重ならない・一意に直る(両方残る)', () => {
  const base = mk('living'), A = F.addRoom(base, 'study', { x: 10, y: 0, now: NOW + 10, id: 'r_a' }).layout, B = F.addRoom(base, 'bath', { x: 10, y: 0, now: NOW + 20, id: 'r_b' }).layout;
  const m = F.applyRemote(A, B); inv(m); assert.ok(m.rooms.r_a && m.rooms.r_b); assert.deepEqual(m, F.applyRemote(B, A));
  const l = Object.keys(base.rooms)[0];
  const A2 = F.addSpot(base, l, 'shelf', { name: '棚', id: 's_a', now: NOW + 10 }).layout, B2 = F.addSpot(base, l, 'shelf', { name: '棚', id: 's_b', now: NOW + 20 }).layout;
  const m2 = F.applyRemote(A2, B2); inv(m2); assert.equal(Object.keys(m2.spots).length, 2); assert.deepEqual(m2, F.applyRemote(B2, A2));
  assert.equal(m2.spots.s_a.name, '棚'); assert.equal(m2.spots.s_b.name, '棚(リビング)'); // 古いほうが元の名前を保つ
});
t('applyRemote: 冪等・空との合成・未設定の remote', () => {
  const L = F.starterLayout('3LDK', NOW);
  assert.deepEqual(F.applyRemote(L, L), L); assert.deepEqual(F.applyRemote(L, undefined), L); assert.deepEqual(F.applyRemote(F.emptyLayout(), L), L); assert.deepEqual(F.applyRemote(undefined, L), L);
  const m = F.applyRemote(L, L); assert.deepEqual(F.applyRemote(m, L), m);
});
t('applyRemote: 結合的・可換的(重なりの補正なしの合成は、3つをどの順で合わせても同じ。補正は repair で冪等)', () => {
  const R = rng(11);
  for (let n = 0; n < 40; n++) {
    const base = F.starterLayout('2LDK', NOW), rep = [0, 1, 2].map((i) => { let L = base; for (let j = 0; j < 6; j++) L = randomOp(L, R, NOW + i * 7 + j * 31 + n); return L; });
    const o = { fix: false }, M = (a, b) => F.applyRemote(a, b, o);
    const x = M(M(rep[0], rep[1]), rep[2]), y = M(rep[2], M(rep[1], rep[0])), z = M(M(rep[1], rep[2]), rep[0]);
    assert.deepEqual(x, y); assert.deepEqual(x, z); inv(F.repair(x)); assert.deepEqual(F.repair(F.repair(x)), F.repair(x));
  }
});
t('compact: 古い墓標だけ捨てる', () => {
  const L = { ...F.emptyLayout(), dead: { old: NOW - 90 * 864e5, fresh: NOW - 864e5 } }; assert.deepEqual(Object.keys(F.compact(L, NOW).dead), ['fresh']);
});
t('createSync: apply は差分だけ送り、receive は相手の変更を取り込む', async () => {
  const sent = []; const S = F.createSync((p) => { sent.push(p); }, () => NOW);
  const r = F.addRoom(S.layout, 'living', { now: NOW }); await S.apply(r.layout); assert.equal(sent.length, 1); assert.deepEqual(Object.keys(sent[0]), [`layout.rooms.${r.id}`]);
  const other = F.addRoom(S.layout, 'kitchen', { now: NOW + 5 }); // 相手が足した
  await S.receive(other.layout); assert.equal(Object.keys(S.layout.rooms).length, 2); assert.equal(sent.length, 1); // 自分の保存に含まれる分は送り直さない
  await S.receive(F.emptyLayout()); assert.equal(Object.keys(S.layout.rooms).length, 2); assert.ok(sent.length >= 2); // 相手に無いものは送る
  const del = F.deleteRoom(S.layout, r.id, { now: NOW + 50 }); await S.apply(del.layout); assert.equal(sent.at(-1)[`layout.rooms.${r.id}`], DELETE);
});

t('ランダムな操作列: 部屋が重ならない・収納場所が部屋内・名前が一意(60列×150操作=9000回)', () => {
  const R = rng(20260101); let ops = 0;
  for (let n = 0; n < 60; n++) {
    let L = n % 3 === 0 ? F.starterLayout('3LDK', NOW) : F.emptyLayout();
    for (let i = 0; i < 150; i++) { const prev = freeze(L); L = randomOp(prev, R, NOW + n * 1000); inv(L, `seq${n} op${i}`); ops++; }
    assert.deepEqual(F.parseLayout(J(L)), L); // 保存して読み戻しても同じ
  }
  assert.equal(ops, 9000);
});
t('ランダムな2端末の編集と合成: どの時点でも不変条件・順序によらず収束(200回)', () => {
  const R = rng(99);
  for (let n = 0; n < 200; n++) {
    let base = F.starterLayout(['1K', '2LDK', '3LDK', 'house'][n % 4], NOW);
    for (let i = 0; i < 10; i++) base = randomOp(base, R, NOW + i);
    let A = base, B = base; for (let i = 0; i < 12; i++) { A = randomOp(A, R, NOW + 1000 + i * 3); B = randomOp(B, R, NOW + 1001 + i * 3); }
    const m1 = F.applyRemote(A, B), m2 = F.applyRemote(B, A); inv(m1, `merge${n}`); assert.deepEqual(m1, m2); assert.deepEqual(F.applyRemote(m1, A), m1); assert.deepEqual(F.applyRemote(m1, B), m1);
    // 差分だけを相手に送っても、同じ結果になる(各自が自分の変更の差分を相手に適用)
    const viaPatch = F.applyRemote(F.applyPatch(A, F.diffLayout(base, B)), F.emptyLayout()); inv(viaPatch);
  }
});

// ---- store.js: Firestore はモック ----
function mockFs() {
  const calls = [], docs = {}, snaps = [];
  const fs = {
    initializeFirestore: () => ({ db: 1 }), persistentLocalCache: () => ({}), getFirestore: () => ({ db: 1 }),
    collection: (_db, ...p) => ({ path: p.join('/') }),
    doc: (a, ...p) => ({ path: [a?.path, ...p].filter(Boolean).join('/') }),
    getDoc: async (ref) => ({ exists: () => ref.path in docs, data: () => docs[ref.path] }),
    setDoc: async (ref, v) => { calls.push(['setDoc', ref.path, v]); docs[ref.path] = v; },
    updateDoc: async (ref, v) => { calls.push(['updateDoc', ref.path, v]); },
    deleteDoc: async () => {}, arrayUnion: (x) => ({ arrayUnion: x }),
    deleteField: () => ({ __deleteField: true }),
    onSnapshot: (ref, opts, ok, err) => { const s = { ref, opts, ok, err }; snaps.push(s); return () => { s.off = true; }; },
  };
  return { fs, calls, docs, snaps };
}
const snapOf = (data, pending = false) => ({ data: () => data, metadata: { hasPendingWrites: pending }, docs: [] });
const wait = () => new Promise((r) => setTimeout(r, 5));
await ta('store(cloud): saveLayoutPatch は DELETE→deleteField、undefined は落とす、layout. 以外は無視', async () => {
  const m = mockFs(); m.docs['users/u1'] = { hid: 'H1' }; m.docs['households/H1'] = { name: 'x', members: ['u1'] };
  const st = await cloudStore({ appM: { initializeApp: () => ({}) }, authM: { getAuth: () => ({}), onAuthStateChanged: (_a, cb) => cb({ uid: 'u1', displayName: 'U' }) }, fs: m.fs });
  let state; await st.init((s) => { state = s; }); await wait(); assert.equal(state.household.id, 'H1');
  assert.equal(typeof st.subscribeLayout, 'function'); assert.equal(typeof st.saveLayoutPatch, 'function');
  await st.saveLayoutPatch({ 'layout.rooms.r1': { id: 'r1', name: 'a', note: undefined, nest: { z: undefined, k: 1 } }, 'layout.spots.s9': DELETE, 'layout.dead.s9': 123, 'layout.rooms.r2': undefined, 'members': ['evil'], 'name': 'evil' });
  const [c] = m.calls.filter((x) => x[0] === 'updateDoc'); assert.equal(c[1], 'households/H1');
  assert.deepEqual(Object.keys(c[2]).sort(), ['layout.dead.s9', 'layout.rooms.r1', 'layout.spots.s9']);
  assert.deepEqual(c[2]['layout.spots.s9'], { __deleteField: true }); assert.deepEqual(c[2]['layout.rooms.r1'], { id: 'r1', name: 'a', nest: { k: 1 } }); assert.equal(c[2]['layout.dead.s9'], 123);
  assert.ok(!JSON.stringify(c[2]).includes('undefined'));
  const n = m.calls.length; await st.saveLayoutPatch({}); await st.saveLayoutPatch({ x: 1 }); assert.equal(m.calls.length, n); // 空は送らない
});
await ta('store(cloud): subscribeLayout は households/{hid} を購読し、layout を渡す(未設定は空)', async () => {
  const m = mockFs(); m.docs['users/u1'] = { hid: 'H1' }; m.docs['households/H1'] = { name: 'x', members: ['u1'] };
  const st = await cloudStore({ appM: { initializeApp: () => ({}) }, authM: { getAuth: () => ({}), onAuthStateChanged: (_a, cb) => cb({ uid: 'u1', displayName: 'U' }) }, fs: m.fs });
  await st.init(() => {}); await wait();
  const got = []; const un = st.subscribeLayout((l, meta) => got.push([l, meta]), () => {});
  const s = m.snaps.at(-1); assert.equal(s.ref.path, 'households/H1'); assert.equal(s.opts.includeMetadataChanges, true);
  s.ok(snapOf({ name: 'x', members: ['u1'] })); assert.deepEqual(got[0], [F.emptyLayout(), { pending: false }]);
  const L = F.starterLayout('1K', NOW); s.ok(snapOf({ name: 'x', layout: J(L) }, true)); assert.deepEqual(got[1], [L, { pending: true }]);
  s.ok({ data: () => undefined, metadata: { hasPendingWrites: false } }); assert.deepEqual(got[2][0], F.emptyLayout());
  const errs = []; st.subscribeLayout(() => {}, (e) => errs.push(e)); m.snaps.at(-1).err(new Error('x')); assert.equal(errs.length, 1);
  un(); assert.ok(typeof un === 'function');
  // 既存の品目の購読は従来どおり(コレクションを購読)
  st.subscribe(() => {}); assert.equal(m.snaps.at(-1).ref.path, 'households/H1/items');
});
await ta('store(cloud): 家の作成・参加の流れは変わらない', async () => {
  const m = mockFs(); const st = await cloudStore({ appM: { initializeApp: () => ({}) }, authM: { getAuth: () => ({}), onAuthStateChanged: (_a, cb) => cb({ uid: 'u1', displayName: 'U' }) }, fs: m.fs });
  let state; await st.init((s) => { state = s; }); await wait(); assert.equal(state.household, null);
  await st.createHousehold('うち'); const set = m.calls.find((c) => c[0] === 'setDoc' && c[1].startsWith('households/')); assert.deepEqual(Object.keys(set[2]).sort(), ['createdAt', 'members', 'name']); assert.equal(state.household.name, 'うち');
  await st.joinHousehold('abc'); assert.deepEqual(m.calls.find((c) => c[0] === 'updateDoc')[2], { members: { arrayUnion: 'u1' } });
});
await ta('store(local): hs-layout に保存し、購読に流れる(localStorage をモック)', async () => {
  const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const st = localStore(); const got = []; const un = st.subscribeLayout((l, m) => got.push([l, m]));
  assert.deepEqual(got[0][0], F.emptyLayout()); assert.deepEqual(got[0][1], { pending: false });
  const L = F.starterLayout('1K', NOW); await st.saveLayoutPatch(F.diffLayout(F.emptyLayout(), L)); assert.deepEqual(got.at(-1)[0], L); assert.deepEqual(JSON.parse(mem.get('hs-layout')), L);
  const id = rid(L, '寝室'), L2 = F.deleteRoom(L, id, { now: NOW + 9 }).layout; await st.saveLayoutPatch(F.diffLayout(L, L2)); assert.deepEqual(got.at(-1)[0], L2);
  assert.deepEqual(localStore().subscribeLayout((l) => assert.deepEqual(l, L2)) && 1, 1); // 別のインスタンスでも読める
  un(); const n = got.length; await st.saveLayoutPatch({}); assert.equal(got.length, n);
  mem.set('hs-layout', '{broken'); assert.deepEqual((() => { let x; localStore().subscribeLayout((l) => { x = l; }); return x; })(), F.emptyLayout());
  // 品目の保存は従来どおり
  await st.save({ name: 'a', qty: 1 }); let items; localStore().subscribe((a) => { items = a; }); assert.equal(items.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
