import { firebaseConfig } from './config.js';
import { DELETE, applyPatch, parseLayout } from './floorplan.js';

export const CLOUD = !!(firebaseConfig && firebaseConfig.apiKey);
const V = '10.12.2';
const G = (m) => `https://www.gstatic.com/firebasejs/${V}/firebase-${m}.js`;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---- ローカル(お試し)ストア ----
export function localStore() {
  const KEY = 'hs-items', LKEY = 'hs-layout';
  let listener = null;
  const lListeners = new Set();
  const loadL = () => { try { return parseLayout(JSON.parse(localStorage.getItem(LKEY))); } catch { return parseLayout(null); } };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const save = (a) => { localStorage.setItem(KEY, JSON.stringify(a)); listener && listener(a); };
  return {
    mode: 'local',
    async init(onState) { onState({ user: { name: 'この端末', uid: 'local' }, household: { id: 'local', name: 'お試しモード' } }); },
    subscribe(cb) { listener = cb; cb(load()); return () => { listener = null; }; },
    async save(item) {
      const a = load(); const i = a.findIndex((x) => x.id === item.id);
      const rec = { ...item, id: item.id || uid(), updatedAt: Date.now() };
      i >= 0 ? (a[i] = rec) : a.push(rec); save(a);
    },
    async remove(id) { save(load().filter((x) => x.id !== id)); },
    // 間取り: localStorage 'hs-layout' に layout 全体を保存。patch は diffLayout のドット記法(DELETE=消す)
    subscribeLayout(cb) { const f = (l) => cb(l, { pending: false }); lListeners.add(f); f(loadL()); return () => { lListeners.delete(f); }; },
    async saveLayoutPatch(patch) {
      const l = applyPatch(loadL(), patch);
      localStorage.setItem(LKEY, JSON.stringify(l)); lListeners.forEach((f) => f(l));
    },
    async signIn() {}, async signOut() {}, async createHousehold() {}, async joinHousehold() {},
  };
}

// ---- Firebase ストア ----
// mods は注入口(テスト用: { appM, authM, fs } を渡すと gstatic を読まない)
export async function cloudStore(mods) {
  const [appM, authM, fs] = mods ? [mods.appM, mods.authM, mods.fs] : await Promise.all([import(G('app')), import(G('auth')), import(G('firestore'))]);
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  let db;
  try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() }); } catch { db = fs.getFirestore(app); }
  let hid = null; let user = null; let onStateCb = null;

  const emit = async () => {
    if (!user) return onStateCb({ user: null, household: null });
    const snap = await fs.getDoc(fs.doc(db, 'users', user.uid));
    hid = snap.exists() ? snap.data().hid : null;
    if (!hid) return onStateCb({ user: me(), household: null });
    const h = await fs.getDoc(fs.doc(db, 'households', hid));
    onStateCb({ user: me(), household: h.exists() ? { id: hid, ...h.data() } : null });
  };
  const me = () => ({ uid: user.uid, name: user.displayName || user.email });
  const items = () => fs.collection(db, 'households', hid, 'items');

  return {
    mode: 'cloud',
    async init(cb) { onStateCb = cb; authM.onAuthStateChanged(auth, (u) => { user = u; emit(); }); },
    async signIn() {
      const p = new authM.GoogleAuthProvider();
      try { await authM.signInWithPopup(auth, p); } catch (e) { if (e.code !== 'auth/popup-closed-by-user') await authM.signInWithRedirect(auth, p); }
    },
    async signOut() { await authM.signOut(auth); },
    async createHousehold(name) {
      const id = newCode();
      await fs.setDoc(fs.doc(db, 'households', id), { name, members: [user.uid], createdAt: Date.now() });
      await fs.setDoc(fs.doc(db, 'users', user.uid), { hid: id });
      await emit();
    },
    async joinHousehold(code) {
      const id = code.trim().toUpperCase();
      await fs.updateDoc(fs.doc(db, 'households', id), { members: fs.arrayUnion(user.uid) });
      await fs.setDoc(fs.doc(db, 'users', user.uid), { hid: id });
      await emit();
    },
    // cb(品目一覧, {pending: 送信待ちあり}) / 失敗時は onErr(エラー)
    subscribe(cb, onErr) {
      return fs.onSnapshot(items(), { includeMetadataChanges: true },
        (s) => cb(s.docs.map((d) => ({ ...d.data(), id: d.id })), { pending: s.metadata.hasPendingWrites }),
        (e) => onErr?.(e));
    },
    async save(item) {
      const id = item.id || uid();
      // Firestore は undefined を含む保存を拒否するので取り除く
      const rec = JSON.parse(JSON.stringify({ ...item, id, updatedAt: Date.now(), updatedBy: user.displayName || user.email }));
      await fs.setDoc(fs.doc(items(), id), rec);
    },
    async remove(id) { await fs.deleteDoc(fs.doc(items(), id)); },
    // 間取りは家のドキュメント households/{hid} の `layout` フィールドに持つ(1ドキュメント1MB以内・数十KB)。
    // 家のドキュメントの update は「メンバーなら任意のフィールド」を許可済みなので、firestore.rules の変更は不要。
    // cb(layout, {pending: 送信待ちあり})。未設定なら空の layout
    subscribeLayout(cb, onErr) {
      if (!hid) { onErr?.(new Error('no household')); return () => {}; }
      return fs.onSnapshot(fs.doc(db, 'households', hid), { includeMetadataChanges: true },
        (s) => cb(parseLayout(s.data()?.layout), { pending: s.metadata.hasPendingWrites }),
        (e) => onErr?.(e));
    },
    // patch: { 'layout.rooms.r1': {...}, 'layout.spots.s9': DELETE, ... }(diffLayout の結果)。DELETE は deleteField() に、undefined は落とす
    async saveLayoutPatch(patch) {
      if (!hid) throw new Error('no household');
      const upd = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (v === undefined || !k.startsWith('layout.')) continue;
        upd[k] = v === DELETE ? fs.deleteField() : JSON.parse(JSON.stringify(v));
      }
      if (Object.keys(upd).length) await fs.updateDoc(fs.doc(db, 'households', hid), upd);
    },
  };
}

export const createStore = () => (CLOUD ? cloudStore() : Promise.resolve(localStore()));
