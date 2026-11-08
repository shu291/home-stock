// 間取りの画面の純粋な部分(元に戻す・なぞる大きさ・種類の推測)と、クラウド相当の共有(偽の Firestore を cloudStore(mods) に注入した2端末)の検査
// 実行: node js/floorplan-ui.test.mjs
import { touchedIds, undoLayout, guessSpotKind, resizeTarget } from './floorplan-ui.js';
import { createSync, starterLayout, emptyLayout, addRoom, moveRoom, renameRoom, deleteRoom, addSpot, deleteSpot, applyRemote, diffLayout, parseLayout, DELETE } from './floorplan.js';
import { cloudStore } from './store.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const undefs = (v) => { const bad = []; (function w(x, p) { if (x === undefined) bad.push(p); else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) w(y, p + '.' + k); })(v, ''); return bad; };

// ---- 純粋な補助 ----
{
  const a = starterLayout('1K', 1000), room = Object.values(a.rooms)[0];
  const m = moveRoom(a, room.id, 20, 30, { now: 2000 });
  ok(touchedIds(a, m.layout).join() === room.id || m.adjusted, 'touchedIds: 動かした部屋だけ');
  ok(touchedIds(a, a).length === 0, 'touchedIds: 同じなら空');
  const d = deleteRoom(a, room.id, { now: 3000 });
  ok(touchedIds(a, d.layout).length >= 1 + Object.values(a.spots).filter((s) => s.room === room.id).length, 'touchedIds: 部屋と中の収納場所');
  // 元に戻す: 他の端末が見ても戻る(戻した要素の u は新しい)
  const u = undoLayout(m.layout, a, m.layout, 5000);
  ok(JSON.stringify({ ...u.layout.rooms[room.id], u: 0 }) === JSON.stringify({ ...a.rooms[room.id], u: 0 }) && u.layout.rooms[room.id].u > m.layout.rooms[room.id].u, 'undoLayout: 中身は元通りで u は新しい');
  const back = applyRemote(m.layout, u.layout);
  ok(back.rooms[room.id].x === a.rooms[room.id].x, 'undoLayout: 編集後の端末に送ると、戻したほうが勝つ');
  // 削除の取り消し
  const ud = undoLayout(d.layout, a, d.layout, 5000);
  ok(!!ud.layout.rooms[room.id] && ud.layout.dead[room.id] === undefined && ud.layout.rooms[room.id].u > d.layout.dead[room.id], 'undoLayout: 削除を戻すと墓標より新しい u で生き返る');
  ok(Object.values(ud.layout.spots).length === Object.values(a.spots).length, 'undoLayout: 部屋の中の収納場所も戻る');
  ok(Object.keys(applyRemote(d.layout, ud.layout).rooms).includes(room.id), 'undoLayout: 削除した端末と合わせても生き返ったまま');
  // 追加の取り消し
  const ad = addRoom(a, 'study', { now: 4000 }), ua = undoLayout(ad.layout, a, ad.layout, 5000);
  ok(!ua.layout.rooms[ad.id] && ua.layout.dead[ad.id] >= 5000, 'undoLayout: 追加を戻すと墓標');
  // 操作のあとに他の人が変えた要素は触らない
  const other = moveRoom(m.layout, room.id, 20, 34, { now: 9000 }).layout;
  const sk = undoLayout(other, a, m.layout, 9500);
  ok(sk.skipped.includes(room.id) && sk.layout.rooms[room.id].y === other.rooms[room.id].y, 'undoLayout: 後から他の人が変えた要素は戻さない(skipped)');
}
ok(guessSpotKind('冷凍庫') === 'freezer' && guessSpotKind('冷蔵庫B') === 'fridge' && guessSpotKind('食器棚') === 'cupboard' && guessSpotKind('洗面台の下') === 'sink' && guessSpotKind('物置') === 'mono' && guessSpotKind('謎') === 'other' && guessSpotKind('本棚') === 'shelf', 'guessSpotKind');
{
  const r = { x: 4, y: 4, w: 6, h: 4 };
  const t = (d, ux, uy, h = true) => resizeTarget(r, d, ux, uy, h);
  ok(JSON.stringify(t('se', 2, 1)) === JSON.stringify({ x: 4, y: 4, w: 8, h: 5 }), 'resizeTarget: 右下');
  ok(JSON.stringify(t('nw', -2, -1)) === JSON.stringify({ x: 2, y: 3, w: 8, h: 5 }), 'resizeTarget: 左上');
  ok(t('nw', 50, 50).w === 2 && t('nw', 50, 50).h === 2 && t('nw', 50, 50).x === 8, 'resizeTarget: 引き込みすぎても最小(2)・右下は動かない');
  ok(t('e', 99, 0).w + 4 <= 24 && t('w', -99, 0).x === 0, 'resizeTarget: 端で止まる');
  ok(JSON.stringify(t('n', 0, -2)) === JSON.stringify({ x: 4, y: 2, w: 6, h: 6 }) && t('s', 0, -9).h === 2, 'resizeTarget: 辺');
}

// ---- クラウド相当(偽 Firestore) ----
const DB = { docs: { 'users/u1': { hid: 'H' }, 'households/H': { name: 'うち', members: ['u1'] } }, subs: [], writes: [], hold: false, queue: [] };
const FIELD = { del: Symbol('del') };
const get = (path) => DB.docs[path];
const deliver = (s) => s.cb({ data: () => JSON.parse(JSON.stringify(get(s.path))), metadata: { hasPendingWrites: false } });
const notify = (path) => DB.subs.filter((s) => s.path === path).forEach((s) => (DB.hold ? DB.queue.push(s) : deliver(s)));
const mods = {
  appM: { initializeApp: () => ({}) },
  authM: { getAuth: () => ({}), onAuthStateChanged: (a, cb) => queueMicrotask(() => cb({ uid: 'u1', displayName: 'U' })), GoogleAuthProvider: class {}, signInWithPopup() {}, signOut() {} },
  fs: {
    initializeFirestore: () => ({}), persistentLocalCache: () => ({}), getFirestore: () => ({}),
    doc: (a, ...seg) => ({ path: (a.path ? [a.path, ...seg] : seg).join('/') }), collection: (a, ...seg) => ({ path: [...seg].join('/') }),
    getDoc: async (r) => ({ exists: () => !!get(r.path), data: () => get(r.path) }),
    setDoc: async (r, d) => { DB.docs[r.path] = JSON.parse(JSON.stringify(d)); notify(r.path); },
    arrayUnion: (x) => x, deleteField: () => FIELD.del,
    updateDoc: async (r, upd) => {
      DB.writes.push(upd); const d = get(r.path);
      for (const [k, v] of Object.entries(upd)) {
        const seg = k.split('.'); let o = d; for (const s of seg.slice(0, -1)) o = o[s] ??= {};
        if (v === FIELD.del) delete o[seg.at(-1)]; else o[seg.at(-1)] = JSON.parse(JSON.stringify(v));
      }
      notify(r.path);
    },
    onSnapshot: (r, opts, cb) => { const s = { path: r.path, cb }; DB.subs.push(s); deliver(s); return () => { DB.subs = DB.subs.filter((x) => x !== s); }; },
  },
};
async function device() {
  const st = await cloudStore(mods); let hh = null;
  await st.init((s) => { hh = s.household; }); await new Promise((r) => setTimeout(r, 10));
  const sync = createSync((patch) => st.saveLayoutPatch(patch)); st.subscribeLayout((remote) => { sync.receive(remote); });
  return { st, sync, hh };
}
const flush = () => { DB.hold = false; const q = DB.queue.splice(0); q.forEach(deliver); };
{
  const A = await device(), B = await device();
  ok(A.hh?.id === 'H', 'クラウド: 家に入る');
  const T = Date.now(), L0 = starterLayout('2LDK', T);
  await A.sync.apply(L0);
  ok(Object.keys(B.sync.layout.rooms).length === 9 && Object.keys(B.sync.layout.spots).length === Object.keys(L0.spots).length, 'クラウド: A の間取りが B に届く');
  ok(undefs(DB.docs['households/H']).length === 0, 'クラウド: 保存に undefined がない');
  // 差分: 1つ動かす → 書き込みは1項目
  const living = Object.values(A.sync.layout.rooms).find((r) => r.name === 'ベランダ');
  DB.writes.length = 0;
  await A.sync.apply(moveRoom(A.sync.layout, living.id, living.x, living.y + 1, { now: T + 5000 }).layout);
  ok(DB.writes.length === 1 && Object.keys(DB.writes[0]).join() === `layout.rooms.${living.id}`, 'クラウド: 動かすと、その部屋1つだけ送る(差分) ' + Object.keys(DB.writes.at(-1) || {}).join());
  ok(B.sync.layout.rooms[living.id].y === living.y + 1 && DB.writes.length === 1, 'クラウド: B に反映され、B から余分な送信はない');
  // 同時編集: A は動かし、B は別の部屋の名前を変える(互いに届く前)
  const kit = Object.values(A.sync.layout.rooms).find((r) => r.name === 'キッチン'), bed = Object.values(A.sync.layout.rooms).find((r) => r.name === '寝室');
  DB.hold = true;
  await A.sync.apply(moveRoom(A.sync.layout, bed.id, bed.x + 1, bed.y, { now: T + 6000 }).layout);
  await B.sync.apply(renameRoom(B.sync.layout, kit.id, '台所', { now: T + 6001 }).layout);
  flush(); await new Promise((r) => setTimeout(r, 10));
  const same = stable(A.sync.layout) === stable(B.sync.layout);
  ok(same && A.sync.layout.rooms[kit.id].name === '台所' && A.sync.layout.rooms[bed.id].x === bed.x + 1, 'クラウド: 同時の編集(別の部屋)は両方残り、2端末が同じになる');
  ok(stable(parseLayout(DB.docs['households/H'].layout).rooms) === stable(A.sync.layout.rooms), 'クラウド: 保存された内容も同じ');
  // 元に戻す(他の端末でも戻ったままになる)
  const before = A.sync.layout; const mv = moveRoom(before, bed.id, bed.x + 2, bed.y, { now: T + 7000 });
  await A.sync.apply(mv.layout); const after = A.sync.layout;
  ok(B.sync.layout.rooms[bed.id].x === bed.x + 2, 'クラウド: 動かしたのが B に届く');
  DB.writes.length = 0;
  await A.sync.apply(undoLayout(A.sync.layout, before, after, T + 7500).layout);
  ok(A.sync.layout.rooms[bed.id].x === bed.x + 1 && B.sync.layout.rooms[bed.id].x === bed.x + 1, 'クラウド: 元に戻すと、B でも戻り、再び「編集後」に戻されない');
  await new Promise((r) => setTimeout(r, 10));
  ok(stable(A.sync.layout) === stable(B.sync.layout) && DB.writes.length === 1, 'クラウド: 戻したあとも2端末が一致・送信は1回');
  // 削除と取り消し(deleteField)
  const sp = Object.values(A.sync.layout.spots)[0], b4 = A.sync.layout;
  await A.sync.apply(deleteSpot(A.sync.layout, sp.id, { now: T + 8000 }).layout); const af = A.sync.layout;
  ok(!DB.docs['households/H'].layout.spots[sp.id] && DB.docs['households/H'].layout.dead[sp.id] && !B.sync.layout.spots[sp.id], 'クラウド: 収納場所の削除は deleteField で消え、墓標が残る');
  await A.sync.apply(undoLayout(A.sync.layout, b4, af, T + 8500).layout);
  ok(!!DB.docs['households/H'].layout.spots[sp.id] && DB.docs['households/H'].layout.dead[sp.id] === undefined && !!B.sync.layout.spots[sp.id], 'クラウド: 削除の取り消しは B でも生き返る');
  ok(undefs(DB.docs['households/H']).length === 0 && DB.writes.every((w) => undefs(w).length === 0), 'クラウド: どの書き込みにも undefined がない');
  // 他の人が消した要素を編集 → 墓標が新しければ消えたまま
  const r1 = Object.values(A.sync.layout.rooms).find((r) => r.name === 'トイレ');
  DB.hold = true;
  await B.sync.apply(deleteRoom(B.sync.layout, r1.id, { now: T + 20000 }).layout);
  await A.sync.apply(moveRoom(A.sync.layout, r1.id, r1.x, r1.y, { now: T + 20001 }).layout.rooms[r1.id] ? addRoom(A.sync.layout, 'study', { now: T + 20002 }).layout : A.sync.layout);
  flush(); await new Promise((r) => setTimeout(r, 10));
  ok(!A.sync.layout.rooms[r1.id] && !B.sync.layout.rooms[r1.id] && stable(A.sync.layout) === stable(B.sync.layout), 'クラウド: 一方が消し、他方が別の編集をしても収束する');
}
// 空の間取りの家(layout が無い)
{
  DB.docs['households/H'] = { name: 'うち', members: ['u1'] };
  const C = await device(); ok(Object.keys(C.sync.layout.rooms).length === 0 && JSON.stringify(C.sync.layout) === JSON.stringify(emptyLayout()), 'クラウド: layout が無い家は空の間取り');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
